// The command line's state root. It follows the lookup of the v1 review
// tools, so existing ledgers and new reviews share one root (v1 ledgers in
// reviews/, v2 reviews in v2/). First match wins:
//
//   1. $AGENT_REVIEWS_STATE_DIR
//   2. $SCALVERT_STATE_DIR, the v1 tools' older name
//   3. ~/.local/state/scalvert, if it holds v1 reviews and the default root
//      holds no reviews of either version, so ledgers from before the
//      rename stay in use
//   4. $XDG_STATE_HOME/agent-reviews, else ~/.local/state/agent-reviews
//
// The library's defaultStateRoot() has only 1 and 4, with no tool-specific
// locations; this is the command line's compatibility layer.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function cliStateRoot(env = process.env, home = homedir()) {
  const explicit = env.AGENT_REVIEWS_STATE_DIR || env.SCALVERT_STATE_DIR;
  if (explicit) return explicit;
  const current = join(env.XDG_STATE_HOME || join(home, ".local", "state"), "agent-reviews");
  const legacy = join(home, ".local", "state", "scalvert");
  const hasReviews = (root) => existsSync(join(root, "reviews")) || existsSync(join(root, "v2"));
  if (!hasReviews(current) && existsSync(join(legacy, "reviews"))) return legacy;
  return current;
}
