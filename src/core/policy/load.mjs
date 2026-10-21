// Parse, validate and resolve a policy file. Fails closed: a file that is
// not JSON, has no version, has an unsupported version, or has any invalid
// setting is an error, never a fallback to defaults.
import { canonicalJson, digestOf, sha256 } from "../digest.mjs";
import { DEFAULT_POLICY, POLICY_FILE, SUPPORTED_VERSIONS } from "./defaults.mjs";
import { validateV1 } from "./validate.mjs";

export class PolicyError extends Error {
  constructor(code, message, errors = []) {
    super(errors.length ? `${message}\n${errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}` : message);
    this.name = "PolicyError";
    this.code = code;
    this.errors = errors;
  }
}

export const NOT_JSON = "policy/not-json";
export const NO_VERSION = "policy/no-version";
export const UNSUPPORTED_VERSION = "policy/unsupported-version";
export const INVALID = "policy/invalid";
export const WEAKENING = "policy/weakening";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Settings fill in from the defaults section by section. A list in the file
// replaces the default list.
function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return structuredClone(over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : structuredClone(v);
  return out;
}

// The unversioned file from before the harness: { review: { depth, deepPaths } }.
function versionZero(raw) {
  if (!isObject(raw) || Object.keys(raw).some((k) => k !== "review") || !isObject(raw.review ?? {})) return null;
  const review = raw.review ?? {};
  if (Object.keys(review).some((k) => k !== "depth" && k !== "deepPaths")) return null;
  const mapped = { version: 1, review: {} };
  if ("depth" in review) mapped.review.defaultDepth = review.depth;
  if ("deepPaths" in review) mapped.review.deepPaths = review.deepPaths;
  return mapped;
}

export function defaultPolicy() {
  const policy = structuredClone(DEFAULT_POLICY);
  return {
    policy,
    declared: null,
    version: 1,
    source: { kind: "default", path: null, ref: null, commit: null, digest: null },
    effectiveDigest: digestOf(policy),
    warnings: [],
  };
}

// source: where the bytes came from, recorded as provenance. For a file
// read from git: { kind: "repo", path, ref, commit }.
export function parsePolicy(bytes, source = { kind: "file", path: POLICY_FILE }) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  const where = [source.path ?? POLICY_FILE, source.commit ? `at ${source.commit.slice(0, 12)}` : null].filter(Boolean).join(" ");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new PolicyError(NOT_JSON, `${where}: not valid JSON (${e.message})`);
  }
  const warnings = [];
  let declared = raw;
  if (!isObject(raw) || !("version" in raw)) {
    declared = versionZero(raw);
    if (!declared) throw new PolicyError(NO_VERSION, `${where}: "version" is required; this harness supports version ${SUPPORTED_VERSIONS.join(", ")}`);
    warnings.push({
      code: "policy/version-0",
      message: `${where} has no "version". It was read as version 1: add "version": 1, and rename review.depth to review.defaultDepth.`,
    });
  } else if (!SUPPORTED_VERSIONS.includes(raw.version)) {
    throw new PolicyError(UNSUPPORTED_VERSION, `${where}: version ${JSON.stringify(raw.version)} is not supported; this harness supports version ${SUPPORTED_VERSIONS.join(", ")}`);
  }
  const errors = validateV1(declared);
  if (errors.length) throw new PolicyError(INVALID, `${where}: invalid policy`, errors);
  // $schema is for editors. Leaving it out of the resolved policy keeps the
  // effective digest the same when only the schema URL changes.
  const { $schema: _schema, ...settings } = declared;
  const policy = merge(DEFAULT_POLICY, settings);
  return {
    policy,
    declared,
    version: 1,
    source: { kind: source.kind ?? "file", path: source.path ?? POLICY_FILE, ref: source.ref ?? null, commit: source.commit ?? null, digest: sha256(Buffer.from(text, "utf8")) },
    effectiveDigest: digestOf(policy),
    warnings,
  };
}

export const policyJson = (policy) => canonicalJson(policy);
