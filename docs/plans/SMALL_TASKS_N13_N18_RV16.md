# Small tasks N13 to N18, RV16 and RV21 (2026-10-03)

**Status:** LIVE or merged on `main`. Code HEAD: `38c76e3`. Range `62e01d8..38c76e3`, date 2026-10-03. All commits are pushed.
**Commits:** `511e1af`, `e6eb22d`, `4ea20a8`, `2a15ce5`, `38c76e3`.
**Deploy:** migration 0148 applied by hand on production on 2026-10-03. The deploy of the code is in `docs/06-deployment.md`.
**Scope:** the open items that the session of 2026-10-02 left (N13 to N18, the rest of RV16 and RV21). No feature was removed.

## Scope

| Task | What it is | Result |
|---|---|---|
| RV16 (a) | Dashboard counters stop at 50 and "Ready to publish" is always 0 | Fixed (`511e1af`) |
| N15 | Check the scenario answer shape at save | Fixed (`e6eb22d`) |
| RV16 (b to d), N17 | Small admin items, role-mismatch notice, stale comments | Fixed (`4ea20a8`) |
| N16, RV21 | Page help for eight admin pages; two hyphen page ids renamed | Fixed (`2a15ce5`), migration 0148 live |
| N13 | Astro 5 upgrade for the marketing site | Done (`38c76e3`) |
| N14 | Check the `pnpm audit` count | Checked, no code change |
| N18 | Check the "Money: never used" line in `docs/02-data-model.md` | Corrected in the doc |

## What changed and why

### RV16 dashboard counters (`511e1af`)

**What changed.**
- New `countGradingQueue` in `modules/07-ai-grading/src/repository.ts`. It runs one RLS-scoped `COUNT(*) FILTER` query and returns `in_queue`, `awaiting_evaluation` and `ready_to_publish`.
- `handleAdminQueue` now returns `{ items, counts }`.
- `listGradingQueue` now includes `auto_submitted` attempts (timer expiry).
- `modules/10-admin-dashboard/src/pages/dashboard.tsx` reads `counts`. If an older API sends no `counts`, the page uses the list length. If the list is capped, the page shows "Showing the oldest N of M".

**Why.** The three dashboard cards (In queue, Awaiting evaluation, Ready to publish) counted the rows of the queue list, fetched with `?limit=50`. So the cards stopped at 50. "Ready to publish" was always 0, because the queue list holds only attempts that are not evaluated yet. The tenant queue list did not include `auto_submitted` attempts, but the platform evaluation queue did.

**Considered and rejected.**
- Raise the client limit to 100. This is still a cap, and "Ready to publish" stays 0.
- Count on the client from `GET /api/admin/attempts`. That list is paged (maximum 100).

**Not included.** A dedicated index for the count. One tenant's attempts bound the scan. Add a partial index on `attempts (tenant_id, status)` if a tenant passes about 100,000 attempts (task N22).

**Impact.** The response of `GET /api/admin/dashboard/queue` has a new field `counts`. The old field `items` stays. See `docs/03-api-contract.md`.

**Files.** `modules/07-ai-grading/src/repository.ts`, `modules/07-ai-grading/src/handlers/admin-queue.ts` (`handleAdminQueue`), `modules/07-ai-grading/src/__tests__/handlers.test.ts` (case 5.3), `modules/10-admin-dashboard/src/pages/dashboard.tsx`.

### N15 scenario answer shape at save (`e6eb22d`)

**What changed.**
- `checkAnswerForSave(type, answer)` in `modules/06-attempt-engine/src/types.ts`. The key is the question TYPE, never the answer shape. Only `scenario` is checked, with the existing `ScenarioAnswerPayloadSchema`. `null` passes. Unknown keys are removed.
- `findQuestionType` in `modules/06-attempt-engine/src/repository.ts`.
- `saveAnswer` in `modules/06-attempt-engine/src/service.ts` calls the check after the lock, owner, status, timer and section checks.
- A wrong shape gives HTTP 400 `AE_INVALID_PARAM` with `param: "answer"`.

**Why.** `saveAnswer` stored any JSON for a scenario question. The evaluation reads `steps`. A wrong shape was stored with no error and evaluated as empty.

**Considered and rejected.**
- Check every question type at save. The other types keep "stored as sent, scores 0 when malformed". A strict check there could block autosave for a client with an older shape.
- Detect the type by the answer shape. The rule from SP7 is that the key comes from the question type.

**Not included.** A question type frozen per attempt (task N21). The check reads `questions.type` live. `question_versions` stores no type. The candidate view (`listFrozenQuestionsForAttempt`) and scoring read `questions.type` the same way. A comment in the code records this.

**Impact.** `docs/03-api-contract.md` (save-answer row) and `modules/06-attempt-engine/SKILL.md`.

**Files.** `modules/06-attempt-engine/src/types.ts`, `repository.ts`, `service.ts`, `src/__tests__/answer-shape-save.test.ts` (4 cases, no database), one database case in `attempt-engine.test.ts`.

### RV16 small items and N17 (`4ea20a8`)

**What changed.**
- `attempt-detail.tsx`: the fallback text is now "Candidate details are not available". It was "Candidate / assessment details pending backend enrichment".
- `generation-attempts.tsx`: the score table keeps the five AI-generated types and also shows any other type that the server returns.
- "Type lists show 5 types": checked, no defect. AI generation supports exactly five types by design (`modules/04-question-bank/src/difficulty-spec.ts:96`). Numeric, multi_select and ordering are authored by hand. A comment in `generate-wizard.tsx` records this.
- `apps/web/src/lib/RequireSession.tsx`: a role mismatch now shows "You do not have access to this page." with a link "Sign in with a different account". It was a silent redirect to the login page. The gate logic did not change. Children do not render. The no-session and MFA redirects did not change.
- N17: the header comments of `billing.tsx` and `grading-jobs.tsx` now describe the pages as they are today (comment only). The unused `_Code` helper is removed from `admin-guide.tsx`.

**Why.** A user with the wrong role saw the login page with no reason. Other items were stale text.

**Considered and rejected.** Add the other types to the generation wizard. The generator supports five types, so the wizard must list five.

**Not included.** A change to the role model. The reviewer role is to be removed (RV60); this notice only explains the redirect.

**Impact.** Web app only. No API change.

**Files.** `modules/10-admin-dashboard/src/pages/attempt-detail.tsx`, `generation-attempts.tsx`, `generate-wizard.tsx`, `billing.tsx`, `grading-jobs.tsx`, `admin-guide.tsx`, `apps/web/src/lib/RequireSession.tsx`, `RequireSession.test.tsx` (2 new tests).

**Rule A check for `_Code`.** It was a 15-line inline `<code>` style helper. It had no caller and no feature behind it. Two independent searches found no use. The owner listed the removal as a task.

### N16 and RV21 page help for eight pages (`2a15ce5`)

**What changed.**
- Two page ids with a hyphen were renamed: `admin.tenant-settings` to `admin.tenant_settings`, and `admin.generate-wizard` to `admin.generate_wizard`. These are help ids only. The routes `/admin/tenant-settings` and `/admin/generate-wizard` do not change.
- Eight `<page>.page` entries were added to `modules/16-help-system/content/en/admin.yml` for: `admin.tenant_settings`, `admin.generate_wizard`, `admin.attempts.detail`, `admin.evaluations.detail`, `admin.grading.jobs`, `admin.question.editor`, `admin.reports.individual`, `admin.reports.landing`.
- The seed `0011_seed_help_content.sql` is regenerated (188 to 196 rows).
- New migration `0148_seed_page_help.sql`. It is idempotent (`ON CONFLICT DO NOTHING`).

**How the lookup works.** `AdminShell helpPage` mounts `HelpProvider page=...`. The API returns the keys `LIKE '<page>.%'`. The (?) button in the header opens the drawer at the key `<page>.page`.

**Why.** The two hyphen ids could never have content, because the seed generator allows only `[a-z0-9_]`. Six more pages had no page help.

**Production.** Migration 0148 was applied by hand and recorded in `schema_migrations` on 2026-10-03. Global help rows went from 195 to 203. All eight new page keys exist. There are 0 duplicate global keys and 0 rows with internal words. The text of the eight entries was checked against each page. Three sentences were corrected before commit.

**Considered and rejected.** Rename the routes to match. Routes are public paths and stay.

**Not included, and open (task N20).** Some help ids on a page are outside the prefix of that page, so their text cannot load:
- `admin.settings.company_name` and `admin.settings.result_release_mode` (`data-help-id` in `tenant-settings.tsx`; pages `admin.settings.billing` and `admin.tenant_settings`).
- `admin.question.content.*` and `admin.question.ordering.*` on the question editor (page `admin.question.editor`).

This is the same class as RCA 2026-05-24 (help prefix mismatch). The planned lint RV71 covers it.

**Impact.** `docs/07-help-system.md` and `modules/16-help-system/SKILL.md`.

**Files.** `modules/16-help-system/content/en/admin.yml`, `modules/16-help-system/migrations/0011_seed_help_content.sql`, `modules/16-help-system/migrations/0148_seed_page_help.sql`, `tenant-settings.tsx`, `generate-wizard.tsx` and `help-system.test.ts` (row count).

### N13 Astro 5 for the marketing site (`38c76e3`)

**What changed.** In `apps/marketing`:
- `astro` 4.16.18 to 5.18.2.
- `@astrojs/tailwind` 5.1.3 to 6.0.2 (Tailwind 3 stays).
- `astro-og-canvas` 0.5.6 to 0.13.2.
- `canvaskit-wasm` 0.39.1 to 0.42.0.
- One code change in `src/pages/og/[...route].ts`: it uses `await OGImageRoute({...})` (the function returns a Promise in 0.13) and drops the removed `param` option.

**Why.** The N10 note held these packages until Astro 5.

**Where the packages live.** `apps/marketing` is outside the root pnpm workspace (`pnpm-workspace.yaml` has `!apps/marketing`). It has its own `apps/marketing/pnpm-lock.yaml`. The upgrade command is `pnpm up --ignore-workspace` inside `apps/marketing`. The root lockfile and the Vite 8 of the web app did not change. Marketing resolves its own Vite 6.4.3.

**Build compared before and after.** 56 HTML files, 54 OG images, 54 sitemap URLs (the sitemap files are byte-identical), pagefind 56 pages. HTML differs in 4 files only:
- `class=""` is printed as `class` on 3 compare pages.
- On `contact.html` the contact form module script moved from `<head>` to the end of `<body>`. Module scripts are deferred, so the behaviour is the same.

There is no change in text, title, meta, canonical, Open Graph, JSON-LD or robots.

**Considered and rejected.** Stay on Astro 4. The two packages held back need Astro 5.

**Not included.** Astro 6 or 7 (a later major). `@astrojs/sitemap` stays unused in the config (kept as a dependency). Storybook 10 (waits for feature review FR18).

**Impact.** The marketing image must be rebuilt for the change to go live. IndexNow ping after each marketing deploy stays as before.

### N14 audit count (check only)

`pnpm audit --audit-level high` gives 97 findings: 10 low, 43 moderate, 42 high and 2 critical. `pnpm audit --prod --audit-level high` gives 5 moderate, 0 high and 0 critical.

Both older numbers were correct. Batch 6 and the CI gate (`.github/workflows/ci.yml` lines 63 and 66) use `--prod`. The N10 run did not use `--prod`.

Every high and critical finding comes through development and test tools:
- vitest (the critical one is advisory GHSA-5xrq-8626-4rwp, reached through vitest 2.1.9 and 4.1.11 and `@vitest/coverage-v8`)
- testcontainers 10.28
- eslint 9 and typescript-eslint 8
- Storybook 8.6
- `@lhci/cli` 0.15 (lighthouse, puppeteer)
- jsdom 25

No production dependency has a high or critical finding. The follow-up is task N19: update these tools in a separate session, because they are major versions.

### N18 money line (`docs/02-data-model.md`)

The line "Money: never used (no payments in v1)" was wrong. `tenant_grading_budgets.monthly_budget_usd` and `used_usd` are `NUMERIC(10,2)` (migration 0041). No code writes them. Module 19-billing counts whole credits (`tenant_plans.included_credits`, `billing_events`), not money. The line (line 11) is corrected.

## Review record

codex:rescue reviewed the uncommitted diff of RV16 (dashboard), N15 and the `RequireSession` change. Verdict: revise, with 2 MEDIUM notes and no HIGH.

1. The scenario check reads the question type live from `questions`, not from a frozen snapshot. A clone refresh can change the type of a question. The lead accepted this. `question_versions` stores no type. The candidate view and scoring read `questions.type` the same way. A code comment records it. Follow-up: task N21.
2. The count has no dedicated index. The lead accepted this. One tenant's attempts bound the scan. A code comment records the limit. Follow-up: task N22.

Codex confirmed:
- The count runs inside `withTenant`, so tenant isolation holds.
- The count predicates match the status rules.
- `auto_submitted` is accepted by the grading handlers.
- The session gate still checks no-session and MFA before the role, and never renders protected children on the notice path.

## Tests

All tests ran on the final tree.

| Check | Result |
|---|---|
| Typecheck, whole repo | 0 errors |
| Lint | 0 errors, 20 warnings (same as before) |
| Module 06 | 289 tests, 288 passed in the full run. One timing test (`recordEvent` per-second rate cap) failed under machine load and passed when run alone. It is not related to the change. |
| Module 07 `handlers.test.ts` | 31 passed |
| Module 10 | 102 passed |
| Module 16 | 93 passed |
| Web | 66 passed (64 before) |

## How to verify

On the live site:
1. Open the admin dashboard. Make sure the three cards show the real counts and that "Ready to publish" is not always 0.
2. On a tenant with more than 50 waiting attempts, make sure the list says "Showing the oldest 50 of N".
3. Open an admin page that had no help (for example the attempt detail page). Click the (?) button in the header. Make sure the drawer shows text.
4. Sign in as a user with the wrong role and open an admin page. Make sure the page says "You do not have access to this page."
5. Open `/contact` on the marketing site. Make sure the form works.

Commands:
1. Run the module 06 test `answer-shape-save.test.ts` with `pnpm --filter @assessiq/attempt-engine test`.
2. Run the module 07 test `handlers.test.ts` and the web test `RequireSession.test.tsx`.
3. Run the help check query from `docs/07-help-system.md` on production. Expect 0.
4. Run this query on production. Expect 8 rows: `SELECT key FROM help_content WHERE tenant_id IS NULL AND key LIKE '%.page' AND key IN ('admin.tenant_settings.page','admin.generate_wizard.page','admin.attempts.detail.page','admin.evaluations.detail.page','admin.grading.jobs.page','admin.question.editor.page','admin.reports.individual.page','admin.reports.landing.page');`
5. In `apps/marketing`, run `pnpm build`. Make sure the build gives 56 HTML files and 54 OG images.

## Rollback

- **Code commits `511e1af`, `e6eb22d`, `4ea20a8`.** Run `git revert <sha>`. Use the code rollback procedure in `docs/06-deployment.md` § Rollback and staging. Rebuild and recreate api, worker and frontend.
- **`2a15ce5` and migration 0148.** Run `git revert 2a15ce5`. Then delete the eight keys from `help_content` where `tenant_id IS NULL`. Then delete the row `0148_seed_page_help.sql` from `schema_migrations`. An older build reads the same table, so the rows do no harm if they stay.
- **`38c76e3` (marketing).** Run `git revert 38c76e3`. Then rebuild the marketing image.

## Old task or feature checked (Rule B)

- **Dashboard counts:** compared with the platform evaluation queue (`listSuperEvaluationQueue`, which already listed `auto_submitted`) and `deriveEvaluationStatus`.
- **N15:** compared with the existing `ScenarioAnswerPayloadSchema` (reused, not rewritten) and the SP7 rule "answer key from question type".
- **N16:** compared with RCA 2026-05-24 (help prefix mismatch) and RS3 (migrations 0146 and 0147).
- **N13:** compared with the N10 note that held these packages for Astro 5.
- **Role-mismatch notice:** compared with RV60 (the reviewer role cannot open admin pages; the role is to be removed).

## Open items

| ID | Item | Who |
|---|---|---|
| N19 | Update the development tools that carry the high and critical audit findings (vitest first). Major versions; separate session | Claude |
| N20 | Help ids that are outside the prefix of their page, so their text cannot load (`admin.settings.company_name`, `admin.settings.result_release_mode`, `admin.question.content.*`, `admin.question.ordering.*`) | Claude |
| N21 | Decide if the question type must be frozen per attempt | Claude, with owner input |
| N22 | Optional partial index on `attempts (tenant_id, status)` for the dashboard count. Only at scale (about 100,000 attempts for one tenant) | Claude |
| RV11 | Help-content admin page (waits for FR14) | Claude |
| RV23 | The "Organisation code" text on candidate login (waits for RO3) | Owner |
| RV33 | Approval of the project `CLAUDE.md` edit | Owner |
| RS4 | Marketing truth pass 2 | Claude |
| RS6 | Feature review (plan tiers first) | Claude |

## Related docs

- `docs/RCA_LOG.md` (four entries dated 2026-10-03).
- `docs/03-api-contract.md` (queue row and save-answer row).
- `docs/07-help-system.md` § "Help text correction pass (2026-10-02)".
- `docs/02-data-model.md` (line 11, money fields).
- `modules/06-attempt-engine/SKILL.md`, `modules/07-ai-grading/SKILL.md`, `modules/16-help-system/SKILL.md`.
- `docs/plans/REVIEW_FIXES_RS1_RS5_N10_N12.md` (the session before this one).
