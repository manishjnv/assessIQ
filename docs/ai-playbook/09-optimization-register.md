# 09. Optimization register (time, token, gate): the one list to keep in sync

Last updated: 2026-10-18 (S19 review). Owner rule: the idea lists for time, token and gate optimization live here. Detail pages: `02` (time), `03` (token), `10` (gate), `08` (S23 token tools plan), `11` (S24 time and gate tools plan).

## How to keep this register in sync

1. **One ID per idea** (TIME-n, TOK-n, GATE-n). Never reuse or renumber an ID. Add new ideas at the end.
2. **Same commit rule:** whoever builds, changes or drops an idea updates its row here (status, date, evidence) in the same commit, and the detail page when numbers change.
3. **Phase 6 of every session:** read this page, update the rows you touched, bump "Last updated". The handoff block in `docs/SESSION_STATE.md` lists the IDs changed.
4. **Evidence, not hope:** a row only goes to Done with a measured number or a commit sha. Put real before and after numbers (CI minutes, tokens per agent) in the Evidence column.
5. **New idea?** Add the row as `Proposed`, link the ROADMAP row (`Z-nn`), and say who must approve it (owner or not).
6. **Keep it short.** Long reasoning goes in the detail page, not here.

Status words: **Done**, **In progress**, **Planned** (has a ROADMAP row or a prompt), **Proposed** (idea only), **Needs owner** (waits for a yes), **Dropped** (with the reason).

## Time optimization

| ID | Idea | Evidence or expected saving | Status | Where |
| --- | --- | --- | --- | --- |
| TIME-1 | API Docker cache layers (manifests stage, BuildKit pnpm cache, `COPY --chown`) | VPS build 25 min to 37 s (`74704fc`) | Done | `02` |
| TIME-2 | CI `e2e` job in parallel with `quality` | CI 15 min to about 10 (`054baf3`) | Done | `02` |
| TIME-3 | `tools/deploy.sh` one-command deploy | Frontend 2m03, API and worker 1m04 | Done | `02`, `05` |
| TIME-4 | `tools/post-deploy-sweep.sh` instead of a Haiku sweep agent | About 85k tokens and minutes saved per deploy | Done | `02`, `05` |
| TIME-5 | `pnpm verify` with cache and stamp | 5 s when clean; 1 to 8 min with changes | Done | `02`, `05` |
| TIME-6 | Lockfile single-router test | CI fails at once instead of a 17-hour blank page (`36d3a74`) | Done | `02`, `06` |
| TIME-7 | Signed-in smoke gate before deploy (`pnpm verify:signed-in`, deploy step 1b) | Catches a blank page before users (`dbfc554`) | Done, except the injected-failure proof (Z-53) | `02` |
| TIME-8 | Faster CI: typecheck in its own job, unit tests in 3 shards, e2e workers or 2 shards, Playwright browser cache, `ci-ok` aggregator (Z-55) | 4.5 to 5 min per run (CI about 10 to about 6); runner minutes up about 60% | Planned (S24 row 1) | `11` |
| TIME-9 | Docs-only commits: always run a 1-minute `docs-check` job, skip heavy jobs; `tools/deploy.sh` also checks CI on the last code commit (Z-56) | A docs-only push waits about 1 min, not 10 | Planned (S24 row 2) | `11` |
| TIME-10 | Agent workflow rules: orchestrator owns shared generated files, no worktree for non-load-bearing rows, fewer larger briefs, ETAs include gate, merge and CI (Z-57) | Claimed 60 min of a 2.7 h session; unverified | Planned (S24 row 7) | `11` |
| TIME-11 | Worktree per session in `.claude/worktrees/<name>` with `tools/wt-setup.sh` and `tools/wt-clean.sh` | No collisions between sessions; fewer blocked pushes | Planned (S24 row 5) | `10`, `11` |
| TIME-12 | Fix the flaky web tests (no blind retry) | About 10 min per false red; 1 in 8 CI runs failed by chance | Planned (S24 row 4) | `10`, `11` |
| TIME-13 | `tools/deploy.sh` applies each migration file in one transaction | Safer deploys, no half-applied files | Proposed, needs owner yes | `11` |
| TIME-14 | Batches of 3 to 4 rows, push after each batch, never on red CI | Fewer red runs | Done (rule in `CLAUDE.md`) | `01` |

Combined estimate for TIME-8 and TIME-9: daily CI waiting from about 100 min to about 37 min if sessions wait idle. The two overlap; do not add them. Measure after S24.

## Token optimization

| ID | Idea | Evidence or expected saving | Status | Where |
| --- | --- | --- | --- | --- |
| TOK-1 | Batch rows per agent; no agent for 1 to 3 tool calls (a run costs about 70k tokens fixed) | About 10% of daily tokens | Rule live; habit | `03` |
| TOK-2 | Generated start brief `docs/NEXT.md`; Phase 0 stops reading the 490k-token logs | About 5% of daily tokens | Planned (S23 row 1) | `08` |
| TOK-3 | Cut avoidable rework: exact briefs, `git merge main` first, `pnpm verify` before reporting, plan by file ownership | About 4% | Partly done; brief template in S23 row 4 | `03`, `08` |
| TOK-4 | Scripts instead of agents: sweep (done), roadmap recount, next free migration numbers | About 3%; sweep done | Partly done (S23 rows 2 and 3) | `08` |
| TOK-5 | Gemini for bulk reads (`tools/gemini.sh`); Codex review with the diff piped by script | About 2 to 3% of Claude tokens | Gemini done; Codex script planned (S23 row 5) | `04`, `08` |
| TOK-6 | Haiku 5.5 trial on display, copy, help text, wiring, docs, tests; routing report; stop if non-gate rework is above 25% after 8 runs | Saves money, not tokens | Rule live; report script planned (S23 row 6) | `04`, `08` |
| TOK-7 | Measure: real `subagent_tokens` per agent in each footer; compare Phase 0 reading size before and after | Proof for the rest | Planned (S23) | `08` |

## Gate optimization

| ID | Idea | Evidence or expected saving | Status | Where |
| --- | --- | --- | --- | --- |
| GATE-1 | One worktree per session (same item as TIME-11) | Removes shared-tree stamp and push-range collisions | Planned, owner approved the folder | `10` |
| GATE-2 | Verify stamp covers only the files in the push range | Stops pushes blocked by another session's edits | Needs owner (safety hook); build behind an env flag | `10`, `11` |
| GATE-3 | Fix flaky web tests (same item as TIME-12) | Removes false red CI | Planned | `10` |
| GATE-4 | Gate checklist template, one gate per batch of security rows, log findings per gate | Less gate tokens, more findings | Needs owner (gate rules) | `10` |
| GATE-5 | Push right after each commit batch; whoever commits, pushes | No cross-session push ranges | Rule | `10` |
| GATE-6 | Build the S23 tools, then re-measure | Closes the loop | Planned | `08` |
| GATE-7 | Keep: AI gate on security paths only; `pnpm verify`; CI green before deploy; deploy checks; router test; diff review by the main model | Quality guards, unchanged | Done | `01`, `10` |

## Change log

- 2026-10-18: register created from the owner's review (time, token and gate lists). Rows TIME-8 to TIME-10 are ROADMAP Z-55 to Z-57.
