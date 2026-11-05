// Work directories: scratch space for one review, such as a checkout of the
// pull request head, a model's profile or eval output. Each review has one,
// at <review dir>/work, so the harness knows which review a directory
// belongs to.
//
// Whoever uses a work directory holds a lease on it: a file in
// <review dir>/leases/ that names the actor and when the lease runs out.
// gc never removes a work directory with a live lease. Leases live outside
// work/, so removing a work directory never removes the record of who held
// it.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { reviewPaths } from "./paths.mjs";
import { alive, withLock } from "./lock.mjs";
import { writeFileAtomic } from "./atomic.mjs";
import { StoreError, INVALID } from "./errors.mjs";

export const LEASE_SCHEMA = "agent-review.lease/v1";
export const DEFAULT_LEASE_MS = 4 * 3_600_000;
export const MAX_LEASE_MS = 7 * 86_400_000;

const ACTOR = /^(human|agent):[^\s]/;
const LEASE_ID = /^[0-9a-f]{12}$/;
const leaseDir = (paths) => join(paths.dir, "leases");
const leaseFile = (paths, id) => join(leaseDir(paths), `${id}.json`);

function checkLeaseId(id) {
  if (!LEASE_ID.test(String(id))) throw new StoreError(INVALID, `a lease ID is 12 hex characters, as review workdir returned it, got ${JSON.stringify(id)}`);
}

// The review's work directory, created if it is missing, with a lease for
// the caller. Without a lease ID it takes a new lease; with one it renews
// that lease, or takes it again under the same ID if it ran out. The lease
// runs leaseMs from now. A pid ends it early: once that process exits, the
// lease no longer counts, so a crashed agent does not hold a directory for
// the rest of its lease. A pid never makes a lease last longer.
export function workdir(root, ref, { actor, lease = null, leaseMs = DEFAULT_LEASE_MS, pid = null, now = Date.now() } = {}) {
  const paths = reviewPaths(root, ref);
  if (typeof actor !== "string" || !ACTOR.test(actor)) throw new StoreError(INVALID, `actor must be human:<name> or agent:<runtime>, got ${JSON.stringify(actor)}`);
  if (!Number.isInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) throw new StoreError(INVALID, `a lease lasts more than 0 and at most ${MAX_LEASE_MS / 3_600_000} hours`);
  if (pid !== null && (!Number.isInteger(pid) || pid <= 0)) throw new StoreError(INVALID, `pid must be a process ID, got ${JSON.stringify(pid)}`);
  if (lease !== null) checkLeaseId(lease);
  if (!existsSync(paths.log)) {
    throw new StoreError(INVALID, `no review ${ref.repo} ${ref.key} under ${root}; start it before asking for a work directory`);
  }
  return withLock(paths.lock, () => {
    const created = !existsSync(paths.work);
    mkdirSync(paths.work, { recursive: true });
    mkdirSync(leaseDir(paths), { recursive: true });
    const id = lease ?? randomBytes(6).toString("hex");
    const before = lease ? readLease(leaseFile(paths, id)) : null;
    if (before && before.actor !== actor) throw new StoreError(INVALID, `lease ${id} belongs to ${before.actor}, not ${actor}`);
    const record = {
      schema: LEASE_SCHEMA,
      id,
      actor,
      pid,
      acquiredAt: before?.acquiredAt ?? new Date(now).toISOString(),
      renewedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + leaseMs).toISOString(),
    };
    writeFileAtomic(leaseFile(paths, id), `${JSON.stringify(record, null, 2)}\n`);
    return { path: paths.work, created, lease: { ...record, renewed: Boolean(before) } };
  });
}

// End a lease. Releasing one that is already gone is not an error, so a
// retry is safe.
export function releaseWorkdir(root, ref, { lease, actor }) {
  checkLeaseId(lease);
  const paths = reviewPaths(root, ref);
  return withLock(paths.lock, () => {
    const file = leaseFile(paths, lease);
    const held = readLease(file);
    if (!held) return { released: false, lease };
    if (actor && held.actor !== actor) throw new StoreError(INVALID, `lease ${lease} belongs to ${held.actor}, not ${actor}`);
    unlinkSync(file);
    return { released: true, lease };
  });
}

function readLease(file) {
  try {
    const l = JSON.parse(readFileSync(file, "utf8"));
    return l.schema === LEASE_SCHEMA ? l : null;
  } catch {
    return null;
  }
}

// Every lease on a review, each with whether it still counts and why not.
// A lease file that cannot be read counts, until it is older than the
// longest lease: an unknown lease is not a released one.
export function readLeases(root, ref, { now = Date.now() } = {}) {
  const paths = reviewPaths(root, ref);
  const dir = leaseDir(paths);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => {
      const file = join(dir, n);
      const l = readLease(file);
      if (!l) {
        const mtime = lstatSync(file).mtimeMs;
        const live = now - mtime < MAX_LEASE_MS;
        return { id: n.replace(/\.json$/, ""), actor: null, pid: null, expiresAt: null, live, why: live ? "the lease file cannot be read" : "an unreadable lease file older than the longest lease" };
      }
      const expired = Date.parse(l.expiresAt) <= now;
      const exited = l.pid !== null && !alive(l.pid);
      return { id: l.id, actor: l.actor, pid: l.pid, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt, live: !expired && !exited, why: expired ? "expired" : exited ? `process ${l.pid} has exited` : null };
    })
    .sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)));
}

// Remove the lease files that no longer count. gc does this when it removes
// a work directory.
export function pruneLeases(root, ref, { now = Date.now() } = {}) {
  const paths = reviewPaths(root, ref);
  for (const l of readLeases(root, ref, { now })) {
    if (l.live) continue;
    try {
      unlinkSync(leaseFile(paths, l.id));
    } catch {}
  }
}

// One walk over a work directory: the bytes it holds on disk, its newest
// modification, every git repository inside it, and any directory that
// could not be read. Symbolic links are counted, never followed.
export function scanWorkdir(dir) {
  let bytes = 0;
  let newestMs = lstatSync(dir).mtimeMs;
  const repos = [];
  const unreadable = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      unreadable.push(d);
      continue;
    }
    // A .git directory, or a .git file for a linked worktree.
    if (entries.some((e) => e.name === ".git")) repos.push(d);
    for (const e of entries) {
      const p = join(d, e.name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      bytes += st.blocks != null ? st.blocks * 512 : st.size;
      if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
      if (st.isDirectory()) stack.push(p);
    }
  }
  return { bytes, newestMs, repos, unreadable };
}
