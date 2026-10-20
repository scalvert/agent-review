#!/usr/bin/env node
// agent-review: the review harness on the command line. People and agents
// run the same commands. Output is JSON, unless stdout is a terminal or
// --text is given; --json forces JSON. A refused step prints
// {"error": {code, message, reasons}} on stderr and exits 1; a usage error
// exits 2.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gitAdapter } from "../adapters/git.mjs";
import {
  defaultStateRoot,
  inbox,
  listReviews,
  next,
  openReview,
  parsePolicy,
  trustedPolicy,
  POLICY_FILE,
} from "../index.mjs";
import { renderError, renderInbox, renderNext } from "./render.mjs";

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
    options: { target: { type: "string" }, head: { type: "string" }, lenses: { type: "string" }, depth: { type: "string" }, "user-depth": { type: "string" } },
    run: (o, h) => h.review().start({ git: h.git(), targetRef: o.target ?? "main", head: o.head ?? "HEAD", lenses: list(o.lenses), depth: o.depth ?? null, userDepth: o["user-depth"] ?? null, actor: h.actor(), opId: o["op-id"] }),
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
    options: { finding: { type: "string" }, as: { type: "string" }, note: { type: "string" } },
    run: (o, h) => h.review().dispose({ finding: need(o, "finding"), as: need(o, "as"), note: o.note ?? null, actor: h.actor(), opId: o["op-id"] }),
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
      return inbox(refs.map((ref) => ({ ref, state: openReview(h.root(), ref).read() })));
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
      const t = trustedPolicy({ git: h.git(), targetRef: o.target ?? "main", head: o.head ?? "HEAD", path: POLICY_FILE });
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
      root: () => o.state ?? defaultStateRoot(env),
      git: () => (gitCache ??= gitAdapter(cwd)),
      head: (ref) => (/^[0-9a-f]{40}$/.test(ref) ? ref : h.git().resolveCommit(ref)),
      actor: () => {
        const a = o.actor ?? env.AGENT_REVIEW_ACTOR;
        if (!a) throw new UsageError("--actor is required: human:<name> or agent:<runtime> (or set AGENT_REVIEW_ACTOR)");
        return a;
      },
      review: () => {
        if (cmd.noRef) throw new Error("internal: command has no review");
        return openReview(h.root(), { repo: need(o, "repo"), key: need(o, "key") });
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

// Run when executed directly or through a bin symlink, not when imported.
const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = main(process.argv.slice(2));
