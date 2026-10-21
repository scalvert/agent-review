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
} from "../src/index.mjs";
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
  assert.deepEqual(next(review.read()).action.findings.map((f) => [f.finding, f.verifierMust]), [
    ["F1", { notFamily: "anthropic" }],
    ["F2", { notFamily: "openai" }],
  ]);
  review.decide({ finding: "F1", kind: "finding-verification", label: "confirmed", probability: 0.9, rationale: "reproduced", verifier: { model: GPT }, head, actor: AGENT });
  review.decide({ finding: "F2", kind: "finding-verification", label: "refuted", probability: 0.2, rationale: "guarded at a.js:3", verifier: { model: OPUS }, head, actor: AGENT });
  assert.deepEqual(next(review.read()).action, { do: "classify", findings: [{ finding: "F1", kinds: ["finding-severity", "finding-origin", "finding-triage"] }] });
  for (const [kind, label] of [["finding-severity", "should-fix"], ["finding-origin", "introduced"], ["finding-triage", "agent-fixable"]]) {
    review.decide({ finding: "F1", kind, label, probability: 0.8, rationale: "r", verifier: { model: GPT }, head, actor: AGENT });
  }
  assert.equal(next(review.read()).action.do, "report");
  const done = review.report({ actor: AGENT }).state;
  const n = next(done);
  assert.equal(n.status, "complete");
  assert.deepEqual(n.report.reported, ["F1"]);
  assert.deepEqual(n.report.dropped, ["F2"]);
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
  const verify = (model, extra = {}) => review.decide({ finding: "F1", kind: "finding-verification", label: "confirmed", probability: 0.9, rationale: "r", verifier: { model, ...extra }, head, actor: AGENT });
  assert.throws(() => verify(OPUS), refused(REFUSED, ["verifier-not-independent"]), "the author verifying itself");
  assert.throws(() => verify(SONNET), refused(REFUSED, ["verifier-not-independent"]), "the author's family");
  assert.throws(() => verify("gateway/claude-x", { family: "anthropic" }), refused(REFUSED, ["verifier-not-independent"]), "a declared family counts");
  assert.equal(verify(GPT).changed, true);
  assert.equal(verify(GPT).changed, false, "the same decision again is a no-op");
  assert.throws(
    () => review.decide({ finding: "F1", kind: "finding-verification", label: "refuted", probability: 0.4, rationale: "x", verifier: { model: GPT }, head, actor: AGENT }),
    refused(REFUSED, ["verifier-repeated"]),
    "one model cannot verify the same finding twice with a different answer",
  );

  const model = setup({ version: 1, independence: { verifier: "model" } });
  happyPanel(model.review, model.head);
  model.review.decide({ finding: "F1", kind: "finding-verification", label: "confirmed", probability: 0.9, rationale: "r", verifier: { model: SONNET }, head: model.head, actor: AGENT });
});

test("decisions without the required rationale are refused", () => {
  const { review, head } = setup({ version: 1 });
  happyPanel(review, head);
  assert.throws(() => review.decide({ finding: "F1", kind: "finding-verification", label: "confirmed", probability: 0.9, rationale: " ", verifier: { model: GPT }, head, actor: AGENT }), refused(REFUSED, ["decision-field"]));
  assert.throws(() => review.decide({ finding: "F1", kind: "finding-verification", label: "maybe", probability: 0.9, rationale: "r", verifier: { model: GPT }, head, actor: AGENT }), refused(WORKFLOW_INVALID));
});

test("steps out of order are refused with the reason", () => {
  const { review, head } = setup({ version: 1 });
  assert.throws(() => review.decide({ finding: "F1", kind: "finding-verification", label: "confirmed", probability: 0.9, rationale: "r", verifier: { model: GPT }, head, actor: AGENT }), refused(REFUSED, ["wrong-state"]));
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
  const v = (finding, model, label, p = 0.9) => review.decide({ finding, kind: "finding-verification", label, probability: p, rationale: "r", verifier: { model }, head, actor: AGENT });
  v("F1", GPT, "confirmed");
  v("F1", SONNET, "refuted", 0.3);
  v("F2", OPUS, "refuted", 0.2);
  const s = review.report({ actor: AGENT }).state;
  const n = next(s);
  assert.equal(n.status, "reported");
  assert.equal(n.waitingOn, "human");
  assert.deepEqual(s.rounds[1].report.escalated, ["F1"]);
  const [item] = inbox([{ ref: REF, state: s }]);
  assert.equal(item.code, "verifiers-disagree");
  assert.match(item.ask, /a person decides/);
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
  const d = (finding, kind, label, model) => review.decide({ finding, kind, label, probability: 0.9, rationale: "r", verifier: { model }, head, actor: AGENT });
  d("F1", "finding-verification", "confirmed", GPT);
  d("F1", "finding-severity", "blocker", GPT);
  d("F1", "finding-origin", "introduced", GPT);
  d("F1", "finding-triage", "agent-fixable", GPT);
  d("F2", "finding-verification", "refuted", OPUS);
  assert.deepEqual(next(review.read()).action.do, "verify-again");
  assert.throws(() => review.report({ actor: AGENT }), refused(REFUSED, ["second-verifier"]));
  d("F1", "finding-verification", "confirmed", SONNET);
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

test("actors are required and must say whether they are a person or an agent", () => {
  const { review, head } = setup({ version: 1 });
  assert.throws(() => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head }), refused(WORKFLOW_INVALID));
  assert.throws(() => review.recordRun({ slot: "correctness", status: "ok", model: OPUS, head, actor: "steve" }), refused(WORKFLOW_INVALID));
});
