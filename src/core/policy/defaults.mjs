// The built-in policy. A repository without a policy file gets this. It
// permits no external actions.
export const POLICY_FILE = "agent-review.json";
export const SUPPORTED_VERSIONS = [1];
export const DEPTHS = ["quick", "standard", "deep"];
export const VERIFIER_INDEPENDENCE = ["model", "family"];
export const CATEGORIES = ["docs", "tests", "deps-patch", "deps-other", "feature", "refactor", "policy", "security-sensitive"];

export const DEFAULT_POLICY = Object.freeze({
  version: 1,
  review: {
    // The depth when nobody chooses one. A default, not a floor.
    defaultDepth: null,
    // The lowest depth any review may run at.
    minDepth: "quick",
    // A changed path that matches one of these makes the review deep.
    deepPaths: [],
    // Lenses every review runs, whatever the depth.
    requiredLenses: ["correctness"],
    minReviewers: 1,
  },
  independence: {
    // Distinct model families across the panel.
    minFamilies: 2,
    // A verifier must differ from the finding's author by this much.
    verifier: "family",
    secondVerifierForBlockers: false,
  },
  evidence: {
    finding: ["file", "line", "precondition", "scenario", "evidence"],
    decision: ["rationale"],
  },
  thresholds: {
    // Report a finding when its verification probability is at least this.
    // These are model probabilities, not calibrated measurements.
    report: 0.7,
    // Below this classification probability, a person decides.
    classify: 0.8,
  },
  escalation: {
    // A change to any of these paths goes to a person.
    paths: [POLICY_FILE],
    // A change classified as any of these goes to a person.
    categories: ["policy", "security-sensitive"],
  },
  actions: {
    // Posting comments or reviews to the repository host.
    post: false,
    merge: { enabled: false, disqualifying: ["blocker", "should-fix"], rules: [] },
  },
});
