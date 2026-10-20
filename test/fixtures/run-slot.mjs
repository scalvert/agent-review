// A separate process that records one reviewer run.
//   node run-slot.mjs <root> <repo> <key> <slot> <model> <head>
import { openReview } from "../../src/index.mjs";

const [root, repo, key, slot, model, head] = process.argv.slice(2);
try {
  const r = openReview(root, { repo, key }).recordRun({
    slot,
    status: "ok",
    model,
    head,
    actor: `agent:writer-${slot}`,
    findings: [{ title: `from ${slot}`, file: `${slot}.js`, line: 1, precondition: "p", scenario: "s", evidence: "e" }],
  });
  process.stdout.write(JSON.stringify({ changed: r.changed }));
} catch (e) {
  process.stderr.write(JSON.stringify({ code: e.code, message: e.message }));
  process.exit(1);
}
