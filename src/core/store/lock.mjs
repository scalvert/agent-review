// An exclusive lock on one path, for writers on one machine.
//
// The lock is a file created with O_EXCL. It holds the owner's PID and a
// random token. A lock whose process is gone, or that is older than staleMs,
// was left by a crash and is removed. A writer that cannot get the lock within
// timeoutMs fails with store/busy, having done nothing.
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

// Stale when its writer is gone, or when it is too old to belong to a
// running command, which also covers a reused PID. A lock with no content
// yet is being created right now, so only age can make it stale.
function isStale({ text, mtimeMs }, staleMs) {
  if (Date.now() - mtimeMs > staleMs) return true;
  try {
    return !alive(JSON.parse(text).pid);
  } catch {
    return false;
  }
}

export function acquire(path, { timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS } = {}) {
  const token = JSON.stringify({ pid: process.pid, token: randomBytes(8).toString("hex"), at: new Date().toISOString() });
  const deadline = Date.now() + timeoutMs;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const held = readLock(path);
    if (held && isStale(held, staleMs)) {
      // Remove it only if it is still the same stale lock, so a waiter does
      // not delete a lock another waiter just took.
      const again = readLock(path);
      if (again && again.text === held.text && again.mtimeMs === held.mtimeMs) {
        try {
          unlinkSync(path);
        } catch {}
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new StoreError(BUSY, `busy: another writer holds ${path}, so nothing was written. Retry; if nothing else is running, remove the lock file.`, { lock: path });
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
