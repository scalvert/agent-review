// The judgments models make about findings, and the labels each may take.
// The harness validates the label; it does not make the judgment.
export const DECISION_KINDS = {
  "finding-verification": ["confirmed", "refuted", "unclear"],
  "finding-severity": ["blocker", "should-fix", "nit"],
  "finding-triage": ["agent-fixable", "needs-judgment"],
  "finding-origin": ["introduced", "missed", "pre-existing"],
};

export const RUN_STATUSES = ["ok", "failed", "skipped"];
// executed: the harness ran the model itself and saw its output.
// attested: a caller says it ran the model. The harness cannot check that.
export const RUNNER_KINDS = ["executed", "attested"];

export const MODEL = /^[\w.-]+\/[\w.:@-]+$/;

// The family a model belongs to, when the caller does not say: the provider
// prefix. Callers that route through a gateway pass the family explicitly.
export const defaultFamily = (model) => String(model).split("/")[0].toLowerCase();
