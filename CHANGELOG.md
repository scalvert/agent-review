# Changelog

## 0.2.0

- `review.maxRounds` (default 3) caps review rounds per change, counting imported v1 rounds. Only a person can start a round past it, with `--past-cap`. A run can lower the cap, never raise it.
- Findings keep `class`, `instances` and `axiom`, so reports can list every place with the same mistake and spot a problem that comes back.
- `review link` records the host's review thread that carries a finding.
- `review dispose --note-file` reads the note from a file or stdin.
- Importing the CLI module no longer runs it, so a bundler can include it.
- The new default changes every policy's effective digest. A review started with 0.1 starts a new round on its next `review start`.
- A 0.1 harness cannot read a review that has a `finding.linked` event. It refuses with `workflow/unknown-event` instead of skipping it.

## 0.1.0

The first release.

- An append-only event log per review, with locking for parallel writers, operation IDs for safe retries, and a copy-only import of v1 ledgers.
- A versioned review policy, `agent-review.json`, read from the target branch. A change cannot weaken it.
- A review workflow bound to a head and a target, with independent verification, `review next` and `inbox`.
- The `agent-review` CLI, with JSON output for agents and text for people.
- Merge eligibility, with a Dependabot patch rule, and a dry run. Nothing merges.
