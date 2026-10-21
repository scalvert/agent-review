// Merge eligibility: a pure function of the review, its trusted policy, and
// facts observed from the repository host at decision time. It returns
// eligible, blocked or escalate, with every reason and the exact inputs it
// evaluated. It never acts.
//
// facts (from adapters; see docs/eligibility.md):
//   observedAt, target: { ref, commit }, head, mergeBase, policyDigest,
//   changedPaths, author: { login, type }, commits: [{ sha, verified, author }],
//   checks: { required: [names] | null, runs: [{ name, headSha, status, conclusion }] },
//   approvals: { count, required }, branchProtection: { known, satisfied },
//   dependencyChanges: null | [{ name, from, to, change, source }]
import { digestOf } from "../digest.mjs";
import { matchPaths } from "../glob.mjs";
import { activeRound } from "../workflow/review.mjs";
import { versionChange } from "./semver.mjs";

export const ELIGIBLE = "eligible";
export const BLOCKED = "blocked";
export const ESCALATE = "escalate";

// Dispositions that say a reported finding is not a problem for this head.
const CLEARED = new Set(["wrong", "intended", "not-worth-it"]);

const block = (code, message, extra = {}) => ({ effect: BLOCKED, code, message, ...extra });
const escalate = (code, message, extra = {}) => ({ effect: ESCALATE, code, message, ...extra });

function ruleReasons(rule, { facts, classification }) {
  const out = [];
  const r = { requireVerifiedCommits: true, dependencies: null, minApprovals: 0, ...rule };
  if (!classification || !r.categories.includes(classification.category)) {
    out.push(`the change is classified ${classification?.category ?? "nothing yet"}, not ${r.categories.join(" or ")}`);
  }
  const login = facts.author?.login;
  if (!login || !r.authors.includes(login)) out.push(`the author is ${login ?? "unknown"}, not ${r.authors.join(" or ")}`);
  if (r.requireVerifiedCommits) {
    const commits = facts.commits ?? [];
    if (commits.length === 0) out.push("the commits are unknown");
    for (const c of commits) {
      if (c.verified !== true) out.push(`commit ${String(c.sha).slice(0, 12)} has no verified signature`);
      if (!c.author || !r.authors.includes(c.author)) out.push(`commit ${String(c.sha).slice(0, 12)} was authored by ${c.author ?? "an unknown account"}`);
    }
  }
  const paths = facts.changedPaths ?? [];
  if (paths.length === 0) out.push("no changed paths are known");
  const allowed = new Set(matchPaths(paths, r.paths).map((m) => m.path));
  for (const p of paths) if (!allowed.has(p)) out.push(`${p} is outside the rule's paths`);
  if (r.dependencies === "patch") {
    const changes = facts.dependencyChanges;
    if (!Array.isArray(changes) || changes.length === 0) out.push("no dependency changes were found, so none can be shown to be patch updates");
    else {
      for (const d of changes) {
        const kind = d.change === "changed" ? versionChange(d.from, d.to) : d.change;
        if (kind !== "patch") out.push(`${d.name} ${d.from ?? "(none)"} -> ${d.to ?? "(none)"} is ${kind}, not a patch update`);
      }
    }
  }
  const need = Math.max(r.minApprovals, facts.approvals?.required ?? 0);
  if ((facts.approvals?.count ?? 0) < need) out.push(`${facts.approvals?.count ?? 0} approvals; ${need} needed`);
  return out;
}

export function evaluateEligibility({ state, facts }) {
  const reasons = [];
  const r = activeRound(state);
  const provenance = {
    round: r?.round ?? null,
    binding: r?.binding ?? null,
    observed: {
      at: facts.observedAt ?? null,
      head: facts.head ?? null,
      mergeBase: facts.mergeBase ?? null,
      target: facts.target ?? null,
      policyDigest: facts.policyDigest ?? null,
      checks: digestOf(facts.checks ?? null),
      approvals: facts.approvals ?? null,
    },
    factsDigest: digestOf(facts),
    rule: null,
  };
  const done = (outcome) => ({ outcome, reasons, provenance });

  if (!r) {
    reasons.push(block("no-review", state.legacy?.length ? "only v1 history exists; there is no review under a version 1 policy" : "no review has started"));
    return done(BLOCKED);
  }
  if (r.status === "invalidated") {
    reasons.push(block("review-invalidated", `round ${r.round} was invalidated (${r.invalidated.reason}); review the new head`));
    return done(BLOCKED);
  }

  // The review must be for exactly what would merge, under the policy that
  // governs it now.
  if (facts.head !== r.binding.head) reasons.push(block("head-changed", `the head is now ${String(facts.head).slice(0, 12)}; the review covers ${r.binding.head.slice(0, 12)}`));
  if (facts.mergeBase !== r.binding.mergeBase) reasons.push(block("merge-base-changed", `the merge base is now ${String(facts.mergeBase).slice(0, 12)}; the review covers ${r.binding.mergeBase.slice(0, 12)}`));
  if (facts.policyDigest !== r.binding.policyDigest) reasons.push(block("policy-changed", "the trusted policy changed since the review started"));

  const policy = r.policy.resolved;
  const merge = policy.actions.merge;
  if (!merge.enabled) reasons.push(block("merge-disabled", "the policy does not enable merge eligibility (actions.merge.enabled)"));

  const open = state.escalations.filter((x) => x.round === r.round && x.status === "open");
  if (r.status !== "reported") reasons.push(block("review-incomplete", `the review is ${r.status}, not reported`));
  for (const x of open) reasons.push(escalate("escalation-open", `${x.id} is open: ${x.message}`, { escalation: x.id }));
  for (const x of state.escalations.filter((y) => y.round === r.round && y.status === "rejected")) {
    reasons.push(block("escalation-rejected", `${x.id} was rejected by ${x.resolution.actor}: ${x.resolution.reason}`, { escalation: x.id }));
  }

  if (r.report) {
    if (!r.report.coverage.complete) reasons.push(block("coverage-gaps", `the panel ran with gaps: ${r.report.coverage.gaps.map((g) => g.slot).join(", ")}`));
    const byId = new Map(state.findings.map((f) => [f.id, f]));
    const approvedEscalations = new Set(state.escalations.filter((x) => x.round === r.round && x.finding && x.status === "approved").map((x) => x.finding));
    for (const id of [...r.report.reported, ...r.report.escalated.filter((x) => approvedEscalations.has(x))]) {
      const f = byId.get(id);
      const sev = f.decisions["finding-severity"]?.at(-1)?.label ?? null;
      if (f.disposition && CLEARED.has(f.disposition.as)) continue;
      if (f.decisions["finding-triage"]?.at(-1)?.label === "needs-judgment" && !f.disposition) {
        reasons.push(escalate("needs-judgment", `${id} needs a person's call: ${f.title}`, { finding: id }));
      } else if (sev === null || merge.disqualifying.includes(sev)) {
        reasons.push(block("disqualifying-finding", `${id} (${sev ?? "unrated"}) is unresolved${f.disposition ? ` (${f.disposition.as})` : ""}: ${f.title}`, { finding: id }));
      }
    }
  }

  // Classification is evidence. Missing, uncertain or sensitive goes to a person.
  const c = r.classification;
  if (!c) reasons.push(escalate("unclassified", "the change has not been classified"));
  else {
    if (c.probability < policy.thresholds.classify) reasons.push(escalate("uncertain-classification", `classified ${c.category} with probability ${c.probability}, below ${policy.thresholds.classify}`));
    if (policy.escalation.categories.includes(c.category)) reasons.push(escalate("escalation-category", `the change is classified ${c.category}, which goes to a person`));
  }

  // Required checks for the exact head, and branch protection.
  const runs = (facts.checks?.runs ?? []).filter((x) => x.headSha === facts.head);
  if (facts.checks?.required == null) reasons.push(block("required-checks-unknown", "the required checks are unknown, so they cannot be shown to pass"));
  else {
    for (const name of facts.checks.required) {
      const run = runs.filter((x) => x.name === name).at(-1);
      if (!run) reasons.push(block("check-missing", `required check ${name} has not run on ${String(facts.head).slice(0, 12)}`));
      else if (run.status !== "completed" || run.conclusion !== "success") reasons.push(block("check-not-green", `required check ${name} is ${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`));
    }
  }
  for (const run of runs) if (["failure", "timed_out", "cancelled", "action_required"].includes(run.conclusion)) reasons.push(block("check-failed", `check ${run.name} ended ${run.conclusion}`));
  if (!facts.branchProtection?.known) reasons.push(block("branch-protection-unknown", "branch protection could not be read"));
  else if (facts.branchProtection.satisfied !== true) reasons.push(block("branch-protection", "branch protection is not satisfied"));

  // A rule must match. Without one, the change merges by hand.
  if (merge.enabled) {
    const misses = [];
    const hit = merge.rules.find((rule) => {
      const why = ruleReasons(rule, { facts, classification: c });
      if (why.length) misses.push({ rule: rule.name, why });
      return why.length === 0;
    });
    if (hit) provenance.rule = hit.name;
    else reasons.push(block("no-rule-matches", "no merge rule matches; merge by hand", { rules: misses }));
  }

  if (reasons.some((x) => x.effect === BLOCKED)) return done(BLOCKED);
  if (reasons.some((x) => x.effect === ESCALATE)) return done(ESCALATE);
  return done(ELIGIBLE);
}
