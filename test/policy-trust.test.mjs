// Trusted policy against real git repositories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_JSON, POLICY_CHANGE, POLICY_INVALID, sha256, trustedPolicy } from "../src/index.mjs";
import { gitAdapter } from "../src/adapters/git.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "trust-"));
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
  return { dir, git, write, commit, adapter: gitAdapter(dir) };
}

const policy = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

test("a change that weakens the policy is reviewed under the target branch's policy, and goes to a person", () => {
  const r = repo();
  r.write("agent-review.json", policy({ version: 1, independence: { minFamilies: 2 } }));
  r.commit("policy");
  r.git("checkout", "-q", "-b", "weaken");
  r.write("agent-review.json", policy({ version: 1, independence: { minFamilies: 1 } }));
  r.write("src/a.js", "1\n");
  const head = r.commit("weaken the policy");
  const t = trustedPolicy({ git: r.adapter, targetRef: "main", head });
  assert.equal(t.trusted.policy.independence.minFamilies, 2);
  assert.equal(t.trusted.source.kind, "repo");
  assert.equal(t.trusted.source.ref, "main");
  assert.equal(t.trusted.source.commit, r.git("rev-parse", "main"));
  assert.equal(t.proposed.valid, true);
  assert.equal(t.proposed.deleted, false);
  assert.deepEqual(t.escalations.map((e) => e.code), [POLICY_CHANGE]);
});

test("deleting the policy file does not remove it from the review", () => {
  const r = repo();
  r.write("agent-review.json", policy({ version: 1, review: { minDepth: "deep" } }));
  r.commit("policy");
  r.git("checkout", "-q", "-b", "delete");
  rmSync(join(r.dir, "agent-review.json"));
  const head = r.commit("delete the policy");
  const t = trustedPolicy({ git: r.adapter, targetRef: "main", head });
  assert.equal(t.trusted.policy.review.minDepth, "deep");
  assert.equal(t.proposed.deleted, true);
  assert.match(t.escalations[0].message, /deletes agent-review\.json/);
});

test("a policy tightened on the target after the change branched still applies", () => {
  const r = repo();
  r.write("agent-review.json", policy({ version: 1 }));
  r.commit("loose policy");
  r.git("checkout", "-q", "-b", "feature");
  r.write("src/a.js", "1\n");
  const head = r.commit("feature work");
  r.git("checkout", "-q", "main");
  r.write("agent-review.json", policy({ version: 1, review: { minReviewers: 3 } }));
  r.commit("tighten policy");
  const t = trustedPolicy({ git: r.adapter, targetRef: "main", head });
  assert.equal(t.trusted.policy.review.minReviewers, 3, "the tip's policy, not the merge base's");
  assert.equal(t.proposed.digest, sha256(policy({ version: 1 })), "the head still has the old, looser file");
  assert.equal(t.escalations.length, 1, "the head's copy differs from the tip's, so a person looks");
});

test("an unchanged policy needs no person, and no file means the safe defaults", () => {
  const r = repo();
  r.write("README.md", "hi\n");
  r.commit("no policy");
  r.git("checkout", "-q", "-b", "docs");
  r.write("README.md", "hello\n");
  const head = r.commit("docs");
  const t = trustedPolicy({ git: r.adapter, targetRef: "main", head });
  assert.equal(t.trusted.source.kind, "default");
  assert.equal(t.trusted.policy.actions.post, false);
  assert.equal(t.proposed, null);
  assert.deepEqual(t.escalations, []);
});

test("an invalid policy on the target branch is an error, not a fallback to defaults", () => {
  const r = repo();
  r.write("agent-review.json", "{ not json");
  const head = r.commit("broken policy");
  assert.throws(() => trustedPolicy({ git: r.adapter, targetRef: "main", head }), (e) => e.code === NOT_JSON && /at [0-9a-f]{12}/.test(e.message));
  r.write("agent-review.json", policy({ version: 1, review: { minReviewers: "two" } }));
  const head2 = r.commit("invalid policy");
  assert.throws(() => trustedPolicy({ git: r.adapter, targetRef: "main", head: head2 }), (e) => e.code === POLICY_INVALID);
});

test("an invalid policy proposed by the change is reported, and the trusted one still applies", () => {
  const r = repo();
  r.write("agent-review.json", policy({ version: 1 }));
  r.commit("policy");
  r.git("checkout", "-q", "-b", "bad");
  r.write("agent-review.json", policy({ version: 9 }));
  const head = r.commit("bad policy");
  const t = trustedPolicy({ git: r.adapter, targetRef: "main", head });
  assert.equal(t.proposed.valid, false);
  assert.match(t.proposed.errors[0].message, /version 9 is not supported/);
  assert.equal(t.trusted.version, 1);
});

test("the git adapter: unknown refs fail, absent files are null, changed paths come back unquoted", () => {
  const r = repo();
  r.write("a.txt", "1\n");
  const base = r.commit("a");
  r.write("src/auth/café.js", "1\n");
  const head = r.commit("b");
  assert.throws(() => r.adapter.resolveCommit("nope"), /not a commit/);
  assert.equal(r.adapter.readFile(head, "missing.json"), null);
  assert.deepEqual(r.adapter.changedPaths(base, head), ["src/auth/café.js"]);
  assert.equal(r.adapter.mergeBase(base, head), base);
});
