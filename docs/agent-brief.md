# Build agent brief (template)

*Type: reference* — This page is the template for the brief that every build agent receives.

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
   After a new table or a new page, also run `pnpm exec vitest run modules/20-data-rights/src/__tests__/erasure-coverage.test.ts` and the help-id page prefix test (`modules/16-help-system/src/__tests__/help-id-page-prefix.test.ts`). `pnpm verify` does not run them. A page's `helpPage` is the id prefix without `.page`. Write route paths as literal strings in UI clients (`pnpm lint:ui-api-contract`).
4. Do not commit.
5. In a worktree, docs/ is a junction to the main clone's docs/ (docs are local only and not in git). Do not delete or move files inside it, and do not run git commands that touch docs/. Docs edits belong to the orchestrator.

## Report

Ask the agent to report these items, in this order.

1. Unified diff of every changed file.
2. Worktree path, if you used a worktree.
3. Change log, under 200 words.

The orchestrator adds the `tokens` figure. Do not ask the agent to estimate it.
