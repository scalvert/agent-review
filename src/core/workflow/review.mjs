// The review lifecycle. Each operation reads the review, checks every
// requirement, and appends its events only if nobody wrote in between
// (expectSeq). If someone did, it reads again and checks again. A refused
// step throws a WorkflowError listing every unmet requirement.
//
//   start -> reviewing -> verifying -> reported   (complete once no
//                                                 escalation is open)
//   a new head, merge base or policy  -> the round is invalidated, and the
//                                        next start opens a new round
//
// People and agents call the same operations. Only a person (an actor
// starting with "human:") can accept a coverage gap or resolve an
// escalation. Actors are declared by the caller, not verified.
import { digestOf } from "../digest.mjs";
import { matchPaths } from "../glob.mjs";
import { resolveDepth } from "../policy/depth.mjs";
import { applyOverrides } from "../policy/overrides.mjs";
import { CATEGORIES } from "../policy/defaults.mjs";
import { trustedPolicy } from "../policy/trust.mjs";
import { CONFLICT } from "../store/errors.mjs";
import { openLog } from "../store/event-log.mjs";
import { DECISION_KINDS, DISPOSITIONS, MODEL, RUNNER_KINDS, RUN_STATUSES, defaultFamily } from "./kinds.mjs";
import { FORBIDDEN, INVALID, REFUSED, STALE, WorkflowError } from "./errors.mjs";
import { numberReport } from "./numbers.mjs";
import { REDUCER_VERSION, initialState, reduce } from "./reducer.mjs";

const MAX_ATTEMPTS = 8;
// Dispositions that say a finding is not a problem.
const CLEARING = ["wrong", "intended", "not-worth-it"];
const ACTOR = /^(human|agent):[^\s]/;

const reason = (code, message, extra = {}) => ({ code, message, ...extra });
const refuse = (message, reasons) => {
  throw new WorkflowError(REFUSED, message, reasons);
};
const invalid = (message) => {
  throw new WorkflowError(INVALID, message);
};

function checkActor(actor, { human = false } = {}) {
  if (typeof actor !== "string" || !ACTOR.test(actor)) invalid(`actor must be human:<name> or agent:<runtime>, got ${JSON.stringify(actor)}`);
  if (human && !actor.startsWith("human:")) throw new WorkflowError(FORBIDDEN, `only a person can do this; ${actor} is not human:<name>`);
}

function checkModel(model, what) {
  if (typeof model !== "string" || !MODEL.test(model)) invalid(`${what} must be provider/model, such as anthropic/opus, got ${JSON.stringify(model)}`);
}

// Findings are named by number: a candidate number before the report, a
// finding number after it (see numbers.mjs). Never by internal key.
function checkNumber(n, what) {
  if (!Number.isInteger(n) || n < 1) invalid(`${what} must be a number from 1, as the harness shows it, got ${JSON.stringify(n)}`);
}

// v1 rounds that count toward the round cap: one per head v1 reviewed.
export const legacyRounds = (state) => state.legacy.reduce((n, l) => n + (l.reviews ?? l.rounds ?? 0), 0);

const candidatesIn = (state, r) => state.findings.filter((f) => f.round === r.round);
const numbered = (state) => state.findings.filter((f) => f.number !== null).map((f) => f.number);
const listOf = (ns) => (ns.length ? ns.join(", ") : "none");

function candidateOf(state, r, n) {
  const f = candidatesIn(state, r).find((x) => x.candidate === n);
  if (!f) refuse(`no candidate ${n} in round ${r.round}`, [reason("unknown-candidate", `candidates in round ${r.round}: ${listOf(candidatesIn(state, r).map((x) => x.candidate))}`, { candidate: n })]);
  return f;
}

function findingOf(state, n) {
  const f = state.findings.find((x) => x.number === n);
  if (!f) refuse(`no finding ${n}`, [reason("unknown-finding", `findings in this review: ${listOf(numbered(state))}`, { finding: n })]);
  return f;
}

export const activeRound = (state) => (state.round ? state.rounds[state.round] : null);

// A string that parses as an https URL with a host, and has no whitespace.
function isHttpsUrl(url) {
  if (typeof url !== "string" || /\s/.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.length > 0;
  } catch {
    return false;
  }
}

function liveRound(state, { statuses }) {
  const r = activeRound(state);
  if (!r) refuse("no review has started", [reason("not-started", "start a review first")]);
  if (r.status === "invalidated") refuse(`round ${r.round} is invalidated`, [reason("invalidated", `round ${r.round} was invalidated (${r.invalidated.reason}); start a new round`)]);
  if (!statuses.includes(r.status)) refuse(`round ${r.round} is ${r.status}`, [reason("wrong-state", `this step needs the review to be ${statuses.join(" or ")}, but it is ${r.status}`)]);
  return r;
}

function checkHead(r, head) {
  if (head !== r.binding.head) {
    throw new WorkflowError(STALE, `this review is bound to ${r.binding.head}, but the caller worked on ${JSON.stringify(head)}`, [
      reason("stale-head", `review ${r.binding.head.slice(0, 12)}; if the change has new commits, start again to open a new round`),
    ]);
  }
}

export function openReview(root, ref, { familyOf = defaultFamily } = {}) {
  const log = openLog(root, ref, { reducer: reduce, initial: initialState(), reducerVersion: REDUCER_VERSION });

  // Read, decide, append if nothing moved; otherwise read and decide again.
  function mutate(decideEvents, { opId } = {}) {
    for (let attempt = 1; ; attempt++) {
      const { seq, state, events: logged } = log.read();
      // An operation ID names one operation. If it already ran, return its
      // result, before any state check: the review may have moved on since,
      // and a retry of a step that succeeded must not be refused.
      if (opId !== undefined) {
        const done = logged.filter((e) => e.op.id === opId);
        if (done.length) return { state, changed: false, seqs: done.map((e) => e.seq) };
      }
      const events = decideEvents(structuredClone(state));
      if (events.length === 0) return { state, changed: false };
      try {
        const r = log.append(events, { expectSeq: seq, opId });
        return { state: r.state, changed: !r.duplicate, seqs: r.seqs };
      } catch (e) {
        if (e.code !== CONFLICT || attempt >= MAX_ATTEMPTS) throw e;
      }
    }
  }

  const read = () => log.read().state;

  // Bind a round to the exact revisions and policy, or confirm the bound
  // one. Idempotent: the same inputs return the existing round.
  function start({ git, targetRef, head, lenses = [], depth: depthFlag = null, overrides = null, userDepth = null, suggestedDepth = "standard", pastCap = false, actor, opId }) {
    checkActor(actor);
    const tp = trustedPolicy({ git, targetRef, head });
    const resolved = applyOverrides(tp.trusted, overrides ?? {}, { source: "overrides" });
    const policy = resolved.policy;
    const mergeBase = git.mergeBase(tp.target.commit, tp.head);
    const changedPaths = git.changedPaths(mergeBase, tp.head);
    const depth = resolveDepth(policy, { flag: depthFlag, user: userDepth, suggested: suggestedDepth, changedPaths });
    for (const l of lenses) if (typeof l !== "string" || !/^[a-z][a-z0-9-]*$/.test(l)) invalid(`lens names are lowercase words, got ${JSON.stringify(l)}`);

    const names = [...new Set([...policy.review.requiredLenses, ...lenses])];
    const slots = names.map((lens) => ({ id: lens, lens }));
    // Enough slots for both minimums: each family needs at least one run.
    const need = Math.max(policy.review.minReviewers, policy.independence.minFamilies);
    for (let i = 2; slots.length < need; i++) slots.push({ id: `${names[0]}-${i}`, lens: names[0] });

    const binding = { target: tp.target, head: tp.head, mergeBase, policyDigest: resolved.effectiveDigest, policySourceDigest: tp.trusted.source.digest };

    return mutate((state) => {
      const r = activeRound(state);
      const events = [];
      if (r && r.status !== "invalidated") {
        const changed = ["head", "mergeBase", "policyDigest"].filter((k) => r.binding[k] !== binding[k]);
        // The target moving with the same merge base and policy leaves the
        // evidence valid; eligibility is recomputed at decision time.
        if (changed.length === 0) return [];
        events.push({ type: "review.invalidated", actor, data: { round: r.round, reason: `${changed.join(", ")} changed`, changed } });
      }
      const round = state.round + 1;
      // Rounds so far, counting v1 rounds this review was imported with. The
      // cap is on reviews of new code: a restart at the same head, because
      // the target's policy or the merge base moved, is not one, and neither
      // is a v1 retry at a head v1 had already reviewed.
      const prior = state.round + legacyRounds(state);
      const cap = policy.review.maxRounds;
      const newCode = !r || r.binding.head !== binding.head;
      if (newCode && prior >= cap) {
        if (!pastCap) {
          refuse(`this change has had ${prior} review rounds; the policy allows ${cap}`, [
            reason("round-cap", `later rounds mostly find older problems, not new ones; consider stepping back from the approach. A person can start another round with --past-cap`, { rounds: prior, cap }),
          ]);
        }
        checkActor(actor, { human: true });
      }
      events.push({
        type: "review.started",
        actor,
        data: {
          round,
          binding,
          policy: { source: tp.trusted.source, effectiveDigest: resolved.effectiveDigest, overrides: resolved.overrides, warnings: tp.trusted.warnings, resolved: policy },
          depth,
          pastCap: newCode && prior >= cap,
          plan: {
            slots,
            requirements: { minReviewers: policy.review.minReviewers, minFamilies: policy.independence.minFamilies, requiredLenses: policy.review.requiredLenses },
          },
          changedPaths: changedPaths.length,
        },
      });
      let n = state.escalations.length;
      for (const x of tp.escalations) events.push({ type: "escalation.raised", actor: "agent:harness", data: { id: `E${++n}`, round, code: x.code, message: x.message, path: x.path } });
      const hits = matchPaths(changedPaths, policy.escalation.paths).filter((h) => h.path !== tp.proposed?.path);
      for (const path of [...new Set(hits.map((h) => h.path))]) {
        const glob = hits.find((h) => h.path === path).glob;
        events.push({ type: "escalation.raised", actor: "agent:harness", data: { id: `E${++n}`, round, code: "escalation-path", message: `${path} matches escalation.paths ${glob}; a person must review it`, path } });
      }
      return events;
    }, { opId });
  }

  function recordRun({ slot, status, model = null, family = null, runner = { kind: "attested", name: "unknown" }, inputsDigest = null, findings = [], reason: why = null, head, actor, opId }) {
    checkActor(actor);
    if (!RUN_STATUSES.includes(status)) invalid(`status must be one of ${RUN_STATUSES.join(", ")}, got ${JSON.stringify(status)}`);
    if (!RUNNER_KINDS.includes(runner?.kind)) invalid(`runner.kind must be one of ${RUNNER_KINDS.join(", ")}`);
    if (status === "ok") checkModel(model, "model");
    else if (typeof why !== "string" || !why.trim()) invalid(`a ${status} run needs a reason`);
    if (status !== "ok" && findings.length) invalid(`a ${status} run cannot have findings`);
    if (!Array.isArray(findings)) invalid("findings must be a list");
    // A sparse list has holes that forEach skips and JSON cannot hold.
    if (Object.keys(findings).length !== findings.length) invalid("findings must not have empty slots");

    return mutate((state) => {
      const r = liveRound(state, { statuses: ["reviewing"] });
      checkHead(r, head);
      const planned = r.plan.slots.find((s) => s.id === slot);
      if (!planned) refuse(`no slot ${JSON.stringify(slot)}`, [reason("unknown-slot", `slots in this round: ${r.plan.slots.map((s) => s.id).join(", ")}`)]);
      const fam = status === "ok" ? (family ?? familyOf(model)) : null;
      const record = { round: r.round, slot, lens: planned.lens, status, model, family: fam, runner, inputsDigest, reason: why, findings: findings.length, findingsDigest: digestOf(findings) };
      const prior = r.runs[slot];
      if (prior?.status === "ok") {
        const same = prior.model === model && prior.findingsDigest === record.findingsDigest && prior.inputsDigest === inputsDigest;
        if (same) return [];
        refuse(`slot ${slot} already has a successful run`, [reason("slot-done", `slot ${slot} was recorded ok by ${prior.model}; a different result for the same slot is not accepted`)]);
      }

      const required = r.policy.resolved.evidence.finding;
      const problems = [];
      findings.forEach((f, i) => {
        if (!f || typeof f !== "object") return problems.push(reason("finding-shape", `finding ${i + 1} must be an object`));
        if (typeof f.title !== "string" || !f.title.trim()) problems.push(reason("finding-field", `finding ${i + 1}: title is required`, { index: i, field: "title" }));
        for (const k of required) {
          const v = f[k];
          const ok = k === "line" ? Number.isInteger(v) && v > 0 : typeof v === "string" && v.trim().length > 0;
          if (!ok) problems.push(reason("finding-field", `finding ${i + 1}: ${k} is required by policy evidence.finding`, { index: i, field: k }));
        }
        // Optional fields that reports and history use. Checked when present.
        const bad = (field, why) => problems.push(reason("finding-field", `finding ${i + 1}: ${field} ${why}`, { index: i, field }));
        if (f.class != null && !(typeof f.class === "string" && /^[a-z][a-z0-9-]*$/.test(f.class))) bad("class", "must be a kebab-case name, such as missing-await");
        if (f.axiom != null && !(typeof f.axiom === "string" && f.axiom.trim())) bad("axiom", "must be a nonempty string");
        const place = (x) => x && typeof x === "object" && typeof x.file === "string" && x.file.trim().length > 0 && (x.line == null || (Number.isInteger(x.line) && x.line > 0));
        // Array.from turns holes into undefined, so a sparse list fails here.
        if (f.instances != null && !(Array.isArray(f.instances) && Array.from(f.instances).every(place))) {
          bad("instances", "must be a list of { file, line }");
        }
      });
      if (problems.length) refuse("findings are missing required evidence", problems);

      const events = [{ type: "run.recorded", actor, data: record }];
      let n = state.findings.length;
      let candidate = candidatesIn(state, r).length;
      for (const f of findings) {
        const finding = {
          title: f.title,
          file: f.file ?? null,
          line: f.line ?? null,
          precondition: f.precondition ?? null,
          scenario: f.scenario ?? null,
          evidence: f.evidence ?? null,
          class: f.class ?? null,
          instances: (f.instances ?? []).map((x) => ({ file: x.file, line: x.line ?? null })),
          axiom: f.axiom ?? null,
          lens: planned.lens,
        };
        events.push({ type: "finding.added", actor, data: { round: r.round, id: `F${++n}`, candidate: ++candidate, author: { slot, model, family: fam }, finding } });
      }
      return events;
    }, { opId });
  }

  function acceptGap({ slot, reason: why, actor, opId }) {
    checkActor(actor, { human: true });
    if (typeof why !== "string" || !why.trim()) invalid("accepting a gap needs a reason");
    return mutate((state) => {
      const r = liveRound(state, { statuses: ["reviewing"] });
      if (!r.plan.slots.some((s) => s.id === slot)) refuse(`no slot ${JSON.stringify(slot)}`, [reason("unknown-slot", `slots: ${r.plan.slots.map((s) => s.id).join(", ")}`)]);
      if (r.runs[slot]?.status === "ok") refuse(`slot ${slot} ran successfully`, [reason("no-gap", `slot ${slot} has no gap to accept`)]);
      if (r.gaps[slot]) return [];
      return [{ type: "gap.accepted", actor, data: { round: r.round, slot, reason: why } }];
    }, { opId });
  }

  // What still blocks moving from reviewing to verifying.
  function coverageReasons(r) {
    const out = [];
    const ok = Object.values(r.runs).filter((x) => x.status === "ok");
    for (const s of r.plan.slots) {
      const run = r.runs[s.id];
      if (run?.status === "ok" || r.gaps[s.id]) continue;
      if (!run) out.push(reason("run-missing", `slot ${s.id} (${s.lens}) has not run`, { slot: s.id }));
      else out.push(reason(`run-${run.status}`, `slot ${s.id} (${s.lens}) ${run.status}: ${run.reason}; retry it, or a person accepts the gap`, { slot: s.id }));
    }
    const req = r.plan.requirements;
    if (ok.length < req.minReviewers) out.push(reason("too-few-reviewers", `${ok.length} successful reviewer runs; the policy needs ${req.minReviewers}`, { have: ok.length, need: req.minReviewers }));
    const families = [...new Set(ok.map((x) => x.family))];
    if (families.length < req.minFamilies) {
      out.push(reason("too-few-families", `reviewers came from ${families.length} model famil${families.length === 1 ? "y" : "ies"} (${families.join(", ") || "none"}); the policy needs ${req.minFamilies}`, { have: families, need: req.minFamilies }));
    }
    return out;
  }

  function advance({ actor, opId }) {
    checkActor(actor);
    return mutate((state) => {
      const r = liveRound(state, { statuses: ["reviewing"] });
      const reasons = coverageReasons(r);
      if (reasons.length) refuse("the panel is not complete", reasons);
      return [{ type: "review.advanced", actor, data: { round: r.round, to: "verifying" } }];
    }, { opId });
  }

  function decide({ candidate, kind, label, probability, rationale = null, verifier, head, actor, opId }) {
    checkActor(actor);
    checkNumber(candidate, "candidate");
    if (!DECISION_KINDS[kind]) invalid(`kind must be one of ${Object.keys(DECISION_KINDS).join(", ")}, got ${JSON.stringify(kind)}`);
    if (!DECISION_KINDS[kind].includes(label)) invalid(`${kind} label must be one of ${DECISION_KINDS[kind].join(", ")}, got ${JSON.stringify(label)}`);
    if (typeof probability !== "number" || !(probability >= 0 && probability <= 1)) invalid(`probability must be from 0 to 1, got ${JSON.stringify(probability)}`);
    checkModel(verifier?.model, "verifier.model");

    return mutate((state) => {
      const r = liveRound(state, { statuses: ["verifying"] });
      checkHead(r, head);
      const f = candidateOf(state, r, candidate);
      const finding = f.id;
      if (f.duplicateOf) {
        const into = state.findings.find((x) => x.id === f.duplicateOf).candidate;
        refuse(`candidate ${candidate} is a duplicate`, [reason("duplicate", `candidate ${candidate} was merged into candidate ${into}; decide on ${into}`, { candidate, into })]);
      }
      const policy = r.policy.resolved;
      const problems = [];
      if (policy.evidence.decision.includes("rationale") && !(typeof rationale === "string" && rationale.trim())) {
        problems.push(reason("decision-field", "rationale is required by policy evidence.decision"));
      }
      const fam = verifier.family ?? familyOf(verifier.model);
      const decision = { round: r.round, finding, kind, label, probability, rationale, verifier: { model: verifier.model, family: fam } };
      const earlier = f.decisions[kind] ?? [];
      const same = (x) => x && x.verifier.model === verifier.model && x.label === label && x.probability === probability && x.rationale === rationale;
      // A repeat is a no-op only if it matches what stands now. For
      // verification that is this verifier's own answer; for the other kinds
      // it is the latest decision, so changing a label and changing it back
      // is recorded, not dropped.
      if (kind === "finding-verification" ? earlier.some(same) : same(earlier.at(-1))) return [];
      // Every judgment about a finding, not only verification, comes from a
      // model independent of its author. Otherwise the author could rate its
      // own finding a nit, or triage away a judgment call.
      const independence = policy.independence.verifier;
      if (verifier.model === f.author.model) {
        problems.push(reason("verifier-not-independent", `${verifier.model} wrote this finding; a different model must make the ${kind} decision`, { author: f.author, verifier: decision.verifier }));
      } else if (independence === "family" && fam === f.author.family) {
        problems.push(reason("verifier-not-independent", `${verifier.model} is in the author's family (${fam}); the policy needs a model from another family for the ${kind} decision`, { author: f.author, verifier: decision.verifier }));
      }
      if (kind === "finding-verification") {
        if (earlier.some((x) => x.verifier.model === verifier.model)) {
          problems.push(reason("verifier-repeated", `${verifier.model} already verified candidate ${candidate}; a second verification needs a different model`));
        }
      }
      if (problems.length) refuse(`the ${kind} decision on candidate ${candidate} was not recorded`, problems);
      return [{ type: "decision.recorded", actor, data: decision }];
    }, { opId });
  }

  // Mark candidates as duplicates of a primary candidate, by candidate number.
  function merge({ into, duplicates, actor, opId }) {
    checkActor(actor);
    checkNumber(into, "into");
    if (!Array.isArray(duplicates) || duplicates.length === 0) invalid("merge needs the candidate numbers of the duplicates");
    for (const n of duplicates) checkNumber(n, "each duplicate");
    return mutate((state) => {
      const r = liveRound(state, { statuses: ["reviewing", "verifying"] });
      const inRound = (n) => candidatesIn(state, r).find((f) => f.candidate === n);
      const candidateOfId = (id) => state.findings.find((f) => f.id === id).candidate;
      const primary = inRound(into);
      const problems = [];
      const unknown = (n) => reason("unknown-candidate", `candidate ${n} is not part of round ${r.round}; candidates: ${listOf(candidatesIn(state, r).map((f) => f.candidate))}`, { candidate: n });
      if (!primary) problems.push(unknown(into));
      else if (primary.duplicateOf) problems.push(reason("duplicate", `candidate ${into} is itself a duplicate of candidate ${candidateOfId(primary.duplicateOf)}`, { candidate: into }));
      for (const n of duplicates) {
        const f = inRound(n);
        if (!f) problems.push(unknown(n));
        else if (n === into) problems.push(reason("self-merge", `candidate ${n} cannot be merged into itself`, { candidate: n }));
        else if (Object.keys(f.decisions).length) problems.push(reason("has-decisions", `candidate ${n} already has decisions; merge duplicates before verifying`, { candidate: n }));
      }
      if (problems.length) refuse("the merge was not recorded", problems);
      const todo = duplicates.map(inRound).filter((f) => f.duplicateOf !== primary.id).map((f) => f.id);
      return todo.length ? [{ type: "finding.merged", actor, data: { round: r.round, into: primary.id, ids: [...new Set(todo)] } }] : [];
    }, { opId });
  }

  // Which findings the report includes, and what is still missing.
  function reportPlan(state, r) {
    const policy = r.policy.resolved;
    const missing = [];
    const reported = [];
    const dropped = [];
    const escalate = [];
    for (const f of state.findings.filter((x) => x.round === r.round && !x.duplicateOf)) {
      const v = f.decisions["finding-verification"] ?? [];
      const c = { candidate: f.candidate };
      if (v.length === 0) {
        missing.push(reason("unverified", `candidate ${f.candidate} has no verification`, c));
        continue;
      }
      const labels = new Set(v.map((x) => x.label));
      if (labels.size > 1) {
        // A person settles the dispute, so the finding needs its severity and
        // origin first: if they say it is real, those decide what it blocks.
        if (!f.decisions["finding-severity"]?.length) missing.push(reason("no-severity", `candidate ${f.candidate} is disputed and has no severity; rate it so a person can settle it`, c));
        if (!f.decisions["finding-origin"]?.length) missing.push(reason("no-origin", `candidate ${f.candidate} is disputed and has no origin`, c));
        escalate.push({ finding: f.id, code: "verifiers-disagree", verdicts: v.map((x) => `${x.verifier.model}: ${x.label}`).join(", ") });
        continue;
      }
      const confirmed = labels.has("confirmed") && Math.min(...v.map((x) => x.probability)) >= policy.thresholds.report;
      if (!confirmed) {
        dropped.push(f.id);
        continue;
      }
      const sev = f.decisions["finding-severity"]?.at(-1)?.label;
      if (!sev) missing.push(reason("no-severity", `candidate ${f.candidate} is confirmed but has no severity`, c));
      if (!f.decisions["finding-origin"]?.length) missing.push(reason("no-origin", `candidate ${f.candidate} is confirmed but has no origin`, c));
      // Triage decides who acts on the finding after the report, and no
      // decision can be recorded once the round is reported.
      if (!f.decisions["finding-triage"]?.length) missing.push(reason("no-triage", `candidate ${f.candidate} is confirmed but has no triage`, c));
      if (sev === "blocker" && policy.independence.secondVerifierForBlockers && new Set(v.map((x) => x.verifier.model)).size < 2) {
        missing.push(reason("second-verifier", `candidate ${f.candidate} is a blocker; the policy needs a second verifier from a different model`, c));
      }
      reported.push(f.id);
    }
    return { missing, reported, dropped, escalate };
  }

  function report({ actor, opId }) {
    checkActor(actor);
    return mutate((state) => {
      const r = liveRound(state, { statuses: ["verifying"] });
      const p = reportPlan(state, r);
      if (p.missing.length) refuse("the report is not ready", p.missing);
      const escalated = p.escalate.map((x) => x.finding);
      // Reported and disputed findings get their numbers now, so the person
      // settling a dispute and the report name findings the same way.
      const numbers = numberReport(state, [...p.reported, ...escalated]);
      const numberOf = (id) => numbers.find((x) => x.finding === id).n;
      let n = state.escalations.length;
      const open = new Set(state.escalations.filter((x) => x.round === r.round && x.finding).map((x) => x.finding));
      const events = p.escalate.filter((x) => !open.has(x.finding)).map((x) => {
        const f = state.findings.find((y) => y.id === x.finding);
        const message = `verifiers disagree on finding ${numberOf(x.finding)}, ${f.title} (${x.verdicts}); a person decides whether it is real`;
        return { type: "escalation.raised", actor: "agent:harness", data: { id: `E${++n}`, round: r.round, code: x.code, message, finding: x.finding } };
      });
      const gaps = Object.entries(r.gaps).map(([slot, g]) => ({ slot, reason: g.reason, acceptedBy: g.actor }));
      events.push({
        type: "review.reported",
        actor,
        data: { round: r.round, report: { reported: p.reported, dropped: p.dropped, escalated, numbers, coverage: { complete: gaps.length === 0, gaps } } },
      });
      return events;
    }, { opId });
  }

  function resolveEscalation({ id, decision, reason: why, actor, opId }) {
    checkActor(actor, { human: true });
    if (!["approve", "reject"].includes(decision)) invalid(`decision must be approve or reject, got ${JSON.stringify(decision)}`);
    if (typeof why !== "string" || !why.trim()) invalid("resolving an escalation needs a reason");
    return mutate((state) => {
      const x = state.escalations.find((y) => y.id === id);
      if (!x) refuse(`no escalation ${JSON.stringify(id)}`, [reason("unknown-escalation", `open escalations: ${state.escalations.filter((y) => y.status === "open").map((y) => y.id).join(", ") || "none"}`)]);
      if (x.status !== "open") {
        if (x.resolution.decision === decision && x.resolution.reason === why) return [];
        refuse(`escalation ${id} is already ${x.status}`, [reason("resolved", `${id} was ${x.status} by ${x.resolution.actor}`)]);
      }
      if (x.round !== state.round || state.rounds[x.round].status === "invalidated") {
        refuse(`escalation ${id} belongs to an invalidated round`, [reason("invalidated", "start the review again; the new round raises its own escalations")]);
      }
      return [{ type: "escalation.resolved", actor, data: { id, decision, reason: why } }];
    }, { opId });
  }

  // Record what became of a reported finding, from this round or an earlier
  // one: a follow-up round is often where an older finding turns out fixed.
  // A finding triaged needs-judgment is a person's call, so only a person can
  // dispose of it.
  function dispose({ finding: number, as, note = null, actor, opId }) {
    checkActor(actor);
    checkNumber(number, "finding");
    if (!DISPOSITIONS.includes(as)) invalid(`disposition must be one of ${DISPOSITIONS.join(", ")}, got ${JSON.stringify(as)}`);
    return mutate((state) => {
      if (!activeRound(state)) refuse("no review has started", [reason("not-started", "start a review first")]);
      const f = findingOf(state, number);
      const finding = f.id;
      const r = state.rounds[f.round];
      // Reported findings, and disputed findings a person said are real. A
      // numbered finding that is neither is a dispute still open, or one a
      // person rejected.
      const dispute = state.escalations.find((x) => x.round === f.round && x.finding === finding);
      if (!r.report.reported.includes(finding) && dispute?.status !== "approved") {
        const why = dispute?.status === "rejected" ? `a person settled finding ${number} as not a problem` : `verifiers disagree on finding ${number}; a person settles that first${dispute ? ` (review resolve --escalation ${dispute.id})` : ""}`;
        refuse(`finding ${number} is not open`, [reason(dispute?.status === "rejected" ? "dispute-rejected" : "disputed", why, { finding: number })]);
      }
      if (f.decisions["finding-triage"]?.at(-1)?.label === "needs-judgment") checkActor(actor, { human: true });
      // Clearing a finding that would block a merge overrides an
      // independent verification, so only a person can do it.
      const disqualifying = r.policy.resolved.actions?.merge?.disqualifying ?? ["blocker", "should-fix"];
      const sev = f.decisions["finding-severity"]?.at(-1)?.label ?? null;
      if (CLEARING.includes(as) && (sev === null || disqualifying.includes(sev))) checkActor(actor, { human: true });
      if (f.disposition?.as === as && f.disposition?.note === note) return [];
      return [{ type: "finding.disposed", actor, data: { round: f.round, finding, as, note } }];
    }, { opId });
  }

  // Classify the change as a whole, such as deps-patch or feature. A
  // classification is evidence for the merge policy, never permission.
  function classify({ category, probability, rationale = null, classifier, head, actor, opId }) {
    checkActor(actor);
    if (!CATEGORIES.includes(category)) invalid(`category must be one of ${CATEGORIES.join(", ")}, got ${JSON.stringify(category)}`);
    if (typeof probability !== "number" || !(probability >= 0 && probability <= 1)) invalid(`probability must be from 0 to 1, got ${JSON.stringify(probability)}`);
    checkModel(classifier?.model, "classifier.model");
    return mutate((state) => {
      const r = liveRound(state, { statuses: ["reviewing", "verifying", "reported"] });
      checkHead(r, head);
      if (r.policy.resolved.evidence.decision.includes("rationale") && !(typeof rationale === "string" && rationale.trim())) {
        refuse("the classification was not recorded", [reason("decision-field", "rationale is required by policy evidence.decision")]);
      }
      const c = r.classification;
      // A different category can lift an escalation, such as
      // security-sensitive to deps-patch, so only a person can change it.
      if (c && c.category !== category) checkActor(actor, { human: true });
      if (c && c.category === category && c.probability === probability && c.rationale === rationale && c.classifier.model === classifier.model) return [];
      const fam = classifier.family ?? familyOf(classifier.model);
      return [{ type: "change.classified", actor, data: { round: r.round, category, probability, rationale, classifier: { model: classifier.model, family: fam } } }];
    }, { opId });
  }

  // Record the host's review thread that carries a finding, such as a GitHub
  // pull request comment, so replies in that thread can be traced back to it.
  function link({ finding: number, thread, url = null, actor, opId }) {
    checkActor(actor);
    checkNumber(number, "finding");
    if (typeof thread !== "string" || !thread.trim()) invalid("link needs a thread ID");
    if (url != null && !isHttpsUrl(url)) invalid(`url must be an https URL, got ${JSON.stringify(url)}`);
    return mutate((state) => {
      const f = findingOf(state, number);
      if (f.thread?.id === thread && f.thread.url === url) return [];
      return [{ type: "finding.linked", actor, data: { finding: f.id, thread, url } }];
    }, { opId });
  }

  return { log, read, start, recordRun, acceptGap, advance, decide, merge, report, resolveEscalation, dispose, classify, link, coverageReasons, reportPlan };
}
