// Strict validation of a version 1 policy. Unknown keys, wrong types and
// out-of-range values are all errors, each with the path to the bad value.
// Validation never fills in defaults; resolve() does that afterwards.
import { checkGlob } from "../glob.mjs";
import { CATEGORIES, DEPTHS, VERIFIER_INDEPENDENCE } from "./defaults.mjs";

const NAME = /^[a-z][a-z0-9-]*$/;
const FINDING_FIELDS = ["file", "line", "precondition", "scenario", "evidence"];
const DECISION_FIELDS = ["rationale"];

const t = {
  object: (fields) => ({ kind: "object", fields }),
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
      enabled: t.literal(false, "merge actions are not supported by this version of the harness"),
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
  return errors;
}

// The setting names, by section, for docs and for the JSON Schema test.
export function v1Keys(spec = V1) {
  return Object.fromEntries(Object.entries(spec.fields).map(([k, s]) => [k, s.kind === "object" ? v1Keys(s) : s.kind]));
}
