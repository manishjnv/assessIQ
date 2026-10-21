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
8. **Docs are local only (owner, 2026-10-21; Z-75 done early).** `docs/` is gitignored and not in git: there is no `git add` for docs, no docs commit and no docs in CI. Build the text first, then write the file. Keep the single copy safe: `node tools/close-session.mjs` zips `docs/` to the Backups folder (keeps the last 5). A worktree gets the main `docs/` through a junction (`tools/wt-setup.sh`). Update the existing doc for a feature; do not add a new file for similar work. The close-out script prints the md count and warns on more than 5 new files or a repeat file name.
8a. **Docs tools (Z-105 to Z-109).** Move a doc with `node tools/docs-move.mjs <from> <to> --reason "..."`: it writes `docs/moves.json` and rewrites the references. Find an old path with `node tools/docs-where.mjs <old path>`. Old session blocks, closed roadmap rows and old roadmap sections go to `docs/archive/` with `node tools/docs-archive.mjs`. Close a session with `node tools/close-session.mjs` (backup, archive, recount, plans index, lint, links, privacy and file-count; it never commits). A plan or design file needs a `Status:` and a `Rows:` line. Private notes go in `docs/private/`. CI scans only the files that are in git (`CLAUDE.md`, `README.md`, `PROJECT_BRAIN.md`, `modules/*/SKILL.md`, `infra/`, `.github/`, `tools/`) for a server IP, a host name or an amount with a currency.
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

## Docs: update the existing file, do not create a new one (owner, 2026-10-21)

1. Before you write a doc, find the file that already covers the feature: the module `SKILL.md`, the numbered doc (`docs/02-data-model.md`, `03-api-contract.md`, `04-auth-flows.md`, `06-deployment.md`, `08-ui-system.md`), a runbook in `docs/runbooks/`, or the design doc for the feature. Update that file.
2. The aim is fewer files, not zero new files. Create a new file when it is really needed (a new feature, a new runbook, a new decision that fits nowhere). Do not create a new file for work of the same kind as an earlier file: a second change to a feature, a second session on a topic, another deploy note. Add to the earlier file instead. Say why in the handoff when you create a file.
3. One change record for each feature, not for each session. A later session that changes the same feature adds a dated section to the same record.
4. A change record or design draft that the work supersedes gets a one-line status at the top: `Status: current`, `as-built` or `superseded by <file>`.
5. All documentation lives in `docs/`. Only the minimum required files stay outside it (`CLAUDE.md`, `README.md`, GitHub convention files, tool-required files). Do not add a new md file outside `docs/` without a reason in the handoff.
6. Do not create a one-time prompt, plan or note file. Prompts go in the chat. Notes go in the handoff block of `docs/SESSION_STATE.md`.
7. At close-out, list the docs you updated and any new file you created, with the reason, in the handoff.
