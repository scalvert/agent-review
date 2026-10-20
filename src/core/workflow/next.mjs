// What the review needs next, and who it is waiting on. Agents loop on
// next(); a person can use it the same way. inbox() lists only what is
// waiting on a person, with one short ask each, so nobody wades through
// every finding.
import { activeRound } from "./review.mjs";

const pendingSlots = (r) => r.plan.slots.filter((s) => r.runs[s.id]?.status !== "ok" && !r.gaps[s.id]);

export function next(state) {
  const r = activeRound(state);
  const open = state.escalations.filter((x) => x.status === "open" && x.round === state.round);
  const human = open.map((x) => ({ escalation: x.id, code: x.code, ask: x.message }));

  if (!r) {
    return {
      status: "not-started",
      waitingOn: "agent",
      action: { do: "start" },
      human,
      note: state.legacy.length ? "this review has v1 history only; it has not been reviewed under a version 1 policy" : null,
    };
  }
  if (r.status === "invalidated") {
    return { status: "invalidated", round: r.round, waitingOn: "agent", action: { do: "start", why: r.invalidated.reason }, human: [] };
  }
  const base = { round: r.round, head: r.binding.head, depth: r.depth.depth };

  if (r.status === "reviewing") {
    const pending = pendingSlots(r);
    if (pending.length) {
      const failed = pending.filter((s) => r.runs[s.id]);
      return {
        status: "reviewing",
        ...base,
        waitingOn: "agent",
        action: {
          do: "run",
          slots: pending.map((s) => ({ slot: s.id, lens: s.lens, retry: Boolean(r.runs[s.id]), lastError: r.runs[s.id]?.reason ?? null })),
          requirements: r.plan.requirements,
          familiesSoFar: [...new Set(Object.values(r.runs).filter((x) => x.status === "ok").map((x) => x.family))],
        },
        human: [...human, ...failed.map((s) => ({ slot: s.id, code: "run-failed", ask: `slot ${s.id} failed (${r.runs[s.id].reason}); retry it, or accept the gap` }))],
      };
    }
    return { status: "reviewing", ...base, waitingOn: "agent", action: { do: "advance" }, human };
  }

  if (r.status === "verifying") {
    const findings = state.findings.filter((f) => f.round === r.round && !f.duplicateOf);
    const policy = r.policy.resolved;
    const verify = findings
      .filter((f) => !(f.decisions["finding-verification"] ?? []).length)
      .map((f) => ({
        finding: f.id,
        author: f.author,
        verifierMust: policy.independence.verifier === "family" ? { notFamily: f.author.family } : { notModel: f.author.model },
      }));
    if (verify.length) return { status: "verifying", ...base, waitingOn: "agent", action: { do: "verify", findings: verify }, human };
    const classify = [];
    const again = [];
    for (const f of findings) {
      const v = f.decisions["finding-verification"];
      const confirmed = v.every((x) => x.label === "confirmed") && Math.min(...v.map((x) => x.probability)) >= policy.thresholds.report;
      if (!confirmed) continue;
      const kinds = ["finding-severity", "finding-origin", "finding-triage"].filter((k) => !f.decisions[k]?.length);
      if (kinds.length) classify.push({ finding: f.id, kinds });
      if (f.decisions["finding-severity"]?.at(-1)?.label === "blocker" && policy.independence.secondVerifierForBlockers && new Set(v.map((x) => x.verifier.model)).size < 2) {
        again.push({ finding: f.id, verifierMust: { notModels: [f.author.model, ...v.map((x) => x.verifier.model)], ...(policy.independence.verifier === "family" ? { notFamily: f.author.family } : {}) } });
      }
    }
    if (classify.length) return { status: "verifying", ...base, waitingOn: "agent", action: { do: "classify", findings: classify }, human };
    if (again.length) return { status: "verifying", ...base, waitingOn: "agent", action: { do: "verify-again", findings: again }, human };
    return { status: "verifying", ...base, waitingOn: "agent", action: { do: "report" }, human };
  }

  // reported: the review is done once no escalation is open. Judgment calls
  // on reported findings still wait on a person, and are listed for them.
  const calls = state.findings
    .filter((f) => f.round === r.round && r.report.reported.includes(f.id) && !f.disposition && f.decisions["finding-triage"]?.at(-1)?.label === "needs-judgment")
    .map((f) => ({ finding: f.id, code: "needs-judgment", ask: `${f.id}: ${f.title} (${f.file ?? "no file"}${f.line ? `:${f.line}` : ""}) needs your call` }));
  if (open.length) return { status: "reported", ...base, waitingOn: "human", action: { do: "resolve", escalations: open.map((x) => x.id) }, human: [...human, ...calls], report: r.report };
  return { status: "complete", ...base, waitingOn: calls.length ? "human" : null, action: calls.length ? { do: "dispose", findings: calls.map((c) => c.finding) } : null, human: calls, report: r.report };
}

// reviews: [{ ref: { repo, key }, state }]
export function inbox(reviews) {
  const items = [];
  for (const { ref, state } of reviews) {
    const n = next(state);
    for (const h of n.human) items.push({ repo: ref.repo, key: ref.key, round: n.round ?? null, ...h });
  }
  return items;
}
