// Where review state lives. The core takes an explicit state root; callers
// decide it. defaultStateRoot() is the portable default, with no personal or
// tool-specific locations.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StoreError, INVALID } from "./errors.mjs";

export function defaultStateRoot(env = process.env, home = homedir()) {
  if (env.AGENT_REVIEWS_STATE_DIR) return env.AGENT_REVIEWS_STATE_DIR;
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "agent-reviews");
}

// Percent-encodes everything except letters, digits, ".", "-" and "_", so
// distinct keys such as "a/b" and "a_b" never share a path. The same encoding
// as the v1 ledgers, so a v1 file and its v2 directory have the same name.
export function keyFile(key) {
  return [...String(key)]
    .map((ch) => (/[\w.-]/.test(ch) ? ch : [...Buffer.from(ch)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("")))
    .join("");
}

export const decodeKeyFile = (name) => decodeURIComponent(name);

export function checkRef({ repo, key } = {}) {
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new StoreError(INVALID, `repo must be owner/name, got ${JSON.stringify(repo)}`);
  }
  if (key === undefined || key === null || String(key) === "") {
    throw new StoreError(INVALID, "key is required: a pull request number or a branch name");
  }
  return { repo, key: String(key) };
}

// v2 state sits under its own directory, so v1 tools that scan reviews/
// never see it.
export function reviewPaths(root, ref) {
  const { repo, key } = checkRef(ref);
  const [owner, name] = repo.split("/");
  const dir = join(root, "v2", owner, name, keyFile(key));
  return { dir, log: join(dir, "events.jsonl"), snapshot: join(dir, "snapshot.json"), lock: join(dir, "lock") };
}

// Every v2 review under a state root, as { repo, key }.
export function listReviews(root) {
  const v2 = join(root, "v2");
  if (!existsSync(v2)) return [];
  const dirs = (p) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  return dirs(v2).flatMap((owner) =>
    dirs(join(v2, owner)).flatMap((name) =>
      dirs(join(v2, owner, name))
        .filter((k) => existsSync(join(v2, owner, name, k, "events.jsonl")))
        .map((k) => ({ repo: `${owner}/${name}`, key: decodeKeyFile(k) })),
    ),
  );
}

// Where a v1 ledger for the same review would be, under a v1 state root.
export function legacyV1Path(v1Root, ref) {
  const { repo, key } = checkRef(ref);
  return join(v1Root, "reviews", repo, `${keyFile(key)}.json`);
}
