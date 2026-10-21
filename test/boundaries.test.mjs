// The core must not depend on adapters, on third-party packages, or on
// anything that runs other programs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CORE = new URL("../src/core/", import.meta.url).pathname;

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".mjs") ? [p] : [];
  });
}

test("core imports only node: built-ins and other core modules", () => {
  const bad = [];
  for (const file of files(CORE)) {
    // Comments can mention imports; only code counts.
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    for (const [, spec] of text.matchAll(/(?:^|\n)\s*(?:import|export)[^"'`]*?from\s+["']([^"']+)["']/g)) {
      const builtin = spec.startsWith("node:") && spec !== "node:child_process";
      const local = spec.startsWith(".") && !join(file, "..", spec).includes(`${join(CORE, "..")}adapters`) && join(file, "..", spec).startsWith(CORE);
      if (!builtin && !local) bad.push(`${relative(CORE, file)} imports ${spec}`);
    }
    if (/\bimport\s*\(/.test(text)) bad.push(`${relative(CORE, file)} uses a dynamic import`);
  }
  assert.deepEqual(bad, []);
});
