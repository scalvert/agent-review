// How findings are named. Each has two numbers that people and agents use,
// and an internal key that neither ever sees.
//
//   candidate  a reviewer's claim in a round: 1, 2, 3 in the order the
//              claims were recorded. Merging and verifying use it, before
//              anything is reported.
//   number     a finding the report shows: 1, 2, 3 in report order. A
//              round's findings are numbered when it reports, after the
//              numbers earlier rounds used, so a number names one finding
//              for the whole review and never changes.
//
// The internal key (F1, F2 in the event log) only ties events together. No
// command takes it and no output shows it.

// Report sections, in report order.
export const SECTIONS = ["blockers", "should-fix", "pre-existing", "smaller", "unrated"];

// Where a finding goes in the report, from its latest severity and origin.
// Only an introduced finding can be a blocker: a missed or pre-existing
// blocker is moved to should-fix.
export function placement(f) {
  const severity = f.decisions["finding-severity"]?.at(-1)?.label ?? null;
  const origin = f.decisions["finding-origin"]?.at(-1)?.label ?? "introduced";
  const capped = severity === "blocker" && origin !== "introduced";
  const effective = capped ? "should-fix" : severity;
  let section = "smaller";
  if (effective === "blocker") section = "blockers";
  else if (effective === "should-fix") section = origin === "pre-existing" ? "pre-existing" : "should-fix";
  else if (effective === null) section = "unrated";
  return { severity: effective, origin, cappedFrom: capped ? "blocker" : null, section };
}

// A plain comparison, so the order is the same in every locale.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The numbers a round's report gives its findings: in section order, then by
// file, line and candidate, after the highest number already given.
// ids are internal keys, as the report event holds them.
export function numberReport(state, ids) {
  let n = Math.max(0, ...state.findings.map((f) => f.number ?? 0));
  const order = (f) => SECTIONS.indexOf(placement(f).section);
  return ids
    .map((id) => state.findings.find((f) => f.id === id))
    .sort((a, b) => order(a) - order(b) || cmp(String(a.file ?? ""), String(b.file ?? "")) || (a.line ?? 0) - (b.line ?? 0) || a.candidate - b.candidate)
    .map((f) => ({ n: ++n, finding: f.id, section: placement(f).section }));
}

// A round's report as people and agents see it: numbers, never keys.
export function publicReport(state, report) {
  if (!report) return null;
  const by = new Map(state.findings.map((f) => [f.id, f]));
  return {
    findings: report.numbers.filter((x) => report.reported.includes(x.finding)).map((x) => ({ n: x.n, section: x.section })),
    disputed: report.numbers.filter((x) => report.escalated.includes(x.finding)).map((x) => x.n),
    dropped: report.dropped.map((id) => by.get(id).candidate),
    coverage: report.coverage,
    at: report.at,
  };
}

// The full review state, with every finding named by its numbers. This is
// what review status prints.
export function publicState(state) {
  const s = structuredClone(state);
  const by = new Map(state.findings.map((f) => [f.id, f]));
  for (const r of Object.values(s.rounds)) r.report = publicReport(state, state.rounds[r.round].report);
  s.findings = s.findings.map(({ id, duplicateOf, ...f }) => ({ ...f, duplicateOf: duplicateOf ? by.get(duplicateOf).candidate : null }));
  s.escalations = s.escalations.map((x) => ({ ...x, finding: x.finding ? by.get(x.finding).number : null }));
  return s;
}
