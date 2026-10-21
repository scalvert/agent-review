// agent-review: the review harness on the command line. People and agents
// run the same commands. Output is JSON, unless stdout is a terminal or
// --text is given; --json forces JSON.
//
// This module has no side effects, so a consumer can bundle it and call
// main() itself. The bin is main.mjs. A refused step prints
// {"error": {code, message, reasons}} on stderr and exits 1; a usage error
// exits 2.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gitAdapter } from "../adapters/git.mjs";
import {
  inbox,
  listReviews,
  next,
  openReview,
  parsePolicy,
  trustedPolicy,
  POLICY_FILE,
} from "../index.mjs";
import { renderEligibility, renderError, renderInbox, renderNext } from "./render.mjs";
import { cliStateRoot } from "./state-root.mjs";

// The state root the command line uses, for consumers that read the same
// reviews.
export { cliStateRoot };
import { githubFacts } from "../adapters/github.mjs";
import { npmDependencyChanges } from "../adapters/npm.mjs";
import { activeRound, dryRunExecutor, evaluateEligibility, importLegacyV1, legacyV1Path, localFacts, prepareMerge } from "../index.mjs";

class UsageError extends Error {}

const COMMON = {
  repo: { type: "string" },
  key: { type: "string" },
  actor: { type: "string" },
  state: { type: "string" },
  cwd: { type: "string" },
  "op-id": { type: "string" },
  json: { type: "boolean" },
  text: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const COMMANDS = {
  "review start": {
    summary: "Start a review round bound to the head, merge base and trusted policy, or confirm the current one.",
    options: { target: { type: "string" }, head: { type: "string" }, lenses: { type: "string" }, depth: { type: "string" }, "user-depth": { type: "string" }, "past-cap": { type: "boolean" } },
    run: (o, h) => h.review().start({ git: h.git(), targetRef: h.target(o.target), head: o.head ?? "HEAD", lenses: list(o.lenses), depth: o.depth ?? null, userDepth: o["user-depth"] ?? null, pastCap: o["past-cap"] === true, actor: h.actor(), opId: o["op-id"] }),
  },
  "review run": {
    summary: "Record one reviewer slot's run: ok with findings, or failed or skipped with a reason.",
    options: { slot: { type: "string" }, status: { type: "string" }, model: { type: "string" }, family: { type: "string" }, findings: { type: "string" }, reason: { type: "string" }, runner: { type: "string" }, head: { type: "string" } },
    run: (o, h) =>
      h.review().recordRun({
        slot: need(o, "slot"),
        status: need(o, "status"),
        model: o.model ?? null,
        family: o.family ?? null,
        findings: o.findings ? readJson(o.findings) : [],
        reason: o.reason ?? null,
        // Runs recorded from the command line are always attested.
        runner: { kind: "attested", name: o.runner ?? "cli" },
        head: h.head(need(o, "head")),
        actor: h.actor(),
        opId: o["op-id"],
      }),
  },
  "review accept-gap": {
    summary: "Let the panel go ahead without a slot that did not run. People only.",
    options: { slot: { type: "string" }, reason: { type: "string" } },
    run: (o, h) => h.review().acceptGap({ slot: need(o, "slot"), reason: need(o, "reason"), actor: h.actor(), opId: o["op-id"] }),
  },
  "review advance": {
    summary: "Move from reviewing to verifying, once the panel is complete.",
    options: {},
    run: (o, h) => h.review().advance({ actor: h.actor(), opId: o["op-id"] }),
  },
  "review merge": {
    summary: "Mark findings as duplicates of a primary finding.",
    options: { into: { type: "string" }, ids: { type: "string" } },
    run: (o, h) => h.review().merge({ into: need(o, "into"), ids: list(need(o, "ids")), actor: h.actor(), opId: o["op-id"] }),
  },
  "review decide": {
    summary: "Record a verification, severity, triage or origin decision on a finding.",
    options: {
      finding: { type: "string" },
      kind: { type: "string" },
      label: { type: "string" },
      probability: { type: "string" },
      rationale: { type: "string" },
      "rationale-file": { type: "string" },
      "verifier-model": { type: "string" },
      "verifier-family": { type: "string" },
      head: { type: "string" },
    },
    run: (o, h) => {
      if (o.rationale != null && o["rationale-file"] != null) throw new UsageError("use --rationale or --rationale-file, not both");
      const p = Number(need(o, "probability"));
      return h.review().decide({
        finding: need(o, "finding"),
        kind: need(o, "kind"),
        label: need(o, "label"),
        probability: p,
        rationale: o["rationale-file"] != null ? readText(o["rationale-file"]).trim() : (o.rationale ?? null),
        verifier: { model: need(o, "verifier-model"), family: o["verifier-family"] ?? null },
        head: h.head(need(o, "head")),
        actor: h.actor(),
        opId: o["op-id"],
      });
    },
  },
  "review report": {
    summary: "Produce the report, once every finding has the decisions it needs.",
    options: {},
    run: (o, h) => h.review().report({ actor: h.actor(), opId: o["op-id"] }),
  },
  "review resolve": {
    summary: "Approve or reject an escalation. People only.",
    options: { escalation: { type: "string" }, decision: { type: "string" }, reason: { type: "string" } },
    run: (o, h) => h.review().resolveEscalation({ id: need(o, "escalation"), decision: need(o, "decision"), reason: need(o, "reason"), actor: h.actor(), opId: o["op-id"] }),
  },
  "review dispose": {
    summary: "Record what became of a reported finding. A needs-judgment finding is a person's call.",
    // --note-file reads the note from a file, or stdin with -, so text copied
    // from a pull request never passes through a shell string.
    options: { finding: { type: "string" }, as: { type: "string" }, note: { type: "string" }, "note-file": { type: "string" } },
    run: (o, h) => {
      if (o.note != null && o["note-file"] != null) throw new UsageError("use --note or --note-file, not both");
      const note = o["note-file"] != null ? readText(o["note-file"]).trim() : (o.note ?? null);
      return h.review().dispose({ finding: need(o, "finding"), as: need(o, "as"), note, actor: h.actor(), opId: o["op-id"] });
    },
  },
  "review link": {
    summary: "Record the host's review thread that carries a finding, such as a pull request comment.",
    options: { finding: { type: "string" }, thread: { type: "string" }, url: { type: "string" } },
    run: (o, h) => h.review().link({ finding: need(o, "finding"), thread: need(o, "thread"), url: o.url ?? null, actor: h.actor(), opId: o["op-id"] }),
  },
  "review classify": {
    summary: "Classify the change as a whole, such as deps-patch or feature. Evidence for the merge policy, never permission.",
    options: { category: { type: "string" }, probability: { type: "string" }, rationale: { type: "string" }, "classifier-model": { type: "string" }, "classifier-family": { type: "string" }, head: { type: "string" } },
    run: (o, h) =>
      h.review().classify({
        category: need(o, "category"),
        probability: Number(need(o, "probability")),
        rationale: o.rationale ?? null,
        classifier: { model: need(o, "classifier-model"), family: o["classifier-family"] ?? null },
        head: h.head(need(o, "head")),
        actor: h.actor(),
        opId: o["op-id"],
      }),
  },
  "eligibility check": {
    summary: "Decide whether the reviewed change may merge under the policy: eligible, blocked or escalate, with every reason. Never merges.",
    options: { pr: { type: "string" }, facts: { type: "string" }, target: { type: "string" } },
    readOnly: true,
    run: (o, h) => evaluateEligibility({ state: h.review().read(), facts: h.facts(o.facts) }),
  },
  "merge dry-run": {
    summary: "Decide eligibility, recheck it from fresh facts, and show what a merge would do. Never merges.",
    options: { pr: { type: "string" }, facts: { type: "string" }, "recheck-facts": { type: "string" }, target: { type: "string" } },
    readOnly: true,
    run: (o, h) => {
      const review = h.review();
      const eligibility = evaluateEligibility({ state: review.read(), facts: h.facts(o.facts) });
      return prepareMerge({
        eligibility,
        recheck: () => evaluateEligibility({ state: review.read(), facts: h.facts(o["recheck-facts"] ?? o.facts) }),
        executor: dryRunExecutor,
        repo: o.repo,
        number: o.pr ?? o.key,
      });
    },
  },
  "review next": {
    summary: "What the review needs next, and who it waits on.",
    options: {},
    readOnly: true,
    run: (o, h) => next(h.review().read()),
  },
  "review status": {
    summary: "The full review state.",
    options: {},
    readOnly: true,
    run: (o, h) => h.review().read(),
  },
  inbox: {
    summary: "Everything waiting on a person, across reviews.",
    options: {},
    readOnly: true,
    noRef: true,
    run: (o, h) => {
      const refs = listReviews(h.root()).filter((r) => !o.repo || r.repo === o.repo);
      // One review this build cannot read must not hide the others. It is
      // listed for a person instead.
      const items = [];
      const readable = [];
      for (const ref of refs) {
        try {
          readable.push({ ref, state: openReview(h.root(), ref).read() });
        } catch (e) {
          items.push({ repo: ref.repo, key: ref.key, round: null, code: "unreadable", ask: `this review cannot be read (${e.code ?? "error"}): ${e.message.split("\n")[0]}` });
        }
      }
      return [...inbox(readable), ...items];
    },
  },
  "policy check": {
    summary: "Validate a policy file, or show the trusted policy for a target ref.",
    options: { file: { type: "string" }, target: { type: "string" }, head: { type: "string" } },
    readOnly: true,
    noRef: true,
    run: (o, h) => {
      if (o.file) {
        const p = parsePolicy(readFileSync(o.file), { kind: "file", path: o.file });
        return { valid: true, version: p.version, warnings: p.warnings, policy: p.policy, effectiveDigest: p.effectiveDigest };
      }
      const t = trustedPolicy({ git: h.git(), targetRef: h.target(o.target), head: o.head ?? "HEAD", path: POLICY_FILE });
      return { valid: true, source: t.trusted.source, warnings: t.trusted.warnings, policy: t.trusted.policy, effectiveDigest: t.trusted.effectiveDigest, proposed: t.proposed, escalations: t.escalations };
    },
  },
};

const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

function need(o, name) {
  if (o[name] == null || o[name] === "") throw new UsageError(`--${name} is required`);
  return o[name];
}

function readText(path) {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

function readJson(path) {
  try {
    return JSON.parse(readText(path));
  } catch (e) {
    throw new UsageError(`${path}: not valid JSON (${e.message})`);
  }
}

function usage() {
  const lines = ["Usage: agent-review <command> [options]", "", "Commands:"];
  for (const [name, c] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(18)} ${c.summary}`);
  lines.push("", "Common options: --repo owner/name --key <pr|branch> --actor human:<name>|agent:<runtime> --state <dir> --cwd <repo dir> --op-id <id>");
  lines.push("The actor can also come from AGENT_REVIEW_ACTOR. Every mutating command needs one.");
  lines.push("Output is JSON, or short text at a terminal. --json and --text choose explicitly.");
  return lines.join("\n");
}

export function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const name = COMMANDS[`${argv[0]} ${argv[1]}`] ? `${argv[0]} ${argv[1]}` : argv[0];
  const cmd = COMMANDS[name];
  if (!cmd) {
    (argv.length && !["-h", "--help", "help"].includes(argv[0]) ? stderr : stdout).write(`${usage()}\n`);
    return argv.length && !["-h", "--help", "help"].includes(argv[0]) ? 2 : 0;
  }
  const rest = argv.slice(name.split(" ").length);
  let textOut = false;
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: { ...COMMON, ...cmd.options }, strict: true, allowPositionals: false });
    } catch (e) {
      throw new UsageError(e.message);
    }
    const o = parsed.values;
    if (o.help) {
      stdout.write(`agent-review ${name}: ${cmd.summary}\nOptions: ${Object.keys(cmd.options).map((k) => `--${k}`).join(" ") || "(none)"}\n`);
      return 0;
    }
    const cwd = o.cwd ?? process.cwd();
    let gitCache;
    const h = {
      root: () => o.state ?? cliStateRoot(env),
      git: () => (gitCache ??= gitAdapter(cwd)),
      head: (ref) => (/^[0-9a-f]{40}$/.test(ref) ? ref : h.git().resolveCommit(ref)),
      actor: () => {
        const a = o.actor ?? env.AGENT_REVIEW_ACTOR;
        if (!a) throw new UsageError("--actor is required: human:<name> or agent:<runtime> (or set AGENT_REVIEW_ACTOR)");
        return a;
      },
      // The target branch: --target, else the remote's default branch (such
      // as origin/main), else main.
      target: (flag) => flag ?? h.git().defaultTarget() ?? "main",
      review: () => {
        if (cmd.noRef) throw new Error("internal: command has no review");
        const ref = { repo: need(o, "repo"), key: need(o, "key") };
        const review = openReview(h.root(), ref);
        // A v1 ledger is imported on first read, while the review has no
        // events of its own. The v1 file is never changed.
        if (review.log.read().seq === 0) importLegacyV1(review.log, ref, legacyV1Path(h.root(), ref));
        return review;
      },
      // Facts for eligibility: from a file, or fresh from GitHub plus the
      // local repository. Read again on every call, so a recheck is real.
      facts: (file) => {
        // A file's facts are the caller's word, so they are marked as such
        // whatever the file says; only fetched facts are "github".
        if (file) return { ...readJson(file), source: "file" };
        if (!o.pr) throw new UsageError("give --pr <number> to read facts from GitHub, or --facts <file>");
        const host = githubFacts({ repo: need(o, "repo"), number: o.pr });
        const round = activeRound(h.review().read());
        if (!round) return { ...host, mergeBase: null, policyDigest: null, dependencyChanges: null };
        const git = h.git();
        let local;
        try {
          // The same ref the review was bound to, so the merge base and policy
          // are computed the same way; eligibility checks it against the host.
          local = localFacts({ git, round, targetRef: o.target ?? round.binding.target.ref, head: host.head });
        } catch (e) {
          throw new UsageError(`${e.message}. Fetch the pull request first: git fetch origin pull/${o.pr}/head`);
        }
        return { ...host, source: "github", localTarget: local.target, mergeBase: local.mergeBase, policyDigest: local.policyDigest, dependencyChanges: npmDependencyChanges(git, local.mergeBase, host.head) };
      },
    };
    if (o.json && o.text) throw new UsageError("use --json or --text, not both");
    textOut = o.text || (!o.json && Boolean(stdout.isTTY));
    const result = cmd.run(o, h);
    const mutation = result && typeof result === "object" && "state" in result && "changed" in result;
    const out = mutation ? { changed: result.changed, next: next(result.state) } : result;
    if (textOut) {
      const text = mutation ? `${result.changed ? "recorded" : "no change (already recorded)"}\n${renderNext(out.next)}`
        : name === "review next" ? renderNext(out)
        : name === "inbox" ? renderInbox(out)
        : name === "eligibility check" ? renderEligibility(out)
        : JSON.stringify(out, null, 2);
      stdout.write(`${text}\n`);
    } else stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      stderr.write(`agent-review ${name}: ${e.message}\n`);
      return 2;
    }
    if (e.code && /^(workflow|policy|store)\//.test(e.code)) {
      stderr.write(textOut ? `${renderError(e)}\n` : `${JSON.stringify({ error: { code: e.code, message: e.message.split("\n")[0], reasons: e.reasons ?? e.errors ?? [] } }, null, 2)}\n`);
      return 1;
    }
    stderr.write(`agent-review ${name}: ${e.message}\n`);
    return 1;
  }
}
