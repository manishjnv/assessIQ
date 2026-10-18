# Build agent brief (template)

Use this template for every build agent. Fill each field before you start the agent.

> [!NOTE]
> Not for tasks of one to three tool calls. Do those yourself in the main session. A new agent costs more than the work.

## Fields

Fill each field. Keep the field names as written.

- Goal: <one sentence. The result the agent must reach.>
- Files: <paths the agent may change, one per line. Name read-only files too.>
- Exact contract: <names, types, behaviour and wording the code must follow.>
- Acceptance test: <the command or check that proves the change works.>

## Rules

Give these rules to every agent. Do not remove them.

1. If in a worktree, run `git merge main` first.
2. Migration number: <N> from the orchestrator; help-id and seed-count range: <range> from the orchestrator.
3. Run `pnpm verify` for the packages you touch before you report.
4. Do not commit.

## Report

Ask the agent to report these items, in this order.

1. Unified diff of every changed file.
2. Worktree path, if you used a worktree.
3. Change log, under 200 words.

The orchestrator adds the `tokens` figure. Do not ask the agent to estimate it.
