// An append-only event log per review, plus a snapshot derived from it.
//
// Guarantees, for writers on one machine:
//
// - Every append runs under the review's lock. It either commits all of its
//   events or none, and returns their sequence numbers. It never silently
//   drops another writer's events.
// - Sequence numbers start at 1 and have no gaps.
// - An append may carry an operation ID. Repeating an append with the same
//   ID and the same events returns the first result and writes nothing, so
//   a retry after a timeout or crash is safe. Reusing an ID for different
//   events is an error. Without an ID, every append is new: identical events
//   can legitimately repeat (a decision changed and then changed back), so
//   the store never guesses that they are a retry.
// - expectSeq makes an append conditional: it fails with store/conflict if
//   anyone appended since the caller read the log.
// - A crash in the middle of an append can leave a partial last line, or
//   only some of a batch's lines. That append never returned, so the whole
//   batch is dropped: read() reports it and the next append removes it, and
//   a retry writes the whole batch again. A bad line anywhere else is
//   corruption, and reading fails rather than guessing.
// - The snapshot is a cache. If it is missing, stale or from another reducer
//   version, it is rebuilt from the log.
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { canonicalJson, digestOf } from "../digest.mjs";
import { writeFileAtomic } from "./atomic.mjs";
import { withLock } from "./lock.mjs";
import { reviewPaths } from "./paths.mjs";
import { StoreError, CONFLICT, CORRUPT, INVALID, OP_ID_REUSED } from "./errors.mjs";

export const EVENT_SCHEMA = "agent-review.event/v1";
export const SNAPSHOT_SCHEMA = "agent-review.snapshot/v1";

const TYPE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const ACTOR = /^(human|agent|system):[^\s].*$/;

function checkEvent(e, i) {
  const where = `event ${i + 1}`;
  if (!e || typeof e !== "object") throw new StoreError(INVALID, `${where}: must be an object`);
  if (typeof e.type !== "string" || !TYPE.test(e.type)) throw new StoreError(INVALID, `${where}: type must look like "review.started", got ${JSON.stringify(e.type)}`);
  if (typeof e.actor !== "string" || !ACTOR.test(e.actor)) throw new StoreError(INVALID, `${where}: actor must be human:<name>, agent:<runtime> or system:<name>, got ${JSON.stringify(e.actor)}`);
  if (e.data !== undefined && (e.data === null || typeof e.data !== "object" || Array.isArray(e.data))) throw new StoreError(INVALID, `${where}: data must be an object`);
  return { type: e.type, actor: e.actor, data: e.data ?? {} };
}

// Read every complete line. A final line with no newline is a partial write
// from a crash; anything else that does not parse is corruption.
function parseLog(path) {
  if (!existsSync(path)) return { events: [], tornBytes: 0, size: 0, dropped: [] };
  const bytes = readFileSync(path);
  const end = bytes.lastIndexOf(0x0a) + 1;
  const events = [];
  const offsets = [];
  const lines = [];
  for (let at = 0; at < end; ) {
    const nl = bytes.indexOf(0x0a, at);
    offsets.push(at);
    lines.push(bytes.subarray(at, nl).toString("utf8"));
    at = nl + 1;
  }
  lines.forEach((line, i) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      throw new StoreError(CORRUPT, `${path}: line ${i + 1} is not JSON; the log is corrupt, and nothing was changed`, { path, line: i + 1 });
    }
    if (e?.schema !== EVENT_SCHEMA) throw new StoreError(CORRUPT, `${path}: line ${i + 1} has schema ${JSON.stringify(e?.schema)}, expected ${EVENT_SCHEMA}`, { path, line: i + 1 });
    if (e.seq !== i + 1) throw new StoreError(CORRUPT, `${path}: line ${i + 1} has seq ${e.seq}; sequence numbers must run 1, 2, 3 with no gaps`, { path, line: i + 1 });
    events.push(e);
  });
  const dropped = [];
  const tornBytes = bytes.length - end;
  if (tornBytes) dropped.push({ kind: "partial-last-line", bytes: tornBytes });
  // A batch is written in one write. If its last events are missing, the
  // append crashed before it returned, so none of the batch counts.
  let size = end;
  const last = events.at(-1);
  if (last && last.op.index + 1 < last.op.size) {
    const first = events.findIndex((e) => e.op.id === last.op.id && e.op.digest === last.op.digest);
    dropped.push({ kind: "partial-batch", opId: last.op.id, events: events.length - first, of: last.op.size });
    size = offsets[first];
    events.splice(first);
  }
  return { events, tornBytes: bytes.length - size, size, dropped };
}

function reduceAll(events, reducer, initial) {
  return events.reduce((state, e) => reducer(state, e), structuredClone(initial));
}

function readSnapshot(path, seq, reducerVersion) {
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    if (s.schema === SNAPSHOT_SCHEMA && s.seq === seq && s.reducerVersion === reducerVersion) return s.state;
  } catch {}
  return undefined;
}

export function openLog(root, ref, { reducer = null, initial = {}, reducerVersion = "none", lock: lockOptions } = {}) {
  const paths = reviewPaths(root, ref);

  function stateFor(events) {
    if (!reducer) return undefined;
    const seq = events.length;
    const cached = readSnapshot(paths.snapshot, seq, reducerVersion);
    return cached !== undefined ? cached : reduceAll(events, reducer, initial);
  }

  function read() {
    const { events, dropped } = parseLog(paths.log);
    return { events, seq: events.length, state: stateFor(events), recovered: dropped };
  }

  function append(batch, { opId, expectSeq } = {}) {
    if (!Array.isArray(batch) || batch.length === 0) throw new StoreError(INVALID, "append needs at least one event");
    const clean = batch.map(checkEvent);
    const digest = digestOf(clean);
    if (opId !== undefined && (typeof opId !== "string" || opId.length === 0 || opId.length > 200)) throw new StoreError(INVALID, "opId must be a nonempty string of at most 200 characters");
    // Without an explicit ID, the append gets a unique one and is never
    // treated as a retry.
    const id = opId ?? `auto:${randomBytes(12).toString("hex")}`;

    mkdirSync(paths.dir, { recursive: true });
    return withLock(
      paths.lock,
      () => {
        const { events, tornBytes, size, dropped } = parseLog(paths.log);
        const recovered = dropped;
        if (tornBytes) {
          const fd = openSync(paths.log, "r+");
          try {
            ftruncateSync(fd, size);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }

        const earlier = events.filter((e) => e.op.id === id);
        if (earlier.length) {
          if (earlier[0].op.digest !== digest) {
            throw new StoreError(OP_ID_REUSED, `operation ${id} was already used for different events; use a new operation ID`, { opId: id });
          }
          return { seqs: earlier.map((e) => e.seq), duplicate: true, seq: events.length, state: stateFor(events), recovered };
        }
        if (expectSeq !== undefined && expectSeq !== events.length) {
          throw new StoreError(CONFLICT, `the log moved: expected seq ${expectSeq}, found ${events.length}. Read it again and retry.`, { expectSeq, seq: events.length });
        }

        const at = new Date().toISOString();
        const added = clean.map((e, i) => ({
          schema: EVENT_SCHEMA,
          seq: events.length + i + 1,
          at,
          op: { id, digest, index: i, size: clean.length },
          ...e,
        }));
        const fd = openSync(paths.log, "a");
        try {
          writeSync(fd, added.map((e) => `${canonicalJson(e)}\n`).join(""));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }

        const all = [...events, ...added];
        let state;
        if (reducer) {
          const before = readSnapshot(paths.snapshot, events.length, reducerVersion);
          state = before !== undefined ? added.reduce((s, e) => reducer(s, e), before) : reduceAll(all, reducer, initial);
          writeFileAtomic(paths.snapshot, `${JSON.stringify({ schema: SNAPSHOT_SCHEMA, reducerVersion, seq: all.length, state }, null, 2)}\n`);
        }
        return { seqs: added.map((e) => e.seq), duplicate: false, seq: all.length, state, recovered };
      },
      lockOptions,
    );
  }

  return { paths, read, append };
}
