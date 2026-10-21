// The command line's state root follows the v1 tools' lookup, so existing
// ledgers are found; the library default stays portable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliStateRoot } from "../src/cli/state-root.mjs";
import { defaultStateRoot } from "../src/index.mjs";

const home = () => mkdtempSync(join(tmpdir(), "home-"));

test("explicit variables win, the new name first", () => {
  assert.equal(cliStateRoot({ AGENT_REVIEWS_STATE_DIR: "/a", SCALVERT_STATE_DIR: "/b" }, home()), "/a");
  assert.equal(cliStateRoot({ SCALVERT_STATE_DIR: "/b" }, home()), "/b");
});

test("v1 ledgers under the old root stay in use until the new root has reviews", () => {
  const h = home();
  mkdirSync(join(h, ".local/state/scalvert/reviews"), { recursive: true });
  assert.equal(cliStateRoot({}, h), join(h, ".local/state/scalvert"));
  mkdirSync(join(h, ".local/state/agent-reviews/v2"), { recursive: true });
  assert.equal(cliStateRoot({}, h), join(h, ".local/state/agent-reviews"), "v2 reviews under the new root win");
});

test("with nothing anywhere, the XDG or default root", () => {
  const h = home();
  assert.equal(cliStateRoot({}, h), join(h, ".local/state/agent-reviews"));
  assert.equal(cliStateRoot({ XDG_STATE_HOME: "/xdg" }, h), "/xdg/agent-reviews");
});

test("the library default has no tool-specific locations", () => {
  const h = home();
  mkdirSync(join(h, ".local/state/scalvert/reviews"), { recursive: true });
  assert.equal(defaultStateRoot({ SCALVERT_STATE_DIR: "/b" }, h), join(h, ".local/state/agent-reviews"));
});
