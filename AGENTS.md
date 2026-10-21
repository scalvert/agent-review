# Working in agent-review

## Layout

- `src/core/` is the harness: policy, workflow, store and decisions. It imports nothing from `src/adapters/` and knows nothing about specific models, agent runtimes or repository hosts. A test enforces this.
- `src/adapters/` holds git, GitHub, runner and classifier adapters. They depend on the core, never the other way.
- `test/` uses only temporary state directories. Never read or write a real review state directory in a test.

## Rules

- Make each change in its own worktree and open pull requests as drafts.
- Every command that changes state checks its preconditions and fails with a reason. Do not rely on callers to follow instructions.
- Never lose or rewrite review history. Migrations copy; they do not move or edit old files.
- Keep the core free of runtime dependencies unless a pull request explains why one is needed.

## Ask first

- Adding a runtime dependency.
- Changing a stored schema or a JSON output shape that a consumer reads.

## Never

- Perform a real merge or publish a package to a registry.
- Put credentials, private repository details or company-internal names in code, tests, fixtures or docs.
