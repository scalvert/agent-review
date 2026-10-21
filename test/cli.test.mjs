// The CLI end to end, as a person or an agent would run it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRepo, stateRoot, finding } from "./helpers.mjs";

const BIN = new URL("../src/cli/main.mjs", import.meta.url).pathname;

function cli(repo, state) {
  return (args, { actor = "agent:test", input } = {}) => {
    // A hermetic environment: the developer's own AGENT_REVIEW_ACTOR must not
    // change what these tests see.
    const env = { ...process.env };
    delete env.AGENT_REVIEW_ACTOR;
    const r = spawnSync("node", [BIN, ...args, "--state", state, "--cwd", repo.dir, ...(actor ? ["--actor", actor] : [])], { encoding: "utf8", input, env });
    let json = null;
    try {
      json = JSON.parse(r.status === 0 ? r.stdout : r.stderr);
    } catch {}
    return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
}

const K = ["--repo", "acme/widgets", "--key", "7"];

test("the full flow on the command line, with a refused step along the way", () => {
  const repo = gitRepo({ version: 1 });
  const run = cli(repo, stateRoot());
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const f1 = join(dir, "f1.json");
  writeFileSync(f1, JSON.stringify([finding(1)]));

  const started = run(["review", "start", ...K, "--target", "main", "--head", "feature", "--lenses", "security"]);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.json.next.action.do, "run");
  assert.deepEqual(started.json.next.action.slots.map((s) => s.slot), ["correctness", "security"]);

  assert.equal(run(["review", "run", ...K, "--slot", "correctness", "--status", "ok", "--model", "anthropic/opus", "--findings", f1, "--head", "feature"]).status, 0);

  // Skipping ahead is refused, with the reasons.
  const early = run(["review", "advance", ...K]);
  assert.equal(early.status, 1);
  assert.equal(early.json.error.code, "workflow/refused");
  assert.deepEqual(early.json.error.reasons.map((r) => r.code), ["run-missing", "too-few-families"]);

  // Findings can come on stdin.
  const viaStdin = run(["review", "run", ...K, "--slot", "security", "--status", "ok", "--model", "openai/gpt-5.5", "--findings", "-", "--head", "feature"], { input: "[]" });
  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  assert.equal(run(["review", "advance", ...K]).json.next.action.do, "verify");

  const same = run(["review", "decide", ...K, "--finding", "F1", "--kind", "finding-verification", "--label", "confirmed", "--probability", "0.9", "--rationale", "r", "--verifier-model", "anthropic/sonnet", "--head", "feature"]);
  assert.equal(same.status, 1);
  assert.equal(same.json.error.reasons[0].code, "verifier-not-independent");

  const rationale = join(dir, "why.txt");
  writeFileSync(rationale, "reproduced with a failing test\n");
  for (const [kind, label] of [["finding-verification", "confirmed"], ["finding-severity", "should-fix"], ["finding-origin", "introduced"], ["finding-triage", "needs-judgment"]]) {
    const r = run(["review", "decide", ...K, "--finding", "F1", "--kind", kind, "--label", label, "--probability", "0.9", "--rationale-file", rationale, "--verifier-model", "openai/gpt-5.5", "--head", "feature"]);
    assert.equal(r.status, 0, r.stderr);
  }
  const reported = run(["review", "report", ...K]);
  assert.equal(reported.json.next.status, "complete");
  assert.equal(reported.json.next.waitingOn, "human", "the judgment call still waits on a person");
  assert.deepEqual(reported.json.next.action, { do: "dispose", findings: ["F1"] });
  assert.deepEqual(reported.json.next.report.reported, ["F1"]);

  // The person sees only the judgment call, not every finding.
  const box = run(["inbox"], { actor: null });
  assert.equal(box.status, 0, box.stderr);
  assert.deepEqual(box.json.map((i) => [i.repo, i.key, i.code, i.finding]), [["acme/widgets", "7", "needs-judgment", "F1"]]);

  // It is the person's call: an agent cannot settle it, a person can.
  assert.equal(run(["review", "dispose", ...K, "--finding", "F1", "--as", "wrong"]).json.error.code, "workflow/forbidden");
  const settled = run(["review", "dispose", ...K, "--finding", "F1", "--as", "accepted", "--note", "real; fix in a follow-up"], { actor: "human:steve" });
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(settled.json.next.waitingOn, null);
  assert.deepEqual(run(["inbox"], { actor: null }).json, []);
  assert.equal(run(["review", "dispose", ...K, "--finding", "F9", "--as", "fixed"]).json.error.reasons[0].code, "not-reported");

  const status = run(["review", "status", ...K], { actor: null });
  assert.equal(status.json.findings[0].decisions["finding-verification"][0].rationale, "reproduced with a failing test");
});

test("a person takes over: an agent cannot accept a gap or resolve an escalation, a person can, and the agent resumes", () => {
  const repo = gitRepo({ version: 1, escalation: { paths: ["agent-review.json", "src/**"] } });
  const run = cli(repo, stateRoot());
  run(["review", "start", ...K, "--head", "feature", "--lenses", "tests"]);
  run(["review", "run", ...K, "--slot", "correctness", "--status", "ok", "--model", "anthropic/opus", "--head", "feature"]);
  run(["review", "run", ...K, "--slot", "tests", "--status", "failed", "--reason", "timed out", "--head", "feature"]);

  const n = run(["review", "next", ...K], { actor: null }).json;
  assert.deepEqual(n.human.map((x) => x.code), ["escalation-path", "run-failed"]);

  const agentGap = run(["review", "accept-gap", ...K, "--slot", "tests", "--reason", "skip"]);
  assert.equal(agentGap.status, 1);
  assert.equal(agentGap.json.error.code, "workflow/forbidden");
  const agentResolve = run(["review", "resolve", ...K, "--escalation", "E1", "--decision", "approve", "--reason", "fine"]);
  assert.equal(agentResolve.json.error.code, "workflow/forbidden");

  // The agent retries the failed slot instead; the person approves the path.
  assert.equal(run(["review", "run", ...K, "--slot", "tests", "--status", "ok", "--model", "openai/gpt-5.5", "--head", "feature"]).status, 0);
  assert.equal(run(["review", "resolve", ...K, "--escalation", "E1", "--decision", "approve", "--reason", "src change reviewed", "--actor", "human:steve"], { actor: null }).status, 0);
  const resumed = run(["review", "advance", ...K]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.next.action.do, "report", "no findings, so straight to the report");
  assert.equal(run(["review", "report", ...K]).json.next.status, "complete");
});

test("a run against an old commit is refused as stale", () => {
  const repo = gitRepo({ version: 1 });
  const run = cli(repo, stateRoot());
  const old = repo.head;
  run(["review", "start", ...K, "--head", "feature"]);
  repo.write("src/a.js", "9\n");
  repo.commit("more");
  const r = run(["review", "run", ...K, "--slot", "correctness", "--status", "ok", "--model", "anthropic/opus", "--head", "feature"]);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, "workflow/stale");
  assert.equal(run(["review", "run", ...K, "--slot", "correctness", "--status", "ok", "--model", "anthropic/opus", "--head", old]).status, 0, "the bound commit by SHA still works");
});

test("usage errors exit 2; refused steps exit 1 with JSON", () => {
  const repo = gitRepo({ version: 1 });
  const run = cli(repo, stateRoot());
  const noActor = run(["review", "start", ...K], { actor: null });
  assert.equal(noActor.status, 2);
  assert.match(noActor.stderr, /--actor is required/);
  assert.equal(run(["review", "start", ...K, "--bogus"]).status, 2);
  assert.equal(run(["review", "run", ...K, "--status", "ok"]).status, 2, "--slot missing");
  assert.equal(run(["nonsense"]).status, 2);
  const help = spawnSync("node", [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /review start/);
});

test("policy check validates a file and shows the trusted policy", () => {
  const repo = gitRepo({ version: 1, review: { minReviewers: 2 } });
  const run = cli(repo, stateRoot());
  const bad = join(repo.dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ version: 1, review: { minReviewers: 0 } }));
  const r = run(["policy", "check", "--file", bad], { actor: null });
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, "policy/invalid");
  assert.deepEqual(r.json.error.reasons.map((x) => x.path), ["review.minReviewers"]);
  const t = run(["policy", "check", "--target", "main", "--head", "feature"], { actor: null });
  assert.equal(t.status, 0, t.stderr);
  assert.equal(t.json.policy.review.minReviewers, 2);
  assert.equal(t.json.source.kind, "repo");
});

test("--text gives a person a few lines, not JSON", () => {
  const repo = gitRepo({ version: 1 });
  const run = cli(repo, stateRoot());
  run(["review", "start", ...K, "--head", "feature"]);
  run(["review", "run", ...K, "--slot", "correctness", "--status", "failed", "--reason", "rate limited", "--head", "feature"]);
  const n = run(["review", "next", ...K, "--text"], { actor: null });
  assert.equal(n.status, 0);
  const lines = n.stdout.trim().split("\n");
  assert.match(lines[0], /^reviewing \(round 1 at [0-9a-f]{12}, standard\)$/);
  assert.equal(lines[1], "next: run correctness (retry: rate limited), correctness-2; needs 2 model families, has none [agent]");
  assert.equal(lines[2], "for a person: slot correctness failed (rate limited); retry it, or accept the gap");
  const refused = run(["review", "advance", ...K, "--text"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr.split("\n")[0], "refused: the panel is not complete");
  assert.match(refused.stderr, /^  - slot correctness \(correctness\) failed: rate limited/m);
  assert.equal(run(["inbox", "--text"], { actor: null }).stdout.trim(), "acme/widgets 7: slot correctness failed (rate limited); retry it, or accept the gap");
  assert.equal(run(["review", "next", ...K, "--text", "--json"], { actor: null }).status, 2);
});

test("a v1 ledger is imported on first read, and one unreadable review does not hide the others", () => {
  const repo = gitRepo({ version: 1 });
  const state = stateRoot();
  const run = cli(repo, state);
  const v1 = join(state, "reviews", "acme", "widgets", "3.json");
  mkdirSync(join(v1, ".."), { recursive: true });
  writeFileSync(v1, JSON.stringify({ schema: "scalvert.review/v1", repo: "acme/widgets", key: "3", rounds: [{ round: 1 }], findings: [] }));
  const before = readFileSync(v1);
  const n = run(["review", "next", "--repo", "acme/widgets", "--key", "3"], { actor: null });
  assert.equal(n.status, 0, n.stderr);
  assert.match(n.json.note, /v1 history only/);
  assert.deepEqual(readFileSync(v1), before, "the v1 file is unchanged");

  run(["review", "start", ...K, "--head", "feature"]);
  run(["review", "run", ...K, "--slot", "correctness", "--status", "failed", "--reason", "timed out", "--head", "feature"]);
  const future = join(state, "v2", "acme", "widgets", "8", "events.jsonl");
  mkdirSync(join(future, ".."), { recursive: true });
  writeFileSync(future, `${JSON.stringify({ schema: "agent-review.event/v1", seq: 1, at: "t", op: { id: "x", digest: "d", index: 0, size: 1 }, type: "review.from-the-future", actor: "agent:x", data: {} })}\n`);
  const box = run(["inbox"], { actor: null });
  assert.equal(box.status, 0, box.stderr);
  assert.deepEqual(box.json.map((i) => [i.key, i.code]).sort(), [["7", "run-failed"], ["8", "unreadable"]]);
});

test("the default target is the remote's default branch when there is one", () => {
  const repo = gitRepo({ version: 1 });
  assert.equal(repo.adapter.defaultTarget(), null, "no remote");
  repo.git("update-ref", "refs/remotes/origin/main", "main");
  repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  assert.equal(repo.adapter.defaultTarget(), "origin/main");
  const run = cli(repo, stateRoot());
  const s = run(["review", "start", ...K, "--head", "feature"]);
  assert.equal(s.status, 0, s.stderr);
  assert.equal(run(["review", "status", ...K], { actor: null }).json.rounds[1].binding.target.ref, "origin/main");
});

test("the bin works through a symlink, as npm installs it", () => {
  const dir = mkdtempSync(join(tmpdir(), "bin-"));
  const link = join(dir, "agent-review");
  symlinkSync(BIN, link);
  const r = spawnSync("node", [link, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: agent-review/);
});
