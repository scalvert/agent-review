// Work directories, leases and gc: scratch space per review, a status that
// says whether it is in use, and removal only of what is done or idle,
// never with git work inside and never with the review's history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOSED_GRACE_DAYS, INVALID, applyGc, openReview, planGc, readLeases, releaseWorkdir, reviewPaths, workdir } from "../src/index.mjs";
import { repoWorkState } from "../src/adapters/git.mjs";
import { pullState } from "../src/adapters/github.mjs";
import { acquire, release } from "../src/core/store/lock.mjs";
import { gitRepo } from "./helpers.mjs";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const AGENT = "agent:test";
const root = () => mkdtempSync(join(tmpdir(), "gc-"));
const code = (c) => (e) => e.code === c;
const later = (days) => Date.now() + days * DAY;
const REPO = gitRepo({ version: 1 });

// A started review (reviewing), or one reported with no findings (complete),
// with a work directory holding one file. The lease from workdir() runs out
// after 4 hours, so a plan a day later sees none.
function review(state, key, { repo = "acme/widgets", file = "scratch.txt", reported = false } = {}) {
  const ref = { repo, key };
  const r = openReview(state, ref);
  r.start({ git: REPO.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT });
  if (reported) {
    r.recordRun({ slot: "correctness", status: "ok", model: "anthropic/opus", head: REPO.head, actor: AGENT, findings: [] });
    r.recordRun({ slot: "security", status: "ok", model: "openai/gpt-5.5", head: REPO.head, actor: AGENT, findings: [] });
    r.advance({ actor: AGENT });
    r.report({ actor: AGENT });
  }
  const { path, lease } = workdir(state, ref, { actor: AGENT });
  if (file) writeFileSync(join(path, file), "x".repeat(4096));
  return { ref, path, lease, paths: reviewPaths(state, ref) };
}

const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A clone of a bare remote, with one commit pushed.
function clone(into) {
  const remote = mkdtempSync(join(tmpdir(), "gc-remote-"));
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(into, "clone", "-q", remote, "repo");
  const dir = join(into, "repo");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  git(dir, "push", "-q", "origin", "HEAD:main");
  return dir;
}

const byKey = (plan) => Object.fromEntries(plan.items.map((i) => [i.key, i]));
const status = (i) => [i.status, i.removable, i.reasons[0].code];

test("workdir: needs a review and an actor, lives under it, and hands out a lease", () => {
  const state = root();
  assert.throws(() => workdir(state, { repo: "acme/widgets", key: "7" }, { actor: AGENT }), code(INVALID));
  const { ref, paths, lease } = review(state, "7", { file: null });
  assert.equal(paths.work, join(paths.dir, "work"));
  assert.throws(() => workdir(state, ref, {}), code(INVALID), "a lease names who holds it");
  assert.throws(() => workdir(state, ref, { actor: AGENT, leaseMs: 0 }), code(INVALID));
  assert.match(lease.id, /^[0-9a-f]{12}$/);
  assert.equal(lease.renewed, false);
  assert.equal(Date.parse(lease.expiresAt) - Date.parse(lease.renewedAt), 4 * HOUR);
  assert.ok(existsSync(join(paths.dir, "leases", `${lease.id}.json`)), "leases live outside work/");

  const again = workdir(state, ref, { actor: AGENT, lease: lease.id, leaseMs: 8 * HOUR });
  assert.deepEqual([again.created, again.lease.id, again.lease.renewed, again.lease.acquiredAt], [false, lease.id, true, lease.acquiredAt]);
  assert.throws(() => workdir(state, ref, { actor: "agent:other", lease: lease.id }), code(INVALID), "only its holder renews a lease");
  assert.throws(() => workdir(state, ref, { actor: AGENT, lease: "../../x" }), code(INVALID));

  assert.deepEqual(releaseWorkdir(state, ref, { lease: lease.id, actor: AGENT }), { released: true, lease: lease.id });
  assert.deepEqual(releaseWorkdir(state, ref, { lease: lease.id, actor: AGENT }), { released: false, lease: lease.id }, "a retry is safe");
});

test("status: a live lease is in use, whatever else is true", () => {
  const state = root();
  const { ref } = review(state, "1");
  workdir(state, ref, { actor: "agent:long-eval", leaseMs: 7 * DAY });
  const host = () => ({ state: "merged", reason: null });
  const [item] = planGc(state, { idleDays: 0, now: later(2), hostState: host }).items;
  assert.deepEqual(status(item), ["in-use", false, "leased"]);
  assert.match(item.reasons[0].message, /leased by agent:long-eval until /);
  assert.equal(item.leases.filter((l) => l.live).length, 1);
  assert.equal(item.leases.filter((l) => !l.live)[0].why, "expired");
});

test("status: a lease whose process has exited no longer counts", async () => {
  const state = root();
  const { ref } = review(state, "1");
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => child.on("exit", r));
  workdir(state, ref, { actor: AGENT, leaseMs: 7 * DAY, pid: child.pid });
  const exited = readLeases(state, ref, { now: later(1) }).find((l) => l.pid === child.pid);
  assert.deepEqual([exited.live, exited.why], [false, `process ${child.pid} has exited`]);

  workdir(state, ref, { actor: AGENT, leaseMs: 7 * DAY, pid: process.pid });
  assert.equal(planGc(state, { idleDays: 0, now: later(1) }).items[0].status, "in-use", "a live process keeps it");
});

test("status: in review, paused, done and idle, from the workflow and the host", () => {
  const state = root();
  review(state, "reviewing");
  review(state, "complete", { reported: true });
  review(state, "merged", { reported: true });
  review(state, "closed");
  review(state, "fresh-merge");
  const host = { merged: "merged", closed: "closed", "fresh-merge": "merged", complete: "open" };
  const hostState = (ref) => (host[ref.key] ? { state: host[ref.key], reason: null } : null);

  const p = byKey(planGc(state, { idleDays: 30, now: later(CLOSED_GRACE_DAYS + 1), hostState }));
  assert.deepEqual(status(p.reviewing), ["in-review", false, "in-review"]);
  assert.match(p.reviewing.reasons[0].message, /the review is reviewing \(round 1\)/);
  assert.deepEqual(p.reviewing.review, { status: "reviewing", round: 1, waitingOn: "agent" });
  assert.deepEqual(status(p.complete), ["paused", false, "paused"]);
  assert.match(p.complete.reasons[0].message, /complete \(round 1\), the pull request is open/);
  assert.deepEqual(status(p.merged), ["done", true, "host-merged"]);
  assert.deepEqual(status(p.closed), ["done", true, "host-closed"], "a merged or closed pull request ends the review, whatever its state");

  const soon = byKey(planGc(state, { idleDays: 30, now: later(0.5), hostState }));
  assert.deepEqual(status(soon["fresh-merge"]), ["paused", false, "grace"]);

  const old = byKey(planGc(state, { idleDays: 30, now: later(31), hostState }));
  assert.deepEqual(status(old.reviewing), ["idle", true, "idle"]);
  assert.deepEqual(status(old.complete), ["idle", true, "idle"]);
});

test("status: the list is ordered by status, and a dry run changes nothing", () => {
  const state = root();
  review(state, "idle");
  const busy = review(state, "busy");
  workdir(state, busy.ref, { actor: AGENT, leaseMs: 7 * DAY });
  const plan = planGc(state, { idleDays: 0, now: later(1) });
  assert.deepEqual(plan.items.map((i) => [i.key, i.status]), [["busy", "in-use"], ["idle", "idle"]]);
  assert.ok(plan.bytes.removable >= 4096);
  assert.ok(plan.items.every((i) => existsSync(i.path)));
});

test("apply: removes the work directory and its spent leases, never the review's history", () => {
  const state = root();
  const { paths, ref } = review(state, "1");
  const log = readFileSync(paths.log, "utf8");
  const done = applyGc(state, planGc(state, { idleDays: 0, now: later(1) }), { now: later(1) });
  assert.equal(done.items[0].removed, true);
  assert.ok(done.bytes.removed >= 4096);
  assert.ok(!existsSync(paths.work));
  assert.equal(readFileSync(paths.log, "utf8"), log);
  assert.ok(existsSync(paths.snapshot));
  assert.deepEqual(readdirSync(join(paths.dir, "leases")), [], "the spent lease is pruned");
  assert.equal(openReview(state, ref).read().round, 1, "the review reads as before");
  assert.equal(planGc(state, { idleDays: 0 }).items.length, 0);
});

test("git work protects a directory: uncommitted, untracked, unpushed or stashed", () => {
  const state = root();
  const cases = {
    clean: () => {},
    dirty: (d) => writeFileSync(join(d, "a.txt"), "2\n"),
    untracked: (d) => writeFileSync(join(d, "new.txt"), "n\n"),
    unpushed: (d) => {
      writeFileSync(join(d, "b.txt"), "b\n");
      git(d, "add", "-A");
      git(d, "commit", "-q", "-m", "local only");
    },
    stashed: (d) => {
      writeFileSync(join(d, "a.txt"), "3\n");
      git(d, "stash", "-q");
    },
  };
  for (const [key, change] of Object.entries(cases)) change(clone(review(state, key, { file: null }).path));

  const plan = byKey(planGc(state, { idleDays: 0, now: later(1), checkRepo: repoWorkState }));
  assert.deepEqual(status(plan.clean), ["idle", true, "idle"], "everything in it can be fetched again");
  assert.deepEqual(
    Object.fromEntries(Object.keys(cases).filter((k) => k !== "clean").map((k) => [k, status(plan[k])])),
    { dirty: ["protected", false, "git-uncommitted"], untracked: ["protected", false, "git-uncommitted"], unpushed: ["protected", false, "git-unpushed"], stashed: ["protected", false, "git-stashed"] },
  );
  assert.equal(plan.unpushed.reasons[0].path, "repo");
});

test("a linked worktree on a branch can go; one with commits only its HEAD has is protected", () => {
  const state = root();
  const main = clone(mkdtempSync(join(tmpdir(), "gc-main-")));
  const onBranch = review(state, "branch", { file: null }).path;
  git(main, "worktree", "add", "-q", "-b", "feature", join(onBranch, "wt"));
  writeFileSync(join(onBranch, "wt", "c.txt"), "c\n");
  git(join(onBranch, "wt"), "add", "-A");
  git(join(onBranch, "wt"), "commit", "-q", "-m", "on the branch");

  const detached = review(state, "detached", { file: null }).path;
  git(main, "worktree", "add", "-q", "--detach", join(detached, "wt"));
  writeFileSync(join(detached, "wt", "d.txt"), "d\n");
  git(join(detached, "wt"), "add", "-A");
  git(join(detached, "wt"), "commit", "-q", "-m", "only HEAD has this");

  const plan = byKey(planGc(state, { idleDays: 0, now: later(1), checkRepo: repoWorkState }));
  assert.equal(plan.branch.removable, true, "the branch keeps the commit in the main repository");
  assert.deepEqual(status(plan.detached), ["protected", false, "git-unpushed"]);
  assert.match(plan.detached.reasons[0].message, /on no remote or branch/);
});

test("protected: a repository git cannot read, or a review the harness cannot read", () => {
  const state = root();
  const { path } = review(state, "1", { file: null });
  mkdirSync(join(path, "broken"));
  writeFileSync(join(path, "broken", ".git"), "gitdir: /nonexistent/worktree\n");
  const [item] = planGc(state, { idleDays: 0, now: later(1), checkRepo: repoWorkState }).items;
  assert.deepEqual(status(item), ["protected", false, "git-unreadable"]);

  const other = review(state, "2");
  writeFileSync(other.paths.log, `${readFileSync(other.paths.log, "utf8")}{"not":"an event"}\n`);
  const p = byKey(planGc(state, { idleDays: 0, now: later(1) }));
  assert.deepEqual(status(p[2]), ["protected", false, "review-unreadable"]);
});

test("apply assesses again under the lock: a new lease, a held lock, a change, or new git work keeps it", () => {
  const state = root();
  const leased = review(state, "leased");
  const locked = review(state, "locked");
  const changed = review(state, "changed");
  const gitWork = review(state, "git");
  mkdirSync(join(gitWork.path, "repo"));
  writeFileSync(join(gitWork.path, "repo", ".git"), "");
  // Clean when planned, with uncommitted work by the time gc removes it.
  const plan = planGc(state, { idleDays: 0, now: later(1), checkRepo: () => [] });
  assert.ok(plan.items.every((i) => i.removable));

  workdir(state, leased.ref, { actor: "agent:late", leaseMs: 7 * DAY });
  const token = acquire(locked.paths.lock);
  const late = join(changed.path, "late.txt");
  writeFileSync(late, "x");
  const future = new Date(Date.now() + 5000);
  utimesSync(late, future, future);
  const checkRepo = (r) => (r === join(gitWork.path, "repo") ? [{ code: "git-uncommitted", message: "1 uncommitted path" }] : []);
  try {
    const done = byKey(applyGc(state, plan, { now: later(1), checkRepo }));
    assert.deepEqual(status(done.leased), ["in-use", false, "leased"]);
    assert.deepEqual(status(done.locked), ["protected", false, "locked"]);
    assert.deepEqual(status(done.changed), ["protected", false, "changed"]);
    assert.deepEqual(status(done.git), ["protected", false, "git-uncommitted"]);
    assert.match(done.git.reasons[0].message, /^repo: /);
    assert.ok(Object.values(done).every((i) => i.removed === false));
  } finally {
    release(locked.paths.lock, token);
  }
  for (const r of [leased, locked, changed, gitWork]) assert.ok(existsSync(r.path));
});

test("a work directory that is a link is never walked or removed", () => {
  const state = root();
  const outside = mkdtempSync(join(tmpdir(), "gc-outside-"));
  writeFileSync(join(outside, "keep.txt"), "mine");
  const { paths } = review(state, "1", { file: null });
  execFileSync("rm", ["-r", paths.work]);
  symlinkSync(outside, paths.work);
  const plan = planGc(state, { idleDays: 0, now: later(1) });
  assert.deepEqual([...status(plan.items[0]), plan.items[0].bytes], ["protected", false, "not-a-directory", 0]);

  // Even a plan that says removable is checked again before anything goes.
  const forged = { ...plan, items: [{ ...plan.items[0], removable: true, lastActivityAt: new Date(later(1)).toISOString() }] };
  const [item] = applyGc(state, forged, { now: later(1) }).items;
  assert.deepEqual([item.removed, item.reasons[0].code], [false, "outside-root"]);
  assert.ok(existsSync(join(outside, "keep.txt")));
});

test("plan: --repo narrows it, and idleDays must be a whole number", () => {
  const state = root();
  review(state, "1");
  review(state, "1", { repo: "acme/other" });
  assert.deepEqual(planGc(state, { idleDays: 0, now: later(1), repo: "acme/other" }).items.map((i) => i.repo), ["acme/other"]);
  assert.throws(() => planGc(state, { idleDays: -1 }), code(INVALID));
  assert.throws(() => planGc(state, { idleDays: 1.5 }), code(INVALID));
});

test("pullState: merged, closed, open, a branch key, and a failed lookup", () => {
  const api = (state, merged_at = null) => () => ({ state, merged_at });
  assert.equal(pullState({ repo: "a/b", key: "1", api: api("closed", "2026-01-01T00:00:00Z") }).state, "merged");
  assert.equal(pullState({ repo: "a/b", key: "1", api: api("closed") }).state, "closed");
  assert.equal(pullState({ repo: "a/b", key: "1", api: api("open") }).state, "open");
  assert.equal(pullState({ repo: "a/b", key: "feat/x", api: api("open") }).state, "unknown");
  const failed = pullState({ repo: "a/b", key: "1", api: () => { throw new Error("gh api: HTTP 404"); } });
  assert.deepEqual(failed, { state: "unknown", reason: "gh api: HTTP 404" });
});

const BIN = new URL("../src/cli/main.mjs", import.meta.url).pathname;
function cli(state, args, { actor, text = false } = {}) {
  const env = { ...process.env };
  delete env.AGENT_REVIEW_ACTOR;
  const r = spawnSync("node", [BIN, ...args, "--state", state, text ? "--text" : "--json", ...(actor ? ["--actor", actor] : [])], { encoding: "utf8", env });
  let json = null;
  try {
    json = JSON.parse(r.status === 0 ? r.stdout : r.stderr);
  } catch {}
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

test("the command line: a lease, workdirs, release, a dry run, and --apply with an actor", () => {
  const state = root();
  const K = ["--repo", "acme/widgets", "--key", "7"];
  assert.equal(cli(state, ["review", "workdir", ...K], { actor: AGENT }).json.error.code, INVALID, "the review must exist");
  openReview(state, { repo: "acme/widgets", key: "7" }).start({ git: REPO.adapter, targetRef: "main", head: "feature", actor: AGENT });

  assert.equal(cli(state, ["review", "workdir", ...K]).status, 2, "a lease needs an actor");
  const wd = cli(state, ["review", "workdir", ...K, "--lease-hours", "2"], { actor: AGENT });
  assert.equal(wd.status, 0, wd.stderr);
  assert.equal(wd.json.created, true);
  writeFileSync(join(wd.json.path, "out.json"), "{}");

  const list = cli(state, ["workdirs", "--offline", "--idle-days", "0"]);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.json.items.map((i) => [i.key, i.status, i.removable]), [["7", "in-use", false]]);
  const text = cli(state, ["workdirs", "--offline", "--idle-days", "0"], { text: true });
  assert.match(text.stdout, /^1 work directory; gc may remove 0, 0 B\n  in-use +acme\/widgets 7 .* leased by agent:test until /);
  assert.equal(cli(state, ["gc", "--offline", "--idle-days", "0"]).json.items[0].removable, false);

  assert.equal(cli(state, ["review", "workdir", ...K, "--release"], { actor: AGENT }).status, 2, "--release needs the lease");
  const rel = cli(state, ["review", "workdir", ...K, "--release", "--lease", wd.json.lease.id], { actor: AGENT });
  assert.deepEqual(rel.json, { released: true, lease: wd.json.lease.id });

  const dry = cli(state, ["gc", "--offline", "--idle-days", "0"]);
  assert.deepEqual([dry.json.applied, dry.json.items[0].status, dry.json.items[0].removable], [false, "idle", true]);
  assert.ok(existsSync(wd.json.path));

  assert.equal(cli(state, ["gc", "--offline", "--idle-days", "-1"]).status, 2);
  const noActor = cli(state, ["gc", "--offline", "--idle-days", "0", "--apply"]);
  assert.equal(noActor.status, 2);
  assert.match(noActor.stderr, /--actor is required/);

  const applied = cli(state, ["gc", "--offline", "--idle-days", "0", "--apply"], { actor: "human:steve" });
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual([applied.json.applied, applied.json.actor, applied.json.items[0].removed], [true, "human:steve", true]);
  assert.ok(!existsSync(wd.json.path));
  assert.ok(existsSync(reviewPaths(state, { repo: "acme/widgets", key: "7" }).log));
});
