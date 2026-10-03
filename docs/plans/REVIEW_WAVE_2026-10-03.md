# Review wave 2026-10-03 (p): N19, N20, E10, N12, N22, RS6, RS8, RS9, RS11, E9, SP7

## 1. Header

**Status:** LIVE on https://assessiq.in. All code is committed and pushed. Open items are in section 17.
**Code HEAD:** `636c970` (the docs handoff commit `6d6c6bd` is on top of it).
**Commit range:** `3911f8b..6d6c6bd` on `main`.
**Deploys:** two waves, both additive only.
- Wave A, HEAD `5f073f0`: migrations 0149, 0150, 0152, 0153; api, worker and frontend recreated.
- Wave B, HEAD `636c970`: migration 0154; api, worker and frontend recreated.

**Migrations (five, applied by hand and recorded in `schema_migrations`):** 0149, 0150, 0152, 0153, 0154.
**Scope:** the open items that the session of 2026-10-03 (o) left, the review fix plan sessions RS6, RS8, RS9 and RS11, and the new task SP7 (`structured_case`). No feature was removed (Rule A).

| Task | What it is | Result | Commits |
|---|---|---|---|
| N20 | Help ids outside their page prefix | Fixed, migration 0149 | `b02bbf3` |
| N22 | Index for the dashboard count | Done, migration 0150 | `fe06cd3` |
| E10 | Stale docs | Done | `c06516a` |
| RS9 | RV62, RV63, RV64 (RV65, RV66 checked) | Done | `afc5069`, `b0c09fd`, `8723dc4`, `a7ea234` |
| RS8 | RV58, RV59, RV60, FR17 gate | Done, migration 0154 | `487707d`, `5e5aaa3`, `59a4816`, `4cd6c8d`, `4374344`, `7ca7cfb`, `a50d573` |
| SP7 | `structured_case` question type | Done, migrations 0152, 0153 | `885403b`, `328dfc8`, `860bfc3`, `e7d7d04` |
| E9 | Split two large files | Done | `4d19c3b`, `0c21079`, `5f073f0` |
| RS6 | Feature review (read only) | Done, 26 results | no code |
| RS11 | E2E stack, CSV guard, RV78 facts | Done | `7accd3f`, `ac8b8cb`, `09595fa`, `beb2278` |
| N19 | Update development tools | Done | `0efd0f9`..`ad4a835`, `a951e5a` |
| N12 | Browser check of ordering | Admin side done locally; live click is the owner | `09595fa` |
| Autosave flush | Submit lost the last answer | Fixed | `0ef50d9` |

## 2. N20 help ids outside the page prefix (`b02bbf3`, migration 0149)

**What changed.**
- The ids `admin.settings.company_name`, `admin.settings.result_release_mode`, `admin.question.content.*` and `admin.question.ordering.*` are renamed under the prefix of their page (`admin.tenant_settings.*`, `admin.question.editor.*`).
- The rename is made in the two pages, in `modules/16-help-system/content/en/admin.yml`, in the seed `0011` and in migration `0149_rename_help_ids_page_prefix.sql`.
- A new guard test `modules/16-help-system/src/__tests__/help-id-page-prefix.test.ts` scans the pages and fails on an id outside its page prefix. A short `ALLOWLIST` (file, id, reason) holds the known exceptions.

**Why.** The help API returns only the keys that match `LIKE '<page>.%'` for the page that mounts `HelpProvider`. These ids sat outside the prefix, so the page never fetched them and the (?) button showed no text. This is the same class as RCA 2026-05-24.

**Files.** `modules/10-admin-dashboard/src/pages/tenant-settings.tsx`, `question-editor.tsx`, `src/__tests__/tenant-settings-release.test.tsx`, the help content and migration files above, `docs/07-help-system.md`, the `SKILL.md` of modules 04 and 10.

**How to verify.** On production, count the old keys. Expect 0. Open Settings and the question editor and click (?). The drawer shows text. Run the guard test with `pnpm --filter @assessiq/help-system test`.

**Rollback.** `git revert b02bbf3`. Run the reverse UPDATE of the eight keys. Delete the row `0149_rename_help_ids_page_prefix.sql` from `schema_migrations`.

**Considered and rejected.** Add new keys with the old ids: the ids would still be outside the prefix. Change the API to return all keys: this loads every key on every page.

**Not included.** 32 older ids that sit outside their page prefix. They are in the `ALLOWLIST` and are task N23.

**Downstream impact.** The help text of the Settings page and the question editor now loads. Every new help id must follow the page prefix rule. Global help rows stay at 203 until wave A adds the SP7 keys (section 7).

## 3. N22 index for the dashboard count (`fe06cd3`, migration 0150)

**What changed.** Migration `modules/06-attempt-engine/migrations/0150_attempts_dashboard_count_idx.sql` creates the partial index `attempts_dashboard_count_idx`. `modules/07-ai-grading/src/repository.ts` (`countGradingQueue`) has an updated comment. `docs/02-data-model.md` records the index.

**Why.** The dashboard cards count attempts with one query (see `docs/plans/SMALL_TASKS_N13_N18_RV16.md`). The codex review of that change asked for an index for the scale case.

**How to verify.** On production, check that the index exists in `pg_indexes`. Open the admin dashboard. The cards load.

**Rollback.** `DROP INDEX IF EXISTS attempts_dashboard_count_idx`. This is harmless. Delete the `schema_migrations` row.

**Considered and rejected.** The existing attempts indexes (checked, Rule B): none covers the status predicate of the count. No index at all: the earlier decision was to add one only at scale; the owner order of this session was to add it.

**Not included.** Any change to the count query.

**Downstream impact.** None for the API. A small write cost on `attempts`.

## 4. E10 stale docs (`c06516a`)

**What changed.** Five docs lose stale text: React 18, `ViewportLock`, "501" texts and PM2 text. Files: `docs/03-api-contract.md`, `docs/08-ui-system.md`, `docs/11-observability.md`, `docs/design/SEO_Strategy.md`, `modules/03-users/SKILL.md`. The line change is small (8 insertions, 8 deletions).

**Why.** An earlier DONE mark for E10 was not correct. Future sessions trust docs. The current text says React 19 and Vite 8, Brevo for email, and bulk import live.

**How to verify.** Search the docs for the old words. The remaining hits are history entries.

**Rollback.** `git revert c06516a`.

**Not included.** History entries and RCA text keep the old words on purpose.

**Downstream impact.** None for code.

## 5. RS9 function defects

### RV62 topic focus reaches the generation runtime (`b0c09fd`, review fixes in `a7ea234`)

**What changed.** The "topic focus" of the generate wizard now reaches the runtime input in `modules/07-ai-grading/src/handlers/admin-generate.ts`. `modules/04-question-bank/src/service.ts` passes it. The review fixes cap `topic_focus` at 200 characters, refuse control characters (`modules/04-question-bank/src/routes.ts`), de-duplicate by sha and make chunk errors null-safe.

**Why.** The topic focus only narrowed the knowledge sources. It never reached the AI prompt variables.

**Considered and rejected.** Change the VPS skill text in this commit. A prompt change is a deploy event with eval re-baselining (project rule 6).

**Not included.** A wizard input field for the topic focus, and a change of the VPS generate skills so that they read `topic_focus` (section 17).

### RV63 preview reads the frozen pool (`afc5069`)

**What changed.** For a non-draft assessment with rows in `assessment_frozen_pool`, `previewAssessment` uses the frozen counts (`countFrozenPoolRows`, `countFrozenForCriterion` in `modules/05-assessment-lifecycle/src/repository.ts`). A draft, or an assessment from before migration 0096 with no rows, keeps the live path.

**Why.** Candidates draw from the frozen pool after publish. The preview counted the live pool.

**Tests.** Two cases in `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts` (frozen path, live fallback).

### RV64 one shared `runGenerationPlan` (`8723dc4`, `a7ea234`)

**What changed.** The three near-copies of the generation plan (sharded, single-call, chunked) in `admin-generate.ts` become one `runGenerationPlan`. Finalize runs only in the `finally` block. De-dup runs on every path. The file loses 503 lines and gains 328.

**Why.** The copies had drifted. The sharded all-fail branch finalized the same row twice. The single-call copy had no de-dup step.

**Tests.** A trigger-based test asserts one UPDATE per generation row. A de-dup test covers the single-call path (`admin-generate-tenant-mode.test.ts`, `admin-generate-stderr.test.ts`, `generate-body-validation.test.ts`).

### RV65 and RV66 (checked, no change)

- RV65: not a defect. `getTenantVisibleAttemptScore` in module 09 and every other tenant read path enforce the release rule.
- RV66: not a code defect. The consent writer exists (`recordTakeConsent` in module 06). `consent_events` has 0 rows because no attempt started since the consent step shipped. Follow-up FU-D20: check after the next pilot attempt.

**How to verify (RS9).** Run the module 05 and module 07 tests. Run one wizard generation and check that `generation_batches` has one row. Preview a published assessment and compare the count with the frozen pool.

**Rollback.** `git revert` the commit. Rebuild and recreate `assessiq-api` and `assessiq-worker`.

**Downstream impact.** `docs/05-ai-pipeline.md` and the `SKILL.md` of modules 04, 05 and 07 record the changes (commit `f5d2aa4`). RV67 needs no fix: sharded generation stays on for 2 tenants and `omnibus` stays the default.

## 6. RS8 load-bearing defects and the reviewer role

### RV58 attempts tab "Awaiting evaluation" (`487707d`)

**What changed.** `GET` attempts list accepts a comma-separated `status` list. Each value is checked. A bad value gives 400 `AIG_INVALID_BODY`. The tab "Pending grading" is now "Awaiting evaluation" and sends `status=submitted,auto_submitted,pending_admin_grading`. Files: `modules/07-ai-grading/src/routes.ts`, `handlers/admin-attempts-list.ts`, `repository.ts`, `modules/10-admin-dashboard/src/pages/attempts.tsx`, `modules/15-analytics/src/repository.ts`.

**Why.** Nothing writes `pending_admin_grading` since `67ed5e2`. The tab was always empty.

**Considered and rejected.** Remove the status (Rule A). The status stays in the CHECK, the types and the readers; FR8 reviews it.

**Check against the old feature.** The status set follows `countGradingQueue`.

### RV59 `createTenant` audit row (`5e5aaa3`)

**What changed.** `createTenant` in `modules/02-tenancy/src/service.ts` calls `auditInTx` in the same transaction. The action is `tenant.provisioned`, in the new tenant's log. The action is added to `ACTION_CATALOG` in `modules/14-audit-log/src/types.ts`. Tests: `audit-writes.test.ts`, `create-tenant.test.ts`.

**Why.** The service ignored its `_createdBySuperAdminUserId` parameter. The only audit write was in the route, after the transaction.

### FR17 worker routes for the super admin only (`59a4816`)

**What changed.** `registerAdminWorkerRoutes` in `apps/api/src/server.ts` uses `authChain({ roles: ['super_admin'] })`.

**Why.** The BullMQ queue is shared by all tenants. A tenant admin could read job data and retry any job. No screen uses these routes.

**Not included.** A route-gate test that lists every `/api/admin/*` route with its role. Manual discipline today.

### RV60 reviewer role removed (`4cd6c8d`, `4374344`, `7ca7cfb`, `a50d573`, migration 0154)

**What changed.**
- Invites, `createUser`, `updateUser` and the super-admin edit-admin reject `role: 'reviewer'` with 400 `INVALID_ROLE`. The invite route enum is `admin | candidate`.
- Email-OTP eligibility is `admin` only. `super_admin` stays blocked.
- TOTP routes accept `admin` and `super_admin`.
- The rate-limit admin tier is `admin` and `super_admin`. A legacy reviewer row falls to the user tier and gets 403 on admin routes.
- The options `anyRoleAuth` (notifications) and `adminOrReviewer` (analytics results CSV) are removed.
- The admin UI and the candidate help lose the reviewer wording. Migration `0154_help_text_no_reviewer_role.sql` updates the help rows; the seed `0011` is regenerated.
- `a50d573` removes an unused select style and import in `EditAdminModal.tsx`.

**Why.** Owner decision RO7: keep the product simple. A reviewer could not open any admin page. Production had 0 reviewer users and 0 open reviewer invites before the change.

**Old purpose checked (Rule B).** The first purpose was a person who reviews grades and reads reports with no admin rights. The tenant review screen covers it.

**Considered and rejected.** Remove the value from the DB CHECK and the TypeScript unions (Rule A: legacy rows must stay readable). A data migration to turn reviewers into admins (no rows exist). A new read-only role (not requested).

**Not included.** No data migration. The value stays in the CHECK, the unions and the `reviewer_count` field. The last-admin guard on demotion is gone with the demotion path; it must return with any future demotion path. Five LOW review notes go to N26.

**Downstream impact.** `docs/04-auth-flows.md` § "Reviewer role removed". One global help row (`admin.users.role`) keeps the word "reviewer" on purpose: its text says that there is no reviewer role.

**How to verify (RS8).** Open the attempts page, tab "Awaiting evaluation". Create a company and check the audit row `tenant.provisioned`. Call `/api/admin/worker/stats` without a session: 401. Run the tests of modules 01, 02, 03, 07, 10, 13, 14 and 15.

**Rollback.** `git revert` the commits of the item, then rebuild and recreate the services. For 0154, read the file first, reverse its statements by hand and delete its `schema_migrations` row.

## 7. SP7 `structured_case` question type (`885403b`, `328dfc8`, `860bfc3`, `e7d7d04`)

**What changed.**
- Migration `modules/04-question-bank/migrations/0152_question_type_structured_case.sql` adds `structured_case` to the `questions_type_check` list. The change is idempotent and touches no table.
- Content shape: a title, a context, an optional log excerpt (maximum 20,000 characters) and 1 to 12 steps. Each step has `select` of `one` or `many`, 2 to 8 options and a `correct` list. Scoring is `all_or_nothing` or `partial` (the default). Types and zod schema are in `modules/04-question-bank/src/types.ts`.
- Answer shape: `{ "steps": { "<stepId>": [int] } }` with the original option indexes. The save check reads the frozen `question_versions.content`.
- Scoring: `structuredCaseFraction` in `modules/09-scoring/src/mcq.ts`. The result is one deterministic `gradings` row. `finalize.ts` is unchanged.
- UI: the editor, the admin views, the generate wizard text, the candidate runner (`StructuredCaseAnswerArea.tsx`) and four help keys. Migration `modules/16-help-system/migrations/0153_seed_structured_case_help.sql` adds the keys; the seed `0011` is regenerated.
- `860bfc3`: the four `non_mcq` predicates exclude the type from the evaluation queue.
- `e7d7d04` (review fix): a select-one step accepts one pick only.

**Why.** Log-triage and incident-response cases need several linked choices about one shared log or story. Single `mcq` and `multi_select` questions cannot share the context.

**Considered and rejected.**
- Reuse `scenario` with all-mcq steps. Determinism must come from the question type, not from its content.
- Extend `multi_select`. It has no shared context and takes one answer only.
- Shuffle the options per step. It needs one option order for each step id.

**Not included.** Per-step option shuffle, AI generation, the `/try` demo, an e2e case in CI, an edit form for existing questions (the editor is create-only), and KQL execution grading (X4, owner decision).

**How to verify.** On the live site, create one `structured_case` question in the editor, publish it in an assessment, take it, and check that the score is set without AI. Run the tests of modules 04, 06 and 09. The local spec `ordering-admin.spec.ts` covers the flow.

**Rollback.** `git revert` the four commits. Rebuild and recreate api, worker and frontend. Do not re-add the old CHECK while a `structured_case` row exists. Delete the four help keys. Delete the `schema_migrations` rows that you reverse.

**Downstream impact.** `docs/02-data-model.md` § "Question type `structured_case`", `docs/03-api-contract.md` (answer save rule), `docs/05-ai-pipeline.md`, `docs/11-observability.md` (commit `f5d2aa4`). Global help rows go from 203 to 207.

## 8. E9 file splits (`4d19c3b`, `0c21079`, `5f073f0`)

**What changed.**
- `modules/04-question-bank/src/service.ts` becomes `service/{_shared,packs,questions,generation}.ts`. `service.ts` stays as the entry file.
- `apps/api/src/routes/admin-super.ts` becomes `routes/admin-super/{_shared,tenants,billing-entitlements,domains,users,entitlement-revoke}.ts`.
- `5f073f0`: the audit call-site guard in `modules/07-ai-grading/src/__tests__/audit-writes.test.ts` expects one `auditInTx` in `admin-generate` after RV64.

**Why.** Both files were very large (2,150 and 2,009 lines in the plan). `platform.tsx` was split in an earlier session.

**Not included.** Any behaviour change. Imports keep their public names.

**How to verify.** Typecheck, and the module 04 and API tests, give the same result as before the split.

**Rollback.** `git revert 0c21079 4d19c3b`.

**Downstream impact.** New work in these areas goes into the split files.

## 9. RS6 feature review (read only, no code)

The review has 26 results: PT1 and FR1 to FR25. The full text is in four local files:
- `docs/plans/RS6_FEATURE_REVIEW_A.md` (PT1, FR7, FR9, FR15, FR19)
- `docs/plans/RS6_FEATURE_REVIEW_B.md` (FR1 to FR6)
- `docs/plans/RS6_FEATURE_REVIEW_C.md` (FR8, FR10, FR11, FR12, FR13, FR20, FR25)
- `docs/plans/RS6_FEATURE_REVIEW_D.md` (FR14, FR16, FR17, FR18, FR21, FR22, FR23, FR24)

| Id | Feature | Result |
|---|---|---|
| PT1 | Plan tiers | Improve (define and finish) |
| FR1 | Audit log viewer, export, archive | Revive viewer and export, merge with Activity, park S3 archive |
| FR2 | Webhooks | Improve |
| FR3 | API keys | Park (revive path written) |
| FR4 | Embed | Revive |
| FR5 | In-app notifications | Merge into SP10 and SP11 notices |
| FR6 | Email templates with no sender | Mixed: revive submitted, merge graded and ready-for-review, park digest, improve totp |
| FR7 | Tenant AI budget and settings | Merge into plan tiers |
| FR8 | Grading jobs page and status | Improve (tenant "Evaluation status") |
| FR9 | Paid AI mode | Park |
| FR10 | Old report routes | Merge topic data into cohort page, park exports, keep refresh |
| FR11 | Behaviour signals and radar | Improve |
| FR12 | Candidate "my assessments" | Merge into candidate portal as "Upcoming" |
| FR13 | Completion modal | Revive |
| FR14 | Help content authoring | Improve |
| FR15 | Per-tenant email sender | Park, revive as Enterprise feature |
| FR16 | Tenancy middleware | Park (superseded, no security gap) |
| FR17 | Worker admin routes | Improve (super-admin tab, tighter gate; gate done in `59a4816`) |
| FR18 | Storybook | Park (re-check at E13) |
| FR19 | Question import by CSV | Park |
| FR20 | Difficulty tags | Improve (show tags; Phase C later) |
| FR21 | KQL answers | Merge three designs into one plan |
| FR22 | Consent and batch tables | Improve (verify wiring) |
| FR23 | Old test scripts | Merge into E13 and the k6 run |
| FR24 | Generation modes | Improve (finish rollout; keep `omnibus` until Stage 4) |
| FR25 | Rubric validation in two places | Improve (module 08 owns all rules) |

**Counts.** 91 follow-up (FU) rows are in `docs/PENDING_TASKS_2026-10-01.md` § P0-V: 71 active and 20 parked. 29 owner decisions are listed there.

**Register corrections found by the review.** The plan text was wrong in several rows, for example: the help text for audit describes a page that does not exist (FR1); 36 files use `auditInTx`, not 35 (FR2); Caddy sets `X-Frame-Options DENY` site wide, a likely iframe blocker (FR4); the Settings budget card no longer shows a budget (FR7); the `/me/assessments` routes are registered and tested (FR12); `smtp_config` has no writer and no value (FR15); the worker routes were open to tenant admins (FR17).

**Rollback.** None. No code changed.

## 10. RS11 e2e stack, CSV guard, dev minter, CI job, RV78 facts

### Local e2e stack (`09595fa`, `beb2278`)

**What changed.** `apps/web/e2e/local-stack.sh` and `seed-db.sh` start throwaway Postgres and Redis containers named `assessiq-e2e-*`. The scripts apply the migrations in the order of `tools/test-support/apply-all-migrations.ts` and start the API, the worker and the web dev server. `--down` removes only these containers. The run guide is `apps/web/e2e/README.md`. `beb2278` forces LF line endings for the shell scripts (`.gitattributes`). The factories create a `super_admin` for packs, levels and questions and a tenant admin for assessments and publish.

| Spec | Result |
|---|---|
| `admin-workflow.spec.ts` | 19 pass, 1 skip (step 12a needs the VPS Claude runtime) |
| `take-happy-path.spec.ts` | 1 pass (un-skipped, real backend) |
| `take-timer-expiry.spec.ts` | 1 pass (un-skipped, real backend) |
| `ordering-admin.spec.ts` (new) | 6 pass (`ordering` and `structured_case`) |
| `take-runner-mocked.spec.ts` | 3 pass |
| `take-error-pages.spec.ts` | 3 pass |
| `a11y.spec.ts` | 3 of 4 pass; the 404 page fails axe `landmark-one-main` and `region` (task N25) |

### CI job

The `e2e` job in `.github/workflows/ci.yml` starts its own `postgres` and `redis` services and needs no repo variables. It is advisory (`continue-on-error`). Make it required after it is green on GitHub (E13). CI for `636c970` is not read yet.

### CSV formula guard (`7accd3f`)

**What changed.** Every CSV writer now prefixes a leading `= + - @` with `'`. Before, only the results CSV had the guard. Four writers get it: audit export (module 14, `service.ts`), analytics heatmap and attempt exports (module 15, `repository.ts`), billing export (module 19, `service.ts`) and the candidate CSV sample (module 10, `CandidateCsvImport.tsx`). Each has one unit test.

**Why.** A name or comment typed by a user could run as a formula in Excel.

**Old rule checked (Rule B).** The guard reuses the rule of `results-export.ts`.

**Not included.** The three AES-256-GCM helpers and the three rate-limit Lua copies are not merged (load-bearing, codex gate; task N24). A shared CSV helper is part of N24.

### Dev session minter (`ac8b8cb`)

**What changed.** `apps/api/src/routes/dev/mint-session.ts` uses `ON CONFLICT (tenant_id, email)`. `apps/web/vite.config.ts` has an env-gated API proxy for e2e.

**Why.** The old clause `ON CONFLICT (tenant_id, lower(email))` has no matching unique index. The route gave 500 for every new candidate. The route exists only when `ENABLE_E2E_TEST_MINTER=true`, so production was never affected. `/api/dev/mint-session` returns 404 on production.

### RV78 migration numbering facts

Recorded in `docs/02-data-model.md` § "Migration numbering facts (RV78)". Nothing is renumbered.
- 126 migration files.
- 10 numbers are used twice: 10, 11, 12, 13, 14, 15, 16, 20, 21, 50.
- 41 numbers are missing up to 153.
- `0057` is a comment-only no-op.
- The real order is the grouping in `apply-all-migrations.ts`. The `find | sort` loop in `docs/06-deployment.md` step 8 is wrong for a fresh database. A warning is added there.
- A new migration takes the next free number above 154.

**Old script checked (Rule B).** The e2e steps reuse the phases of `tests/e2e/walkthrough*.ts`. Phases E and F (leaderboard, email log) are not covered (FU-D23).

**Rollback.** `git revert` the commit. The scripts and specs have no effect on production.

## 11. N19 development tool updates (`0efd0f9`..`ad4a835`, `a951e5a`)

**What changed.**
- vitest 2.1 to 4.1.11 in every workspace. `@vitest/coverage-v8` 4.1.11. testcontainers 10.28.0 to 11.14.0.
- Lockfile-only bumps: browserslist (4.28.x), brace-expansion, js-yaml (4.1.1 to 4.3.2, 3.14.2 to 3.15.2), ip-address (10.2.0 to 10.7.3), grpc-js (1.14.3 to 1.14.5), protobufjs (7.5.6 to 7.6.6) and tmp (0.2.5 to 0.2.7).
- Harness fixes: module 13 `vi.mock` factories use `function` (vitest 4 cannot call `new` on an arrow mock). Module 17 sets `testTimeout` to 30 s (the axe test).
- `a951e5a` takes the lockfile from the branch tip after a cherry-pick order mix-up.

**Audit before and after.** `pnpm audit --audit-level high` without `--prod`: 42 high and 2 critical before, 6 high and 0 critical after. With `--prod`: 0 high and 0 critical, unchanged.

**What is left and why.** The 6 high findings are all in two places: the pinned lighthouse chain of `@lhci/cli` (extract-zip, basic-ftp, tmp 0.1) and the vite 5 of Storybook 8.6. Storybook waits for the FR18 decision (park, re-check at E13).

**Not bumped.** jsdom, eslint, typescript-eslint, Node, pnpm, TypeScript, Storybook.

**Known timing-sensitive tests.** Module 06 rate cap and module 01 TOTP constant time can fail under load. They behave the same at baseline.

**Impact on production.** None. These are development tools. The record is in `docs/12-test-coverage.md` § "Tool versions (N19)".

**Rollback.** `git revert` the six commits and the lockfile commit, then run `pnpm install`.

## 12. N12 browser check of the ordering question

- Candidate side: done earlier (session n, `c788ed7`), `take-runner-mocked.spec.ts`, 3 tests with a mocked API.
- Admin side: done locally in a real-backend browser run. `ordering-admin.spec.ts` authors, publishes, takes and scores `ordering` and `structured_case`, then opens the admin view.
- Live site: the click stays with the owner. The Chrome extension disconnected, so local Playwright replaced the live click. Do not claim a live behaviour check.

## 13. Found during the work

| Finding | Result |
|---|---|
| Submit inside the 5 s autosave window lost the last answer | Fixed in `0ef50d9` |
| Dev minter `ON CONFLICT` target gave 500 | Fixed in `ac8b8cb` |
| Worker routes open to tenant admins | Fixed in `59a4816` |
| 32 help ids outside their page prefix | In the guard `ALLOWLIST`; task N23 |
| The `admin.generate` page help (0148) says "Numeric, multi-select and ordering questions are written by hand" and omits structured case | Open, small follow-up |
| Step 8 of `docs/06-deployment.md` has a wrong migration order for a fresh database | Warning added in docs/06 (see RV78) |

**Autosave flush (`0ef50d9`).** `handleSubmit` in `apps/web/src/pages/take/Attempt.tsx` now flushes every pending save, then posts the submit. The answer autosave is debounced by 5 s. Section finish already flushed. There is no unit test for the flush order. The e2e specs `take-happy-path` and `take-timer-expiry` run on the real backend. Rollback: `git revert 0ef50d9`.

The RCA entries for these items are in `docs/RCA_LOG.md` (nine entries dated 2026-10-03, from "Help ids outside their page prefix never loaded (N20)" to "CSV formula-injection guard missing on four writers").

## 14. Adversarial reviews

codex was not fired. Sonnet takeover ran three times (the global fallback ladder).

| Change | Verdict | What was applied |
|---|---|---|
| RV64 and RV62 (module 07 and 04) | Accept, with 4 revisions | All 4 applied in `a7ea234`: null-safe chunk errors, `topic_focus` cap, control-character refusal, sha de-dup |
| SP7 `structured_case` | Accept, 6 LOW | 1 applied: select-one takes one pick (`e7d7d04`) |
| RV60 reviewer role (auth) | Accept, 5 LOW | None in the commits; all go to N26 |
| RV59 (one-call addition) | No full review | Footer note only |

The final commit `636c970` carries the `Adversarial-Review:` trailer that the push gate needs.

## 15. Deploy

Full records: `docs/06-deployment.md`, sections "Review-fix deploy wave A" and "Review-fix deploy wave B".

**Wave A (HEAD `5f073f0`, commits `3911f8b..5f073f0`).**
1. Pre-deploy check (read-only): the clone was clean on `main` at `3911f8b`. 24 containers ran. Migrations were applied up to 0148 (79 rows). Global help rows: 203. Disk 54 % used. Load 0.3.
2. Push, then `git pull --ff-only` on the VPS: `3911f8b` to `5f073f0`.
3. Apply 0149, 0150, 0152 and 0153 by hand and record each one. Global help rows: 203 to 207.
4. Build `assessiq-api` and `assessiq-frontend`. Use the names with the `assessiq-` prefix. A first try with `api` and `frontend` did nothing.
5. `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`.

**Wave B (HEAD `636c970`, commits `5f073f0..636c970`).**
1. Push, then `git pull --ff-only`: `5f073f0` to `636c970`.
2. Apply 0154 by hand and record it. Global help rows stay at 207.
3. Build `assessiq-api` and `assessiq-frontend`. Both builds exit with 0.
4. Recreate api, worker and frontend, same command as wave A.

**Checks after each wave (all passed).**
- 24 containers before and after.
- 200 for `/`, `/admin`, `/admin/login`, `/candidate/login`, `/take/x` and `/api/health` (wave A also `/pricing`, `/try`, `/take/expired`).
- `/verify/XXXX-0000-00-000000` returns 404.
- `/api/admin/worker/stats` returns 401 without a session. `/api/dev/mint-session` returns 404.
- 0 error lines (level 50 or 60) in the api and worker logs: 10 minutes after wave A, 3 minutes after wave B.
- Wave A database checks: 13 rows under `admin.tenant_settings.%` and `admin.question.editor.%`; the index exists; `questions_type_check` includes `structured_case`; 207 help rows; 0 old keys.
- The Haiku post-deploy grid missed the lazy chunks. The lead checked the lazy chunk `src-94kvjwDT.js`: it contains "Awaiting evaluation", "Structured case", `admin.tenant_settings.company_name` and `admin.question.editor.content.`.

**Not done.** Marketing is not rebuilt. No IndexNow ping. No browser click test on the live site (owner): the Settings (?) help, the question editor with a structured case, the attempts tab "Awaiting evaluation", and the preview of a published assessment.

## 16. Tests

Run on `main` before wave B. Docker is the bottleneck: run suites with `--no-file-parallelism` and run timing tests alone.

| Check | Result |
|---|---|
| Typecheck | 0 errors |
| Lint | 0 errors, 20 warnings |
| Module 01 | 286 |
| Module 02 | 59 |
| Module 03 | 60 |
| Module 04 | 251 |
| Module 06 | 301 |
| Module 07 | 397 (and the guard test: 41) |
| Module 10 | 103 |
| Module 11 | 114 |
| Module 13 | 249 |
| Module 14 | 24 |
| Module 15 | 147 |
| Module 16 | 94 |
| Module 19 | 52 |
| `apps/api` | 131 |
| `apps/web` | 73 |
| Local e2e | admin-workflow 19 of 20 (1 skip), take-happy-path 1, take-timer-expiry 1, ordering-admin 6, take-runner-mocked 3, take-error-pages 3, a11y 3 of 4 |
| CI on GitHub for `636c970` | Not read yet |

## 17. Open items

### Claude

| ID | Item |
|---|---|
| CI | Read CI: `gh run list --commit 636c970` |
| N23 | Rename the 32 help ids in the `ALLOWLIST` of `help-id-page-prefix.test.ts` |
| N24 | Merge the three AES-256-GCM helpers and the three rate-limit Lua copies (load-bearing, codex gate) |
| N25 | 404 page a11y: add a main landmark and a region |
| N26 | RV60 LOW follow-ups: HTTP-level 400 and 403 tests, stale "admin + reviewer" comments, `InAppNotificationRoleSchema` |
| RS7 | Follow-ups of the feature review: FR13 completion modal, FR4 RV43 embed insert fix, FR2 webhook fan-out, FR25 rubric validation in module 08 |
| Wizard | Add the topic-focus field to the generate wizard, and make the VPS generate skills read `topic_focus` (a prompt change is a deploy event with eval re-baseline) |
| Help text | Correct the `admin.generate` page help (omits structured case) |
| RS4, RS10 | Marketing truth pass 2; guards promised in RCA entries (RS10 needs owner approvals for some items) |

### Owner

| Item | Detail |
|---|---|
| PT1 decisions | Tier contents, credit meaning, INR prices, Razorpay or Stripe, terms section 7 |
| RO3 | The candidate "Organisation code" text |
| RV33 | Approval of the project `CLAUDE.md` edit |
| N21 | Decide if the question type is frozen per attempt |
| X4 | KQL execution: decision on VPS RAM (FU-D17, FU-D18) |
| Eval | Run, compare and bless the eval, then switch to enforce |
| MASTER_KEY | Choose the rotation date (the live key is not rotated) |
| N3 | Push-gate hook fix (hooks are permission config) |
| Live clicks | Settings (?) help, question editor with a structured case, attempts "Awaiting evaluation" tab, preview of a published assessment, N12 on the live site |

**Open questions.** (1) Answer the 29 review decisions in one sitting, or per feature as RS7 reaches it? (2) Make the CI e2e job required once it is green?

## 18. Old task or feature checked (Rule B)

- SP7 against reuse of `scenario` with all-mcq steps: rejected, determinism must come from the type.
- RV60 against the tenant review screen: it covers the first purpose.
- RS11 against `tests/e2e/walkthrough*.ts`: steps reused; phases E and F not covered.
- N22 against the existing attempts indexes: none covers the count.
- RV58 against `countGradingQueue`: its status set is reused.
- The CSV guard against `results-export.ts`: its rule is reused.

## 19. Process notes

1. The permission classifier refused `git cherry-pick` onto main, an agent brief that named production facts, and a chained `pnpm lint:rls`. After the owner gave explicit permission, the same commands passed. Keep production facts out of builder briefs and merge after a go-ahead.
2. `git log main..HEAD` lists the newest commit first. Cherry-pick a worktree branch in reverse order. Take the lockfile from the branch tip after a conflict.
3. Docker is the bottleneck. Run suites with `--no-file-parallelism`. Run timing tests alone.
4. A help page shows only the keys that start with its page id. The guard test enforces it now.
5. The Chrome extension disconnected. Local Playwright replaced the live click.
6. Docs are gitignored: add this file with `git add -f` in its own command if it must be tracked.

## Related docs

- `docs/SESSION_STATE.md` entry (p).
- `docs/06-deployment.md` wave A and wave B.
- `docs/RCA_LOG.md` (nine entries dated 2026-10-03, from N20 to the CSV guard).
- `docs/02-data-model.md` (structured_case, RV78 facts, N22 index), `docs/04-auth-flows.md` (reviewer role removed), `docs/12-test-coverage.md` (tool versions, e2e suite).
- `docs/plans/RS6_FEATURE_REVIEW_A.md` to `D.md` (local only), `docs/PENDING_TASKS_2026-10-01.md` § P0-V (local only).
- `docs/plans/SMALL_TASKS_N13_N18_RV16.md` (the session before this one).
