import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUSY,
  CONFLICT,
  CORRUPT,
  INVALID,
  LEGACY_IMPORTED,
  OP_ID_REUSED,
  defaultStateRoot,
  digestOf,
  importLegacyV1,
  keyFile,
  legacyV1Path,
  openLog,
  reviewPaths,
  sha256,
} from "../src/index.mjs";

const FIXTURE = new URL("./fixtures/append.mjs", import.meta.url).pathname;
const REF = { repo: "acme/widgets", key: "feat/x" };
const root = () => mkdtempSync(join(tmpdir(), "store-"));
const ev = (n, actor = "agent:test") => ({ type: "test.wrote", actor, data: { n } });

// A reducer that counts events and keeps their values in order.
const counting = { reducer: (s, e) => ({ count: s.count + 1, values: [...s.values, e.data.n] }), initial: { count: 0, values: [] }, reducerVersion: "count/1" };

const code = (c) => (e) => e.code === c;

test("paths: v2 lives under v2/, with the v1 key encoding", () => {
  const r = "/state";
  assert.equal(reviewPaths(r, REF).dir, "/state/v2/acme/widgets/feat%2Fx");
  assert.equal(legacyV1Path(r, REF), "/state/reviews/acme/widgets/feat%2Fx.json");
  assert.notEqual(keyFile("a/b"), keyFile("a_b"));
  assert.throws(() => reviewPaths(r, { repo: "nope", key: "1" }), code(INVALID));
  assert.throws(() => reviewPaths(r, { repo: "a/b", key: "" }), code(INVALID));
});

test("defaultStateRoot has no personal or tool-specific locations", () => {
  assert.equal(defaultStateRoot({ AGENT_REVIEWS_STATE_DIR: "/x" }, "/home/u"), "/x");
  assert.equal(defaultStateRoot({ XDG_STATE_HOME: "/xdg" }, "/home/u"), "/xdg/agent-reviews");
  assert.equal(defaultStateRoot({}, "/home/u"), "/home/u/.local/state/agent-reviews");
});

test("append and read: sequence numbers run 1, 2, 3 and the snapshot matches the log", () => {
  const log = openLog(root(), REF, counting);
  assert.deepEqual(log.append([ev(1)]).seqs, [1]);
  const r = log.append([ev(2), ev(3)], { opId: "two" });
  assert.deepEqual(r.seqs, [2, 3]);
  assert.deepEqual(r.state, { count: 3, values: [1, 2, 3] });
  const read = log.read();
  assert.equal(read.seq, 3);
  assert.deepEqual(read.events.map((e) => [e.seq, e.op.id, e.op.index, e.op.size]), [
    [1, `auto:${digestOf([{ type: "test.wrote", actor: "agent:test", data: { n: 1 } }])}`, 0, 1],
    [2, "two", 0, 2],
    [3, "two", 1, 2],
  ]);
  assert.deepEqual(read.state, { count: 3, values: [1, 2, 3] });
});

test("invalid events are rejected before anything is written", () => {
  const log = openLog(root(), REF);
  assert.throws(() => log.append([]), code(INVALID));
  assert.throws(() => log.append([{ type: "Bad Type", actor: "agent:x" }]), code(INVALID));
  assert.throws(() => log.append([{ type: "ok", actor: "robot" }]), code(INVALID));
  assert.throws(() => log.append([{ type: "ok", actor: "agent:x", data: [1] }]), code(INVALID));
  assert.throws(() => log.append([ev(1), { type: "ok" }]), code(INVALID), "one bad event rejects the whole batch");
  assert.equal(log.read().seq, 0);
});

test("a retry with the same operation ID writes nothing and returns the first result", () => {
  const log = openLog(root(), REF, counting);
  const first = log.append([ev(1)], { opId: "op-1" });
  const again = log.append([ev(1)], { opId: "op-1" });
  assert.deepEqual(again.seqs, first.seqs);
  assert.equal(again.duplicate, true);
  assert.equal(log.read().seq, 1);
  // Without an explicit ID, identical events from the same actor are a retry.
  log.append([ev(5)]);
  assert.equal(log.append([ev(5)]).duplicate, true);
  assert.equal(log.append([ev(5, "agent:other")]).duplicate, false, "another actor's identical event is new");
  assert.equal(log.read().seq, 3);
});

test("reusing an operation ID for different events is an error", () => {
  const log = openLog(root(), REF);
  log.append([ev(1)], { opId: "op-1" });
  assert.throws(() => log.append([ev(2)], { opId: "op-1" }), code(OP_ID_REUSED));
  assert.equal(log.read().seq, 1);
});

test("expectSeq: an append fails if the log moved since the caller read it", () => {
  const log = openLog(root(), REF);
  log.append([ev(1)]);
  const { seq } = log.read();
  log.append([ev(2)]);
  assert.throws(() => log.append([ev(3)], { expectSeq: seq }), (e) => e.code === CONFLICT && e.details.seq === 2);
  assert.deepEqual(log.append([ev(3)], { expectSeq: 2 }).seqs, [3]);
});

test("a partial last line from a crash is reported, then removed by the next append", () => {
  const log = openLog(root(), REF, counting);
  log.append([ev(1)]);
  const partial = '{"schema":"agent-review.event/v1","seq":2,"ty';
  appendFileSync(log.paths.log, partial);
  const read = log.read();
  assert.equal(read.seq, 1);
  assert.deepEqual(read.recovered, [{ kind: "partial-last-line", bytes: Buffer.byteLength(partial) }]);
  const r = log.append([ev(2)]);
  assert.deepEqual(r.seqs, [2]);
  assert.equal(r.recovered[0].kind, "partial-last-line");
  assert.deepEqual(log.read().recovered, []);
  assert.deepEqual(log.read().state.values, [1, 2]);
});

test("a bad line in the middle is corruption: reading and writing fail, and nothing changes", () => {
  const log = openLog(root(), REF);
  log.append([ev(1)]);
  log.append([ev(2)]);
  const lines = readFileSync(log.paths.log, "utf8").split("\n");
  lines[0] = "{not json";
  writeFileSync(log.paths.log, lines.join("\n"));
  const before = readFileSync(log.paths.log, "utf8");
  assert.throws(() => log.read(), (e) => e.code === CORRUPT && e.details.line === 1);
  assert.throws(() => log.append([ev(3)]), code(CORRUPT));
  assert.equal(readFileSync(log.paths.log, "utf8"), before);
});

test("a gap in sequence numbers is corruption", () => {
  const log = openLog(root(), REF);
  log.append([ev(1)]);
  log.append([ev(2)]);
  const lines = readFileSync(log.paths.log, "utf8").trimEnd().split("\n");
  writeFileSync(log.paths.log, `${lines[1]}\n`);
  assert.throws(() => log.read(), (e) => e.code === CORRUPT && /no gaps/.test(e.message));
});

test("the snapshot is a cache: missing, stale or from another reducer version, it is rebuilt", () => {
  const r = root();
  const log = openLog(r, REF, counting);
  log.append([ev(1)]);
  log.append([ev(2)]);
  rmSync(log.paths.snapshot);
  assert.deepEqual(log.read().state, { count: 2, values: [1, 2] });
  writeFileSync(log.paths.snapshot, JSON.stringify({ schema: "agent-review.snapshot/v1", reducerVersion: "count/1", seq: 2, state: { count: 99, values: [] } }));
  assert.equal(log.read().state.count, 99, "a current snapshot is used as is");
  const v2 = openLog(r, REF, { ...counting, reducerVersion: "count/2" });
  assert.equal(v2.read().state.count, 2, "another reducer version rebuilds");
  writeFileSync(log.paths.snapshot, "{torn");
  assert.equal(log.read().state.count, 2, "an unreadable snapshot rebuilds");
});

function writer(r, n, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("node", [FIXTURE, r, REF.repo, REF.key, String(n), ...(timeoutMs ? [String(timeoutMs)] : [])]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (status) => resolve({ status, out, err }));
  });
}

test("40 parallel writer processes: every event lands, with unique sequence numbers", async () => {
  const r = root();
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => writer(r, i + 1)));
  assert.deepEqual(results.filter((x) => x.status !== 0), []);
  const { events } = openLog(r, REF).read();
  assert.equal(events.length, 40);
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.deepEqual(new Set(events.map((e) => e.data.n)).size, 40);
});

test("a held lock: the writer fails with store/busy and writes nothing", async () => {
  const r = root();
  const { lock, dir } = reviewPaths(r, REF);
  mkdirSync(dir, { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "test" }));
  const res = await writer(r, 1, 200);
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.err).code, BUSY);
  assert.equal(openLog(r, REF).read().seq, 0);
  assert.ok(existsSync(lock), "the holder's lock is left alone");
});

test("a held lock: the writer waits, then commits once the lock is released", async () => {
  const r = root();
  const { lock, dir } = reviewPaths(r, REF);
  mkdirSync(dir, { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "test" }));
  const pending = writer(r, 1);
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(openLog(r, REF).read().seq, 0);
  rmSync(lock);
  assert.equal((await pending).status, 0);
  assert.equal(openLog(r, REF).read().seq, 1);
  assert.ok(!existsSync(lock));
});

test("stale locks are recovered: a dead PID, or older than 30 seconds", () => {
  const r = root();
  const { lock, dir } = reviewPaths(r, REF);
  mkdirSync(dir, { recursive: true });
  const dead = Number(spawnSync("node", ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
  writeFileSync(lock, JSON.stringify({ pid: dead, token: "crashed" }));
  const log = openLog(r, REF);
  log.append([ev(1)]);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "old" }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  log.append([ev(2)]);
  assert.equal(log.read().seq, 2);
  assert.ok(!existsSync(lock));
});

test("a failed append leaves no lock and no temp files", () => {
  const log = openLog(root(), { repo: "a/b", key: "1" }, { ...counting, reducer: () => { throw new Error("reducer failed"); } });
  assert.throws(() => log.append([ev(1)]), /reducer failed/);
  assert.ok(!existsSync(log.paths.lock));
  assert.deepEqual(readdirSync(log.paths.dir).filter((n) => n.endsWith(".tmp")), []);
});

function v1Ledger(r, ref, extra = {}) {
  const path = legacyV1Path(r, ref);
  mkdirSync(dirname(path), { recursive: true });
  const ledger = {
    schema: "scalvert.review/v1",
    repo: ref.repo,
    key: ref.key,
    rounds: [{ round: 1, base: "a".repeat(40), head: "b".repeat(40), lenses: ["correctness"], models: [], runs: [], startedAt: "2026-10-01T00:00:00.000Z" }],
    findings: [{ id: "F1", title: "t", disposition: { as: "fixed", note: null, at: "2026-10-02T00:00:00.000Z" } }],
    ...extra,
  };
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
  return path;
}

test("v1 import copies the ledger, marks it legacy, and leaves the v1 file untouched", () => {
  const r = root();
  const path = v1Ledger(r, REF);
  const before = readFileSync(path);
  const log = openLog(r, REF);
  const res = importLegacyV1(log, REF, path);
  assert.equal(res.imported, true);
  assert.equal(res.digest, sha256(before));
  assert.deepEqual(readFileSync(path), before, "the v1 file is byte-for-byte unchanged");
  const [e] = log.read().events;
  assert.equal(e.type, LEGACY_IMPORTED);
  assert.equal(e.actor, "system:legacy-import");
  assert.equal(e.data.provenance, "legacy");
  assert.deepEqual(e.data.source, { schema: "scalvert.review/v1", path, digest: sha256(before) });
  assert.equal(e.data.ledger.findings[0].disposition.as, "fixed", "dispositions carry over as history");
});

test("v1 import is idempotent, and a changed v1 file is imported again", () => {
  const r = root();
  const path = v1Ledger(r, REF);
  const log = openLog(r, REF);
  importLegacyV1(log, REF, path);
  assert.equal(importLegacyV1(log, REF, path).duplicate, true);
  assert.equal(log.read().seq, 1);
  v1Ledger(r, REF, { findings: [] });
  assert.equal(importLegacyV1(log, REF, path).imported, true);
  assert.equal(log.read().seq, 2);
});

test("v1 import refuses a file that is not a v1 ledger for this review", () => {
  const r = root();
  const log = openLog(r, REF);
  assert.deepEqual(importLegacyV1(log, REF, join(r, "missing.json")).imported, false);
  const other = v1Ledger(r, { repo: "acme/other", key: "1" });
  assert.throws(() => importLegacyV1(log, REF, other), code(INVALID));
  const bad = join(r, "bad.json");
  writeFileSync(bad, JSON.stringify({ schema: "something/v9", repo: REF.repo, key: REF.key }));
  assert.throws(() => importLegacyV1(log, REF, bad), code(INVALID));
  assert.equal(log.read().seq, 0);
});
