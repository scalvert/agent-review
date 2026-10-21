import { test } from "node:test";
import assert from "node:assert/strict";
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
