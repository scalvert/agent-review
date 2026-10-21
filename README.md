# agent-review

A code review harness that people and AI agents run through the same commands.

The harness owns the review lifecycle, the evidence each step needs, the repository's review policy, and what actions are allowed. Models supply the judgments: findings, verification, severity and classification. Each command checks its preconditions and refuses with a reason. So a skipped step is an error, not a prompt someone forgot to follow.

## What it enforces

- **Steps happen in order, on the right commit.** A review is bound to a head and a target. A run or decision for another commit is refused, and a new head starts a new round.
- **Independent verification.** A finding is verified, rated and triaged by a different model than the one that found it, and by default a different model family. When verifiers disagree, a person decides.
- **People keep the calls that matter.** Only a person can clear a blocker, settle a dispute, change a change's classification or resolve an escalation.
- **The policy comes from the target branch.** A pull request cannot weaken its own review policy. A stricter policy added after the branch was cut still applies.
- **History is kept.** Every step is an event in an append-only log, with who did it and on what evidence. Parallel agents can write at once without losing updates.
- **Merging stays a human decision.** `eligibility check` and `merge dry-run` say whether a change could merge and why. Nothing in this package merges.

## Status

Version 0.3. The design is settled, but it has had little use outside one person's work, and the JSON output and policy format may change before 1.0. [scalvert/skills](https://github.com/scalvert/skills) bundles it into its review skills.

It is not on npm. Install it from a tag:

```sh
npm install github:scalvert/agent-review#v0.3.0
```

## Quick start

```sh
agent-review review start --repo acme/widgets --key 7 --head HEAD --actor human:you
agent-review review next --repo acme/widgets --key 7
```

`review next` says what the review needs next and who it waits on: an agent or a person. Run the step it names, then ask again. [docs/cli.md](docs/cli.md) walks through a full review, as an agent and as a person.

## Docs

- [CLI](docs/cli.md): the commands, with walkthroughs.
- [Workflow](docs/workflow.md): states, steps, independence and retries.
- [Policy](docs/policy.md): `agent-review.json`, and why a change cannot weaken it.
- [Eligibility](docs/eligibility.md): merge rules, such as Dependabot patch updates, and the dry run.
- [Store](docs/store.md): the event log, locking and the v1 import.

## Limits

- Independence is checked on the model each caller declares. The harness cannot tell when two names are the same model.
- Probabilities from models are not calibrated. Thresholds in the policy are settings, not guarantees.
- Locking covers writers on one machine, not a shared network directory.

## Develop

```sh
npm test
```

Node 22 or later. The package has no runtime dependencies. See [AGENTS.md](AGENTS.md) for the rules contributors and agents follow.

## License

MIT
