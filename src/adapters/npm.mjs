// npm dependency changes between two commits, from package-lock.json and
// package.json, never from a pull request's title.
//
// Fails closed. Returns null when either commit has no lockfile, or one
// without a "packages" map (lockfileVersion 1), so a rule that needs
// patch-only changes cannot pass on missing evidence. Every other change is
// reported, and anything that is not a plain version step is reported as
// "other" with what changed, so it can never count as a patch:
//
// - a lockfile entry whose version is unchanged but whose resolved,
//   integrity or any other field changed (a swapped tarball);
// - a version step that also changes the registry host, adds an install
//   script, or changes fields npm does not change for an update;
// - any package.json change outside the dependency sections, such as
//   scripts or overrides;
// - a dependency range whose operator changed (^1.2.3 to ~1.2.4) or that is
//   not a simple version.
import { canonicalJson } from "../core/digest.mjs";

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
// Fields npm may change in a lockfile entry when the version moves.
const BUMP_FIELDS = new Set(["version", "resolved", "integrity", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines", "funding", "license", "deprecated"]);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function readJson(git, commit, path) {
  const bytes = git.readFile(commit, path);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

const changedFields = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((k) => canonicalJson(a?.[k] ?? null) !== canonicalJson(b?.[k] ?? null));

const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

// v2 lockfiles also carry a nested "dependencies" tree for npm 6; flatten it
// so its entries get the same checks.
function legacyEntries(tree, prefix = "", out = {}) {
  for (const [name, e] of Object.entries(tree ?? {})) {
    const key = `${prefix}${name}`;
    out[key] = { version: e.version, resolved: e.resolved, integrity: e.integrity };
    if (e.dependencies) legacyEntries(e.dependencies, `${key}/`, out);
  }
  return out;
}

function compareEntries(a, b, source, changes) {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === "") continue;
    const name = key.replace(/^.*node_modules\//, "");
    const x = a[key];
    const y = b[key];
    const where = `${source} ${key}`;
    if (!x) {
      changes.push({ name, from: null, to: y.version ?? null, change: "added", source: where });
      continue;
    }
    if (!y) {
      changes.push({ name, from: x.version ?? null, to: null, change: "removed", source: where });
      continue;
    }
    const fields = changedFields(x, y);
    if (fields.length === 0) continue;
    if (x.version === y.version) {
      changes.push({ name, from: x.version, to: y.version, change: "other", detail: `${fields.join(", ")} changed without a version change`, source: where });
      continue;
    }
    const odd = fields.filter((f) => !BUMP_FIELDS.has(f));
    const problems = [];
    if (odd.length) problems.push(`${odd.join(", ")} changed`);
    if (x.resolved && y.resolved && host(x.resolved) !== host(y.resolved)) problems.push(`the registry changed from ${host(x.resolved)} to ${host(y.resolved)}`);
    if (problems.length) changes.push({ name, from: x.version, to: y.version, change: "other", detail: problems.join("; "), source: where });
    else changes.push({ name, from: x.version, to: y.version, change: "changed", source: where });
  }
}

// A simple range: an optional ^ or ~, then x.y.z.
const range = (r) => {
  const m = /^([\^~]?)(\d+\.\d+\.\d+)$/.exec(String(r).trim());
  return m ? { op: m[1], version: m[2] } : null;
};

function comparePackageJson(pa, pb, source, changes) {
  const rest = (p) => Object.fromEntries(Object.entries(p ?? {}).filter(([k]) => !SECTIONS.includes(k)));
  const other = changedFields(rest(pa), rest(pb));
  if (other.length) changes.push({ name: source, from: null, to: null, change: "other", detail: `${other.join(", ")} changed`, source });
  for (const section of SECTIONS) {
    const x = pa?.[section] ?? {};
    const y = pb?.[section] ?? {};
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (x[name] === y[name]) continue;
      const where = `${source} ${section}`;
      if (x[name] === undefined) changes.push({ name, from: null, to: y[name], change: "added", source: where });
      else if (y[name] === undefined) changes.push({ name, from: x[name], to: null, change: "removed", source: where });
      else {
        const a = range(x[name]);
        const b = range(y[name]);
        if (!a || !b) changes.push({ name, from: x[name], to: y[name], change: "other", detail: "not a simple version range", source: where });
        else if (a.op !== b.op) changes.push({ name, from: x[name], to: y[name], change: "other", detail: `the range operator changed from "${a.op}" to "${b.op}"`, source: where });
        else changes.push({ name, from: a.version, to: b.version, change: "changed", source: where });
      }
    }
  }
}

export function npmDependencyChanges(git, base, head) {
  const before = readJson(git, base, "package-lock.json");
  const after = readJson(git, head, "package-lock.json");
  if (!before || !after || !isObject(before.packages) || !isObject(after.packages)) return null;
  const changes = [];
  const top = (l) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== "packages" && k !== "dependencies"));
  const topFields = changedFields(top(before), top(after));
  if (topFields.length) changes.push({ name: "package-lock.json", from: null, to: null, change: "other", detail: `${topFields.join(", ")} changed`, source: "package-lock.json" });
  compareEntries(before.packages, after.packages, "package-lock.json", changes);
  if (before.dependencies || after.dependencies) compareEntries(legacyEntries(before.dependencies), legacyEntries(after.dependencies), "package-lock.json dependencies", changes);
  comparePackageJson(before.packages[""], after.packages[""], "package-lock.json root", changes);
  comparePackageJson(readJson(git, base, "package.json") ?? {}, readJson(git, head, "package.json") ?? {}, "package.json", changes);
  return changes;
}
