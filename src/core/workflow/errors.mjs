// A refused workflow step. reasons lists every unmet requirement, each with
// a code, so a caller can act on all of them at once.
export class WorkflowError extends Error {
  constructor(code, message, reasons = []) {
    super(reasons.length ? `${message}\n${reasons.map((r) => `  - ${r.message}`).join("\n")}` : message);
    this.name = "WorkflowError";
    this.code = code;
    this.reasons = reasons;
  }
}

// A step whose requirements are not met yet.
export const REFUSED = "workflow/refused";
// The caller reviewed a different revision than the review is bound to.
export const STALE = "workflow/stale";
// Input that is malformed.
export const INVALID = "workflow/invalid";
// A step this actor may not take, such as an agent accepting a gap.
export const FORBIDDEN = "workflow/forbidden";
// The log has an event this version of the harness does not know.
export const UNKNOWN_EVENT = "workflow/unknown-event";
