// Which work directories are in use, and which can go. Each gets one status
// and one answer, removable or not, with the reasons, so a person or an
// agent asks the harness instead of guessing from timestamps.
//
//   in-use     a live lease: someone said they are using it
//   protected  something would be lost or cannot be checked: git work, an
//              unreadable directory or review, a held lock, a link
//   in-review  the round is reviewing or verifying
//   paused     reported, complete, invalidated or not started, with the
//              pull request open or unknown
//   done       the pull request is merged or closed           (removable)
//   idle       nothing changed for idleDays                   (removable)
//
// The first that applies wins, so a live lease or git work keeps a
// directory whatever else is true. done needs CLOSED_GRACE_DAYS without a
// change, and in-review and paused become idle after idleDays.
//
// gc removes work directories and nothing else. A review's events,
// snapshot and leases' history are never touched.
//
// The core runs no programs. What it cannot see from the file system comes
// from callbacks: checkRepo(path) says why a git repository inside a work
// directory must be kept, and hostState(ref) says whether the pull request
// is open, merged or closed.
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { relative, sep } from "node:path";
import { listReviews, reviewPaths } from "../store/paths.mjs";
import { withLock } from "../store/lock.mjs";
import { pruneLeases, readLeases, scanWorkdir } from "../store/workdir.mjs";
import { StoreError, BUSY, INVALID } from "../store/errors.mjs";
import { openReview } from "./review.mjs";
import { next } from "./next.mjs";

export const DEFAULT_IDLE_DAYS = 30;
// A merged or closed review's work directory is kept this long after its
// last change, for an agent finishing up without a lease.
export const CLOSED_GRACE_DAYS = 1;
export const WORKDIR_STATUSES = ["in-use", "protected", "in-review", "paused", "done", "idle"];
const DAY_MS = 86_400_000;
const IN_REVIEW = new Set(["reviewing", "verifying"]);

const days = (ms) => Math.floor(ms / DAY_MS);
const rel = (base, p) => relative(base, p) || ".";

// One review's work directory, assessed now. null if it has none.
// ownLock: the caller holds the review's lock, so the lock file is not a
// reason to keep it.
export function assessWorkdir(root, ref, { now = Date.now(), idleDays = DEFAULT_IDLE_DAYS, host = null, checkRepo = () => [], ownLock = false } = {}) {
  const paths = reviewPaths(root, ref);
  let st;
  try {
    st = lstatSync(paths.work);
  } catch {
    return null;
  }
  const base = { repo: ref.repo, key: ref.key, path: paths.work, bytes: 0, idleDays: null, lastActivityAt: null, host, review: null, leases: readLeases(root, ref, { now }) };
  // Only a real directory is a work directory. A link is never walked or
  // removed: what it points to is not the harness's to delete.
  if (!st.isDirectory()) return { ...base, status: "protected", removable: false, reasons: [{ code: "not-a-directory", message: `${paths.work} is not a directory; remove it by hand if it is not needed` }] };

  const scan = scanWorkdir(paths.work);
  const lastActivityMs = Math.max(scan.newestMs, lstatSync(paths.log).mtimeMs);
  const idle = days(now - lastActivityMs);
  const item = { ...base, bytes: scan.bytes, idleDays: idle, lastActivityAt: new Date(lastActivityMs).toISOString() };

  let reviewError = null;
  try {
    const n = next(openReview(root, ref).read());
    item.review = { status: n.status, round: n.round ?? null, waitingOn: n.waitingOn ?? null };
  } catch (e) {
    reviewError = e;
  }

  const live = item.leases.filter((l) => l.live);
  if (live.length) {
    return { ...item, status: "in-use", removable: false, reasons: live.map((l) => ({ code: "leased", message: l.actor ? `leased by ${l.actor}${l.pid ? ` (process ${l.pid})` : ""} until ${l.expiresAt}` : `lease ${l.id}: ${l.why}` })) };
  }

  const keep = [];
  if (!ownLock && existsSync(paths.lock)) keep.push({ code: "locked", message: "a writer holds the review's lock" });
  if (reviewError) keep.push({ code: "review-unreadable", message: `the review cannot be read (${reviewError.code ?? "error"}): ${reviewError.message.split("\n")[0]}` });
  for (const d of scan.unreadable) keep.push({ code: "unreadable", message: `${rel(paths.work, d)} cannot be read` });
  for (const r of scan.repos) for (const why of checkRepo(r)) keep.push({ ...why, path: rel(paths.work, r), message: `${rel(paths.work, r)}: ${why.message}` });
  if (keep.length) return { ...item, status: "protected", removable: false, reasons: keep };

  if (host && (host.state === "merged" || host.state === "closed")) {
    if (idle >= CLOSED_GRACE_DAYS) return { ...item, status: "done", removable: true, reasons: [{ code: `host-${host.state}`, message: `the pull request is ${host.state}; no lease, and idle ${idle} days` }] };
  }
  if (idle >= idleDays) return { ...item, status: "idle", removable: true, reasons: [{ code: "idle", message: `no lease, and idle ${idle} days, at least ${idleDays}` }] };
  if (host && (host.state === "merged" || host.state === "closed")) {
    return { ...item, status: "paused", removable: false, reasons: [{ code: "grace", message: `the pull request is ${host.state}, but the directory changed under ${CLOSED_GRACE_DAYS} day ago` }] };
  }
  const status = item.review && IN_REVIEW.has(item.review.status) ? "in-review" : "paused";
  const where = item.review ? `the review is ${item.review.status}${item.review.round ? ` (round ${item.review.round})` : ""}` : "the review";
  const pr = host?.state === "open" ? ", the pull request is open" : "";
  return { ...item, status, removable: false, reasons: [{ code: status, message: `${where}${pr}; idle ${idle} days, under ${idleDays}` }] };
}

// Every work directory and its status, without changing anything.
export function planGc(root, { now = Date.now(), idleDays = DEFAULT_IDLE_DAYS, repo = null, hostState = () => null, checkRepo = () => [] } = {}) {
  if (!Number.isInteger(idleDays) || idleDays < 0) throw new StoreError(INVALID, `idleDays must be a whole number of days, 0 or more, got ${JSON.stringify(idleDays)}`);
  const items = [];
  for (const ref of listReviews(root)) {
    if (repo && ref.repo !== repo) continue;
    if (!existsSync(reviewPaths(root, ref).work) && !isLink(reviewPaths(root, ref).work)) continue;
    const item = assessWorkdir(root, ref, { now, idleDays, host: hostState(ref), checkRepo });
    if (item) items.push(item);
  }
  items.sort((a, b) => WORKDIR_STATUSES.indexOf(a.status) - WORKDIR_STATUSES.indexOf(b.status) || b.bytes - a.bytes || a.repo.localeCompare(b.repo) || a.key.localeCompare(b.key));
  return { idleDays, items, bytes: { removable: sum(items.filter((i) => i.removable)), kept: sum(items.filter((i) => !i.removable)) } };
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const sum = (items) => items.reduce((n, i) => n + i.bytes, 0);

// Remove what the plan marked removable. Each removal holds the review's
// lock and assesses the directory again first, with the host state from the
// plan. One that is no longer removable, or that changed since the plan, is
// kept with the new reasons. Holding the lock means no lease can be taken
// between the check and the removal.
export function applyGc(root, plan, { now = Date.now(), checkRepo = () => [] } = {}) {
  const realRoot = realpathSync(root);
  const items = plan.items.map((item) => {
    if (!item.removable) return { ...item, removed: false };
    const paths = reviewPaths(root, item);
    const kept = (fresh, code, message) => ({ ...(fresh ?? item), status: "protected", removable: false, removed: false, reasons: [{ code, message }] });
    try {
      return withLock(
        paths.lock,
        () => {
          // Never remove anything outside the state root, whatever a link says.
          const real = realpathSync(paths.work);
          if (!real.startsWith(realRoot + sep)) return kept(null, "outside-root", `${paths.work} resolves outside the state root`);
          const fresh = assessWorkdir(root, item, { now, idleDays: plan.idleDays, host: item.host, checkRepo, ownLock: true });
          if (!fresh) return { ...item, removed: true, reasons: [...item.reasons, { code: "gone", message: "already removed" }] };
          if (!fresh.removable) return { ...fresh, removed: false };
          if (Date.parse(fresh.lastActivityAt) > Date.parse(item.lastActivityAt)) return kept(fresh, "changed", "the work directory changed after the plan was made");
          rmSync(paths.work, { recursive: true });
          pruneLeases(root, item, { now });
          return { ...fresh, removed: true };
        },
        { timeoutMs: 0 },
      );
    } catch (e) {
      if (e.code === BUSY) return kept(null, "locked", "a writer holds the review's lock");
      if (e.code === "ENOENT") return { ...item, removed: true, reasons: [...item.reasons, { code: "gone", message: "already removed" }] };
      throw e;
    }
  });
  return { idleDays: plan.idleDays, items, bytes: { removed: sum(items.filter((i) => i.removed)), kept: sum(items.filter((i) => !i.removed)) } };
}
