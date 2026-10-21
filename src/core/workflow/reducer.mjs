// Review state, rebuilt from the event log. Every event is applied the same
// way whether a person or an agent wrote it.
import { LEGACY_IMPORTED } from "../store/legacy-v1.mjs";
import { WorkflowError, UNKNOWN_EVENT } from "./errors.mjs";
import { numberReport } from "./numbers.mjs";

// Bump when the state shape changes, so cached snapshots are rebuilt.
export const REDUCER_VERSION = "review/5";

export const initialState = () => ({
  legacy: [],
  round: 0,
  rounds: {},
  findings: [],
  escalations: [],
});

const current = (s, round) => s.rounds[round];

export function reduce(state, e) {
  const s = state;
  const d = e.data;
  switch (e.type) {
    case LEGACY_IMPORTED:
      s.legacy = s.legacy.filter((l) => l.path !== d.source.path);
      s.legacy.push({ path: d.source.path, digest: d.source.digest, rounds: d.rounds, findings: d.findings, seq: e.seq });
      break;
    case "review.started":
      s.round = d.round;
      s.rounds[d.round] = {
        round: d.round,
        status: "reviewing",
        startedAt: e.at,
        startedBy: e.actor,
        binding: d.binding,
        policy: d.policy,
        depth: d.depth,
        // Started past the policy's round cap, by a person.
        pastCap: d.pastCap ?? false,
        plan: d.plan,
        runs: {},
        gaps: {},
        report: null,
        invalidated: null,
        classification: null,
      };
      break;
    case "change.classified":
      current(s, d.round).classification = { category: d.category, probability: d.probability, rationale: d.rationale, classifier: d.classifier, actor: e.actor, at: e.at };
      break;
    case "review.invalidated":
      current(s, d.round).status = "invalidated";
      current(s, d.round).invalidated = { reason: d.reason, changed: d.changed, at: e.at };
      break;
    case "run.recorded":
      current(s, d.round).runs[d.slot] = { ...d, at: e.at, actor: e.actor };
      break;
    case "gap.accepted":
      current(s, d.round).gaps[d.slot] = { reason: d.reason, actor: e.actor, at: e.at };
      break;
    case "finding.added":
      // Findings recorded by 0.1 have no class, instances or axiom. Before
      // 0.3 the event has no candidate number: it is the order in the round.
      s.findings.push({
        class: null,
        instances: [],
        axiom: null,
        ...d.finding,
        id: d.id,
        round: d.round,
        candidate: d.candidate ?? s.findings.filter((f) => f.round === d.round).length + 1,
        number: null,
        author: d.author,
        duplicateOf: null,
        decisions: {},
        disposition: null,
        thread: null,
      });
      break;
    case "finding.linked":
      s.findings.find((x) => x.id === d.finding).thread = { id: d.thread, url: d.url, actor: e.actor, at: e.at };
      break;
    case "finding.merged":
      for (const id of d.ids) s.findings.find((f) => f.id === id).duplicateOf = d.into;
      break;
    case "decision.recorded": {
      const f = s.findings.find((x) => x.id === d.finding);
      (f.decisions[d.kind] ??= []).push({ label: d.label, probability: d.probability, rationale: d.rationale, verifier: d.verifier, actor: e.actor, at: e.at, seq: e.seq });
      break;
    }
    case "finding.disposed": {
      const f = s.findings.find((x) => x.id === d.finding);
      f.disposition = { as: d.as, note: d.note, actor: e.actor, at: e.at };
      break;
    }
    case "review.advanced":
      current(s, d.round).status = d.to;
      break;
    case "review.reported": {
      // Before 0.3 the report has no numbers. They are given here the same
      // way the report gives them now, from the state at the report.
      const numbers = d.report.numbers ?? numberReport(s, [...d.report.reported, ...d.report.escalated]);
      for (const x of numbers) s.findings.find((f) => f.id === x.finding).number = x.n;
      // 0.2 raised its escalations just before this event, with messages
      // that name the finding by its key. Name it by its number instead.
      for (const x of s.escalations) nameByNumber(s, x);
      current(s, d.round).status = "reported";
      current(s, d.round).report = { ...d.report, numbers, at: e.at };
      break;
    }
    case "escalation.raised":
      s.escalations.push({ id: d.id, round: d.round, code: d.code, message: d.message, path: d.path ?? null, finding: d.finding ?? null, status: "open", raisedAt: e.at, resolution: null });
      nameByNumber(s, s.escalations.at(-1));
      break;
    case "escalation.resolved": {
      const x = s.escalations.find((y) => y.id === d.id);
      x.status = d.decision === "approve" ? "approved" : "rejected";
      x.resolution = { decision: d.decision, reason: d.reason, actor: e.actor, at: e.at };
      break;
    }
    default:
      // Fail closed: an event this version does not know might be one that
      // matters, such as an invalidation, so the review cannot be read.
      throw new WorkflowError(UNKNOWN_EVENT, `event ${e.seq} has type ${JSON.stringify(e.type)}, which this version of the harness does not know; upgrade the harness to read this review`);
  }
  return s;
}

// A message 0.2 wrote names its finding by key: "verifiers disagree on F1".
// Every output passes the message through, so it would show the key. Once
// the finding has a number, the message names that instead. The log keeps
// what was written. A message from 0.3 has no key, so this changes nothing.
function nameByNumber(s, x) {
  if (!x.finding) return;
  const n = s.findings.find((f) => f.id === x.finding)?.number;
  if (n == null) return;
  x.message = x.message.replace(new RegExp(`\\b${x.finding}\\b`, "g"), `finding ${n}`);
}
