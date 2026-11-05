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
    leases/<id>.json  who is using work/, and until when
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

A review often needs scratch space: a checkout of the pull request head, a model's profile, eval output. `workdir(root, ref, { actor })` (`agent-review review workdir`) returns the review's `work/` directory, creates it if it is missing, and gives the caller a lease. The review must already exist. Nothing is written to the event log, so older builds read the review as before.

### Leases

A lease says "I am using this directory". Nothing else can say that: reading files does not change their times, and a process can sit in a directory for hours without writing.

- A lease names its actor and runs for `leaseMs` (4 hours by default, at most 7 days; `--lease-hours`).
- Pass the lease ID back to renew it (`--lease <id>`). Renewing a lease that ran out takes it again under the same ID. Only its actor can renew or release it.
- `releaseWorkdir` (`--release --lease <id>`) ends it. Releasing a lease that is gone is not an error.
- `pid` (`--pid`) ends a lease early, once that process exits, so a crashed agent does not hold a directory for the rest of its lease. A PID never makes a lease last longer. Pass the PID of the long-running process, not of the shell that runs the command.
- Each lease is its own file, so parallel agents never overwrite each other's.
- A lease file that cannot be read counts as live until it is older than the longest lease.

### Status

`planGc(root, options)` gives every work directory one status, whether it is `removable`, and why. `agent-review workdirs` lists them. The first status that applies wins:

| Status | When | Removable |
|---|---|---|
| `in-use` | A live lease | No |
| `protected` | Something would be lost or cannot be checked (below) | No |
| `done` | The pull request is merged or closed, and nothing changed for a day (`CLOSED_GRACE_DAYS`) | Yes |
| `idle` | Nothing in the directory or the log changed for `idleDays` (default 30, `--idle-days`) | Yes |
| `in-review` | The round is `reviewing` or `verifying` | No |
| `paused` | The review is `reported`, `complete`, `invalidated` or `not-started`, or its pull request merged less than a day ago | No |

The command line asks GitHub for numeric keys; `--offline` skips it. A branch key, or a failed lookup, is `unknown`, and only the workflow and idle time count.

A directory is `protected` when:

| Reason | Code |
|---|---|
| A git repository inside it has uncommitted or untracked paths | `git-uncommitted` |
| A clone has commits that no remote has, on any branch or HEAD. For a linked worktree, whose branches stay in the main repository, only commits that nothing but its HEAD reaches count | `git-unpushed` |
| A git repository inside it has stashes | `git-stashed` |
| Git cannot read a repository inside it | `git-unreadable` |
| A writer holds the review's lock | `locked` |
| A directory inside it cannot be read | `unreadable` |
| `work` is a link or a file, not a directory | `not-a-directory` |
| The review's log cannot be read | `review-unreadable` |

### gc

`applyGc(root, plan)` (`agent-review gc --apply`) removes what the plan marked removable. `gc` without `--apply` is a dry run. For each directory it holds the review's lock and assesses it again, with the host state from the plan. A directory that gained a lease, changed since the plan, now holds git work, or resolves outside the state root is kept with the new reasons. Holding the lock means no lease can be taken between the check and the removal.

It removes `work/` and the leases that no longer count. `events.jsonl` and `snapshot.json` are never removed, so a collected review keeps its whole history.

A process that never asks for a lease, such as a person in a terminal, is not seen. The workflow status and idle time still apply, and git work is still protected.

Removing a linked worktree's directory leaves its registration in the main repository. `git worktree prune` there clears it.

## Migrating v1 ledgers

`importLegacyV1(log, ref, path)` copies a v1 ledger (`scalvert.review/v1`) into the log as one `legacy.v1-imported` event:

- The v1 file is never moved, edited or deleted, so v1 tools keep working and a rollback needs no repair.
- The event records the file's SHA-256 digest and `provenance: "legacy"`. Findings and dispositions carry over as history. A legacy round never counts as evidence under a later policy.
- Importing the same bytes again does nothing. If the v1 file changed since the last import, a new event records the new content and supersedes the old one.
- A file with another schema, or one for a different review, is refused.
