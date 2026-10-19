# 09. Optimization register (time, token, gate): the one list to keep in sync

Last updated: 2026-10-18 (S27). Owner rule: the idea lists for time, token and gate optimization live here. Detail pages: `02` (time), `03` (token), `10` (gate), `08` (S23 token tools plan), `11` (S24 time and gate tools plan).

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
| TIME-1 | API Docker cache layers (manifests stage, BuildKit pnpm cache, `COPY --chown`) | API rebuild after a code edit 11 min to 4 min (`74704fc`; the commit message says measured locally, not on the VPS) | Done | `02` |
| TIME-2 | CI `e2e` job in parallel with `quality` | CI 15 min to about 8 min, serial vs parallel (`054baf3`) | Done | `02` |
| TIME-3 | `tools/deploy.sh` one-command deploy | Frontend 2m03, API and worker 1m04 (`9b7d18cf`) | Done | `02`, `05` |
| TIME-4 | `tools/post-deploy-sweep.sh` instead of a Haiku sweep agent | About 85k tokens saved per deploy (estimate; script in `c4f0159a`) | Done | `02`, `05` |
| TIME-5 | `pnpm verify` with cache and stamp | 5 s when clean; 1 to 8 min with changes (`369c25e7`) | Done | `02`, `05` |
| TIME-6 | Lockfile single-router test | CI fails at once instead of a 17-hour blank page (`36d3a74`) | Done | `02`, `06` |
| TIME-7 | Signed-in smoke gate before deploy (`pnpm verify:signed-in`, deploy step 1b) | Catches a blank page before users (`dbfc554`) | Done (S25): CI runs `signed-in-smoke`; CI proof S27: injected router turned CI red, run 39146004131 | `02` |
| TIME-8 | Faster CI: typecheck in its own job, unit tests in 3 shards, e2e in 2 shards (Z-58), Playwright browser cache, `ci-ok` aggregator (Z-55) | 4.5 to 5 min per run (CI about 10 to about 6); runner minutes up about 60% | Done (S25): CI 6m50 to 3m45 measured (`84305460`) | `11` |
| TIME-9 | Docs-only commits: always run a 1-minute `docs-check` job, skip heavy jobs; `tools/deploy.sh` also checks CI on the last code commit (Z-56) | Docs-only CI run 34 s (`52e47fa8`) and 37 s (`fb2cd882`); before, a full run of about 10 min | Done (`aa5dbf6e`) | `11` |
| TIME-10 | Agent workflow rules: orchestrator owns shared generated files, no worktree for non-load-bearing rows, fewer larger briefs, ETAs include gate, merge and CI (Z-57) | Claimed 60 min of a 2.7 h session; claim not verified | Done (`05193ac1`) | `01`, `11` |
| TIME-11 | Worktree per session in `.claude/worktrees/<name>` with `tools/wt-setup.sh` and `tools/wt-clean.sh` (Z-57) | Scripts exist; no collisions measured yet between sessions | Done (`05193ac1`) | `10`, `11` |
| TIME-12 | Fix the one known flaky web test (`AttemptSubmitModal` key test) and stop blind retries | Flaky test fixed (`05193ac1`); Playwright `retries` now 0 (`8eb0a949`), so a new flake shows as red at once | Done (`05193ac1`) | `10`, `11` |
| TIME-13 | `tools/deploy.sh` applies each migration file in one transaction | Built in `05193ac1`: a file with no own BEGIN/COMMIT runs with its `schema_migrations` row in one `psql -1` transaction. A file with its own BEGIN/COMMIT keeps the old two-step path (not one transaction). | Built in `05193ac1`; VPS dry run not run; needs owner yes **Approved (owner, 2026-10-19, v2 sheet R33): YES.** Enable and test on the next real migration. | `11` |
| TIME-14 | Batches of 3 to 4 rows, push after each batch, never on red CI | Fewer red runs | Done (rule in `CLAUDE.md` and `01`, added `c4f0159a`) | `01` |
| TIME-15 | Signed-in smoke into CI; drop deploy step 1b (Z-59) | Est. 3 to 6 min per frontend deploy | Done (S25, `23ee76fc`): step 1b removed, CI gates the spec; proven red on a bad lockfile (S27, run 39146004131) | `11` |
| TIME-16 | Cut red CI rate and remove Playwright `retries: 2` (Z-60). Related: Z-58, Z-59, Z-60, Z-61, Z-62, Z-66 | One red costs 7 to 10 min plus the fix loop; biggest item. Red-CI rate (method: last 30 runs of ci.yml, gh run list --limit 30, measured 2026-10-18): 2 of 30 red (7%). See `12`. | Done in code (`8eb0a949`): retries 0. Streak 3 of 10 green code runs on the new setting (S27, `tools/ci-green-streak.sh`, measured) | `10`, `11`, `12` |
| TIME-17 | Deploy builds only changed services, both-services fallback (Z-61) | Est. 0.5 to 2 min per deploy | Done (S25, `84305460`): per-image markers, dry run shown | `11` |
| TIME-18 | 4th unit shard; background `pnpm verify` at commit (Z-62) | Est. 0.5 min CI; hides 1 to 8 min | Done (S25, `23ee76fc`): background verify; 4th shard not needed | `11` |

Combined estimate for TIME-8 and TIME-9: daily CI waiting from about 100 min to about 37 min if sessions wait idle. The two overlap; do not add them. Measure after S24.

## Token optimization

| ID | Idea | Evidence or expected saving | Status | Where |
| --- | --- | --- | --- | --- |
| TOK-1 | Batch rows per agent; no agent for 1 to 3 tool calls (a run costs about 70k tokens fixed) | About 10% of daily tokens | Rule live; habit | `03` |
| TOK-2 | Generated start brief `docs/NEXT.md`; Phase 0 stops reading the 490k-token logs | About 5% of daily tokens | Done (S26): `tools/next-brief.mjs`; Phase 0 reading 512k to 129k tokens (est., -75%, RCA kept) | `08` |
| TOK-3 | Cut avoidable rework: exact briefs, `git merge main` first, `pnpm verify` before reporting, plan by file ownership | About 4% | Done (S27, Z-67): `docs/agent-brief.md`, linked from `CLAUDE.md` and `01`; sample brief had all 15 field names | `03`, `08` |
| TOK-4 | Scripts instead of agents: sweep (done), roadmap recount, next free migration numbers | About 3%; sweep done | Done (S27, Z-68): `tools/roadmap-recount.mjs` (matches Z.7: pending 101, closed 153, total 254) and `tools/next-migration.mjs` (prints 0206); sweep done earlier | `08` |
| TOK-5 | Gemini for bulk reads (`tools/gemini.sh`); Codex review with the diff piped by script | About 2 to 3% of Claude tokens | Gemini done. Codex script done (S27, Z-69): `tools/codex-review.sh`, dry run and tests only; live call NOT tested (Codex down) | `04`, `08` |
| TOK-6 | Haiku 5.5 trial on display, copy, help text, wiring, docs, tests; routing report; stop if non-gate rework is above 25% after 8 runs | Saves money, not tokens | S34 (2026-10-19): 2 more Haiku 5.5 runs (EXP-5/6 tails, review queue UI), both accepted without rework by the agent diff; 0 of 2 reworked, but the orchestrator had to fix a nav strip flag and two CI guard tests (help page prefix, erasure coverage) that the agent briefs did not name. Add both tests to the agent brief. Rule live; `tools/routing-report.mjs` built (S26); all-time 75 Opus, 314 Sonnet and 47 Haiku runs; Haiku 5.5 trial from 2026-10-18: 8 runs, 7 non-gate, 2 reworked (29%), STOP by the rule (checked by `routing-report`, S27). S28 (2026-10-18) re-run of `routing-report --since 2026-10-18`: 9 runs, 8 non-gate, 3 reworked (38%), STOP. Reworked runs: Z-64 (NEXT.md brief generator), Z-42 part 3 (blueprint mocks), and Z-67/Z-68/TOK-6 build (Opus changed the closed-word rule and a fixture). Sample is small (3 of 8). Recommendation, owner decides: keep Haiku only for sweeps, digests, research and docs; use Sonnet for build code. The rule text is NOT changed. Owner has not answered the Haiku trial question (v2 sheet R35 blank). | `04`, `08` |
| TOK-7 | Measure: real `subagent_tokens` per agent in each footer; compare Phase 0 reading size before and after | Proof for the rest | Partly done (S26): footer template has `tokens:`; before/after Phase 0 size measured in Z-64; per-agent tokens fill in from now on | `08` |

## Gate optimization

| ID | Idea | Evidence or expected saving | Status | Where |
| --- | --- | --- | --- | --- |
| GATE-1 | One worktree per session (same item as TIME-11) | Removes shared-tree stamp and push-range collisions | Done (`05193ac1`), same item as TIME-11 | `10` |
| GATE-2 | Verify stamp covers only the files in the push range | Stops pushes blocked by another session's edits | **Deferred (owner, 2026-10-18: no for now).** Worktrees (GATE-1) fix the same problem without touching the safety hook. Revisit after a week of worktree use if two sessions still share one folder | `10`, `11` |
| GATE-3 | Fix flaky web tests (same item as TIME-12) | Removes false red CI | Done (`05193ac1`), same item as TIME-12 | `10` |
| GATE-4 | Gate checklist template, one gate per batch of security rows (cap 3 security rows per batch), log findings per gate | About 15 to 30 min and 0.2M tokens a day; same attack list for every review | S34 (2026-10-19): one gate for 3 rows (Sonnet takeover, 262 s, 154k tokens): ACCEPT, 5 low findings, 3 fixed, 2 recorded. Log line in SESSION_STATE S34. **Approved (owner, 2026-10-18).** Done (S26): `gate-checklist.md` and CLAUDE.md rule; ROADMAP Z-65 | `10` |
| GATE-5 | Push right after each commit batch; whoever commits, pushes | No cross-session push ranges | Rule | `10` |
| GATE-6 | Build the S23 tools, then re-measure | Closes the loop | Done (S27): tools built (Z-64 to Z-69); numbers below | `08` |
| GATE-7 | Keep: AI gate on security paths only; `pnpm verify`; CI green before deploy; deploy checks; router test; diff review by the main model | Quality guards, unchanged. Evidence: `pnpm verify` (`369c25e7`), router test (`36d3a74`), deploy checks (`9b7d18cf`) | Done | `01`, `10` |
| GATE-8 | Full security review before the pilot launch (all security paths, once), whatever the per-batch gates found | Catches what batch reviews miss; project has no real data yet, so this is the planned catch-all | Proposed; schedule before the pilot (owner 2026-10-18 chose per-batch gates now) **Approved (owner, 2026-10-19, v2 sheet R32): YES, schedule before the pilot.** ROADMAP Z-86. | `10` |

## GATE-6 re-measure (S27, 2026-10-18)

| Number | Before | After | Kind | Source |
| --- | --- | --- | --- | --- |
| (a) Phase 0 reading set | about 512k tokens (PROJECT_BRAIN, architecture overview, SESSION_STATE, ROADMAP, RCA_LOG) | about 13.1k tokens (PROJECT_BRAIN 30,836 B + architecture overview 11,557 B + NEXT.md 10,030 B = 52,423 B; RCA_LOG by grep only) | estimated (bytes / 4) | `wc -c` |
| (b) CI seconds per job, mean of last 5 code runs (wall 3m28 to 4m12) | CI 6m50 (S24) | e2e shard-2 210 s, shard-1 194 s, unit 185 / 177 / 164 s, typecheck 120 s, phone 144 s, quality 98 s, docs-check 26 s | measured | `gh run view` on 39145795259, 39143114447, 39141608685, 39141251694, 39140227325 |
| (c) Red rate, last 30 runs of ci.yml (method of doc `12`) | 2 of 30 (7%) at S24 | 2 failure, 27 success, 1 still running (7% of 29 done); 0 red since `8eb0a949` | measured | `gh run list --workflow ci.yml --limit 30` |
| (d) Rework per route since 2026-10-18 | all-time Opus 24%, Sonnet 38%, Haiku 19% | Haiku 2 of 8 (25%; 29% non-gate, trial reads STOP), Sonnet 9 of 21 (43%), Opus no logged runs | measured (small samples) | `routing-report` parser, SESSION_STATE |

## Change log

- 2026-10-19 (owner v2 sheet): GATE-8 approved (ROADMAP Z-86); TIME-13 approved (apply at the next real migration); the Haiku trial question (R35) is still open.
- 2026-10-18 (owner decision, TOK-2): Phase 0 no longer reads `docs/RCA_LOG.md` in full (about 116k tokens). `NEXT.md` holds the newest 5 entries; sessions grep the log by module or keyword before planning or reviewing. Phase 0 reading falls from about 129k to about 13k tokens (est., bytes / 4). Risk: the recurring-pattern view in Phase 3 now depends on the keyword grep.
- 2026-10-18 (7-point re-review): ROADMAP rows added by category: time Z-58 to Z-62, token Z-64 and Z-66, gate Z-65, register sync Z-63. Order: Z-63, Z-64, Z-58, Z-59, Z-60 (retries to 0 after 3 green runs), Z-65, Z-66.
- 2026-10-18 (S24 review): TIME-15 to TIME-18 added (ROADMAP Z-59 to Z-62) after an Opus 5.5 and Fable cross-check. Measured baseline: CI 6.8 min on a code push. The red-CI figure of that review is superseded; see `12`. TIME-8 e2e shards are Z-58. Rejected: affected-only tests on main, migration dry run (already in `ci.yml`), image registry, auto-deploy.
- 2026-10-18 (later): owner decided GATE-2 deferred (no for now), GATE-4 approved (one gate per batch, checklist, cap 3 security rows); GATE-8 added.
- 2026-10-18: register created from the owner's review (time, token and gate lists). Rows TIME-8 to TIME-10 are ROADMAP Z-55 to Z-57.

- 2026-10-18 (S25): TIME-7, 8, 15, 16, 17, 18 built. Measured: CI code push 6m50 to 3m45 (jobs: e2e shard-2 3m24 longest). Reviewer found a stale-base hole in the first TIME-17 draft (diff against VPS HEAD); fixed with per-image markers.

- 2026-10-18 (Z-63): register synced with code; rows changed: TIME-1, TIME-2, TIME-3, TIME-4, TIME-5, TIME-8, TIME-9, TIME-10, TIME-11, TIME-12, TIME-13, TIME-14, TIME-16, GATE-1, GATE-3, GATE-7. One red-CI figure now (doc `12`).
- 2026-10-18 (S28): TOK-6 facts and recommendation written (3 of 8 non-gate runs reworked; owner decides). Rule unchanged.
- 2026-10-18 (S27, batches 2 and 3): TIME-7, 15, 16 updated (CI proof, streak 3 of 10); TOK-5 done in code; GATE-6 closed with the four numbers above; Z-59 proof recorded in RCA_LOG.
- 2026-10-18 (S27, batch 1): TOK-3, TOK-4 done; TOK-6 `--since` added and stale "43 runs" text fixed. Trial since 2026-10-18 reads STOP (29% non-gate rework over 7 runs: Z-64 and Z-42 part 3); owner decides.
- 2026-10-18 (S26): Z-63 to Z-66 built. TOK-2, TOK-6, TOK-7 and GATE-4 rows updated. Phase 0 reading set estimate 512k to 129k tokens.
