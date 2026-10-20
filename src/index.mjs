// The public entry point.
export const VERSION = "0.0.0";

export { canonicalJson, digestOf, sha256 } from "./core/digest.mjs";
export { StoreError, BUSY, CONFLICT, CORRUPT, INVALID, OP_ID_REUSED } from "./core/store/errors.mjs";
export { withLock, acquire, release, DEFAULT_TIMEOUT_MS, DEFAULT_STALE_MS } from "./core/store/lock.mjs";
export { writeFileAtomic } from "./core/store/atomic.mjs";
export { defaultStateRoot, keyFile, reviewPaths, legacyV1Path } from "./core/store/paths.mjs";
export { openLog, EVENT_SCHEMA, SNAPSHOT_SCHEMA } from "./core/store/event-log.mjs";
export { importLegacyV1, LEGACY_V1_SCHEMA, LEGACY_IMPORTED } from "./core/store/legacy-v1.mjs";
