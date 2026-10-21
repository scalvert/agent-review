// The boundary between deciding a merge and doing one.
//
// prepareMerge takes an eligibility result and, at action time, computes it
// again from fresh facts. If the outcome is no longer eligible, or the head,
// merge base, policy, checks, approvals or matched rule differ from what was
// decided, it refuses: a decision is never used on inputs it did not see.
// Only then does it call an executor, which must merge exactly the head that
// was reviewed (for example with the host's expected-SHA parameter).
//
// The harness ships only a dry-run executor. Nothing in this repository
// performs a merge.
import { WorkflowError, REFUSED } from "../workflow/errors.mjs";
import { ELIGIBLE } from "./eligibility.mjs";

export const dryRunExecutor = Object.freeze({
  name: "dry-run",
  dryRun: true,
  merge: ({ repo, number, sha }) => ({ merged: false, dryRun: true, wouldMerge: { repo, number, sha } }),
});

const KEYS = [
  ["head", (p) => p.observed.head],
  ["merge base", (p) => p.observed.mergeBase],
  ["policy", (p) => p.observed.policyDigest],
  ["checks", (p) => p.observed.checks],
  ["approvals", (p) => JSON.stringify(p.observed.approvals)],
  ["matched rule", (p) => p.rule],
  ["facts source", (p) => p.factsSource],
];

export function prepareMerge({ eligibility, recheck, executor = dryRunExecutor, repo, number }) {
  const why = (code, message, extra = {}) => ({ code, message, ...extra });
  if (eligibility.outcome !== ELIGIBLE) {
    throw new WorkflowError(REFUSED, "the change is not eligible to merge", [why("not-eligible", `the decision was ${eligibility.outcome}`), ...eligibility.reasons]);
  }
  if (!executor?.dryRun) {
    throw new WorkflowError(REFUSED, "no merge executor is available", [why("no-executor", "this harness performs dry runs only")]);
  }
  const fresh = recheck();
  const changed = KEYS.filter(([, get]) => get(fresh.provenance) !== get(eligibility.provenance)).map(([name]) => name);
  if (fresh.outcome !== ELIGIBLE || changed.length) {
    throw new WorkflowError(REFUSED, "the eligibility decision is stale", [
      ...changed.map((name) => why("stale-eligibility", `the ${name} changed after eligibility was decided`)),
      ...(fresh.outcome !== ELIGIBLE ? [why("no-longer-eligible", `a fresh check says ${fresh.outcome}`), ...fresh.reasons] : []),
    ]);
  }
  // Facts the harness did not fetch itself make this a simulation, and the
  // result says so.
  const simulated = fresh.provenance.factsSource !== "github";
  return { executor: executor.name, simulated, decidedOn: eligibility.provenance, recheckedOn: fresh.provenance, result: executor.merge({ repo, number, sha: fresh.provenance.observed.head }) };
}
