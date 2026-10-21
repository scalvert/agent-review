// Short text output for people. Agents get JSON; a person at a terminal gets
// a few lines: where the review is, what happens next, and what needs them.
const short = (sha) => (sha ? sha.slice(0, 12) : "");

function action(a) {
  if (!a) return "nothing; the review is complete";
  switch (a.do) {
    case "start":
      return a.why ? `start a new round (${a.why})` : "start the review";
    case "run":
      return `run ${a.slots.map((s) => (s.retry ? `${s.slot} (retry: ${s.lastError})` : s.slot)).join(", ")}; needs ${a.requirements.minFamilies} model families, has ${a.familiesSoFar.length ? a.familiesSoFar.join(", ") : "none"}`;
    case "advance":
      return "advance to verification";
    case "verify":
      return `verify ${a.findings.map((f) => `${f.finding} (not ${f.verifierMust.notFamily ?? f.verifierMust.notModel})`).join(", ")}`;
    case "decide":
      return `decide ${a.findings.map((f) => `${f.finding}: ${f.kinds.map((k) => k.replace("finding-", "")).join(", ")}`).join("; ")}`;
    case "classify":
      return "classify the change (review classify)";
    case "verify-again":
      return `second verifier for ${a.findings.map((f) => f.finding).join(", ")}`;
    case "report":
      return "write the report";
    case "resolve":
      return `a person resolves ${a.escalations.join(", ")}`;
    case "dispose":
      return `a person decides ${a.findings.join(", ")} (review dispose)`;
    default:
      return a.do;
  }
}

export function renderNext(n) {
  const head = n.round ? `round ${n.round} at ${short(n.head)}, ${n.depth}` : "no round yet";
  const lines = [`${n.status} (${head})`];
  if (n.note) lines.push(`note: ${n.note}`);
  lines.push(`next: ${action(n.action)}${n.waitingOn ? ` [${n.waitingOn}]` : ""}`);
  for (const h of n.human ?? []) lines.push(`for a person: ${h.ask}${h.escalation ? ` (${h.escalation})` : ""}`);
  if (n.report) {
    const r = n.report;
    lines.push(`report: ${r.reported.length} reported${r.reported.length ? ` (${r.reported.join(", ")})` : ""}, ${r.dropped.length} dropped, ${r.escalated.length} escalated${r.coverage.complete ? "" : `; coverage gaps: ${r.coverage.gaps.map((g) => g.slot).join(", ")}`}`);
  }
  return lines.join("\n");
}

export function renderInbox(items) {
  if (!items.length) return "Nothing needs you.";
  return items.map((i) => `${i.repo} ${i.key}: ${i.ask}${i.escalation ? ` (${i.escalation})` : ""}`).join("\n");
}

export function renderEligibility(e) {
  // Name the rule only when it decided the outcome, so a blocked result does
  // not read as if the rule blocked it.
  const from = e.provenance.factsSource === "github" ? "" : `; simulated from ${e.provenance.factsSource} facts`;
  const lines = [`${e.outcome}${e.outcome === "eligible" && e.provenance.rule ? ` (rule ${e.provenance.rule})` : ""}${from}`];
  for (const r of e.reasons) {
    lines.push(`  ${r.effect === "blocked" ? "blocks" : "for a person"}: ${r.message}`);
    for (const miss of r.rules ?? []) lines.push(`    rule ${miss.rule}: ${miss.why.join("; ")}`);
  }
  return lines.join("\n");
}

export function renderError(e) {
  const reasons = e.reasons ?? e.errors ?? [];
  return [`refused: ${e.message.split("\n")[0]}`, ...reasons.map((r) => `  - ${r.path ? `${r.path}: ` : ""}${r.message}`)].join("\n");
}
