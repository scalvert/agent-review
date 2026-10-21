# Review policy

A repository sets its review rules in `agent-review.json` at its root. The harness reads it from the target branch, validates it strictly, and records which version of it governed each review.

```json
{
  "$schema": "https://github.com/scalvert/agent-review/schema/policy-v1.schema.json",
  "version": 1,
  "review": { "minDepth": "standard", "deepPaths": ["src/auth/**", ".github/workflows/**"], "minReviewers": 2 },
  "independence": { "minFamilies": 2, "verifier": "family", "secondVerifierForBlockers": true },
  "escalation": { "paths": ["agent-review.json", "package.json"], "categories": ["policy", "security-sensitive"] }
}
```

## Which policy applies

The trusted policy is the file at the target branch's tip when the review starts. It is never the head's copy, and never the merge base's copy. This means:

- A change cannot weaken its own review. Editing or deleting `agent-review.json` in a pull request has no effect on that pull request's review.
- A change that touches `agent-review.json` always goes to a person, whatever `escalation.paths` says. A policy cannot remove its own protection.
- A policy tightened on the target after a change branched still applies to that change.
- With no file, the built-in defaults apply. They permit no external actions.

Each review records the policy's source: the ref, the commit, the path, the SHA-256 of the file's bytes (`source.digest`), and a digest of the resolved policy (`effectiveDigest`). A later stage invalidates a review when either digest changes.

## Failing closed

These are all errors. None of them falls back to the defaults.

| Problem | Error code |
|---|---|
| The file is not JSON | `policy/not-json` |
| No `"version"` | `policy/no-version` |
| A version this harness does not support, including `"1"` as a string | `policy/unsupported-version` |
| An unknown setting, a wrong type or a value out of range | `policy/invalid`, with one entry per bad value |
| An override that would weaken the policy | `policy/weakening`, with one entry per setting |

One exception keeps old repositories working. A file with no version that has only `review.depth` and `review.deepPaths`, the format from before the harness, is read as version 1, with a warning that says how to update it.

## Settings

Every setting is optional, except `version`. The JSON Schema in `schema/policy-v1.schema.json` lists them for editors.

| Setting | Default | Meaning |
|---|---|---|
| `review.defaultDepth` | `null` | The depth when nobody chooses one: `quick`, `standard` or `deep`. A default, not a floor. |
| `review.minDepth` | `quick` | The lowest depth any review may run at. |
| `review.deepPaths` | `[]` | A changed path that matches one of these globs makes the review deep. |
| `review.requiredLenses` | `["correctness"]` | Lenses every review runs. |
| `review.minReviewers` | `1` | Reviewer runs the panel needs. |
| `independence.minFamilies` | `2` | Distinct model families across the panel. |
| `independence.verifier` | `family` | A verifier must differ from the finding's author by `model` or by `family`. |
| `independence.secondVerifierForBlockers` | `false` | Whether each blocker needs a second, independent verifier. |
| `evidence.finding` | all five | The finding fields that must be present: `file`, `line`, `precondition`, `scenario` and `evidence`. |
| `evidence.decision` | `["rationale"]` | The fields every decision must have. |
| `thresholds.report` | `0.7` | Report a finding at or above this verification probability. |
| `thresholds.classify` | `0.8` | Below this classification probability, a person decides. |
| `escalation.paths` | `["agent-review.json"]` | A change to any of these globs goes to a person. |
| `escalation.categories` | `["policy", "security-sensitive"]` | A change classified as any of these goes to a person. |
| `actions.post` | `false` | Whether the harness may post comments or reviews. |
| `actions.merge.enabled` | `false` | Lets the harness decide merge eligibility. It needs at least one rule. Nothing merges: the harness ships only a dry-run executor. |
| `actions.merge.disqualifying` | `["blocker", "should-fix"]` | Severities of reported findings that block a merge until they are disposed of as `wrong`, `intended` or `not-worth-it`. |
| `actions.merge.rules` | `[]` | When a change may merge automatically. See [eligibility](eligibility.md). |

In the file, a list replaces the default list. Model probabilities are not calibrated, so the thresholds are policy settings, not measurements of safety.

Globs are relative to the repository root. `**` matches across folders, and `*` and `?` match within one folder.

## Depth

The first choice that is set wins: the `--depth` flag, `review.defaultDepth`, the user's default, then a suggestion from the diff. Then the floors apply. `minDepth` raises the depth to at least its value. Any changed path that matches `deepPaths` raises it to `deep`. A floor only raises the depth, and the result says which rule raised it.

## Overrides

A run can tighten the policy, for example with command-line flags. It can never loosen it.

| Kind of setting | An override may |
|---|---|
| Lists: `deepPaths`, `requiredLenses`, `evidence.*`, `escalation.*` | Add entries |
| Floors and counts: `minDepth`, `minReviewers`, `minFamilies`, `verifier`, `secondVerifierForBlockers`, `thresholds.classify` | Raise them |
| `thresholds.report` | Lower it, so that more findings are reported |
| `actions.post`, `actions.merge.enabled` | Turn them off |
| `actions.merge.disqualifying` | Add severities |
| `actions.merge.rules` | Nothing. Rules come only from the trusted policy. |
| `defaultDepth` | Set it to any depth |

If any override would weaken the policy, the whole set is refused, and the error names each setting.
