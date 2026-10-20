# agent-review

A code review harness that people and AI agents run through the same commands.

The harness owns the review lifecycle, the evidence each step needs, the repository's review policy, and what actions are allowed. Models supply the judgments: findings, verification, severity and classification. Each command checks its preconditions and refuses with a reason, so a skipped step is an error rather than a prompt someone forgot to follow.

This repository is private while the core takes shape. Nothing is published to npm.

## Status

Under construction. The first piece is the [state store](docs/store.md): locked, append-only review logs that parallel agents can write to without losing updates, with a copy-only import of v1 ledgers.

## Develop

```sh
npm test
```

Node 22 or later. The core has no runtime dependencies.
