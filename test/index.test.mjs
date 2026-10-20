import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/index.mjs";

test("the entry point loads", () => {
  assert.equal(typeof VERSION, "string");
});
