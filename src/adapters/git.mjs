// The git adapter: the core's git interface, backed by the git command.
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";

// Why a git repository inside a work directory must be kept, as reasons for
// gc: uncommitted or untracked files, commits on no remote, or stashes. An
// empty list means everything in it can be fetched again. If git cannot
// read the repository, it is kept: an unknown state is not a clean one.
export function repoWorkState(dir) {
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  const reasons = [];
  try {
    const changed = git(["status", "--porcelain", "--untracked-files=normal"]).split("\n").filter(Boolean).length;
    if (changed) reasons.push({ code: "git-uncommitted", message: `${changed} uncommitted or untracked ${changed === 1 ? "path" : "paths"}` });
    let hasHead = true;
    try {
      git(["rev-parse", "--verify", "--quiet", "HEAD"]);
    } catch {
      hasHead = false;
    }
    if (hasHead) {
      // A clone takes its branches with it, so a commit on any of them that
      // no remote has would be lost. A linked worktree (.git is a file)
      // leaves its branches in the main repository, so only commits that
      // nothing but its HEAD reaches would be lost.
      const linked = lstatSync(join(dir, ".git")).isFile();
      const range = linked ? ["HEAD", "--not", "--remotes", "--branches"] : ["HEAD", "--branches", "--not", "--remotes"];
      const unpushed = Number(git(["rev-list", "--count", ...range]).trim());
      if (unpushed) reasons.push({ code: "git-unpushed", message: `${unpushed} ${unpushed === 1 ? "commit" : "commits"} on no remote${linked ? " or branch" : ""}` });
    }
    const stashes = git(["stash", "list"]).split("\n").filter(Boolean).length;
    if (stashes) reasons.push({ code: "git-stashed", message: `${stashes} ${stashes === 1 ? "stash" : "stashes"}` });
  } catch (e) {
    return [{ code: "git-unreadable", message: `git cannot read it (${String(e.stderr ?? e.message).trim().split("\n")[0]})` }];
  }
  return reasons;
}

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
    // The remote's default branch, such as origin/main, if it is known.
    defaultTarget(remote = "origin") {
      try {
        return git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], { encoding: "utf8" }).trim() || null;
      } catch {
        return null;
      }
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
