# Merge eligibility

`evaluateEligibility({ state, facts })` decides whether a reviewed change may merge without a person. It returns one of three outcomes, with every reason and the exact inputs it evaluated:

- `eligible`: a merge rule matches and nothing blocks.
- `blocked`: something rules it out. The change merges by hand, if at all.
- `escalate`: nothing rules it out, but a person must decide.

The function never acts. Nothing in this repository performs a merge.

## The checks

A change is `blocked` if any of these holds:

| Code | Holds when |
|---|---|
| `no-review`, `review-invalidated`, `review-incomplete` | No reviewed round exists for this change, or the round is not reported |
| `head-changed`, `merge-base-changed`, `policy-changed` | The round covers different commits, or a different trusted policy, than what would merge now |
| `merge-disabled` | `actions.merge.enabled` is not `true` |
| `coverage-gaps` | The panel ran with an accepted gap |
| `escalation-rejected` | A person rejected an escalation |
| `disqualifying-finding` | A reported finding at a `disqualifying` severity is not disposed of as `wrong`, `intended` or `not-worth-it`. `accepted` means real and still present, so it blocks. |
| `required-checks-unknown`, `check-missing`, `check-not-green`, `check-failed` | A required check has not passed on the exact head, or any check on the head failed |
| `branch-protection-unknown`, `branch-protection` | Branch protection could not be read, or is not satisfied |
| `target-not-fetched` | The local target ref, where the policy and merge base were read, is not at the tip the host reports |
| `no-rule-matches` | No merge rule matches. The reason lists why each rule missed. |

A change goes to a person (`escalate`) if any of these holds:

| Code | Holds when |
|---|---|
| `escalation-open` | An escalation is open, for example a policy change or an escalation path |
| `needs-judgment` | A reported finding is triaged `needs-judgment` and has no disposition |
| `unclassified`, `uncertain-classification` | The change has no category, or its probability is below `thresholds.classify`. Without a category, no rule is checked, so the outcome escalates rather than blocks. |
| `escalation-category` | The category is in `escalation.categories` |

A classification is evidence for the policy, not permission. A model saying `deps-patch` does not make a change a patch update. The rule checks the dependency changes itself.

## Merge rules

```json
{
  "name": "dependabot-npm-patch",
  "categories": ["deps-patch"],
  "authors": ["dependabot[bot]"],
  "requireVerifiedCommits": true,
  "paths": ["package.json", "package-lock.json"],
  "dependencies": "patch",
  "minApprovals": 0
}
```

A rule matches only if every condition holds:

- The change is classified as one of `categories`.
- The pull request's author, as the host reports it, is one of `authors`. The title and branch name are never read.
- With `requireVerifiedCommits` (the default), every commit was committed and signed by GitHub itself (committer `web-flow`, as Dependabot's commits are), with a verified signature, and was authored by one of `authors`. A verified signature alone is not enough. Someone could sign a commit with their own key and give it the bot's author email, and GitHub would show it as verified and as the bot's. A person pushing a commit onto a bot's branch breaks the match, and so does a pull request with 250 or more commits, because GitHub lists at most 250.
- Every changed path matches `paths`. A rename counts both its old and new paths.
- With `dependencies: "patch"`, every dependency change in `package-lock.json` and `package.json` is a semver patch step, such as `1.2.3` to `1.2.4`, and nothing else changed. None of these match:
  - An added or removed package, a prerelease, or a downgrade.
  - A lockfile entry whose `resolved`, `integrity` or any other field changed without a version change, such as a swapped tarball.
  - A version step that changes the registry host, adds an install script, or changes fields npm does not change for an update.
  - Any `package.json` change outside the dependency sections, such as `scripts` or `overrides`.
  - A range whose operator changed, such as `^1.2.3` to `~1.2.4`, or one that is not a simple `x.y.z`, `^x.y.z` or `~x.y.z`.
  - A missing lockfile, or a lockfile without a `packages` map (lockfile version 1). That is no evidence, not a pass.
- The head has at least `minApprovals` approvals, and at least as many as branch protection requires. Only each reviewer's latest review counts, and only if it is for the current head.

`examples/dependabot-patch.json` is a complete policy built around this rule.

## Facts

The facts come from adapters, observed at decision time:

| Fact | Source |
|---|---|
| `head`, `author`, `commits`, `changedPaths`, `checks`, `approvals`, `branchProtection`, `target` | `githubFacts()` in `src/adapters/github.mjs`. It only reads, through `gh api`. |
| `mergeBase`, `policyDigest` | `localFacts()`: the merge base of the target's tip and the head, and the trusted policy's digest with the round's own overrides |
| `dependencyChanges` | `npmDependencyChanges()` in `src/adapters/npm.mjs`, from the lockfile diff |

Required checks include both check runs and commit statuses. An approval counts only if it is the reviewer's latest review, is for the current head, and the reviewer has write, maintain or admin permission. An approval whose permission cannot be read does not count.

The policy and merge base are read from the review's own target ref, the one `review start` bound. Eligibility blocks if that ref is not at the tip GitHub reports, so a stale or moved local ref cannot stand in for the real target. Every result records its `factsSource`: `github` when the harness fetched the facts, `file` when they came from `--facts`. Only fetched facts make a real decision, and `merge dry-run` labels anything else as simulated.

GitHub reports branch protection as satisfied only when `mergeable_state` is `clean`. If the protection settings cannot be read, because the branch has none or the token cannot read them, protection is unknown, and the change is blocked.

## The merge boundary

`prepareMerge({ eligibility, recheck, executor })` is the only path from a decision to a merge:

1. It refuses unless the decision was `eligible`.
2. It refuses unless the executor is a dry run. The harness ships only `dryRunExecutor`.
3. It calls `recheck()`, which must evaluate eligibility again from facts fetched fresh at that moment.
4. It refuses if the fresh outcome is not `eligible`, or if any of these changed: the head, the merge base, the policy digest, the checks, the approvals, the matched rule or the facts' source. Each change is named. Even a harmless-looking change, such as a new approval, needs a new decision.
5. Only then does it call the executor, with the head SHA that was reviewed and rechecked.

A real executor added later must keep this contract. It must pass the reviewed SHA to the host's merge call, so that the host refuses if the head moved in the last moment, and it must never merge any other SHA.

## On the command line

```sh
agent-review eligibility check --repo acme/widgets --key 9 --pr 9 --text
agent-review merge dry-run --repo acme/widgets --key 9 --pr 9
```

With `--pr`, facts come from GitHub and the local repository, so fetch the pull request's head first. With `--facts <file>`, they come from a JSON file. `merge dry-run --recheck-facts <file>` uses a second file for the recheck, so you can see what a moved head does.
