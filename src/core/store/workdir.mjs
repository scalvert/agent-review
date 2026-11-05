// Work directories: scratch space for one review, such as a checkout of the
// pull request head, a model's profile or eval output. Each review has one,
// at <review dir>/work, so the harness knows which review a directory
// belongs to and when it is safe to remove.
//
// gc removes work directories and nothing else. A review's events and
// snapshot are never touched, so its history survives every collection.
//
// The core runs no programs. What it cannot see from the file system comes
// from callbacks: checkRepo(path) says why a git repository inside a work
// directory must be kept, and hostState(ref) says whether the pull request
// is open, merged or closed.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { listReviews, reviewPaths } from "./paths.mjs";
import { withLock } from "./lock.mjs";
import { StoreError, BUSY, INVALID } from "./errors.mjs";

export const DEFAULT_IDLE_DAYS = 30;
// A merged or closed review's work directory is kept this long after its
// last change, so an agent finishing up is not cut off.
export const CLOSED_GRACE_DAYS = 1;
const DAY_MS = 86_400_000;

// The review's work directory, created if it is missing. The review must
// exist, so every work directory belongs to a review that gc can judge.
export function workdir(root, ref) {
  const paths = reviewPaths(root, ref);
  if (!existsSync(paths.log)) {
    throw new StoreError(INVALID, `no review ${ref.repo} ${ref.key} under ${root}; start it before asking for a work directory`);
  }
  return withLock(paths.lock, () => {
    const created = !existsSync(paths.work);
    mkdirSync(paths.work, { recursive: true });
    return { path: paths.work, created };
  });
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

const days = (ms) => Math.floor(ms / DAY_MS);
const rel = (base, p) => relative(base, p) || ".";

// What gc would do, without changing anything. Each review with a work
// directory gets one item: purge, with the reasons it may go, or keep, with
// the reasons it stays. A reason to keep always wins.
export function planGc(root, { now = Date.now(), idleDays = DEFAULT_IDLE_DAYS, repo = null, hostState = () => null, checkRepo = () => [] } = {}) {
  if (!Number.isInteger(idleDays) || idleDays < 0) throw new StoreError(INVALID, `idleDays must be a whole number of days, 0 or more, got ${JSON.stringify(idleDays)}`);
  const items = [];
  for (const ref of listReviews(root)) {
    if (repo && ref.repo !== repo) continue;
    const paths = reviewPaths(root, ref);
    let st;
    try {
      st = lstatSync(paths.work);
    } catch {
      continue;
    }
    // Only a real directory is a work directory. A link is never walked or
    // removed: what it points to is not the harness's to delete.
    if (!st.isDirectory()) {
      items.push({ repo: ref.repo, key: ref.key, path: paths.work, bytes: 0, idleDays: null, lastActivityAt: null, host: null, action: "keep", reasons: [{ code: "not-a-directory", message: `${paths.work} is not a directory; remove it by hand if it is not needed` }] });
      continue;
    }
    const scan = scanWorkdir(paths.work);
    const lastActivityMs = Math.max(scan.newestMs, lstatSync(paths.log).mtimeMs);
    const idle = days(now - lastActivityMs);
    const keep = [];
    if (existsSync(paths.lock)) keep.push({ code: "locked", message: "a writer holds the review's lock" });
    for (const d of scan.unreadable) keep.push({ code: "unreadable", message: `${rel(paths.work, d)} cannot be read` });
    for (const r of scan.repos) for (const why of checkRepo(r)) keep.push({ ...why, path: rel(paths.work, r), message: `${rel(paths.work, r)}: ${why.message}` });

    const host = hostState(ref);
    const purge = [];
    if (host && (host.state === "merged" || host.state === "closed") && idle >= CLOSED_GRACE_DAYS) {
      purge.push({ code: `host-${host.state}`, message: `the pull request is ${host.state}, and the work directory has been idle ${idle} days` });
    }
    if (idle >= idleDays) purge.push({ code: "idle", message: `idle ${idle} days, at least ${idleDays}` });
    if (!keep.length && !purge.length) keep.push({ code: "active", message: `idle ${idle} days, under ${idleDays}${host?.state === "open" ? ", and the pull request is open" : ""}` });

    items.push({
      repo: ref.repo,
      key: ref.key,
      path: paths.work,
      bytes: scan.bytes,
      idleDays: idle,
      lastActivityAt: new Date(lastActivityMs).toISOString(),
      host,
      action: keep.length ? "keep" : "purge",
      reasons: keep.length ? keep : purge,
    });
  }
  items.sort((a, b) => b.bytes - a.bytes || a.repo.localeCompare(b.repo) || a.key.localeCompare(b.key));
  return { idleDays, items, bytes: { purge: sum(items.filter((i) => i.action === "purge")), keep: sum(items.filter((i) => i.action === "keep")) } };
}

const sum = (items) => items.reduce((n, i) => n + i.bytes, 0);

// Remove what the plan marked purge. Each removal holds the review's lock,
// and checks again first: a work directory that changed since the plan, or
// that now holds git work, is kept.
export function applyGc(root, plan, { checkRepo = () => [] } = {}) {
  const realRoot = realpathSync(root);
  const items = plan.items.map((item) => {
    if (item.action !== "purge") return item;
    const paths = reviewPaths(root, item);
    const kept = (code, message) => ({ ...item, action: "keep", reasons: [{ code, message }] });
    try {
      return withLock(
        paths.lock,
        () => {
          // Never remove anything outside the state root, whatever a link says.
          const real = realpathSync(paths.work);
          if (!real.startsWith(realRoot + sep)) return kept("outside-root", `${paths.work} resolves outside the state root`);
          const scan = scanWorkdir(paths.work);
          // lastActivityAt has whole milliseconds; mtimes can have fractions.
          if (Math.floor(scan.newestMs) > Date.parse(item.lastActivityAt)) return kept("changed", "the work directory changed after the plan was made");
          if (scan.unreadable.length) return kept("unreadable", `${rel(paths.work, scan.unreadable[0])} cannot be read`);
          for (const r of scan.repos) {
            const why = checkRepo(r);
            if (why.length) return kept(why[0].code, `${rel(paths.work, r)}: ${why[0].message}`);
          }
          rmSync(paths.work, { recursive: true });
          return { ...item, action: "removed" };
        },
        { timeoutMs: 0 },
      );
    } catch (e) {
      if (e.code === BUSY) return kept("locked", "a writer holds the review's lock");
      if (e.code === "ENOENT") return { ...item, action: "removed", reasons: [...item.reasons, { code: "gone", message: "already removed" }] };
      throw e;
    }
  });
  return { idleDays: plan.idleDays, items, bytes: { removed: sum(items.filter((i) => i.action === "removed")), keep: sum(items.filter((i) => i.action === "keep")) } };
}
