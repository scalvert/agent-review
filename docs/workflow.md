# The review workflow

A review moves through fixed states. Each operation checks its requirements and refuses with every unmet one, so a skipped step is an error, not something a prompt forgot to say. People and agents call the same operations.

```text
start -> reviewing -> verifying -> reported -> complete (no open escalations)

new head, merge base or policy on the next start -> round invalidated -> new round
```

## Operations

| Operation | Needs | Records |
|---|---|---|
| `start` | A target ref and a head. A new round past `review.maxRounds` (counting v1 rounds) needs a person and `pastCap` | The round's binding: target commit, head, merge base, policy digests, depth, and the reviewer slots |
| `recordRun` | `reviewing`, the bound head, a planned slot | One slot's run: `ok`, `failed` or `skipped`, with model, family, runner and findings. Each finding may also carry `class` (kebab-case), `instances` (other `{ file, line }` places with the same mistake) and `axiom`. |
| `acceptGap` | A person; a slot that did not run successfully | That the panel may go ahead without the slot, with a reason |
| `advance` | Every slot ok or gap-accepted, `minReviewers` and `minFamilies` met | The move to `verifying` |
| `merge` | Duplicates with no decisions yet | That findings are duplicates of a primary |
| `decide` | `verifying`, the bound head, a verifier independent of the author | A verification, severity, triage or origin decision |
| `report` | Every finding verified; reported findings with severity and origin; a second verifier on blockers when the policy asks | Reported, dropped and escalated findings, and coverage |
| `resolveEscalation` | A person; an open escalation in the current round | Approve or reject, with a reason |
| `dispose` | `reported`; a reported finding, or a disputed one a person approved. A person, if the finding is triaged `needs-judgment`, or if it clears (`wrong`, `intended`, `not-worth-it`) a finding at a disqualifying or missing severity | `fixed`, `accepted`, `wrong`, `intended` or `not-worth-it`, with an optional note |
| `classify` | `reviewing`, `verifying` or `reported`; the bound head. A person, to change the category once it is set | The change's category, such as `deps-patch`, with a probability. Evidence for the merge policy, never permission. |
| `link` | A finding in any round | The host's review thread that carries it, such as a pull request comment, with an optional https URL |

`next(state)` returns the next required step, who it waits on, and what a person needs to look at. `inbox(reviews)` lists the same person items across reviews: escalations, failed slots, and reported findings triaged `needs-judgment` with no disposition yet. Each comes with a one-line ask. A review is `complete` once no escalation is open. Judgment calls on its findings still show as waiting on a person until someone disposes of them.

## Binding and invalidation

Each round is bound to the head, the merge base and the policy's effective digest. A run or decision for a different head is refused as `workflow/stale`.

Calling `start` again with the same head, merge base and policy returns the existing round. If any of the three changed, the round is invalidated with the reason, and a new round starts with no runs and no decisions. Findings stay in the history, but nothing from an invalidated round counts toward the new one. If only the target branch moved, the round stands. The merge-eligibility check in a later stage rechecks the target at decision time.

## Independence

Every decision about a finding (verification, severity, triage and origin) must come from a different model than the finding's author. With `independence.verifier: "family"` (the default), it must also come from a different family. Otherwise an author could rate its own finding a nit, or triage away a judgment call. One model cannot verify the same finding twice with different answers.

When verifiers disagree, the finding needs a severity and an origin, then goes to a person. The report does not pick a side. If the person approves, the finding is real: it blocks according to its severity, and a person can dispose of it. If the person rejects, the finding is not a problem, and it is dropped.

## Retries, resumption and parallel writers

- Pass an operation ID (`opId`, or `--op-id` on the command line) to make a retry safe. A repeat with the same ID returns the earlier result, even if the review has moved on since, such as a retried `advance` after the review reached `verifying`.
- Without an ID, repeating an operation whose result is already in place is a no-op, such as recording the same successful run or the same decision again. A step that changed the state, such as `advance`, is refused the second time with `wrong-state`. After an uncertain result, check `review next`.
- A failed or skipped slot can be recorded again. A different result for a slot that already succeeded is refused.
- Each operation appends only if nobody wrote since it read the state. Otherwise it reads again and checks again, so parallel agents on different slots all land.
- The state is rebuilt from the event log, so a new process resumes exactly where the last one stopped.
- An event type this version does not know stops the read (`workflow/unknown-event`), rather than being skipped.

## Legacy history

A review that holds only an imported v1 ledger reports `not-started`, with a note that it has v1 history only. Legacy rounds never satisfy a version 1 policy.

## What the harness cannot check

- **Actors are declared.** `human:` and `agent:` are what the caller says. An agent that claims to be a person is not detected.
- **Runs are attested.** A run recorded through these operations is `attested`. Only a runner adapter that executes the model itself may record `executed`.
- **Families are declared or derived.** By default the family is the model's provider prefix. Callers behind a gateway pass the family. Two names for the same model are not detected.
- **Evidence is present, not proven.** A nonempty `scenario` field does not make the scenario true. That is what verification is for.
