// An append-only event log per review, plus a snapshot derived from it.
//
// Guarantees, for writers on one machine:
//
// - Every append runs under the review's lock. It either commits all of its
//   events or none, and returns their sequence numbers. It never silently
//   drops another writer's events.
// - Sequence numbers start at 1 and have no gaps.
// - Each append has an operation ID. Repeating an append with the same ID
//   and the same events returns the first result and writes nothing, so a
//   retry after a timeout or crash is safe. Reusing an ID for different
//   events is an error.
// - expectSeq makes an append conditional: it fails with store/conflict if
//   anyone appended since the caller read the log.
// - A crash in the middle of an append can leave a partial last line. That
//   append never returned, so the partial line is dropped: read() reports it
//   and the next append removes it. A bad line anywhere else is corruption,
//   and reading fails rather than guessing.
// - The snapshot is a cache. If it is missing, stale or from another reducer
//   version, it is rebuilt from the log.
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
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
  if (!existsSync(path)) return { events: [], tornBytes: 0, size: 0 };
  const text = readFileSync(path, "utf8");
  const end = text.lastIndexOf("\n") + 1;
  const events = [];
  const lines = text.slice(0, end).split("\n").slice(0, -1);
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
  return { events, tornBytes: Buffer.byteLength(text.slice(end)), size: Buffer.byteLength(text.slice(0, end)) };
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
    const { events, tornBytes } = parseLog(paths.log);
    return {
      events,
      seq: events.length,
      state: stateFor(events),
      recovered: tornBytes ? [{ kind: "partial-last-line", bytes: tornBytes }] : [],
    };
  }

  function append(batch, { opId, expectSeq } = {}) {
    if (!Array.isArray(batch) || batch.length === 0) throw new StoreError(INVALID, "append needs at least one event");
    const clean = batch.map(checkEvent);
    const digest = digestOf(clean);
    // Without an explicit ID, the same events from the same actor count as a
    // retry of the same operation.
    const id = opId ?? `auto:${digest}`;
    if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new StoreError(INVALID, "opId must be a nonempty string of at most 200 characters");

    mkdirSync(paths.dir, { recursive: true });
    return withLock(
      paths.lock,
      () => {
        const { events, tornBytes, size } = parseLog(paths.log);
        const recovered = [];
        if (tornBytes) {
          const fd = openSync(paths.log, "r+");
          try {
            ftruncateSync(fd, size);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          recovered.push({ kind: "partial-last-line", bytes: tornBytes });
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
