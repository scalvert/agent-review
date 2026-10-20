// A separate writer process for the concurrency tests.
//   node append.mjs <root> <repo> <key> <n> [timeoutMs]
import { openLog } from "../../src/index.mjs";

const [root, repo, key, n, timeoutMs] = process.argv.slice(2);
const log = openLog(root, { repo, key }, { lock: timeoutMs ? { timeoutMs: Number(timeoutMs) } : undefined });
try {
  const r = log.append([{ type: "test.wrote", actor: `agent:writer-${n}`, data: { n: Number(n) } }]);
  process.stdout.write(JSON.stringify(r));
} catch (e) {
  process.stderr.write(JSON.stringify({ code: e.code, message: e.message }));
  process.exit(1);
}
