// Import a v1 ledger (schema scalvert.review/v1) into a review's event log.
//
// The import copies; it never moves, edits or deletes the v1 file, so the
// v1 tools keep working and a rollback needs no repair. The event records
// the file's digest and marks everything in it as legacy: findings and
// dispositions carry over as history, but a legacy round never counts as
// evidence for a policy that came later.
//
// Importing the same bytes as the latest import is a no-op. If the v1 file
// changed since the last import (v1 tools still write it during a
// migration), a new import event records the new content and supersedes the
// old one, even if that content matches an older import.
import { existsSync, readFileSync } from "node:fs";
import { sha256 } from "../digest.mjs";
import { checkRef } from "./paths.mjs";
import { StoreError, INVALID } from "./errors.mjs";

export const LEGACY_V1_SCHEMA = "scalvert.review/v1";
export const LEGACY_IMPORTED = "legacy.v1-imported";

export function importLegacyV1(log, ref, v1Path, { actor = "system:legacy-import" } = {}) {
  const { repo, key } = checkRef(ref);
  if (!existsSync(v1Path)) return { imported: false, reason: "no v1 ledger", path: v1Path };
  const bytes = readFileSync(v1Path);
  const digest = sha256(bytes);
  let ledger;
  try {
    ledger = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new StoreError(INVALID, `${v1Path}: not JSON, so it was not imported`);
  }
  if (ledger.schema !== LEGACY_V1_SCHEMA) {
    throw new StoreError(INVALID, `${v1Path}: schema ${JSON.stringify(ledger.schema)} is not ${LEGACY_V1_SCHEMA}, so it was not imported`);
  }
  if (ledger.repo !== repo || String(ledger.key) !== key) {
    throw new StoreError(INVALID, `${v1Path}: holds ${ledger.repo} ${ledger.key}, not ${repo} ${key}, so it was not imported`);
  }
  // Compare with the latest import of this file, not every earlier one: if
  // the file changed and then changed back, the old content is current again.
  const { events, seq } = log.read();
  const latest = events.filter((e) => e.type === LEGACY_IMPORTED && e.data.source?.path === v1Path).at(-1);
  if (latest?.data.source.digest === digest) return { imported: false, duplicate: true, digest, seq: latest.seq, path: v1Path };
  const result = log.append(
    [
      {
        type: LEGACY_IMPORTED,
        actor,
        data: {
          provenance: "legacy",
          source: { schema: LEGACY_V1_SCHEMA, path: v1Path, digest },
          rounds: ledger.rounds?.length ?? 0,
          findings: ledger.findings?.length ?? 0,
          ledger,
        },
      },
    ],
    // The ID names the content and the log position it follows, so a retry
    // of this import is recognized and a later re-import is not.
    { opId: `legacy-v1-import:${digest}:after-${seq}`, expectSeq: seq },
  );
  return { imported: !result.duplicate, duplicate: result.duplicate, digest, seq: result.seqs[0], path: v1Path };
}
