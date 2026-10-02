# Pilot batch 5 (2026-10-02): sections follow-ups, high-stakes vote, eval gate, durable generation batches, CI hardening

**Status:** LIVE on production (https://assessiq.in), deployed 2026-10-02 at `27f6357` (`21502db..27f6357`).
**Deploy:** migrations 0136, 0138, 0140, 0141, 0142 by hand; api/worker/frontend rebuilt and recreated; `AI_EVAL_GATE=warn` (no baseline blessed yet — N5); checks in `docs/06-deployment.md` § Batch 5 deploy. Adversarial review: codex:rescue on E1+E2 = accept (trailer on `27f6357`).

**Scope:** five tasks from `docs/PENDING_TASKS_2026-10-01.md`: N1, E1, E2, E6, N2 (this also closes E7 and D6).

**Not included:** section edit UI (new row N6), fixing the 17 high dependency advisories (N4), growing the eval golden set (N5), e2e in CI (E13, still last), owner tasks.

**Where the detail lives:**

| Topic | Doc |
| --- | --- |
| Migrations 0136, 0138, 0140, 0141, 0142; `settings.high_stakes`; sections lock rule | `docs/02-data-model.md` § "Batch 5 schema changes" |
| Routes, payloads, error codes (`SECTIONS_LOCKED`, `AIG_EVAL_GATE`, `sections_summary`, `section_scores`) | `docs/03-api-contract.md` § "Batch 5" |
| High-stakes vote, eval gate, override quality loop | `docs/05-ai-pipeline.md` (Stage 3 rules, § "E1", § "E2") |
| Deploy order, `baselines` dir, `AI_EVAL_GATE`, eval bootstrap, rollback | `docs/06-deployment.md` § "Batch 5 deploy" |
| CI and test changes | `docs/12-test-coverage.md` |
| Defects found | `docs/RCA_LOG.md` (two 2026-10-02 entries at the end) |
| Eval harness usage | `modules/07-ai-grading/eval/README.md` |
| Module internals | `SKILL.md` of modules 04, 05, 06, 07, 09, 15, 20 |

---

## N1. Sections follow-ups (`48f4dd0`)
- **What:**
  - (a) Per-section scores: `getSectionScoresForAttempt` (09) gives earned/max per section, using the same "effective grading" rule as the total (latest `graded_at`, an override wins ties). The results CSV gets one `Section: <name> (%)` column per section. The admin attempt page gets a "Section scores" table.
  - (b) `updateAssessment` (05) throws 409 `SECTIONS_LOCKED` when `settings.sections` would change and any attempt exists.
  - (c) The candidate attempt view carries `sections_summary` (counts only). The final submit dialog now counts unanswered questions across ALL sections.
  - Help migration 0136.
- **Why:** (a) placement cells want a per-section view. (b) editing sections moves live deadlines and changes draws. (c) the dialog only counted the last section, so students could submit with whole sections blank.
- **Considered and rejected:**
  - Allowing edits and recomputing deadlines. Draws and `section_index` are frozen per attempt, so it cannot be made consistent.
  - Sending question ids in `sections_summary`. Counts are enough and leak nothing.
  - Locking only on in-progress attempts. Submitted attempts also hold frozen draws and per-section scores.
- **Not included:** a section edit UI (N6). Sections can still only be set in the create form.
- **Impact:**
  - Section scores and CSV columns stay blank until the score is released to the tenant. Callers must never call the 09 function for an unreleased score.
  - The lock compares canonical JSON, so re-saving identical sections is allowed.
  - Modules touched: 05, 06, 09, 10, 11, 15, 16, apps/web.

## E1. High-stakes two-model vote (`1070d71`)
- **What:**
  - Assessment-level setting `settings.high_stakes` (bool, default off). Set at create or with `PATCH /api/admin/assessments/:id/grading` (any status, audited).
  - Runtime (`claude-code-vps.ts`): Stage 3 always runs. Any band difference between Stage 2 and Stage 3 goes to manual review (`review_needed`). The normal rule stays a gap of 2 or more.
  - A Stage 3 failure returns `AIG_ESCALATION_FAILURE`, so the answer lands in `review_needed` and stays out of "Accept all".
  - Least-AI tier 2 (reuse of an identical answer) is skipped, because a reused grade may have come from one model.
  - UI: a `HighStakesCard` on the assessment page, a toggle in the create flow, and an "evaluation" badge on the super-admin queue. Help migration 0138.
- **Why:** for high-consequence tests a single model's band is not enough. Two models must agree exactly.
- **Considered and rejected:**
  - Per-question `high_stakes` metadata (the old doc text). Nothing reads it, and the admin cannot see it.
  - Reusing the generic `escalation_failure` class. It did not map to `review_needed`.
  - Majority or higher-confidence pick. Exact agreement is the point.
- **Not included:** a third model, a tenant-level default, a per-question override, any change to the grade-escalate prompt.
- **Impact:**
  - More AI cost and time per answer for flagged assessments (Stage 3 always runs).
  - Admins see more `review_needed` rows.
  - Module 07 reads the flag live at grading time, so toggling affects only later runs.
  - Codex gate applies (07 is load-bearing); sign-off is recorded in `docs/SESSION_STATE.md`.

## E2. Eval gate and override quality (`9354183`, `a789ab5`)
- **What:**
  - `eval run` and `bless` record `skill_shas` (anchors, band, escalate; 8-hex) read from the skill files.
  - `assertEvalGate()` runs before any AI spawn in grade-all and re-run. Mode comes from `AI_EVAL_GATE`: `off`, `warn` (default), `enforce`. Unknown values are treated as `enforce`. In enforce, an unapproved prompt set returns 409 `AIG_EVAL_GATE`.
  - A prompt set is approved only if some baseline has exactly the same three shas. A baseline without `skill_shas` approves nothing.
  - Super-admin GET `/api/admin/super/eval-gate` and `/api/admin/super/grading-quality?days=`. The evaluations page shows a banner and a quality table.
  - Migration 0140: view `grading_override_quality`. Migration 0141: help rows.
  - CLI `harvest-overrides --since <date>` writes private eval cases to the gitignored `eval/cases-private/`.
  - Compose: the api container gets `AI_EVAL_GATE` and a bind mount of `eval/baselines`.
- **Why:** grading prompts are skill files on the VPS, and a prompt edit used to need no proof. Overrides are real human disagreement and were not measured.
- **Considered and rejected:**
  - Running the eval in CI (no Max login in CI; D5).
  - Gate default `enforce` (it would block all AI grading until the first bless; `warn` is the safe default).
  - A new table for overrides. The existing override rows already carry what is needed, so a view is enough.
  - A read-only baselines mount (first version). Opus review changed it to read-write in `a789ab5`: `bless` runs inside the api container and must write there. A host run would also hash `/root/.claude/skills`, which may differ from the live mount, so the gate would never match.
- **Not included:** blessing a baseline (not done yet), growing the golden set (N5), flipping to `enforce`, gating question generation.
- **Impact:**
  - Every later skill edit needs run, compare, bless before deploy, or grading warns (or 409s in enforce).
  - Do NOT set `enforce` before the first bless: all AI grading would stop.
  - `cases-private/` holds student answers. It is gitignored and must never be committed or copied off the server.
  - Baselines live on the host (`/srv/assessiq/modules/07-ai-grading/eval/baselines`) and survive container recreates. `runs/` is container-local, so run, compare and bless in one container life.
  - Codex gate applies (07).

## E6. Server-side generation batches (`d7123d4`)
- **What:**
  - Table `generation_batches` (migration 0142, owned by 07): plan and progress per (tenant, user).
  - Routes in module 04, super-admin guard: `GET /api/admin/generation-batches/active`, `PUT /api/admin/generation-batches/:id`, `PATCH /api/admin/generation-batches/:id`.
  - `admin-generate.ts` adds each finished category to `completed_category_ids` server-side (best-effort, never fails the generation).
  - The generate wizard resumes from the API. A one-time step migrates an old localStorage plan.
- **Why:** the plan lived in localStorage, so a new browser or device lost it. A tab that died mid-category left the plan unaware of a category the server had finished, so resume duplicated it.
- **Considered and rejected:**
  - Server-side orchestration. The browser still drives categories one by one (single-flight AI mutex and the Cloudflare 100 s timeout; also no ambient AI is allowed).
  - Overwriting `completed_category_ids` on PUT. It is unioned, so a stale tab cannot erase progress.
- **Not included:** background execution, multiple active batches per user, a batch history UI.
- **Impact:**
  - Progress update failures only log `generation.batch.progress.failed`.
  - A foreign tenant's or user's batch id returns 409 and does not reveal which.
  - Modules: 04 (routes), 07 (migration, handler), 10 (wizard, api client).

## N2. CI hardening (`28992d1`, `e2d4c49`, `e5090b1`; also closes E7 and D6)
- **What:**
  - Six stale `apps/api` tests fixed (root causes below).
  - CI: a "Test (apps/api)" step, `pnpm audit --prod --audit-level=critical` (blocking), a high-level audit step (informational, `|| true`), and `.github/dependabot.yml` (npm weekly, grouped minor and patch; actions monthly).
  - 11 data-rights DB integration tests (erasure, export, retention, erased list) in `20-data-rights`.
- **Stale test causes:**
  - `@assessiq/attempt-engine` mocks missed `registerAttemptAdminRoutes` (3 files).
  - `mint-session` also needed `CANDIDATE_LOGIN_TOKEN_TTL_SEC`.
  - `google/start` tests still expected the removed `?tenant=` param (tenant-less login P1).
  - `/embed` now redirects (302 to `/take/a/<id>?embed=true`) and sets the embed cookie. The test expected JSON.
  - `whoami` needed `getEnrollmentStatus` in the mock.
- **Why:** the root vitest config covers only `modules/**` and `packages/**`, so `apps/api` tests never ran in CI and drifted for weeks.
- **Rejected:** quarantining the failures. The fixes were small.
- **Not included:** fixing the audit findings. The first run found 0 critical and 17 high: nodemailer <10.0.6, fastify <5.12.2, fast-uri <3.1.7, find-my-way <9.7.0 (new row N4). The frozen-lockfile change and admin dashboard tests are not part of this.
- **Impact:** CI is slower (some tests start Postgres or Redis containers). The critical audit can now block merges.

---

## Verify on the live site
- Sections:
  - Open a released attempt of a sectioned test: the admin page shows "Section scores". Before release the table is absent.
  - Download results CSV: `Section: ... (%)` columns, blank for unreleased rows.
  - Edit sections on an assessment that has attempts: expect "Sections can't be changed after students have started this test."
  - Take a sectioned test: the final submit dialog lists unanswered counts for every section.
- High stakes:
  - Toggle the "High-stakes grading" card on an assessment. Grade an answer: the evaluation shows the badge. A band difference between the two models gives `review_needed`.
- Eval gate:
  - `GET /api/admin/super/eval-gate` as super admin: `{mode:"warn", approved:false, ...}` until a bless. The evaluations page shows the banner.
  - `GET /api/admin/super/grading-quality?days=90` returns `items` per prompt sha.
- Generation batches:
  - Start a multi-category generation in the wizard, close the tab, open it in another browser: the plan resumes and completed categories are marked.
- CI: the next push shows "Test (apps/api)" and both audit steps.

## Rollback
- **Code:** redeploy the previous image tag (`git checkout <sha>` on the VPS, rebuild).
- **Migrations:** additive (a table, a view, help rows). Each header has rollback notes. The old image ignores them.
- **Gate:** set `AI_EVAL_GATE=off` in `.env` and recreate `assessiq-api`.
- **High stakes:** untick the card per assessment.
- **Compose mount:** the baselines mount is rw. Leaving it in place after a code rollback is harmless.

## Downstream impact / open items
- **N4:** bump fastify, nodemailer, fast-uri, find-my-way for 17 high advisories.
- **N5:** grow the eval golden set (about 1 case today), run the first bless, then set `AI_EVAL_GATE=enforce`.
- **N6:** section edit UI (was N1 d). Must respect `SECTIONS_LOCKED`.
- **N3:** push-gate hook still awaits owner approval.
- **E13:** e2e in CI, last.
