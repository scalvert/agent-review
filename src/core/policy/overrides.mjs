// Per-run overrides, such as command-line flags, on top of the trusted
// policy. An override may make a review stricter, never weaker. A weakening
// override is an error that names each setting, not something quietly
// ignored.
import { digestOf } from "../digest.mjs";
import { DEPTHS, VERIFIER_INDEPENDENCE } from "./defaults.mjs";
import { INVALID, PolicyError, WEAKENING } from "./load.mjs";
import { validateV1 } from "./validate.mjs";

const rank = (order) => (v) => order.indexOf(v);

// How each setting may change. "any" settings are defaults, not limits.
const RULES = {
  "review.defaultDepth": { kind: "any" },
  "review.minDepth": { kind: "atLeast", rank: rank(DEPTHS) },
  "review.deepPaths": { kind: "addOnly" },
  "review.requiredLenses": { kind: "addOnly" },
  "review.minReviewers": { kind: "atLeast", rank: (n) => n },
  // A run may lower the cap, never raise it: going past it is a person's call.
  "review.maxRounds": { kind: "atMost", rank: (n) => n },
  "independence.minFamilies": { kind: "atLeast", rank: (n) => n },
  "independence.verifier": { kind: "atLeast", rank: rank(VERIFIER_INDEPENDENCE) },
  "independence.secondVerifierForBlockers": { kind: "atLeast", rank: (b) => (b ? 1 : 0) },
  "evidence.finding": { kind: "addOnly" },
  "evidence.decision": { kind: "addOnly" },
  // Reporting more findings is stricter, so the report bar may only drop.
  "thresholds.report": { kind: "atMost", rank: (n) => n },
  // Sending more classifications to a person is stricter.
  "thresholds.classify": { kind: "atLeast", rank: (n) => n },
  "escalation.paths": { kind: "addOnly" },
  "escalation.categories": { kind: "addOnly" },
  "actions.post": { kind: "atMost", rank: (b) => (b ? 1 : 0) },
  "actions.merge.enabled": { kind: "atMost", rank: (b) => (b ? 1 : 0) },
  "actions.merge.disqualifying": { kind: "addOnly" },
  // actions.merge.rules has no entry: rules come only from the trusted policy.
};

function leaves(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? leaves(v, path) : [[path, v]];
  });
}

const get = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
function set(obj, path, value) {
  const keys = path.split(".");
  keys.slice(0, -1).reduce((o, k) => (o[k] ??= {}), obj)[keys.at(-1)] = value;
}

export function applyOverrides(resolved, overrides, { source = "flags" } = {}) {
  if (!overrides || Object.keys(overrides).length === 0) return { ...resolved, overrides: [] };
  if ("version" in overrides) throw new PolicyError(INVALID, `${source}: overrides cannot set version`);
  const errors = validateV1(overrides).map((e) => ({ ...e, path: e.path === "(root)" ? source : e.path }));
  if (errors.length) throw new PolicyError(INVALID, `${source}: invalid overrides`, errors);

  const policy = structuredClone(resolved.policy);
  const applied = [];
  const weakening = [];
  for (const [path, value] of leaves(overrides)) {
    const rule = RULES[path];
    const before = get(policy, path);
    if (!rule) {
      weakening.push({ path, message: "cannot be overridden" });
      continue;
    }
    let after = value;
    if (rule.kind === "addOnly") after = [...before, ...value.filter((v) => !before.includes(v))];
    else if (rule.kind === "atLeast" && rule.rank(value) < rule.rank(before)) {
      weakening.push({ path, message: `cannot go from ${JSON.stringify(before)} to ${JSON.stringify(value)}: an override may only make the review stricter` });
      continue;
    } else if (rule.kind === "atMost" && rule.rank(value) > rule.rank(before)) {
      weakening.push({ path, message: `cannot go from ${JSON.stringify(before)} to ${JSON.stringify(value)}: an override may only make the review stricter` });
      continue;
    }
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      set(policy, path, after);
      applied.push({ path, from: before, to: after, source });
    }
  }
  if (weakening.length) throw new PolicyError(WEAKENING, `${source}: these overrides would weaken the trusted policy, so none were applied`, weakening);
  return { ...resolved, policy, effectiveDigest: digestOf(policy), overrides: applied };
}
