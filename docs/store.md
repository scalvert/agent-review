# The review store

Each review has an append-only event log and a snapshot derived from it. People and agents write to it through the same calls, often in parallel.

## Layout

```text
<state root>/
  v2/<owner>/<repo>/<key>/
    events.jsonl    one event per line, the record of truth
    snapshot.json   a cache, rebuilt from the log when it is missing or stale
    lock            present only while a writer holds it
    work/           scratch files for the review, created by review workdir
  reviews/<owner>/<repo>/<key>.json   v1 ledgers, read but never changed
```

The state root is chosen by the caller. `defaultStateRoot()` returns `$AGENT_REVIEWS_STATE_DIR`, else `$XDG_STATE_HOME/agent-reviews`, else `~/.local/state/agent-reviews`. Keys are percent-encoded, so `feat/x` becomes `feat%2Fx`, and distinct keys never share a path.

## Events

```json
{"actor":"agent:claude","at":"2026-10-20T21:00:00.000Z","data":{},"op":{"digest":"sha256:...","id":"op-1","index":0,"size":1},"schema":"agent-review.event/v1","seq":1,"type":"review.started"}
```

- `type` is dotted lowercase, such as `review.started`.
- `actor` is `human:<name>`, `agent:<runtime>` or `system:<name>`. Actors are declared, not verified. Later stages record which runs the harness executed itself and which it was only told about.
- `seq` starts at 1 and has no gaps.
- `op` ties each event to the append that wrote it.

## Guarantees

These hold for writers on one machine.

| Situation | What happens |
|---|---|
| Two writers append at once | Both commit in turn, with distinct sequence numbers. Neither loses the other's events. |
| A writer cannot get the lock within 10 seconds | It fails with `store/busy` and writes nothing. |
| A writer crashed holding the lock | The next writer removes the lock if its PID is gone or it is older than 30 seconds. |
| A retry with the same operation ID and events | It returns the first result and writes nothing. |
| An append without an operation ID | It is always new. The store never guesses that identical events are a retry, because a value can change and change back. |
| An operation ID reused for different events | It fails with `store/op-id-reused`. |
| `expectSeq` given and the log moved | It fails with `store/conflict`, so the caller reads again and decides again. |
| A crash mid-append left a partial last line, or only part of a batch | That append never returned, so the whole batch is dropped. `read()` reports it, the next append removes it, and a retry writes the whole batch again. |
| A bad line anywhere else | It fails with `store/corrupt`. Nothing is changed or guessed. |
| A missing, stale or unreadable snapshot | It is rebuilt from the log. |

An append writes all of its lines in one write and calls `fsync` before it returns. Each snapshot is written to a unique temporary file and then renamed into place.

Not covered: a state root shared between machines over a network file system, where `O_EXCL` and PIDs are not reliable.

## Work directories and gc

A review often needs scratch space: a checkout of the pull request head, a model's profile, eval output. `workdir(root, ref)` (`agent-review review workdir`) returns the review's `work/` directory and creates it if it is missing. The review must already exist. Nothing is written to the event log, so older builds read the review as before.

`planGc(root, options)` says which work directories can go, and `applyGc(root, plan)` removes them. `agent-review gc` runs both: a dry run by default, and a removal with `--apply`.

A work directory can go when either is true:

- The pull request is merged or closed, and nothing in the directory or the log changed for a day (`CLOSED_GRACE_DAYS`). The command line asks GitHub for numeric keys; `--offline` skips it. A branch key, or a failed lookup, is `unknown`, and only idle time counts.
- Nothing in the directory or the log changed for `idleDays` (default 30, `--idle-days`).

It is kept, whatever the above says, when:

| Reason | Code |
|---|---|
| A git repository inside it has uncommitted or untracked paths | `git-uncommitted` |
| A clone has commits that no remote has, on any branch or HEAD. For a linked worktree, whose branches stay in the main repository, only commits that nothing but its HEAD reaches count | `git-unpushed` |
| A git repository inside it has stashes | `git-stashed` |
| Git cannot read a repository inside it | `git-unreadable` |
| A writer holds the review's lock | `locked` |
| A directory inside it cannot be read | `unreadable` |
| `work` is a link or a file, not a directory | `not-a-directory` |

`applyGc` checks each directory again under the review's lock just before it removes it. A directory that changed since the plan, now holds git work, or resolves outside the state root is kept. `events.jsonl` and `snapshot.json` are never removed, so a collected review keeps its whole history.

Removing a linked worktree's directory leaves its registration in the main repository. `git worktree prune` there clears it.

## Migrating v1 ledgers

`importLegacyV1(log, ref, path)` copies a v1 ledger (`scalvert.review/v1`) into the log as one `legacy.v1-imported` event:

- The v1 file is never moved, edited or deleted, so v1 tools keep working and a rollback needs no repair.
- The event records the file's SHA-256 digest and `provenance: "legacy"`. Findings and dispositions carry over as history. A legacy round never counts as evidence under a later policy.
- Importing the same bytes again does nothing. If the v1 file changed since the last import, a new event records the new content and supersedes the old one.
- A file with another schema, or one for a different review, is refused.
