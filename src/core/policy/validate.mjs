// Strict validation of a version 1 policy. Unknown keys, wrong types and
// out-of-range values are all errors, each with the path to the bad value.
// Validation never fills in defaults; resolve() does that afterwards.
import { checkGlob } from "../glob.mjs";
import { CATEGORIES, DEPTHS, VERIFIER_INDEPENDENCE } from "./defaults.mjs";

const NAME = /^[a-z][a-z0-9-]*$/;
const FINDING_FIELDS = ["file", "line", "precondition", "scenario", "evidence"];
const DECISION_FIELDS = ["rationale"];

const t = {
  object: (fields, { required = [] } = {}) => ({ kind: "object", fields, required }),
  login: () => ({ kind: "login" }),
  enumOf: (values, { nullable = false } = {}) => ({ kind: "enum", values, nullable }),
  int: (min, max) => ({ kind: "int", min, max }),
  prob: () => ({ kind: "prob" }),
  bool: () => ({ kind: "bool" }),
  list: (item, { unique = true } = {}) => ({ kind: "list", item, unique }),
  name: () => ({ kind: "name" }),
  glob: () => ({ kind: "glob" }),
  literal: (value, why) => ({ kind: "literal", value, why }),
};

export const V1 = t.object({
  // For editors; the harness ignores its value.
  $schema: { kind: "string" },
  version: t.literal(1),
  review: t.object({
    defaultDepth: t.enumOf(DEPTHS, { nullable: true }),
    minDepth: t.enumOf(DEPTHS),
    deepPaths: t.list(t.glob()),
    requiredLenses: t.list(t.name()),
    minReviewers: t.int(1, 20),
    maxRounds: t.int(1, 20),
  }),
  independence: t.object({
    minFamilies: t.int(1, 5),
    verifier: t.enumOf(VERIFIER_INDEPENDENCE),
    secondVerifierForBlockers: t.bool(),
  }),
  evidence: t.object({
    finding: t.list(t.enumOf(FINDING_FIELDS)),
    decision: t.list(t.enumOf(DECISION_FIELDS)),
  }),
  thresholds: t.object({
    report: t.prob(),
    classify: t.prob(),
  }),
  escalation: t.object({
    paths: t.list(t.glob()),
    categories: t.list(t.enumOf(CATEGORIES)),
  }),
  actions: t.object({
    post: t.bool(),
    merge: t.object({
      // Lets the harness decide merge eligibility. Nothing merges unless a
      // merge executor is also configured, and none ships with the harness.
      enabled: t.bool(),
      // Reported findings at these severities block a merge until disposed.
      disqualifying: t.list(t.enumOf(["blocker", "should-fix", "nit"])),
      rules: t.list(
        t.object(
          {
            name: t.name(),
            // The change must be classified as one of these.
            categories: t.list(t.enumOf(CATEGORIES)),
            // The pull request's author must be one of these accounts.
            authors: t.list(t.login()),
            // Every commit must carry a signature the host verified.
            requireVerifiedCommits: t.bool(),
            // Every changed path must match one of these.
            paths: t.list(t.glob()),
            // "patch": every dependency change must be a semver patch bump.
            dependencies: t.enumOf(["patch"], { nullable: true }),
            minApprovals: t.int(0, 10),
          },
          { required: ["name", "categories", "authors", "paths"] },
        ),
        { unique: false },
      ),
    }),
  }),
});

const show = (v) => JSON.stringify(v);
const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function check(spec, value, path, errors) {
  const at = path || "(root)";
  switch (spec.kind) {
    case "object": {
      if (kindOf(value) !== "object") return errors.push({ path: at, message: `must be an object, got ${kindOf(value)}` });
      for (const key of Object.keys(value)) {
        const sub = path ? `${path}.${key}` : key;
        if (!(key in spec.fields)) errors.push({ path: sub, message: `is not a known setting; known: ${Object.keys(spec.fields).join(", ")}` });
        else check(spec.fields[key], value[key], sub, errors);
      }
      for (const key of spec.required ?? []) {
        if (!(key in value)) errors.push({ path: path ? `${path}.${key}` : key, message: "is required" });
        else if (Array.isArray(value[key]) && value[key].length === 0) errors.push({ path: path ? `${path}.${key}` : key, message: "must not be empty" });
      }
      return;
    }
    case "enum":
      if (value === null && spec.nullable) return;
      if (!spec.values.includes(value)) errors.push({ path: at, message: `must be one of ${spec.values.join(", ")}${spec.nullable ? " or null" : ""}, got ${show(value)}` });
      return;
    case "int":
      if (!Number.isInteger(value) || value < spec.min || value > spec.max) errors.push({ path: at, message: `must be a whole number from ${spec.min} to ${spec.max}, got ${show(value)}` });
      return;
    case "prob":
      if (typeof value !== "number" || !(value >= 0 && value <= 1)) errors.push({ path: at, message: `must be a number from 0 to 1, got ${show(value)}` });
      return;
    case "string":
      if (typeof value !== "string") errors.push({ path: at, message: `must be a string, got ${kindOf(value)}` });
      return;
    case "bool":
      if (typeof value !== "boolean") errors.push({ path: at, message: `must be true or false, got ${show(value)}` });
      return;
    case "login":
      if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/.test(value)) errors.push({ path: at, message: `must be an account name such as "dependabot[bot]", got ${show(value)}` });
      return;
    case "name":
      if (typeof value !== "string" || !NAME.test(value)) errors.push({ path: at, message: `must be a lowercase name such as "security", got ${show(value)}` });
      return;
    case "glob": {
      const why = checkGlob(value);
      if (why) errors.push({ path: at, message: `${why}, got ${show(value)}` });
      return;
    }
    case "literal":
      if (value !== spec.value) errors.push({ path: at, message: spec.why ? `${spec.why}; it must be ${show(spec.value)}` : `must be ${show(spec.value)}, got ${show(value)}` });
      return;
    case "list": {
      if (!Array.isArray(value)) return errors.push({ path: at, message: `must be a list, got ${kindOf(value)}` });
      value.forEach((item, i) => check(spec.item, item, `${at}[${i}]`, errors));
      if (spec.unique) {
        const seen = new Set();
        value.forEach((item, i) => {
          const k = show(item);
          if (seen.has(k)) errors.push({ path: `${at}[${i}]`, message: `repeats ${k}` });
          seen.add(k);
        });
      }
      return;
    }
  }
}

export function validateV1(value) {
  const errors = [];
  check(V1, value, "", errors);
  // Merge eligibility with no rule would have nothing to match.
  const merge = value?.actions?.merge;
  if (merge?.enabled === true && !(Array.isArray(merge.rules) && merge.rules.length)) {
    errors.push({ path: "actions.merge.rules", message: "is required when actions.merge.enabled is true" });
  }
  const names = (merge?.rules ?? []).map((r) => r?.name);
  names.forEach((n, i) => {
    if (n && names.indexOf(n) !== i) errors.push({ path: `actions.merge.rules[${i}].name`, message: `repeats ${show(n)}` });
  });
  return errors;
}

// The setting names, by section, for docs and for the JSON Schema test.
export function v1Keys(spec = V1) {
  return Object.fromEntries(Object.entries(spec.fields).map(([k, s]) => [k, s.kind === "object" ? v1Keys(s) : s.kind]));
}
