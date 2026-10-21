import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as api from "../src/index.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the reported version is the package's version", () => {
  assert.equal(api.VERSION, pkg.version);
});

test("every exported entry point loads", async () => {
  for (const [name, path] of Object.entries(pkg.exports)) {
    const mod = await import(new URL(`../${path}`, import.meta.url));
    assert.ok(Object.keys(mod).length > 0, name);
  }
  const cli = await import("agent-review/cli");
  assert.equal(typeof cli.main, "function", "consumers run the CLI in process");
});

test("importing the CLI runs nothing, even from a script named like the bin", () => {
  // A consumer's bundle is its own entry point, so an "am I the main module"
  // check in the imported code would be true and run the harness. There is
  // none: main() runs only when called.
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../src/cli/run.mjs", import.meta.url).href)});`, "review", "next"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});
