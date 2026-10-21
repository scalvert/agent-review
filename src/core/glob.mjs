// Path globs for policy: ** matches across folders, * and ? within one
// folder. Paths are repository-relative with forward slashes.
export function checkGlob(glob) {
  if (typeof glob !== "string" || glob.length === 0) return "must be a nonempty string";
  if (glob.startsWith("/")) return "must be relative to the repository root, without a leading /";
  if (glob.includes("\\")) return "must use forward slashes";
  if (/(^|\/)\.\.(\/|$)/.test(glob)) return "must not contain ..";
  return null;
}

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// Every (path, glob) pair that matches, in path order.
export function matchPaths(paths, globs) {
  const compiled = globs.map((g) => [g, globToRegExp(g)]);
  return paths.flatMap((p) => compiled.filter(([, re]) => re.test(p)).map(([g]) => ({ path: p, glob: g })));
}
