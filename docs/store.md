# The review store

Each review has an append-only event log and a snapshot derived from it. People and agents write to it through the same calls, often in parallel.

## Layout

```text
<state root>/
  v2/<owner>/<repo>/<key>/
    events.jsonl    one event per line, the record of truth
    snapshot.json   a cache, rebuilt from the log when it is missing or stale
    lock            present only while a writer holds it
  reviews/<owner>/<repo>/<key>.json   v1 ledgers, read but never changed
```

The state root is chosen by the caller. `defaultStateRoot()` returns `$AGENT_REVIEWS_STATE_DIR`, else `$XDG_STATE_HOME/agent-reviews`, else `~/.local/state/agent-reviews`. Keys are percent-encoded, so `feat/x` becomes `feat%2Fx`, and distinct keys never share a path.

## Events

```json
{"actor":"agent:tau","at":"2026-10-20T21:00:00.000Z","data":{},"op":{"digest":"sha256:...","id":"op-1","index":0,"size":1},"schema":"agent-review.event/v1","seq":1,"type":"review.started"}
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

## Migrating v1 ledgers

`importLegacyV1(log, ref, path)` copies a v1 ledger (`scalvert.review/v1`) into the log as one `legacy.v1-imported` event:

- The v1 file is never moved, edited or deleted, so v1 tools keep working and a rollback needs no repair.
- The event records the file's SHA-256 digest and `provenance: "legacy"`. Findings and dispositions carry over as history. A legacy round never counts as evidence under a later policy.
- Importing the same bytes again does nothing. If the v1 file changed since the last import, a new event records the new content and supersedes the old one.
- A file with another schema, or one for a different review, is refused.
