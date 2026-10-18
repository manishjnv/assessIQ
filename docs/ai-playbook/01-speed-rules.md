# 01. Speed rules (owner, 2026-10-18)

Source of truth: the "Speed rules" section of `CLAUDE.md`. This page explains them.

**Goal:** finish work fast without cutting quality or the delivered functions.

## The rules

1. **Functionality first.** Test the happy path and the main failure case. Do not write broad edge-case suites unless the row is security-related.
2. **Verify before every push.** Run `pnpm verify` (cached lint and scoped typecheck). Agents run it for the packages they touch before they report.
3. **Gate only security paths.** An adversarial review (Sonnet takeover while Codex is down) is for `01-auth`, `02-tenancy`, `07-ai-grading`, `14-audit-log`, `infra/**`, and anything that decides who may sit a test or gets marks or time. UI, docs and display-only rows skip the gate.
4. **Smoke, not full e2e.** For a changed screen run one local smoke spec. CI runs the rest.
5. **Batches of 3 to 4 rows.** Then push, watch CI until green, deploy with `tools/deploy.sh`, sweep. Never stack new work on a red CI. Give an ETA for the next push only.
6. **Agent brief.** Every build agent: `git merge main` first when in a worktree; use the migration number and help-id range the orchestrator assigns; run `pnpm verify`; do not commit; report the worktree path and a diff under 200 words.
7. **Plan by file ownership.** Rows that edit the same file go to one agent or run in order. Everything else runs at once.
8. **Docs writes.** Build the text first, then write the file. Add docs with `git add -f <file>` (the `docs/` folder is ignored by `.gitignore` but its files are tracked). Never add a whole folder.
9. **Deploy is additive.** The VPS is shared. Use `tools/deploy.sh`. Never prune, never stop non-`assessiq-*` services.

## Definition of done (project rule 9)

Commit, deploy, document, handoff. The handoff is the top block of `docs/SESSION_STATE.md` with the agent footer.

## Agent workflow rules (Z-57, 2026-10-18)

`docs/agent-brief.md` is the template for every build agent (Z-67). These rules summarise it.

1. The orchestrator owns shared generated files. Agents never edit the `help-system.test.ts` counts, `seeds/help_content.sql`, shared `SKILL.md` files or shared doc hunks.
2. The orchestrator regenerates the help seed once, after it merges the agent work.
3. Use no worktree for non-load-bearing UI rows. Use a worktree only for load-bearing writes.
4. Give related rows to one agent. Use fewer, larger briefs.
5. Give an ETA that includes the gate, the merge and the CI run.
6. Agents run `pnpm verify` before they report.
