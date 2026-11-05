// Work directories and gc: scratch space per review, removed once the review
// is done, never with its history and never with git work inside.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOSED_GRACE_DAYS, INVALID, applyGc, openLog, planGc, reviewPaths, workdir } from "../src/index.mjs";
import { repoWorkState } from "../src/adapters/git.mjs";
import { pullState } from "../src/adapters/github.mjs";
import { acquire, release } from "../src/core/store/lock.mjs";

const DAY = 86_400_000;
const root = () => mkdtempSync(join(tmpdir(), "gc-"));
const code = (c) => (e) => e.code === c;
const later = (days) => Date.now() + days * DAY;

// A review with one event, so it exists, and a work directory with a file.
function review(state, key, { repo = "acme/widgets", file = "scratch.txt" } = {}) {
  const ref = { repo, key };
  openLog(state, ref).append([{ type: "test.wrote", actor: "agent:test", data: {} }]);
  const { path } = workdir(state, ref);
  if (file) writeFileSync(join(path, file), "x".repeat(4096));
  return { ref, path, paths: reviewPaths(state, ref) };
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

test("workdir: needs a review, lives under it, and is created once", () => {
  const state = root();
  assert.throws(() => workdir(state, { repo: "acme/widgets", key: "7" }), code(INVALID));
  const { ref, paths } = review(state, "7", { file: null });
  assert.equal(paths.work, join(paths.dir, "work"));
  assert.ok(existsSync(paths.work));
  assert.deepEqual(workdir(state, ref), { path: paths.work, created: false });
});

test("plan: idle reviews go, recent ones stay, and a dry run changes nothing", () => {
  const state = root();
  review(state, "1");
  const plan = planGc(state, { idleDays: 30, now: later(31) });
  assert.equal(plan.items[0].action, "purge");
  assert.deepEqual(plan.items[0].reasons.map((r) => r.code), ["idle"]);
  assert.ok(plan.bytes.purge >= 4096);
  assert.ok(existsSync(plan.items[0].path), "planning removes nothing");

  const fresh = planGc(state, { idleDays: 30, now: later(2) });
  assert.equal(fresh.items[0].action, "keep");
  assert.equal(fresh.items[0].reasons[0].code, "active");
});

test("plan: a merged or closed pull request goes after the grace period; an open one waits", () => {
  const state = root();
  for (const k of ["1", "2", "3"]) review(state, k);
  const host = { 1: "merged", 2: "closed", 3: "open" };
  const hostState = (ref) => ({ state: host[ref.key], reason: null });

  const soon = byKey(planGc(state, { idleDays: 30, now: later(0), hostState }));
  assert.equal(soon[1].action, "keep", "not within the grace period");

  const p = byKey(planGc(state, { idleDays: 30, now: later(CLOSED_GRACE_DAYS + 1), hostState }));
  assert.deepEqual([p[1].action, p[1].reasons[0].code], ["purge", "host-merged"]);
  assert.deepEqual([p[2].action, p[2].reasons[0].code], ["purge", "host-closed"]);
  assert.equal(p[3].action, "keep");
  assert.match(p[3].reasons[0].message, /pull request is open/);
});

test("apply: removes the work directory only, never the review's history", () => {
  const state = root();
  const { paths } = review(state, "1");
  const log = readFileSync(paths.log, "utf8");
  const done = applyGc(state, planGc(state, { idleDays: 0, now: later(1) }));
  assert.equal(done.items[0].action, "removed");
  assert.ok(done.bytes.removed >= 4096);
  assert.ok(!existsSync(paths.work));
  assert.equal(readFileSync(paths.log, "utf8"), log);
  assert.ok(existsSync(paths.dir));
  assert.equal(planGc(state, { idleDays: 0 }).items.length, 0);
});

test("git work keeps a directory: uncommitted, untracked, unpushed or stashed", () => {
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
  assert.equal(plan.clean.action, "purge", "everything in it can be fetched again");
  assert.deepEqual(
    Object.fromEntries(Object.keys(cases).filter((k) => k !== "clean").map((k) => [k, [plan[k].action, plan[k].reasons[0].code]])),
    { dirty: ["keep", "git-uncommitted"], untracked: ["keep", "git-uncommitted"], unpushed: ["keep", "git-unpushed"], stashed: ["keep", "git-stashed"] },
  );
  assert.equal(plan.unpushed.reasons[0].path, "repo");
});

test("a linked worktree on a branch can go; one with commits only its HEAD has stays", () => {
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
  assert.equal(plan.branch.action, "purge", "the branch keeps the commit in the main repository");
  assert.deepEqual([plan.detached.action, plan.detached.reasons[0].code], ["keep", "git-unpushed"]);
  assert.match(plan.detached.reasons[0].message, /on no remote or branch/);
});

test("a git repository git cannot read is kept", () => {
  const state = root();
  const { path } = review(state, "1", { file: null });
  mkdirSync(join(path, "broken"));
  writeFileSync(join(path, "broken", ".git"), "gitdir: /nonexistent/worktree\n");
  const [item] = planGc(state, { idleDays: 0, now: later(1), checkRepo: repoWorkState }).items;
  assert.deepEqual([item.action, item.reasons[0].code], ["keep", "git-unreadable"]);
});

test("apply checks again: a held lock, a change since the plan, or new git work keeps it", () => {
  const state = root();
  const locked = review(state, "locked");
  const changed = review(state, "changed");
  const gitWork = review(state, "git");
  mkdirSync(join(gitWork.path, "repo"));
  writeFileSync(join(gitWork.path, "repo", ".git"), "");
  // Clean when planned, with uncommitted work by the time gc removes it.
  const plan = planGc(state, { idleDays: 0, now: later(1), checkRepo: () => [] });
  assert.ok(plan.items.every((i) => i.action === "purge"));

  const token = acquire(locked.paths.lock);
  const late = join(changed.path, "late.txt");
  writeFileSync(late, "x");
  const future = new Date(Date.now() + 5000);
  utimesSync(late, future, future);
  const checkRepo = (r) => (r === join(gitWork.path, "repo") ? [{ code: "git-uncommitted", message: "1 uncommitted path" }] : []);
  try {
    const done = byKey(applyGc(state, plan, { checkRepo }));
    assert.deepEqual([done.locked.action, done.locked.reasons[0].code], ["keep", "locked"]);
    assert.deepEqual([done.changed.action, done.changed.reasons[0].code], ["keep", "changed"]);
    assert.deepEqual([done.git.action, done.git.reasons[0].code], ["keep", "git-uncommitted"]);
    assert.match(done.git.reasons[0].message, /^repo: /);
  } finally {
    release(locked.paths.lock, token);
  }
  for (const r of [locked, changed, gitWork]) assert.ok(existsSync(r.path));
});

test("a work directory that is a link is never walked or removed", () => {
  const state = root();
  const outside = mkdtempSync(join(tmpdir(), "gc-outside-"));
  writeFileSync(join(outside, "keep.txt"), "mine");
  openLog(state, { repo: "acme/widgets", key: "1" }).append([{ type: "test.wrote", actor: "agent:test", data: {} }]);
  symlinkSync(outside, reviewPaths(state, { repo: "acme/widgets", key: "1" }).work);
  const plan = planGc(state, { idleDays: 0, now: later(1) });
  assert.deepEqual([plan.items[0].action, plan.items[0].reasons[0].code, plan.items[0].bytes], ["keep", "not-a-directory", 0]);

  // Even a plan that says purge is checked again before anything is removed.
  const forged = { ...plan, items: [{ ...plan.items[0], action: "purge", lastActivityAt: new Date(later(1)).toISOString() }] };
  const [item] = applyGc(state, forged).items;
  assert.deepEqual([item.action, item.reasons[0].code], ["keep", "outside-root"]);
  assert.ok(existsSync(join(outside, "keep.txt")));
});

test("plan: --repo narrows it, and idleDays must be a whole number", () => {
  const state = root();
  review(state, "1");
  review(state, "1", { repo: "acme/other" });
  assert.deepEqual(planGc(state, { idleDays: 0, repo: "acme/other" }).items.map((i) => i.repo), ["acme/other"]);
  assert.throws(() => planGc(state, { idleDays: -1 }), code(INVALID));
  assert.throws(() => planGc(state, { idleDays: 1.5 }), code(INVALID));
});

test("pullState: merged, closed, open, a branch key, and a failed lookup", () => {
  const api = (state, merged_at = null) => () => ({ state, merged_at });
  assert.equal(pullState({ repo: "a/b", key: "1", api: api("closed", "2026-01-01T00:00:00Z") }).state, "merged");
  assert.equal(pullState({ repo: "a/b", key: "1", api: api("closed") }).state, "closed");
  assert.equal(pullState({ repo: "a/b", key: "1", api: api("open") }).state, "open");
  assert.deepEqual(pullState({ repo: "a/b", key: "feat/x", api: api("open") }).state, "unknown");
  const failed = pullState({ repo: "a/b", key: "1", api: () => { throw new Error("gh api: HTTP 404"); } });
  assert.deepEqual(failed, { state: "unknown", reason: "gh api: HTTP 404" });
});

const BIN = new URL("../src/cli/main.mjs", import.meta.url).pathname;
function cli(state, args, { actor } = {}) {
  const env = { ...process.env };
  delete env.AGENT_REVIEW_ACTOR;
  const r = spawnSync("node", [BIN, ...args, "--state", state, "--json", ...(actor ? ["--actor", actor] : [])], { encoding: "utf8", env });
  let json = null;
  try {
    json = JSON.parse(r.status === 0 ? r.stdout : r.stderr);
  } catch {}
  return { status: r.status, json, stderr: r.stderr };
}

test("the command line: workdir, a dry run, and --apply with an actor", () => {
  const state = root();
  const K = ["--repo", "acme/widgets", "--key", "7"];
  const missing = cli(state, ["review", "workdir", ...K]);
  assert.equal(missing.status, 1);
  assert.equal(missing.json.error.code, INVALID);

  openLog(state, { repo: "acme/widgets", key: "7" }).append([{ type: "test.wrote", actor: "agent:test", data: {} }]);
  const wd = cli(state, ["review", "workdir", ...K]);
  assert.equal(wd.status, 0, wd.stderr);
  assert.equal(wd.json.created, true);
  writeFileSync(join(wd.json.path, "out.json"), "{}");

  const dry = cli(state, ["gc", "--offline", "--idle-days", "0"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.json.applied, false);
  assert.deepEqual(dry.json.items.map((i) => [i.key, i.action]), [["7", "purge"]]);
  assert.ok(existsSync(wd.json.path));

  assert.equal(cli(state, ["gc", "--offline", "--idle-days", "-1"]).status, 2);
  const noActor = cli(state, ["gc", "--offline", "--idle-days", "0", "--apply"]);
  assert.equal(noActor.status, 2);
  assert.match(noActor.stderr, /--actor is required/);

  const applied = cli(state, ["gc", "--offline", "--idle-days", "0", "--apply"], { actor: "human:steve" });
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual([applied.json.applied, applied.json.actor, applied.json.items[0].action], [true, "human:steve", "removed"]);
  assert.ok(!existsSync(wd.json.path));
  assert.ok(existsSync(reviewPaths(state, { repo: "acme/widgets", key: "7" }).log));
});
