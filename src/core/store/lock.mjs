// An exclusive lock on one path, for writers on one machine.
//
// The lock is a file created with O_EXCL, holding the owner's PID and a
// random token. A writer that cannot get it within timeoutMs fails with
// store/busy, having done nothing.
//
// Reclaiming a lock left by a crash is the dangerous part: two waiters can
// both see the same dead lock, and the slower one must not delete the lock
// the faster one just took. So:
//
// - A lock is stale only when its process is gone. A lock held by a live
//   process is never removed, however old; the writer reports busy, and a
//   person can remove the lock. (A lock file with no readable PID, left by
//   a crash during creation, is stale once it is older than staleMs.)
// - Only the holder of a short "breaker" lock (<path>.break, also O_EXCL)
//   may remove a stale lock, and only after reading it again under the
//   breaker. Others wait. So no two waiters reclaim at once.
// - A breaker left by a crash is removed when its process is gone. That is
//   the one remaining window, and it needs two crashes in a row.
//
// Not covered: state directories shared between machines over a network
// file system, where O_EXCL and PIDs are not reliable.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { StoreError, BUSY } from "./errors.mjs";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_STALE_MS = 30_000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function readLock(path) {
  try {
    return { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

function isStale({ text, mtimeMs }, staleMs) {
  let pid;
  try {
    pid = JSON.parse(text).pid;
  } catch {
    return Date.now() - mtimeMs > staleMs;
  }
  return !alive(pid);
}

function create(path, token) {
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, token);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return false;
  }
}

const newToken = () => JSON.stringify({ pid: process.pid, token: randomBytes(8).toString("hex"), at: new Date().toISOString() });

// Remove the lock at path if it is stale, holding the breaker while doing it.
function reclaim(path, staleMs) {
  const breaker = `${path}.break`;
  const token = newToken();
  if (!create(breaker, token)) {
    const b = readLock(breaker);
    if (b && isStale(b, staleMs)) {
      try {
        unlinkSync(breaker);
      } catch {}
    }
    return;
  }
  try {
    const held = readLock(path);
    if (held && isStale(held, staleMs)) {
      try {
        unlinkSync(path);
      } catch {}
    }
  } finally {
    if (readLock(breaker)?.text === token) {
      try {
        unlinkSync(breaker);
      } catch {}
    }
  }
}

export function acquire(path, { timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS } = {}) {
  const token = newToken();
  const deadline = Date.now() + timeoutMs;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    if (create(path, token)) return token;
    const held = readLock(path);
    if (held && isStale(held, staleMs)) {
      reclaim(path, staleMs);
      // Retry at once only if the lock is gone. If another waiter holds the
      // breaker, wait like any other writer, so the deadline still applies.
      if (!readLock(path)) continue;
    }
    if (Date.now() > deadline) {
      throw new StoreError(BUSY, `busy: another writer holds ${path}, so nothing was written. Retry; if no review command is running, remove the lock file.`, { lock: path });
    }
    sleep(wait + Math.floor(Math.random() * wait));
  }
}

export function release(path, token) {
  if (readLock(path)?.text !== token) return;
  try {
    unlinkSync(path);
  } catch {}
}

export function withLock(path, fn, options) {
  const token = acquire(path, options);
  try {
    return fn();
  } finally {
    release(path, token);
  }
}
