// Read-only GitHub facts for merge eligibility. It never writes to GitHub.
//
// api(path) returns the parsed JSON for a GET request, or throws with
// .status for an HTTP error. The default uses the gh command, which must be
// signed in; tests pass a fake.
import { execFileSync } from "node:child_process";

export function ghApi(path) {
  try {
    return JSON.parse(execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", path], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    const err = new Error(`gh api ${path}: ${String(e.stderr ?? e.message).trim()}`);
    err.status = /HTTP (\d{3})/.exec(String(e.stderr))?.[1] ? Number(/HTTP (\d{3})/.exec(String(e.stderr))[1]) : null;
    throw err;
  }
}

function pages(api, path) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const batch = api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const items = Array.isArray(batch) ? batch : (batch.check_runs ?? []);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

// Facts the host knows. mergeBase, policyDigest and dependencyChanges come
// from the local repository; the caller adds them.
export function githubFacts({ repo, number, api = ghApi, now = () => new Date().toISOString() }) {
  const pr = api(`repos/${repo}/pulls/${number}`);
  const head = pr.head.sha;
  const commits = pages(api, `repos/${repo}/pulls/${number}/commits`).map((c) => ({
    sha: c.sha,
    verified: c.commit?.verification?.verified === true,
    author: c.author?.login ?? null,
  }));
  const files = pages(api, `repos/${repo}/pulls/${number}/files`);
  const changedPaths = [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
  const runs = pages(api, `repos/${repo}/commits/${head}/check-runs`).map((r) => ({ name: r.name, headSha: r.head_sha, status: r.status, conclusion: r.conclusion }));

  let required = null;
  let requiredApprovals = 0;
  let protectionKnown = false;
  try {
    const p = api(`repos/${repo}/branches/${encodeURIComponent(pr.base.ref)}/protection`);
    protectionKnown = true;
    const rsc = p.required_status_checks;
    required = rsc ? [...new Set([...(rsc.contexts ?? []), ...(rsc.checks ?? []).map((c) => c.context)])] : [];
    requiredApprovals = p.required_pull_request_reviews?.required_approving_review_count ?? 0;
  } catch (e) {
    // 404: no protection, which is not the same as protection satisfied.
    // 403: no permission to read it. Either way it stays unknown.
    if (e.status !== 404 && e.status !== 403) throw e;
  }

  // An approval counts if it is the reviewer's latest review and is for the
  // current head.
  const latest = new Map();
  for (const r of pages(api, `repos/${repo}/pulls/${number}/reviews`)) if (r.user?.login) latest.set(r.user.login, r);
  const approvals = [...latest.values()].filter((r) => r.state === "APPROVED" && r.commit_id === head).length;

  const target = api(`repos/${repo}/branches/${encodeURIComponent(pr.base.ref)}`);
  return {
    observedAt: now(),
    target: { ref: pr.base.ref, commit: target.commit.sha },
    head,
    author: { login: pr.user?.login ?? null, type: pr.user?.type ?? null },
    commits,
    changedPaths,
    checks: { required, runs },
    approvals: { count: approvals, required: requiredApprovals },
    // GitHub reports "clean" only when the pull request can merge with every
    // protection rule satisfied.
    branchProtection: { known: protectionKnown, satisfied: protectionKnown ? pr.mergeable_state === "clean" : null, mergeableState: pr.mergeable_state ?? null },
  };
}
