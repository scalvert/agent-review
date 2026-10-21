// Which policy governs a review, and whether the change under review tries
// to alter it.
//
// The trusted policy is the file at the target branch's current tip, not at
// the merge base and never at the head. A policy tightened after the change
// branched still applies, and a change cannot weaken its own review by
// editing or deleting the file. An invalid policy at the tip is an error: the
// review does not fall back to defaults.
//
// A change that touches the policy file always goes to a person, whatever
// escalation.paths says, so a policy cannot drop its own protection.
//
// git is an interface, so the core never runs programs itself:
//   resolveCommit(ref) -> full commit SHA
//   readFile(commit, path) -> Buffer, or null when the file does not exist
import { sha256 } from "../digest.mjs";
import { POLICY_FILE } from "./defaults.mjs";
import { defaultPolicy, parsePolicy } from "./load.mjs";

export const POLICY_CHANGE = "policy-change";

export function trustedPolicy({ git, targetRef, head, path = POLICY_FILE }) {
  const tip = git.resolveCommit(targetRef);
  const headCommit = git.resolveCommit(head);
  const tipBytes = git.readFile(tip, path);
  const trusted = tipBytes ? parsePolicy(tipBytes, { kind: "repo", path, ref: targetRef, commit: tip }) : { ...defaultPolicy(), source: { kind: "default", path, ref: targetRef, commit: tip, digest: null } };

  const headBytes = git.readFile(headCommit, path);
  const same = (tipBytes === null && headBytes === null) || (tipBytes !== null && headBytes !== null && tipBytes.equals(headBytes));
  let proposed = null;
  const escalations = [];
  if (!same) {
    let valid = true;
    let errors = [];
    if (headBytes) {
      try {
        parsePolicy(headBytes, { kind: "repo", path, ref: head, commit: headCommit });
      } catch (e) {
        valid = false;
        errors = e.errors?.length ? e.errors : [{ path: "(file)", message: e.message }];
      }
    }
    proposed = { path, commit: headCommit, digest: headBytes ? sha256(headBytes) : null, deleted: headBytes === null, valid, errors };
    escalations.push({
      code: POLICY_CHANGE,
      path,
      message: headBytes === null ? `this change deletes ${path}; a person must review it, and the policy at ${targetRef} still applies` : `this change edits ${path}; a person must review it, and the policy at ${targetRef} still applies until it merges`,
    });
  }
  return { trusted, target: { ref: targetRef, commit: tip }, head: headCommit, proposed, escalations };
}
