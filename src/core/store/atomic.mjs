// Replace a file so readers see the old content or the new, never a mix.
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";

export function writeFileAtomic(path, text) {
  // A unique name per writer, so two writers never rename each other's file.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
