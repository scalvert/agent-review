// The review depth for one run. The first choice that is set wins: the
// --depth flag, the policy's defaultDepth, the user's default, then the
// diff's suggestion. The policy's floors then apply: minDepth, and deep for
// any changed path that matches deepPaths. A floor raises the depth and says
// why; it never lowers it.
import { matchPaths } from "../glob.mjs";
import { DEPTHS } from "./defaults.mjs";
import { INVALID, PolicyError } from "./load.mjs";

const rank = (d) => DEPTHS.indexOf(d);

export function resolveDepth(policy, { flag = null, user = null, suggested = "standard", changedPaths = [] } = {}) {
  for (const [name, v] of [["--depth", flag], ["user default", user], ["suggestion", suggested]]) {
    if (v !== null && !DEPTHS.includes(v)) throw new PolicyError(INVALID, `${name}: depth must be one of ${DEPTHS.join(", ")}, got ${JSON.stringify(v)}`);
  }
  const [chosen, source] =
    flag ? [flag, "--depth"]
    : policy.review.defaultDepth ? [policy.review.defaultDepth, "policy review.defaultDepth"]
    : user ? [user, "user default"]
    : [suggested, "suggested from the diff"];

  let depth = chosen;
  const raisedBy = [];
  if (rank(policy.review.minDepth) > rank(depth)) {
    raisedBy.push({ rule: "review.minDepth", from: depth, to: policy.review.minDepth });
    depth = policy.review.minDepth;
  }
  const hits = matchPaths(changedPaths, policy.review.deepPaths);
  if (hits.length && depth !== "deep") {
    raisedBy.push({ rule: "review.deepPaths", from: depth, to: "deep", path: hits[0].path, glob: hits[0].glob });
    depth = "deep";
  }
  return { depth, chosen, source, raisedBy };
}
