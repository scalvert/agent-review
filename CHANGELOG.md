# Changelog

## 0.3.0

Findings are named by number. Internal keys such as `F2` never reach a person, so they cannot end up in a report or a pull request comment.

- **Breaking:** `review decide` takes `--candidate <n>` instead of `--finding <id>`, and `review merge` takes `--into <n> --duplicates <n,n>` instead of `--into <id> --ids <ids>`. A candidate is a reviewer's claim in the current round, numbered 1, 2, 3 in the order recorded.
- **Breaking:** `review dispose` and `review link` take `--finding <n>`, the number the report gave the finding. A round numbers its reported and disputed findings when it reports, in report order, after the numbers earlier rounds used, so a number names one finding for the whole review. `link` now needs a numbered finding.
- **Breaking:** an internal key passed to `--candidate`, `--finding`, `--into` or `--duplicates` is a usage error, exit 2. The library's `decide`, `merge`, `dispose` and `link` take the same numbers.
- `review next`, `inbox`, `review status`, eligibility reasons and refusals name candidates and findings by number. `review next` lists each candidate with its title, file and line, and its report shows `findings` (number and section), `disputed` and `dropped`.
- A dispute's escalation names the finding by number and title.
- `dispose` on a disputed finding says the dispute is settled first, and names the escalation.
- New exports: `SECTIONS`, `placement`, `numberReport`, `publicReport` and `publicState`.
- A review written by 0.2 is numbered when it is read, the same way a report numbers findings now, and its dispute messages name the finding by number instead of its key. The log keeps what 0.2 wrote. Cached snapshots are rebuilt.

## 0.2.0

- `review.maxRounds` (default 3) caps review rounds on new code per change, counting imported v1 rounds. Only a person can start a round past it, with `--past-cap`. A restart at the same head, because the target's policy or the merge base moved, does not count against it. A run can lower the cap, never raise it. `next` shows `roundsSoFar`.
- `review dispose` accepts a reported finding from an earlier round, so a follow-up can close a finding that turned out fixed.
- `review link` accepts only an https URL with a host. Findings and their `instances` cannot have empty slots, and an instance's file cannot be blank.
- A file named by `--findings`, `--rationale-file` or `--note-file` that cannot be read is a usage error, exit 2.
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
