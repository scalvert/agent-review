import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_POLICY,
  NOT_JSON,
  NO_VERSION,
  POLICY_INVALID,
  UNSUPPORTED_VERSION,
  WEAKENING,
  applyOverrides,
  defaultPolicy,
  matchPaths,
  parsePolicy,
  resolveDepth,
  sha256,
  v1Keys,
} from "../src/index.mjs";

const parse = (obj) => parsePolicy(JSON.stringify(obj));
const fails = (code, paths) => (e) => {
  assert.equal(e.code, code, e.message);
  if (paths) assert.deepEqual(e.errors.map((x) => x.path), paths);
  return true;
};

test("a minimal policy is version 1 with every default filled in", () => {
  const p = parse({ version: 1 });
  assert.deepEqual(p.policy, DEFAULT_POLICY);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.source.digest, sha256('{"version":1}'));
});

test("settings fill in section by section, and a list replaces the default", () => {
  const p = parse({ version: 1, review: { deepPaths: ["src/auth/**"] }, escalation: { categories: ["policy"] } });
  assert.deepEqual(p.policy.review.deepPaths, ["src/auth/**"]);
  assert.equal(p.policy.review.minReviewers, DEFAULT_POLICY.review.minReviewers);
  assert.deepEqual(p.policy.escalation.categories, ["policy"]);
  assert.deepEqual(p.policy.escalation.paths, DEFAULT_POLICY.escalation.paths);
});

test("fail closed: not JSON, no version, unsupported versions", () => {
  assert.throws(() => parsePolicy("{ version: 1 }"), fails(NOT_JSON));
  assert.throws(() => parse({ review: { minReviewers: 2 } }), fails(NO_VERSION), "a versionless file that is not the old format");
  assert.throws(() => parse([]), fails(NO_VERSION));
  assert.throws(() => parse({ version: 2 }), fails(UNSUPPORTED_VERSION));
  assert.throws(() => parse({ version: "1" }), fails(UNSUPPORTED_VERSION));
  assert.throws(() => parse({ version: 0 }), fails(UNSUPPORTED_VERSION));
});

test("fail closed: every invalid setting is reported, with its path", () => {
  assert.throws(
    () =>
      parse({
        version: 1,
        reviews: {},
        review: { minDepth: "thorough", deepPaths: ["/etc/**", "a", "a"], requiredLenses: ["Security"], minReviewers: 0 },
        independence: { minFamilies: 1.5, verifier: "author", secondVerifierForBlockers: "yes" },
        evidence: { finding: ["vibes"] },
        thresholds: { report: 1.2, classify: "high" },
        escalation: { paths: [""], categories: ["urgent"] },
        actions: { post: "no", merge: { enabled: true }, deploy: true },
      }),
    fails(POLICY_INVALID, [
      "reviews",
      "review.minDepth",
      "review.deepPaths[0]",
      "review.deepPaths[2]",
      "review.requiredLenses[0]",
      "review.minReviewers",
      "independence.minFamilies",
      "independence.verifier",
      "independence.secondVerifierForBlockers",
      "evidence.finding[0]",
      "thresholds.report",
      "thresholds.classify",
      "escalation.paths[0]",
      "escalation.categories[0]",
      "actions.post",
      "actions.deploy",
      "actions.merge.rules",
    ]),
  );
});

test("turning merge eligibility on needs at least one rule", () => {
  assert.throws(() => parse({ version: 1, actions: { merge: { enabled: true } } }), (e) => e.code === POLICY_INVALID && e.errors[0].path === "actions.merge.rules" && /is required/.test(e.errors[0].message));
  assert.throws(() => parse({ version: 1, actions: { merge: { rules: [{ name: "a", categories: ["docs"], authors: ["x"], paths: ["*"] }, { name: "a", categories: ["docs"], authors: ["x"], paths: ["*"] }] } } }), (e) => e.errors[0].path === "actions.merge.rules[1].name");
});

test("the old unversioned file reads as version 1, with a warning that says how to update it", () => {
  const p = parse({ review: { depth: "deep", deepPaths: ["src/auth/**"] } });
  assert.equal(p.policy.review.defaultDepth, "deep");
  assert.deepEqual(p.policy.review.deepPaths, ["src/auth/**"]);
  assert.equal(p.warnings[0].code, "policy/version-0");
  assert.match(p.warnings[0].message, /add "version": 1/);
  assert.throws(() => parse({ review: { depth: "thorough" } }), fails(POLICY_INVALID, ["review.defaultDepth"]), "and is validated like version 1");
});

test("digests: the source digest is of the bytes, the effective digest of the resolved policy", () => {
  const a = parsePolicy('{"version":1,"review":{"minReviewers":2}}');
  const b = parsePolicy('{ "review": { "minReviewers": 2 }, "version": 1 }');
  assert.notEqual(a.source.digest, b.source.digest);
  assert.equal(a.effectiveDigest, b.effectiveDigest);
  assert.notEqual(a.effectiveDigest, defaultPolicy().effectiveDigest);
});

test("overrides may only tighten; each weakening is named and none is applied", () => {
  const base = parse({ version: 1, review: { minDepth: "standard", deepPaths: ["src/auth/**"], minReviewers: 2 }, actions: { post: true } });
  const tighter = applyOverrides(base, {
    review: { minDepth: "deep", deepPaths: ["infra/**"], minReviewers: 3, defaultDepth: "quick" },
    independence: { verifier: "family", secondVerifierForBlockers: true },
    thresholds: { report: 0.5, classify: 0.9 },
    actions: { post: false },
  });
  assert.equal(tighter.policy.review.minDepth, "deep");
  assert.deepEqual(tighter.policy.review.deepPaths, ["src/auth/**", "infra/**"], "lists only grow");
  assert.equal(tighter.policy.actions.post, false);
  assert.equal(tighter.policy.review.defaultDepth, "quick", "defaultDepth is a default, not a limit");
  assert.notEqual(tighter.effectiveDigest, base.effectiveDigest);
  assert.ok(tighter.overrides.every((o) => o.source === "flags"));

  assert.throws(
    () =>
      applyOverrides(base, {
        review: { minDepth: "quick", minReviewers: 1 },
        independence: { minFamilies: 1, verifier: "model" },
        thresholds: { report: 0.9, classify: 0.5 },
      }),
    fails(WEAKENING, ["review.minDepth", "review.minReviewers", "independence.minFamilies", "independence.verifier", "thresholds.report", "thresholds.classify"]),
  );
  const offPost = parse({ version: 1 });
  assert.throws(() => applyOverrides(offPost, { actions: { post: true } }), fails(WEAKENING, ["actions.post"]));
  assert.throws(() => applyOverrides(base, { version: 1 }), fails(POLICY_INVALID));
  assert.throws(() => applyOverrides(base, { review: { minDepth: "max" } }), fails(POLICY_INVALID, ["review.minDepth"]));
});

test("depth: flag, then policy default, then user default, then the suggestion; floors only raise", () => {
  const p = (review) => parse({ version: 1, review }).policy;
  assert.deepEqual(resolveDepth(p({}), { suggested: "quick" }), { depth: "quick", chosen: "quick", source: "suggested from the diff", raisedBy: [] });
  assert.equal(resolveDepth(p({}), { user: "deep", suggested: "quick" }).source, "user default");
  assert.equal(resolveDepth(p({ defaultDepth: "standard" }), { user: "deep" }).depth, "standard", "the repo's default beats the user's");
  assert.equal(resolveDepth(p({ defaultDepth: "deep" }), { flag: "quick" }).depth, "quick", "a flag beats a default");
  const floored = resolveDepth(p({ minDepth: "standard" }), { flag: "quick" });
  assert.equal(floored.depth, "standard");
  assert.deepEqual(floored.raisedBy, [{ rule: "review.minDepth", from: "quick", to: "standard" }]);
  const deep = resolveDepth(p({ deepPaths: ["src/auth/**"] }), { flag: "quick", changedPaths: ["README.md", "src/auth/café.js"] });
  assert.equal(deep.depth, "deep");
  assert.deepEqual(deep.raisedBy.at(-1), { rule: "review.deepPaths", from: "quick", to: "deep", path: "src/auth/café.js", glob: "src/auth/**" });
  assert.throws(() => resolveDepth(p({}), { flag: "max" }), fails(POLICY_INVALID));
});

test("globs: ** crosses folders, * and ? stay within one", () => {
  const hit = (paths, globs) => matchPaths(paths, globs).map((m) => m.path);
  assert.deepEqual(hit(["a.js", "src/a.js", "src/x/a.js"], ["src/**"]), ["src/a.js", "src/x/a.js"]);
  assert.deepEqual(hit(["a.js", "src/a.js", "src/x/a.js"], ["**/a.js"]), ["a.js", "src/a.js", "src/x/a.js"]);
  assert.deepEqual(hit(["src/a.js", "src/x/a.js"], ["src/*.js"]), ["src/a.js"]);
  assert.deepEqual(hit(["a1.md", "a12.md"], ["a?.md"]), ["a1.md"]);
  assert.deepEqual(hit(["src.js"], ["src/**"]), [], "a folder glob does not match a sibling file");
});

test("the JSON Schema for editors names the same settings as the validator", () => {
  const schema = JSON.parse(readFileSync(new URL("../schema/policy-v1.schema.json", import.meta.url), "utf8"));
  const fromSchema = (node) =>
    Object.fromEntries(
      Object.entries(node.properties)
        .filter(([k]) => k !== "$schema")
        .map(([k, v]) => [k, v.type === "object" ? fromSchema(v) : null]),
    );
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "$schema").map(([k, v]) => [k, typeof v === "object" ? strip(v) : null]));
  assert.deepEqual(fromSchema(schema), strip(v1Keys()));
});

test("the example policy is valid, and $schema is allowed", () => {
  const p = parsePolicy(readFileSync(new URL("../examples/agent-review.json", import.meta.url)));
  assert.equal(p.policy.review.minDepth, "standard");
  assert.equal(p.policy.actions.merge.enabled, false);
  assert.throws(() => parse({ version: 1, $schema: 5 }), fails(POLICY_INVALID, ["$schema"]));
});
