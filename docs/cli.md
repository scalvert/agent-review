# The command line

`agent-review` is the same harness for people and agents. Every command checks its requirements and refuses with reasons. A person and an agent can hand a review back and forth at any step.

- Output is JSON for agents. At a terminal, or with `--text`, it is a few lines for a person. `--json` forces JSON.
- A refused step exits 1. With JSON output, the reasons go to stderr as `{"error": {code, message, reasons}}`. A usage error exits 2.
- Every command that changes state needs `--actor human:<name>` or `--actor agent:<runtime>`, or `AGENT_REVIEW_ACTOR`.
- `--head` takes a ref or a SHA. The harness resolves a ref to its commit, so a run against an old commit is refused.
- `--target` defaults to the remote's default branch, such as `origin/main`, else `main`. Eligibility reads the policy from the same ref and blocks if it is behind the host.
- Candidates and findings are named by number. `--candidate <n>` names a reviewer's claim in the current round, numbered 1, 2, 3 in the order the claims were recorded; `merge` and `decide` take it. `--finding <n>` names a finding the report showed; `dispose` and `link` take it. The report numbers its findings in report order, after the numbers earlier rounds used, so a finding keeps its number for the whole review. The event log ties events together with internal keys, but no command takes one and no output shows one. An internal key such as `F2` is a usage error.
- State lives under `--state`. Without it, the command line follows the v1 review tools' lookup, so existing ledgers and new reviews share one root:
  - `$AGENT_REVIEWS_STATE_DIR`, else `$SCALVERT_STATE_DIR`.
  - Else `~/.local/state/scalvert`, if it holds v1 reviews and the default root holds none.
  - Else `$XDG_STATE_HOME/agent-reviews`, else `~/.local/state/agent-reviews`.

## Commands

| Command | Does |
|---|---|
| `review start` | Starts a round bound to the head, merge base and trusted policy, or confirms the current one. Past the policy's round cap, only a person can start one, with `--past-cap`. |
| `review run` | Records one reviewer slot: `ok` with findings, or `failed` or `skipped` with a reason |
| `review accept-gap` | Lets the panel go ahead without a slot (people only) |
| `review advance` | Moves to verification once the panel is complete |
| `review merge` | Marks candidates as duplicates of a primary: `--into <n> --duplicates <n,n>` |
| `review decide` | Records a verification, severity, triage or origin decision on `--candidate <n>` |
| `review classify` | Records the change's category, such as `deps-patch`. Merge eligibility needs it, and only a person can change it once it is set. |
| `review report` | Writes the report once every finding has what it needs |
| `review resolve` | Approves or rejects an escalation (people only) |
| `review dispose` | Records what became of `--finding <n>`, from this round or an earlier one. A `needs-judgment` finding is a person's call, and so is clearing a disqualifying one as `wrong`, `intended` or `not-worth-it`. `--note-file <file>`, or `-` for stdin, reads the note from a file, so text copied from a pull request never passes through a shell string. |
| `review link` | Records the review thread on the host that carries `--finding <n>` |
| `eligibility check` | Decides whether the change may merge: `eligible`, `blocked` or `escalate`, with every reason. It never merges. |
| `merge dry-run` | Decides eligibility, rechecks it from fresh facts, and shows what a merge would do. It never merges. |
| `review next` | Shows what is needed next, and who it waits on |
| `review status` | Shows the full state, with candidates and findings by number |
| `inbox` | Shows everything waiting on a person, across reviews |
| `review workdir` | Prints the review's work directory for scratch files, such as a checkout or eval output, creates it if it is missing, and gives the caller a lease so `gc` leaves it alone. `--lease-hours <n>` (default 4), `--lease <id>` to renew, `--pid <n>` to end the lease when that process exits, `--release --lease <id>` when done. Put review scratch here, not in the repository under review. |
| `workdirs` | Lists every work directory with its status (`in-use`, `protected`, `in-review`, `paused`, `done` or `idle`), size, and whether `gc` may remove it, with the reason. `--idle-days`, `--repo` and `--offline` as for `gc`. |
| `gc` | Removes the work directories that are `done` or `idle`; a dry run unless `--apply`, which needs an actor. `--idle-days <n>` (default 30), `--repo` to narrow it, `--offline` to skip GitHub. A leased directory, or one with uncommitted, unpushed or stashed git work, is never removed, and neither is review history. See [the store](store.md#work-directories-and-gc). |
| `policy check` | Validates a policy file, or shows the trusted policy for a target |

## A person's walkthrough

This session is real output, shortened only by leaving out repeated options. The repository's policy needs two reviewers from two model families.

```text
$ agent-review review start --repo acme/widgets --key 7 --head fix --actor agent:claude
recorded
reviewing (round 1 at 471e4c1d28b6, standard)
next: run correctness, correctness-2; needs 2 model families, has none [agent]

$ agent-review review advance ...
refused: the panel is not complete
  - slot correctness (correctness) has not run
  - slot correctness-2 (correctness) has not run
  - 0 successful reviewer runs; the policy needs 2
  - reviewers came from 0 model families (none); the policy needs 2
```

Skipping ahead is refused, and the refusal lists everything that is missing. One reviewer then succeeds and one fails:

```text
$ agent-review review run ... --slot correctness-2 --status failed --reason "rate limited" --head fix
recorded
reviewing (round 1 at 471e4c1d28b6, standard)
next: run correctness-2 (retry: rate limited); needs 2 model families, has anthropic [agent]
for a person: slot correctness-2 failed (rate limited); retry it, or accept the gap

$ agent-review review accept-gap ... --slot correctness-2 --reason "skip it" --actor agent:claude
refused: only a person can do this; agent:claude is not human:<name>

$ agent-review inbox
acme/widgets 7: slot correctness-2 failed (rate limited); retry it, or accept the gap
```

The person sees one line. They can accept the gap with `--actor human:<name>`, or leave the retry to the agent. Here the agent retries with a model from another family, verifies across families, and reports. A verifier from the author's family is refused:

```text
$ agent-review review decide ... --candidate 1 --kind finding-verification --label confirmed --verifier-model anthropic/sonnet ...
refused: the finding-verification decision on candidate 1 was not recorded
  - anthropic/sonnet is in the author's family (anthropic); the policy needs a model from another family for the finding-verification decision

$ agent-review review report ...
recorded
complete (round 1 at 471e4c1d28b6, standard)
next: a person decides finding 1 (review dispose) [human]
for a person: finding 1, add() subtracts (math.js:1), needs your call
report: 1 reported (finding 1), 0 dropped, 0 disputed

$ agent-review inbox
acme/widgets 7: finding 1, add() subtracts (math.js:1), needs your call
```

The verifier triaged it `needs-judgment`, so it waits on the person, and only on that one finding. The person names it by the number the report gave it:

```sh
agent-review review dispose --repo acme/widgets --key 7 --finding 1 --as accepted --note "fix in a follow-up" --actor human:steve
```

## An agent's loop

An agent does not need the workflow written into its prompt. It asks the harness:

```sh
while true; do
  step=$(agent-review review next --repo "$REPO" --key "$KEY" --json)
  case $(echo "$step" | jq -r '.action.do // "done"') in
    start)    agent-review review start --repo "$REPO" --key "$KEY" --head HEAD --actor agent:me ;;
    run)      ;;  # run each slot in .action.slots on a model, then: review run --slot ... --head HEAD
    advance)  agent-review review advance --repo "$REPO" --key "$KEY" --actor agent:me ;;
    verify)   ;;  # verify each of .findings[].candidate with a model that meets .verifierMust, then: review decide --candidate <n> ...
    verify-again) ;;  # a second verifier for each blocker, a model not in .verifierMust.notModels, then: review decide --candidate <n> ...
    decide)   ;;  # severity, origin and triage for each candidate, by a model that meets .verifierMust, then: review decide --candidate <n> ...
    classify) ;;  # the change's category, one of .categories, then: review classify ...
    report)   agent-review review report --repo "$REPO" --key "$KEY" --actor agent:me ;;
    *)        break ;;  # waiting on a person, or done; show them: agent-review inbox --text
  esac
done
```

Scratch files go in the review's work directory, not in the repository under review. Take a lease before using it, renew it while you work, and release it when you stop:

```sh
wd=$(agent-review review workdir --repo "$REPO" --key "$KEY" --actor agent:me --json)
dir=$(echo "$wd" | jq -r .path) lease=$(echo "$wd" | jq -r .lease.id)
# ... work in "$dir"; for a long run, renew within the lease:
agent-review review workdir --repo "$REPO" --key "$KEY" --actor agent:me --lease "$lease" --json >/dev/null
# ... when done:
agent-review review workdir --repo "$REPO" --key "$KEY" --actor agent:me --release --lease "$lease"
```

A crashed agent's lease runs out on its own. `gc` removes the directory once the pull request merges, or once it is idle long enough.

This is real output, with live pull request lookups on this repository. Review 12 has an agent's lease, review 11's checkout has an uncommitted edit, and pull request 10 is merged:

```text
$ agent-review workdirs
3 work directories; gc may remove 1, 1.9 MB
  in-use    scalvert/agent-review 12  296.0 KB  leased by agent:claude until 2026-11-05T08:47:17.520Z
  protected scalvert/agent-review 11  2.7 MB  checkout: 1 uncommitted or untracked path
  done      scalvert/agent-review 10  1.9 MB  the pull request is merged; no lease, and idle 34 days

$ agent-review gc --apply --actor human:steve
removed 1 work directory, 1.9 MB
  in-use    scalvert/agent-review 12  296.0 KB  leased by agent:claude until 2026-11-05T08:47:17.520Z
  protected scalvert/agent-review 11  2.7 MB  checkout: 1 uncommitted or untracked path
  removed   scalvert/agent-review 10  1.9 MB  the pull request is merged; no lease, and idle 34 days
```

The agent stops when `waitingOn` is `human`. When the person has acted, the same loop resumes from the log, in this process or a new one.

## Taking over and resuming

A person can run any command an agent can, and some only a person can. The state is the event log, not the agent's memory. So after a crash, a new session or a handoff, `review next` gives the same answer. To make a retry safe after a lost response, pass the same `--op-id` both times; the retry returns the earlier result. A review with only a v1 ledger has that ledger imported on its first read. The v1 file is never changed.
