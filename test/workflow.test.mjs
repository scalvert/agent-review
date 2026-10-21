// The review lifecycle, against the acceptance tests in the plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FORBIDDEN,
  REFUSED,
  STALE,
  UNKNOWN_EVENT,
  WORKFLOW_INVALID,
  WEAKENING,
  importLegacyV1,
  inbox,
  legacyV1Path,
  next,
  openLog,
  openReview,
  publicState,
  reduce,
  initialState,
} from "../src/index.mjs";
import { renderNext } from "../src/cli/render.mjs";
import { finding, gitRepo, stateRoot } from "./helpers.mjs";

const REF = { repo: "acme/widgets", key: "42" };
const AGENT = "agent:test";
const HUMAN = "human:steve";
const OPUS = "anthropic/opus";
const SONNET = "anthropic/sonnet";
const GPT = "openai/gpt-5.5";

// Refused with exactly these reason codes.
const refused = (code, reasons) => (e) => {
  assert.equal(e.code, code, e.message);
  if (reasons) assert.deepEqual(e.reasons.map((r) => r.code), reasons);
  return true;
};

function setup(policy, opts = {}) {
  const repo = gitRepo(policy);
  const review = openReview(stateRoot(), REF);
  const started = review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: opts.lenses ?? ["security"], actor: AGENT });
  return { repo, review, head: repo.head, state: started.state };
}

// Two reviewers from two families, one finding each; verified across families.
function happyPanel(review, head) {
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: [finding(1)] });
  review.recordRun({ slot: "security", status: "ok", model: GPT, head, actor: AGENT, findings: [finding(2)] });
  review.advance({ actor: AGENT });
}

// The happy panel, with candidate 1 confirmed at a severity and candidate 2
// refuted, then reported.
function reportOne(review, head, severity = "should-fix") {
  happyPanel(review, head);
  for (const [kind, label] of [["finding-verification", "confirmed"], ["finding-severity", severity], ["finding-origin", "introduced"], ["finding-triage", "agent-fixable"]]) {
    review.decide({ candidate: 1, kind, label, probability: 0.9, rationale: "r", verifier: { model: GPT }, head, actor: AGENT });
  }
  review.decide({ candidate: 2, kind: "finding-verification", label: "refuted", probability: 0.1, rationale: "r", verifier: { model: OPUS }, head, actor: AGENT });
  return review.report({ actor: AGENT }).state;
}

test("a valid path reaches a complete review, with provenance for every step", () => {
  const { repo, review, head, state } = setup({ version: 1 });
  const round = state.rounds[1];
  assert.equal(round.binding.head, head);
  assert.equal(round.binding.target.commit, repo.git("rev-parse", "main"));
  assert.equal(round.binding.mergeBase, repo.git("rev-parse", "main"));
  assert.equal(round.policy.source.kind, "repo");
  assert.match(round.binding.policyDigest, /^sha256:/);
  assert.deepEqual(round.plan.slots.map((s) => s.id), ["correctness", "security"]);
  assert.deepEqual(next(state).action.do, "run");

  happyPanel(review, head);
  assert.deepEqual(next(review.read()).action.findings.map((f) => [f.candidate, f.title, f.verifierMust]), [
    [1, "finding 1", { notFamily: "anthropic" }],
    [2, "finding 2", { notFamily: "openai" }],
  ]);
  review.decide({ candidate: 1, kind: "finding-verification", label: "confirmed", probability: 0.9, rationale: "reproduced", verifier: { model: GPT }, head, actor: AGENT });
  review.decide({ candidate: 2, kind: "finding-verification", label: "refuted", probability: 0.2, rationale: "guarded at a.js:3", verifier: { model: OPUS }, head, actor: AGENT });
  assert.deepEqual(next(review.read()).action, {
    do: "decide",
    findings: [{ candidate: 1, title: "finding 1", file: "src/f1.js", line: 1, kinds: ["finding-severity", "finding-origin", "finding-triage"], author: { slot: "correctness", model: OPUS, family: "anthropic" }, verifierMust: { notFamily: "anthropic" } }],
  });
  for (const [kind, label] of [["finding-severity", "should-fix"], ["finding-origin", "introduced"], ["finding-triage", "agent-fixable"]]) {
    review.decide({ candidate: 1, kind, label, probability: 0.8, rationale: "r", verifier: { model: GPT }, head, actor: AGENT });
  }
  assert.equal(next(review.read()).action.do, "report");
  const done = review.report({ actor: AGENT }).state;
  const n = next(done);
  assert.equal(n.status, "complete");
  assert.deepEqual(n.report.findings, [{ n: 1, section: "should-fix" }]);
  assert.deepEqual(n.report.dropped, [2], "dropped candidates, by candidate number");
  assert.equal(n.report.coverage.complete, true);
  const f1 = done.findings[0];
  assert.deepEqual(f1.author, { slot: "correctness", model: OPUS, family: "anthropic" });
  assert.deepEqual(f1.decisions["finding-verification"][0].verifier, { model: GPT, family: "openai" });
  assert.equal(done.rounds[1].runs.correctness.runner.kind, "attested", "a run the harness did not execute is attested");
});

test("missing reviewers and too few families block the panel, with every reason", () => {
  const { review, head } = setup({ version: 1, review: { minReviewers: 3 } });
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT });
  assert.throws(() => review.advance({ actor: AGENT }), refused(REFUSED, ["run-missing", "run-missing", "too-few-reviewers", "too-few-families"]));
  review.recordRun({ slot: "security", status: "ok", model: SONNET, head, actor: AGENT });
  review.recordRun({ slot: "correctness-2", status: "ok", model: OPUS, head, actor: AGENT });
  assert.throws(() => review.advance({ actor: AGENT }), refused(REFUSED, ["too-few-families"]), "three anthropic runs are still one family");
});

test("findings without the evidence the policy requires are refused, and nothing is written", () => {
  const { review, head } = setup({ version: 1 });
  assert.throws(
    () => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: [finding(1, { scenario: "" }), finding(2, { line: 0 })] }),
    refused(REFUSED, ["finding-field", "finding-field"]),
  );
  assert.equal(review.read().findings.length, 0);
  assert.equal(review.read().rounds[1].runs.correctness, undefined);
  assert.throws(() => review.recordRun({ slot: "correctness", status: "failed", head, actor: AGENT }), refused(WORKFLOW_INVALID), "a failed run needs a reason");
  assert.throws(() => review.recordRun({ slot: "correctness", status: "ok", model: "opus", head, actor: AGENT }), refused(WORKFLOW_INVALID), "models are provider/model");
});

test("a verifier from the author's model, or its family when the policy says so, is refused", () => {
  const { review, head } = setup({ version: 1 });
  happyPanel(review, head);
  const verify = (model, extra = {}) => review.decide({ candidate: 1, kind: "finding-verification", label: "confirmed", probability: 0.9, rationale: "r", verifier: { model, ...extra }, head, actor: AGENT });
  assert.throws(() => verify(OPUS), refused(REFUSED, ["verifier-not-independent"]), "the author verifying itself");
  assert.throws(() => verify(SONNET), refused(REFUSED, ["verifier-not-independent"]), "the author's family");
  assert.throws(() => verify("gateway/claude-x", { family: "anthropic" }), refused(REFUSED, ["verifier-not-independent"]), "a declared family counts");
  assert.equal(verify(GPT).changed, true);
  assert.equal(verify(GPT).changed, false, "the same decision again is a no-op");
  assert.throws(
    () => review.decide({ candidate: 1, kind: "finding-verification", label: "refuted", probability: 0.4, rationale: "x", verifier: { model: GPT }, head, actor: AGENT }),
    refused(REFUSED, ["verifier-repeated"]),
    "one model cannot verify the same finding twice with a different answer",
  );

  const model = setup({ version: 1, independence: { verifier: "model" } });
  happyPanel(model.review, model.head);
  model.review.decide({ candidate: 1, kind: "finding-verification", label: "confirmed", probability: 0.9, rationale: "r", verifier: { model: SONNET }, head: model.head, actor: AGENT });
});

test("decisions without the required rationale are refused", () => {
  const { review, head } = setup({ version: 1 });
  happyPanel(review, head);
  assert.throws(() => review.decide({ candidate: 1, kind: "finding-verification", label: "confirmed", probability: 0.9, rationale: " ", verifier: { model: GPT }, head, actor: AGENT }), refused(REFUSED, ["decision-field"]));
  assert.throws(() => review.decide({ candidate: 1, kind: "finding-verification", label: "maybe", probability: 0.9, rationale: "r", verifier: { model: GPT }, head, actor: AGENT }), refused(WORKFLOW_INVALID));
});

test("steps out of order are refused with the reason", () => {
  const { review, head } = setup({ version: 1 });
  assert.throws(() => review.decide({ candidate: 1, kind: "finding-verification", label: "confirmed", probability: 0.9, rationale: "r", verifier: { model: GPT }, head, actor: AGENT }), refused(REFUSED, ["wrong-state"]));
  assert.throws(() => review.report({ actor: AGENT }), refused(REFUSED, ["wrong-state"]));
  happyPanel(review, head);
  assert.throws(() => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT }), refused(REFUSED, ["wrong-state"]));
  assert.throws(() => review.report({ actor: AGENT }), refused(REFUSED, ["unverified", "unverified"]));
});

test("a new head invalidates the round: old evidence does not carry over, and stale writes are refused", () => {
  const { repo, review, head } = setup({ version: 1 });
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: [finding(1)] });
  repo.write("src/a.js", "3\n");
  const newHead = repo.commit("more work");
  assert.throws(() => review.recordRun({ slot: "security", status: "ok", model: GPT, head: newHead, actor: AGENT }), refused(STALE));
  const s = review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT }).state;
  assert.equal(s.rounds[1].status, "invalidated");
  assert.deepEqual(s.rounds[1].invalidated.changed, ["head"]);
  assert.equal(s.round, 2);
  assert.deepEqual(s.rounds[2].runs, {}, "the new round starts with no runs");
  assert.throws(() => review.recordRun({ slot: "security", status: "ok", model: GPT, head, actor: AGENT }), refused(STALE), "the old head is now stale");
  assert.equal(next(s).action.do, "run");
});

test("a policy change on the target invalidates the round; the target moving alone does not", () => {
  const { repo, review, head } = setup({ version: 1 });
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT });
  repo.git("checkout", "-q", "main");
  repo.write("docs/x.md", "x\n");
  repo.commit("unrelated");
  repo.git("checkout", "-q", "feature");
  const same = review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT });
  assert.equal(same.changed, false, "same head, merge base and policy: the round stands");
  assert.equal(same.state.round, 1);

  repo.git("checkout", "-q", "main");
  repo.write("agent-review.json", JSON.stringify({ version: 1, review: { minReviewers: 3 } }));
  repo.commit("tighten");
  repo.git("checkout", "-q", "feature");
  const s = review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT }).state;
  assert.deepEqual(s.rounds[1].invalidated.changed, ["policyDigest"]);
  assert.equal(s.rounds[2].plan.requirements.minReviewers, 3);
});

test("a pull request that weakens its policy is reviewed under the trusted one, and a person must look", () => {
  const repo = gitRepo({ version: 1, independence: { minFamilies: 2 } });
  repo.write("agent-review.json", JSON.stringify({ version: 1, independence: { minFamilies: 1 } }));
  const head = repo.commit("weaken");
  const review = openReview(stateRoot(), REF);
  const s = review.start({ git: repo.adapter, targetRef: "main", head: "feature", actor: AGENT }).state;
  assert.equal(s.rounds[1].plan.requirements.minFamilies, 2);
  assert.deepEqual(next(s).human.map((h) => h.code), ["policy-change"]);
  assert.throws(() => review.start({ git: repo.adapter, targetRef: "main", head, actor: AGENT, overrides: { independence: { minFamilies: 1 } } }), (e) => e.code === WEAKENING);
});

test("a change to an escalation path goes to a person", () => {
  const repo = gitRepo({ version: 1, escalation: { paths: ["agent-review.json", ".github/**"] } });
  repo.write(".github/workflows/ci.yml", "on: push\n");
  repo.commit("ci");
  const s = openReview(stateRoot(), REF).start({ git: repo.adapter, targetRef: "main", head: "feature", actor: AGENT }).state;
  assert.deepEqual(next(s).human.map((h) => [h.code, h.ask]), [["escalation-path", ".github/workflows/ci.yml matches escalation.paths .github/**; a person must review it"]]);
});

test("verifiers that disagree go to a person; only a person resolves it", () => {
  const { review, head } = setup({ version: 1, independence: { verifier: "model" } });
  happyPanel(review, head);
  const v = (candidate, model, label, p = 0.9) => review.decide({ candidate, kind: "finding-verification", label, probability: p, rationale: "r", verifier: { model }, head, actor: AGENT });
  v(1, GPT, "confirmed");
  v(1, SONNET, "refuted", 0.3);
  v(2, OPUS, "refuted", 0.2);
  assert.throws(() => review.report({ actor: AGENT }), refused(REFUSED, ["no-severity", "no-origin"]), "a disputed finding is rated before a person settles it");
  for (const [kind, label] of [["finding-severity", "should-fix"], ["finding-origin", "introduced"]]) {
    review.decide({ candidate: 1, kind, label, probability: 0.8, rationale: "r", verifier: { model: GPT }, head, actor: AGENT });
  }
  const s = review.report({ actor: AGENT }).state;
  const n = next(s);
  assert.equal(n.status, "reported");
  assert.equal(n.waitingOn, "human");
  assert.equal(s.findings[0].number, 1, "a disputed finding is numbered with the report");
  assert.deepEqual(n.report.findings, []);
  assert.deepEqual(n.report.disputed, [1], "the report lists the disputed finding by number");
  assert.deepEqual(n.report.dropped, [2], "and the refuted one by candidate number");
  assert.match(renderNext(n), /report: 0 reported, 1 dropped, 1 disputed/);
  const [item] = inbox([{ ref: REF, state: s }]);
  assert.equal(item.code, "verifiers-disagree");
  assert.equal(item.finding, 1);
  assert.match(item.ask, /^verifiers disagree on finding 1, finding 1 \(.*\); a person decides/);
  assert.throws(() => review.dispose({ finding: 1, as: "fixed", actor: AGENT }), refused(REFUSED, ["disputed"]), "an open dispute is settled first");
  assert.throws(() => review.resolveEscalation({ id: item.escalation, decision: "approve", reason: "real", actor: AGENT }), refused(FORBIDDEN));
  const done = review.resolveEscalation({ id: item.escalation, decision: "approve", reason: "it is real", actor: HUMAN }).state;
  assert.equal(next(done).status, "complete");
  assert.equal(done.escalations[0].resolution.actor, HUMAN);
});

test("a failed run: an agent retries, or only a person accepts the gap, and the report says so", () => {
  const { review, head } = setup({ version: 1, review: { requiredLenses: ["correctness", "tests"] } }, { lenses: ["security"] });
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT });
  review.recordRun({ slot: "security", status: "ok", model: GPT, head, actor: AGENT });
  review.recordRun({ slot: "tests", status: "failed", reason: "model timed out", head, actor: AGENT });
  assert.throws(() => review.advance({ actor: AGENT }), refused(REFUSED, ["run-failed"]));
  assert.deepEqual(inbox([{ ref: REF, state: review.read() }]).map((i) => i.code), ["run-failed"]);
  assert.throws(() => review.acceptGap({ slot: "tests", reason: "skip it", actor: AGENT }), refused(FORBIDDEN));
  review.acceptGap({ slot: "tests", reason: "the tests lens is down today", actor: HUMAN });
  review.advance({ actor: AGENT });
  const s = review.report({ actor: AGENT }).state;
  assert.deepEqual(s.rounds[1].report.coverage, { complete: false, gaps: [{ slot: "tests", reason: "the tests lens is down today", acceptedBy: HUMAN }] });
});

test("retries are predictable: the same run twice is a no-op, a failed slot can be retried, a different result cannot replace a good one", () => {
  const { review, head } = setup({ version: 1 });
  const run = () => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: [finding(1)] });
  assert.equal(run().changed, true);
  assert.equal(run().changed, false);
  assert.equal(review.read().findings.length, 1);
  assert.throws(() => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: [finding(9)] }), refused(REFUSED, ["slot-done"]));
  review.recordRun({ slot: "security", status: "failed", reason: "rate limited", head, actor: AGENT });
  review.recordRun({ slot: "security", status: "ok", model: GPT, head, actor: AGENT });
  review.advance({ actor: AGENT });
  assert.throws(() => review.advance({ actor: AGENT }), refused(REFUSED, ["wrong-state"]), "advancing twice is refused, not repeated");
});

test("resuming: a fresh process reads the same state and the same next step", () => {
  const root = stateRoot();
  const repo = gitRepo({ version: 1 });
  const a = openReview(root, REF);
  a.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT });
  a.recordRun({ slot: "correctness", status: "ok", model: OPUS, head: repo.head, actor: AGENT });
  const b = openReview(root, REF);
  assert.deepEqual(next(b.read()), next(a.read()));
  assert.deepEqual(next(b.read()).action.slots.map((s) => s.slot), ["security"]);
});

test("parallel reviewer processes on different slots all land", async () => {
  const root = stateRoot();
  const repo = gitRepo({ version: 1 });
  const lenses = ["security", "tests", "docs", "api-compat", "data", "taste", "spec-fit"];
  openReview(root, REF).start({ git: repo.adapter, targetRef: "main", head: "feature", lenses, actor: AGENT });
  const slots = ["correctness", ...lenses];
  const fixture = new URL("./fixtures/run-slot.mjs", import.meta.url).pathname;
  const results = await Promise.all(
    slots.map(
      (slot, i) =>
        new Promise((resolve) => {
          const c = spawn("node", [fixture, root, REF.repo, REF.key, slot, i % 2 ? GPT : OPUS, repo.head]);
          let err = "";
          c.stderr.on("data", (d) => (err += d));
          c.on("close", (status) => resolve({ status, err }));
        }),
    ),
  );
  assert.deepEqual(results.filter((r) => r.status !== 0), []);
  const s = openReview(root, REF).read();
  assert.deepEqual(Object.keys(s.rounds[1].runs).sort(), [...slots].sort());
  assert.equal(s.findings.length, slots.length);
  assert.equal(new Set(s.findings.map((f) => f.id)).size, slots.length, "finding IDs stay unique");
});

test("a blocker needs a second verifier from another model when the policy says so", () => {
  const { review, head } = setup({ version: 1, independence: { secondVerifierForBlockers: true, verifier: "model" } });
  happyPanel(review, head);
  const d = (candidate, kind, label, model) => review.decide({ candidate, kind, label, probability: 0.9, rationale: "r", verifier: { model }, head, actor: AGENT });
  d(1, "finding-verification", "confirmed", GPT);
  d(1, "finding-severity", "blocker", GPT);
  d(1, "finding-origin", "introduced", GPT);
  d(1, "finding-triage", "agent-fixable", GPT);
  d(2, "finding-verification", "refuted", OPUS);
  assert.deepEqual(next(review.read()).action.do, "verify-again");
  assert.throws(() => review.report({ actor: AGENT }), refused(REFUSED, ["second-verifier"]));
  d(1, "finding-verification", "confirmed", SONNET);
  assert.equal(next(review.report({ actor: AGENT }).state).status, "complete");
});

test("legacy v1 history alone is not a review under the policy", () => {
  const root = stateRoot();
  const path = legacyV1Path(root, REF);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schema: "scalvert.review/v1", repo: REF.repo, key: REF.key, rounds: [{ round: 1 }], findings: [{ id: "F1", disposition: { as: "fixed" } }] }));
  const review = openReview(root, REF);
  importLegacyV1(review.log, REF, path);
  const n = next(review.read());
  assert.equal(n.status, "not-started");
  assert.match(n.note, /v1 history only/);
  assert.throws(() => review.advance({ actor: AGENT }), refused(REFUSED, ["not-started"]));
  assert.throws(() => review.report({ actor: AGENT }), refused(REFUSED, ["not-started"]));
});

test("an event type this version does not know stops the read", () => {
  const root = stateRoot();
  const review = openReview(root, REF);
  openLog(root, REF).append([{ type: "review.from-the-future", actor: AGENT, data: {} }]);
  assert.throws(() => review.read(), refused(UNKNOWN_EVENT));
});

test("the default plan can complete: enough slots for the family minimum", () => {
  const repo = gitRepo({ version: 1 });
  const review = openReview(stateRoot(), REF);
  const s = review.start({ git: repo.adapter, targetRef: "main", head: "feature", actor: AGENT }).state;
  assert.deepEqual(s.rounds[1].plan.slots.map((x) => x.id), ["correctness", "correctness-2"], "two slots for two families");
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head: repo.head, actor: AGENT });
  review.recordRun({ slot: "correctness-2", status: "ok", model: GPT, head: repo.head, actor: AGENT });
  assert.equal(next(review.advance({ actor: AGENT }).state).action.do, "report");
});

test("changing a decision and changing it back is recorded, not dropped as a repeat", () => {
  const { review, head } = setup({ version: 1 });
  happyPanel(review, head);
  const sev = (label) => review.decide({ candidate: 1, kind: "finding-severity", label, probability: 0.9, rationale: "r", verifier: { model: GPT }, head, actor: AGENT });
  sev("blocker");
  sev("nit");
  assert.equal(sev("blocker").changed, true);
  assert.equal(review.read().findings[0].decisions["finding-severity"].at(-1).label, "blocker");
  assert.equal(sev("blocker").changed, false, "repeating what stands now is a no-op");
});

test("a finding's author cannot rate, triage or place its own finding", () => {
  const { review, head } = setup({ version: 1 });
  happyPanel(review, head);
  for (const [kind, label] of [["finding-severity", "nit"], ["finding-triage", "agent-fixable"], ["finding-origin", "pre-existing"]]) {
    assert.throws(() => review.decide({ candidate: 1, kind, label, probability: 0.9, rationale: "r", verifier: { model: SONNET }, head, actor: AGENT }), refused(REFUSED, ["verifier-not-independent"]), kind);
  }
});

test("a retry with --op-id returns the earlier result, even after the review moved on", () => {
  const { review, head } = setup({ version: 1 });
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, opId: "run-1" });
  review.recordRun({ slot: "security", status: "ok", model: GPT, head, actor: AGENT, opId: "run-2" });
  const first = review.advance({ actor: AGENT, opId: "adv-1" });
  assert.equal(first.changed, true);
  const again = review.advance({ actor: AGENT, opId: "adv-1" });
  assert.equal(again.changed, false, "a lost response can be retried safely");
  assert.deepEqual(again.seqs, first.seqs);
  assert.equal(review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, opId: "run-1" }).changed, false, "a run retried after the review advanced");
  assert.throws(() => review.advance({ actor: AGENT }), refused(REFUSED, ["wrong-state"]), "without an op ID, advancing twice is still refused");
});

test("next asks for the change's classification when merge eligibility is on", () => {
  const policy = { version: 1, actions: { merge: { enabled: true, rules: [{ name: "docs", categories: ["docs"], authors: ["bot"], paths: ["**"] }] } } };
  const { review, head } = setup(policy);
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT });
  review.recordRun({ slot: "security", status: "ok", model: GPT, head, actor: AGENT });
  const n = next(review.advance({ actor: AGENT }).state);
  assert.equal(n.action.do, "classify");
  assert.ok(n.action.categories.includes("deps-patch"));
  review.classify({ category: "docs", probability: 0.9, rationale: "r", classifier: { model: GPT }, head, actor: AGENT });
  assert.equal(next(review.read()).action.do, "report");
});

test("the round cap: an agent is refused past it, a person can go past it, and v1 rounds count", () => {
  const { repo, review } = setup({ version: 1, review: { maxRounds: 2 } });
  const again = (msg, actor = AGENT, pastCap = false) => {
    repo.write("src/a.js", `${msg}\n`);
    repo.commit(msg);
    return review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], pastCap, actor });
  };
  again("two");
  assert.throws(() => again("three"), refused(REFUSED, ["round-cap"]));
  assert.throws(() => again("three-b", AGENT, true), (e) => e.code === "workflow/forbidden", "--past-cap is a person's call");
  const s = again("three-c", HUMAN, true).state;
  assert.equal(s.round, 3);
  assert.equal(s.rounds[3].pastCap, true);
  assert.equal(s.rounds[2].status, "invalidated");

  // A review imported from a v1 ledger with 3 rounds is already at the default cap.
  const root = stateRoot();
  const ref = { repo: "acme/old", key: "1" };
  const v1 = legacyV1Path(root, ref);
  mkdirSync(join(v1, ".."), { recursive: true });
  writeFileSync(v1, JSON.stringify({ schema: "scalvert.review/v1", repo: ref.repo, key: ref.key, rounds: [{ round: 1 }, { round: 2 }, { round: 3 }], findings: [] }));
  const old = openReview(root, ref);
  importLegacyV1(old.log, ref, v1);
  const fresh = gitRepo({ version: 1 });
  assert.throws(() => old.start({ git: fresh.adapter, targetRef: "main", head: "feature", actor: AGENT }), refused(REFUSED, ["round-cap"]));
  assert.equal(next(old.read()).roundsSoFar, 3, "next shows the rounds so far");
});

test("the round cap counts one v1 round per head: v1 retries at the same head are not rounds", () => {
  const root = stateRoot();
  const ref = { repo: "acme/retried", key: "7" };
  const v1 = legacyV1Path(root, ref);
  mkdirSync(join(v1, ".."), { recursive: true });
  // v1 started a round on every run: two reviews of head a, one of head b.
  const rounds = [{ round: 1, head: "a" }, { round: 2, head: "a" }, { round: 3, head: "b" }];
  writeFileSync(v1, JSON.stringify({ schema: "scalvert.review/v1", repo: ref.repo, key: ref.key, rounds, findings: [] }));
  const old = openReview(root, ref);
  importLegacyV1(old.log, ref, v1);
  assert.equal(next(old.read()).roundsSoFar, 2);
  const fresh = gitRepo({ version: 1 });
  const s = old.start({ git: fresh.adapter, targetRef: "main", head: "feature", actor: AGENT }).state;
  assert.equal(s.rounds[1].pastCap, false, "two reviewed heads leave room under the default cap of 3");
  assert.equal(s.legacy[0].rounds, 3, "the imported round count is unchanged");
});

test("a confirmed finding needs a triage before the report", () => {
  const { review, head } = setup({ version: 1 });
  happyPanel(review, head);
  for (const [kind, label] of [["finding-verification", "confirmed"], ["finding-severity", "should-fix"], ["finding-origin", "introduced"]]) {
    review.decide({ candidate: 1, kind, label, probability: 0.9, rationale: "r", verifier: { model: GPT }, head, actor: AGENT });
  }
  review.decide({ candidate: 2, kind: "finding-verification", label: "refuted", probability: 0.1, rationale: "r", verifier: { model: OPUS }, head, actor: AGENT });
  assert.throws(() => review.report({ actor: AGENT }), refused(REFUSED, ["no-triage"]));
  review.decide({ candidate: 1, kind: "finding-triage", label: "agent-fixable", probability: 0.9, rationale: "r", verifier: { model: GPT }, head, actor: AGENT });
  assert.equal(next(review.report({ actor: AGENT }).state).status, "complete");
});

test("the round cap counts new code: a restart because the target's policy changed is not a round", () => {
  const { repo, review } = setup({ version: 1, review: { maxRounds: 2 } });
  repo.write("src/a.js", "two\n");
  repo.commit("two");
  review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT });
  // The policy on main changes; the head does not.
  repo.git("checkout", "-q", "main");
  repo.write("agent-review.json", `${JSON.stringify({ version: 1, review: { maxRounds: 2, minReviewers: 2 } })}\n`);
  repo.commit("stricter policy");
  repo.git("checkout", "-q", "feature");
  const s = review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT }).state;
  assert.equal(s.round, 3);
  assert.equal(s.rounds[3].pastCap, false);
  assert.match(s.rounds[2].invalidated.reason, /policyDigest/);
  // New code after that is past the cap.
  repo.write("src/a.js", "three\n");
  repo.commit("three");
  assert.throws(() => review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT }), refused(REFUSED, ["round-cap"]));
});

test("a finding reported in an earlier round can be disposed in a later one", () => {
  const { repo, review, head } = setup({ version: 1 });
  reportOne(review, head);
  repo.write("src/a.js", "fixed\n");
  repo.commit("fix");
  review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT });
  // Mid-review in round 2, the round-1 finding turns out fixed.
  const s = review.dispose({ finding: 1, as: "fixed", actor: AGENT }).state;
  assert.equal(s.findings.find((f) => f.number === 1).disposition.as, "fixed");
  // Clearing it is still a person's call, and a dropped candidate has no finding number.
  assert.throws(() => review.dispose({ finding: 1, as: "wrong", actor: AGENT }), (e) => e.code === "workflow/forbidden");
  assert.throws(() => review.dispose({ finding: 2, as: "fixed", actor: AGENT }), refused(REFUSED, ["unknown-finding"]));
  assert.throws(() => review.dispose({ finding: "F1", as: "fixed", actor: AGENT }), refused(WORKFLOW_INVALID), "an internal key is not a number");
});

test("findings are numbered in report order when the round reports, and numbers continue across rounds", () => {
  const { repo, review, head } = setup({ version: 1 });
  // Candidate 1 is a nit and candidate 2 a blocker, so the report puts 2 first.
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: [finding(1)] });
  review.recordRun({ slot: "security", status: "ok", model: GPT, head, actor: AGENT, findings: [finding(2)] });
  review.advance({ actor: AGENT });
  const rate = (candidate, severity, model, h = head) => {
    for (const [kind, label] of [["finding-verification", "confirmed"], ["finding-severity", severity], ["finding-origin", "introduced"], ["finding-triage", "agent-fixable"]]) {
      review.decide({ candidate, kind, label, probability: 0.9, rationale: "r", verifier: { model }, head: h, actor: AGENT });
    }
  };
  rate(1, "nit", GPT);
  rate(2, "blocker", OPUS);
  let s = review.report({ actor: AGENT }).state;
  assert.deepEqual(s.findings.map((f) => [f.candidate, f.number]), [[1, 2], [2, 1]], "the blocker is finding 1");
  assert.deepEqual(next(s).report.findings, [{ n: 1, section: "blockers" }, { n: 2, section: "smaller" }]);

  // Round 2: its candidates start again at 1; its findings continue at 3.
  repo.write("src/a.js", "3\n");
  const head2 = repo.commit("more");
  review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT });
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head: head2, actor: AGENT, findings: [finding(3)] });
  review.recordRun({ slot: "security", status: "ok", model: GPT, head: head2, actor: AGENT });
  s = review.advance({ actor: AGENT }).state;
  assert.deepEqual(next(s).action.findings.map((f) => f.candidate), [1]);
  rate(1, "should-fix", GPT, head2);
  s = review.report({ actor: AGENT }).state;
  assert.deepEqual(s.findings.map((f) => [f.round, f.candidate, f.number]), [[1, 1, 2], [1, 2, 1], [2, 1, 3]], "earlier numbers do not change");
  assert.equal(review.dispose({ finding: 1, as: "fixed", actor: AGENT }).changed, true, "finding 1 is still the round-1 blocker");
});

test("a log from before 0.3, without candidate or finding numbers, is numbered the same way", () => {
  const root = stateRoot();
  const repo = gitRepo({ version: 1 });
  const review = openReview(root, REF);
  review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT });
  const s = reportOne(review, repo.head, "blocker");
  const old = openLog(root, REF).read().events.map((e) => {
    const data = structuredClone(e.data);
    if (e.type === "finding.added") delete data.candidate;
    if (e.type === "review.reported") delete data.report.numbers;
    return { ...e, data };
  });
  const rebuilt = old.reduce((state, e) => reduce(state, e), initialState());
  assert.deepEqual(rebuilt.findings.map((f) => [f.candidate, f.number]), s.findings.map((f) => [f.candidate, f.number]));
  assert.deepEqual(rebuilt.rounds[1].report.numbers, s.rounds[1].report.numbers);
});

test("a dispute raised by 0.2, whose message names a key, is shown with the finding's number", () => {
  const root = stateRoot();
  const repo = gitRepo({ version: 1, independence: { verifier: "model" } });
  const review = openReview(root, REF);
  review.start({ git: repo.adapter, targetRef: "main", head: "feature", lenses: ["security"], actor: AGENT });
  happyPanel(review, repo.head);
  const v = (candidate, model, label) => review.decide({ candidate, kind: "finding-verification", label, probability: label === "confirmed" ? 0.9 : 0.2, rationale: "r", verifier: { model }, head: repo.head, actor: AGENT });
  v(1, GPT, "refuted");
  v(2, OPUS, "confirmed");
  v(2, SONNET, "refuted");
  for (const kind of ["finding-severity", "finding-origin"]) review.decide({ candidate: 2, kind, label: kind === "finding-severity" ? "should-fix" : "introduced", probability: 0.8, rationale: "r", verifier: { model: OPUS }, head: repo.head, actor: AGENT });
  review.report({ actor: AGENT });
  // The log as 0.2 wrote it: no numbers, and the message 0.2 wrote.
  const old = openLog(root, REF).read().events.map((e) => {
    const data = structuredClone(e.data);
    if (e.type === "finding.added") delete data.candidate;
    if (e.type === "review.reported") delete data.report.numbers;
    if (e.type === "escalation.raised") data.message = `verifiers disagree on ${data.finding} (${OPUS}: confirmed, ${SONNET}: refuted); a person decides whether it is real`;
    return { ...e, data };
  });
  assert.ok(old.some((e) => e.type === "escalation.raised" && /\bF2\b/.test(e.data.message)), "the 0.2 message names the key");
  const s = old.reduce((state, e) => reduce(state, e), initialState());
  const key = /\bF[0-9]+\b/;
  const [item] = inbox([{ ref: REF, state: s }]);
  assert.match(item.ask, /^verifiers disagree on finding 1 \(/, "the disputed finding is the round's first number");
  for (const out of [next(s), publicState(s), inbox([{ ref: REF, state: s }])]) assert.doesNotMatch(JSON.stringify(out), key);
  assert.doesNotMatch(renderNext(next(s)), key);
});

test("no output names a finding by its internal key", () => {
  const { review, head } = setup({ version: 1, independence: { verifier: "model" } });
  happyPanel(review, head);
  const key = /\bF[0-9]+\b/;
  assert.doesNotMatch(JSON.stringify(next(review.read())), key, "verifying");
  review.merge({ into: 1, duplicates: [2], actor: AGENT });
  const v = (label, model) => review.decide({ candidate: 1, kind: "finding-verification", label, probability: 0.9, rationale: "r", verifier: { model }, head, actor: AGENT });
  v("confirmed", GPT);
  v("refuted", SONNET);
  for (const kind of ["finding-severity", "finding-origin"]) review.decide({ candidate: 1, kind, label: kind === "finding-severity" ? "blocker" : "introduced", probability: 0.9, rationale: "r", verifier: { model: GPT }, head, actor: AGENT });
  const s = review.report({ actor: AGENT }).state;
  for (const out of [next(s), publicState(s), inbox([{ ref: REF, state: s }])]) assert.doesNotMatch(JSON.stringify(out), key);
  assert.equal(publicState(s).findings[1].duplicateOf, 1, "a duplicate points at its primary's candidate number");
  const refusal = (() => {
    try {
      review.dispose({ finding: 1, as: "fixed", actor: AGENT });
    } catch (e) {
      return e;
    }
  })();
  assert.doesNotMatch(JSON.stringify({ message: refusal.message, reasons: refusal.reasons }), key);
});

test("sparse lists and URLs that are not https URLs are refused before anything is written", () => {
  const { review, head } = setup({ version: 1 });
  const sparse = new Array(2);
  sparse[0] = { file: "src/b.js", line: 2 };
  assert.throws(() => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: [finding(1, { instances: sparse })] }), refused(REFUSED, ["finding-field"]));
  assert.throws(() => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: [finding(1, { instances: [{ file: "   " }] })] }), refused(REFUSED, ["finding-field"]));
  const holes = new Array(1);
  assert.throws(() => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: holes }), (e) => e.code === WORKFLOW_INVALID);
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: [finding(1)] });
  for (const url of ["https://", "https://a b", "http://example.com", new URL("https://example.com/x")]) {
    assert.throws(() => review.link({ finding: 1, thread: "T1", url, actor: AGENT }), (e) => e.code === WORKFLOW_INVALID, String(url));
  }
});

test("findings keep their class, instances and axiom, and bad shapes are refused", () => {
  const { review, head } = setup({ version: 1 });
  assert.throws(
    () => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: [finding(1, { class: "Missing Await", instances: [{ line: 3 }] })] }),
    refused(REFUSED, ["finding-field", "finding-field"]),
  );
  review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: AGENT, findings: [finding(1, { class: "missing-await", instances: [{ file: "src/b.js", line: 9 }, { file: "src/c.js" }], axiom: "T3" })] });
  const [f] = review.read().findings;
  assert.equal(f.class, "missing-await");
  assert.deepEqual(f.instances, [{ file: "src/b.js", line: 9 }, { file: "src/c.js", line: null }]);
  assert.equal(f.axiom, "T3");
  assert.equal(f.thread, null);
});

test("a finding can be linked to the host's review thread, by finding number", () => {
  const { review, head } = setup({ version: 1 });
  happyPanel(review, head);
  assert.throws(() => review.link({ finding: 1, thread: "PRRT_1", actor: AGENT }), refused(REFUSED, ["unknown-finding"]), "nothing is numbered before the report");
  review.decide({ candidate: 2, kind: "finding-verification", label: "refuted", probability: 0.1, rationale: "r", verifier: { model: OPUS }, head, actor: AGENT });
  for (const [kind, label] of [["finding-verification", "confirmed"], ["finding-severity", "nit"], ["finding-origin", "introduced"], ["finding-triage", "agent-fixable"]]) {
    review.decide({ candidate: 1, kind, label, probability: 0.9, rationale: "r", verifier: { model: GPT }, head, actor: AGENT });
  }
  review.report({ actor: AGENT });
  assert.throws(() => review.link({ finding: 9, thread: "PRRT_1", actor: AGENT }), refused(REFUSED, ["unknown-finding"]));
  assert.throws(() => review.link({ finding: 1, thread: "PRRT_1", url: "http://x", actor: AGENT }), (e) => e.code === WORKFLOW_INVALID);
  review.link({ finding: 1, thread: "PRRT_1", url: "https://github.com/acme/widgets/pull/7#discussion_r1", actor: AGENT });
  assert.equal(review.link({ finding: 1, thread: "PRRT_1", url: "https://github.com/acme/widgets/pull/7#discussion_r1", actor: AGENT }).changed, false);
  const f = review.read().findings.find((x) => x.number === 1);
  assert.deepEqual([f.thread.id, f.thread.url], ["PRRT_1", "https://github.com/acme/widgets/pull/7#discussion_r1"]);
});

test("actors are required and must say whether they are a person or an agent", () => {
  const { review, head } = setup({ version: 1 });
  assert.throws(() => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head }), refused(WORKFLOW_INVALID));
  assert.throws(() => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: "steve" }), refused(WORKFLOW_INVALID));
});
