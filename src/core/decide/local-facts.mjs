// Facts from the local repository for an eligibility check: the merge base
// between the target's tip and the head, and the trusted policy's digest
// now, with the same overrides the round started with. If the target's
// policy file changed, the digest changes, and the check blocks.
import { applyOverrides } from "../policy/overrides.mjs";
import { trustedPolicy } from "../policy/trust.mjs";

function overridesOf(round) {
  const out = {};
  for (const { path, to } of round.policy.overrides ?? []) {
    const keys = path.split(".");
    keys.slice(0, -1).reduce((o, k) => (o[k] ??= {}), out)[keys.at(-1)] = to;
  }
  return out;
}

export function localFacts({ git, round, targetRef, head }) {
  const tp = trustedPolicy({ git, targetRef, head });
  const resolved = applyOverrides(tp.trusted, overridesOf(round), { source: "round overrides" });
  return {
    target: tp.target,
    head: tp.head,
    mergeBase: git.mergeBase(tp.target.commit, tp.head),
    policyDigest: resolved.effectiveDigest,
  };
}
