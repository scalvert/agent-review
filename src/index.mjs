// The public entry point.
export const VERSION = "0.0.0";

export { canonicalJson, digestOf, sha256 } from "./core/digest.mjs";
export { StoreError, BUSY, CONFLICT, CORRUPT, INVALID, OP_ID_REUSED } from "./core/store/errors.mjs";
export { withLock, acquire, release, DEFAULT_TIMEOUT_MS, DEFAULT_STALE_MS } from "./core/store/lock.mjs";
export { writeFileAtomic } from "./core/store/atomic.mjs";
export { defaultStateRoot, keyFile, reviewPaths, legacyV1Path } from "./core/store/paths.mjs";
export { openLog, EVENT_SCHEMA, SNAPSHOT_SCHEMA } from "./core/store/event-log.mjs";
export { importLegacyV1, LEGACY_V1_SCHEMA, LEGACY_IMPORTED } from "./core/store/legacy-v1.mjs";

export { checkGlob, globToRegExp, matchPaths } from "./core/glob.mjs";
export { DEFAULT_POLICY, POLICY_FILE, SUPPORTED_VERSIONS, DEPTHS, CATEGORIES } from "./core/policy/defaults.mjs";
export { validateV1, v1Keys } from "./core/policy/validate.mjs";
export { PolicyError, parsePolicy, defaultPolicy, NOT_JSON, NO_VERSION, UNSUPPORTED_VERSION, INVALID as POLICY_INVALID, WEAKENING } from "./core/policy/load.mjs";
export { applyOverrides } from "./core/policy/overrides.mjs";
export { resolveDepth } from "./core/policy/depth.mjs";
export { trustedPolicy, POLICY_CHANGE } from "./core/policy/trust.mjs";

export { DECISION_KINDS, RUN_STATUSES, RUNNER_KINDS, defaultFamily } from "./core/workflow/kinds.mjs";
export { WorkflowError, REFUSED, STALE, INVALID as WORKFLOW_INVALID, FORBIDDEN, UNKNOWN_EVENT } from "./core/workflow/errors.mjs";
export { REDUCER_VERSION, initialState, reduce } from "./core/workflow/reducer.mjs";
export { openReview, activeRound } from "./core/workflow/review.mjs";
export { next, inbox } from "./core/workflow/next.mjs";
