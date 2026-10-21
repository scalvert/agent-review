// Shared fixtures: a git repository with a policy, and a state root.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitAdapter } from "../src/adapters/git.mjs";

export function gitRepo(policy = { version: 1 }) {
  const dir = mkdtempSync(join(tmpdir(), "wf-repo-"));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const write = (path, text) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (msg) => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  if (policy) write("agent-review.json", `${JSON.stringify(policy, null, 2)}\n`);
  write("src/a.js", "1\n");
  commit("base");
  git("checkout", "-q", "-b", "feature");
  write("src/a.js", "2\n");
  const head = commit("change");
  return { dir, git, write, commit, head, adapter: gitAdapter(dir) };
}

export const stateRoot = () => mkdtempSync(join(tmpdir(), "wf-state-"));

export const finding = (n, extra = {}) => ({ title: `finding ${n}`, file: `src/f${n}.js`, line: n, precondition: "p", scenario: "s", evidence: "e", ...extra });
