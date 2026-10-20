// npm dependency changes between two commits, from package-lock.json and
// package.json, never from a pull request's title. Returns null when there
// is no lockfile at either commit, so a rule that needs patch-only changes
// cannot pass on missing evidence.
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function readJson(git, commit, path) {
  const bytes = git.readFile(commit, path);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

// The lowest version a simple range allows: ^1.2.3, ~1.2.3 and 1.2.3 give
// 1.2.3. Anything else (ranges, tags, URLs) is kept as is and will not
// count as a patch change.
const floor = (range) => {
  const m = /^[\^~]?(\d+\.\d+\.\d+)$/.exec(String(range).trim());
  return m ? m[1] : String(range);
};

export function npmDependencyChanges(git, base, head) {
  const before = readJson(git, base, "package-lock.json");
  const after = readJson(git, head, "package-lock.json");
  if (!before || !after) return null;
  const changes = [];
  const pkgs = (lock) => lock.packages ?? {};
  const a = pkgs(before);
  const b = pkgs(after);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === "") continue;
    const name = key.replace(/^.*node_modules\//, "");
    const from = a[key]?.version ?? null;
    const to = b[key]?.version ?? null;
    if (from === to) continue;
    changes.push({ name, from, to, change: from === null ? "added" : to === null ? "removed" : "changed", source: `package-lock.json ${key}` });
  }
  const pa = readJson(git, base, "package.json") ?? {};
  const pb = readJson(git, head, "package.json") ?? {};
  for (const section of SECTIONS) {
    const x = pa[section] ?? {};
    const y = pb[section] ?? {};
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (x[name] === y[name]) continue;
      const from = x[name] === undefined ? null : floor(x[name]);
      const to = y[name] === undefined ? null : floor(y[name]);
      changes.push({ name, from, to, change: from === null ? "added" : to === null ? "removed" : "changed", source: `package.json ${section}` });
    }
  }
  return changes;
}
