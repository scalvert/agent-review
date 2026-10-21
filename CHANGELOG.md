# Changelog

## 0.1.0

The first release.

- An append-only event log per review, with locking for parallel writers, operation IDs for safe retries, and a copy-only import of v1 ledgers.
- A versioned review policy, `agent-review.json`, read from the target branch. A change cannot weaken it.
- A review workflow bound to a head and a target, with independent verification, `review next` and `inbox`.
- The `agent-review` CLI, with JSON output for agents and text for people.
- Merge eligibility, with a Dependabot patch rule, and a dry run. Nothing merges.
