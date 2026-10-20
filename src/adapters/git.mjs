// The git adapter: the core's git interface, backed by the git command.
import { execFileSync } from "node:child_process";

export function gitAdapter(cwd) {
  const git = (args, opts = {}) => execFileSync("git", ["-C", cwd, ...args], { maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"], ...opts });
  return {
    resolveCommit(ref) {
      try {
        return git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { encoding: "utf8" }).trim();
      } catch {
        throw new Error(`git: ${JSON.stringify(ref)} is not a commit in ${cwd}`);
      }
    },
    readFile(commit, path) {
      // Absent is not an error; anything else is.
      try {
        git(["cat-file", "-e", `${commit}:${path}`]);
      } catch {
        return null;
      }
      return git(["cat-file", "blob", `${commit}:${path}`]);
    },
    mergeBase(a, b) {
      return git(["merge-base", a, b], { encoding: "utf8" }).trim();
    },
    // Paths changed between two commits, as git stores them (-z, so names
    // that git would quote come back unquoted).
    changedPaths(base, head) {
      return git(["diff", "--name-only", "--no-renames", "-z", base, head], { encoding: "utf8" }).split("\0").filter(Boolean);
    },
  };
}
