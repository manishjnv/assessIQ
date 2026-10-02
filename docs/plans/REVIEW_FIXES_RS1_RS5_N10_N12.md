# Review fixes RS1, RS2, RS3, RS5 and N10 to N12 (2026-10-02, session n)

**Status:** LIVE on production (https://assessiq.in). Code HEAD on `main`: `c788ed7`. Docs commits follow it: `5f258d4` (deploy record, RCA entries, handoff) and the commit that adds this file. Range `274bbc6..5f258d4`, date 2026-10-02 (stage 2 ended about 00:00 IST on 2026-10-03).
**Commits:** `0d02ea9`, `ac531c5`, `578c0aa`, `8113192`, `f40400c`, `8cc46c2`, `48e1cfb`, `c788ed7`, `5f258d4`.
**Deploy:** two stages. Migrations 0146 and 0147 by hand. Detail: `docs/06-deployment.md` § "RS1–RS5 + N10–N12 deploy".
**Scope:** the candidate-facing and text fixes from the 2026-10-02 project review (RS1, RS2, RS3, RS5), the scenario mcq fix (N11), the argon2 upgrade (N10) and a mocked browser check of the candidate runner (N12). No feature was removed.

## Scope

| Task | What it is | Result |
|---|---|---|
| RS1 | Candidate-facing defects: numeric box, invite text, help ids, certificate link | Fixed, live (`0d02ea9`) |
| N11 | Scenario `mcq` steps keep their options in the candidate view | Fixed, live (`ac531c5`) |
| RS2 | True text and brand on admin screens | Fixed, live (`578c0aa`), two items open (RV11, RV16) |
| RS3 | Help text corrections, 10 new keys, migrations 0146 and 0147 | Fixed, live (`8113192`, `8cc46c2`) |
| RS5 | Docs truth pass on root docs, numbered docs, SKILL files, plan headers | Done (`f40400c`), two items open (RV33, RV41c part) |
| N10 | `argon2` 0.40.3 to 0.45.1 | Live (`48e1cfb`) |
| N12 | Playwright spec of the candidate runner with a mocked API | Passes 3 of 3 (`c788ed7`); not run in CI |

## What changed and why

### RS1 candidate-facing defects (`0d02ea9`)

**What changed.**
- RV1: `<AnswerArea>` in `apps/web/src/pages/take/Attempt.tsx` now has `key={currentQuestion.question_id}`.
- RV2 and RV3: the invite dialog and the invite-accept page say "7 days". The footers "Phase 0 · 2026" and "Token #… · 72 h TTL" are removed there and on `apps/web/src/pages/admin/mfa.tsx`.
- RV4: four UI help ids now equal their content keys: `candidate.auth.expiring_soon`, `candidate.cert.completion_modal`, `candidate.cert.share_linkedin`, `admin.assessments.list.content_source`.
- RV5: the certificate drawer links `${window.location.origin}/verify/<id>`.

**Why.** `NumericAnswerArea` keeps a local text draft. Without a key, React reused it between two numeric questions, so the box showed the old text. The server invite TTL is 7 days (`modules/03-users/src/invitations.ts`). The help ids had a hyphen where the keys have an underscore, so no text showed. The old host was a literal in the page.

**Files.** `apps/web/src/pages/take/Attempt.tsx`, `AttemptSections.test.tsx`, `modules/10-admin-dashboard/src/pages/users.tsx`, `certificates.tsx`, `assessment-detail.tsx`, `apps/web/src/pages/invite-accept.tsx`, `apps/web/src/pages/admin/mfa.tsx`, `modules/11-candidate-ui` (`CandidateSessionBanner.tsx`, `CompletionModal.tsx`, `MyCertificates.tsx`).

**Considered and rejected.** A reset effect inside `NumericAnswerArea` fixes one answer area only. The key resets all of them.

**Not included.** The invite text is static. It does not read the expiry from the API response.

**Impact.** No API or schema change. Same defect class as RCA 2026-05-24 (help id mismatch) and RCA 2026-10-01 (invite TTL). See `docs/RCA_LOG.md`.

### N11 scenario mcq steps (`ac531c5`)

**What changed.** In `sanitizeContentForCandidate` (`modules/06-attempt-engine/src/repository.ts`), branch `scenario`, a step with `type === "mcq"` and an array `options` keeps `type`, `id` (string) and `options` (string items only). This is an allowlist. `correct`, `trap` and `expected` never leave the server. A step in the generated shape `{prompt, expected}` has no type and keeps `prompt` only. The runner (`ScenarioAnswerArea` in `Attempt.tsx`) shows radio options and saves the chosen option text as `{stepIndex, response}`.

**Why.** The sanitizer kept only `prompt` for each step, so an mcq step showed no options.

**Files.** `modules/06-attempt-engine/src/repository.ts`, `modules/06-attempt-engine/src/__tests__/sanitize-content-for-candidate.test.ts` (2 new cases, 12 pass).

**Considered and rejected.** Dropping the mcq step type. The owner rule is to keep features.

**Not included.** The mcq step is not auto-scored: a scenario is evaluated from the string response. A stricter check of the scenario answer shape is a separate task (open item N15).

**Impact.** `docs/03-api-contract.md` (candidate attempt row) and `modules/06-attempt-engine/SKILL.md` describe the rule. Adversarial review (Sonnet): accept, LOW notes only.

### RS2 text, brand and small defects (`578c0aa`)

**What changed.**
- RV6 and RV7: the kit manifest and preview image carry the old name "AccessIQ" and a wrong domain. The kit stays untouched (project rule). The app uses consumer copies: `apps/web/public/brand/favicon/app.webmanifest`, `apps/web/public/brand/social/app-og.png` and `app-og.svg` (rendered with `@resvg/resvg-js`). `apps/web/index.html` links them.
- RV8 (`billing.tsx`, Settings page): header "Plan & usage". New cards "How evaluation and usage work" and "Questions about your plan" (keeps `data-help-id="admin.settings.billing.budget"`). The "Technical details" box is removed.
- RV9 (`grading-jobs.tsx`): the engineer notes and the "Coming soon" card are replaced by "Where to find results". Page, route and menu item stay (feature review FR8).
- RV10 (`admin-guide.tsx`): rewritten for the current flow (licensed sets, copy a set, 8 question types, sections and timers, integrity, publish, invite up to 1,000 rows by CSV and 7-day links, evaluation by AssessIQ, review and release, reports, results CSV, certificates). All step anchors and help ids stay.
- RV12 (`tenant-settings.tsx`): the call to `/admin/me` is removed. That route does not exist and `/api/auth/whoami` has no retention field.
- RV13 (`pack-detail.tsx`): `generation-attempts` is requested for the super admin only. The route is super-admin only.
- RV14 (`cohort-report.tsx`): the radar is not rendered there. The distribution list stays. `ArchetypeRadar.tsx` is kept (feature review FR11).
- RV15: the theme fixture key `wipro-soc` is now `default` (`modules/17-ui-system/src/fixtures/tenants.ts`, `apps/web/src/App.tsx`, two stories).

**Why.** Customers saw the wrong product name in the browser manifest and in link previews, and admin screens described limits and steps that no longer apply.

**Considered and rejected.** Editing the kit files (project rule: do not). Static files in the `public/` root: the shared Caddy `@app` matcher sends only `/admin*`, `/candidate*`, `/take*`, `/try*`, `/assets/*` and `/brand/*` to the app, so root files would go to the marketing site and return 404. Rule: a new static file of the app goes under `/brand/` or `/assets/`.

**Not included.** RV11 (help-content admin page; waits for feature review FR14). RV16 (four small admin items). Stale header comments in `billing.tsx` and `grading-jobs.tsx`, and an unused `_Code` helper in `admin-guide.tsx`.

**Impact.** `apps/web/public/brand/` is gitignored because the prebuild script mirrors the kit there. The three files are force-added. Their names differ from the kit names, so the mirror script cannot overwrite them. The kit copies (`/brand/favicon/site.webmanifest`, `/brand/social/og-image.png`) are still served; nothing links them. See `docs/08-ui-system.md`.

### RS3 help text (`8113192`, `8cc46c2`)

**What changed.** `modules/16-help-system/content/en/admin.yml` and `candidate.yml`: 29 entries corrected, 10 new entries, keys 178 to 188, none removed or renamed. New keys: `admin.attempts.release_confirm`, `admin.attempts.print_review`, `admin.attempts.grading_in_progress`, `admin.attempts.grading_stalled`, `admin.attempts.grading_summary`, `admin.activity.feed`, `admin.attempts.list.page`, `admin.dashboard.home.page`, `admin.users.list.page`, `admin.evaluations.queue.page`. The seed `0011_seed_help_content.sql` is regenerated (188 rows; it was stale). Migrations 0146 and 0147 carry the text to production.

**Why.** Help text named internal tools, models and table names, and some entries described behaviour that no longer exists.

**Review correction.** The rewritten MFA entry still said recovery codes are not supported. The code gives 10 one-time recovery codes at enrolment (`apps/api/src/routes/auth/totp.ts`), so the text says that.

**Considered and rejected.** Renaming keys (keys are never renamed). Removing the 44 keys with no screen (they record the first purpose of dormant features; owner rule A).

**Not included.** The page prefixes `admin.tenant-settings` and `admin.generate-wizard` contain a hyphen. The seed generator allows only `[a-z0-9_]`, so they have no content until the UI id changes. Six more prefixes have no content yet: `admin.attempts.detail`, `admin.evaluations.detail`, `admin.grading.jobs`, `admin.question.editor`, `admin.reports.individual`, `admin.reports.landing`. The candidate login text "Organisation code" waits for an owner decision (RO3). The key names `admin.grading.rerun.opus` and `admin.reports.cost.empty_in_claude_code_vps_mode` keep their names; their text is clean.

**Impact.** `docs/07-help-system.md` has the rule that help rows can exist outside the YAML. No API or schema change.

### RS5 docs truth pass (`f40400c`)

**What changed.** Root docs, numbered docs 01, 03, 05, 06, 08, 09, 11, 12, 13 and 14, 11 module SKILL files, 13 plan and design headers, and the local task list. Each now says what is built.

**Why.** Future sessions trust docs. Several said React 18, nginx, or described features as not built when they are live.

**Not included.** RV33 (project `CLAUDE.md`; needs owner approval). RV41c in part: six memory notes outside the repo are corrected; three wait for the owner. The line "Money: never used (no payments in v1)" in `docs/02-data-model.md` is not checked against the billing tables.

**Impact.** Documents only. No code change.

### N10 argon2 (`48e1cfb`)

**What changed.** `argon2` `^0.40.0` to `^0.45.1` in `modules/01-auth/package.json`. The only user is MFA recovery-code hashing in `modules/01-auth/src/totp.ts` (argon2id, memoryCost 65536, timeCost 3, parallelism 4, all explicit). No source change. New test `modules/01-auth/src/__tests__/argon2-compat.test.ts` (3 cases): a hash made by 0.40.3 verifies, a wrong input is rejected, the parameters are equal.

**Why.** Finish the majors skipped in batch 7 (N7).

**Files.** `modules/01-auth/package.json`, `pnpm-lock.yaml`, the new test.

**Considered and rejected.** Holding argon2 back. The compatibility test shows old hashes still verify. Version 0.45 writes the PHC parameters as `m,p,t` where 0.40 wrote `m,t,p`; nothing in the repo matches that string.

**Not included.** `astro-og-canvas` 0.13 and `canvaskit-wasm` 0.42 (0.13 needs Astro 5; the marketing site is on Astro 4.16). Storybook 10 (owner review FR18).

**Impact.** The API image is `node:22-slim` (glibc); the package ships a prebuilt binary; no Dockerfile change. Adversarial review (codex): accept, 1 LOW (two Babel dev packages moved one patch level in the lockfile).

### N12 mocked browser check (`c788ed7`)

**What changed.** New spec `apps/web/e2e/take-runner-mocked.spec.ts`. The Chrome extension was not connected, so the spec runs the real app in headless Chromium (Playwright) with the HTTP API mocked. 3 tests pass: ordering (4 items, first Up and last Down disabled, Down on item 1 swaps, saved body `{order:[1,0,2,3]}`), two numeric questions in a row (second box empty, Prev restores 42), scenario mcq step (three radios and a text step, saved `{steps:[{stepIndex:0,response:'Beta'},{stepIndex:1,response:''}]}`).

**Why.** Check the candidate runner after RS1 and N11 without a real backend.

**Considered and rejected.** The old skipped specs `take-happy-path` and `take-timer-expiry`: they need a real backend. The new spec mocks the API.

**Not included.** The admin authoring screen for ordering, server scoring on a real backend, publish and the admin view. CI runs only `admin-workflow.spec.ts`, so CI does not run this spec.

**Impact.** Test file only.

## Migrations

| # | What | Applied |
|---|---|---|
| 0146 `modules/16-help-system/migrations/0146_update_help_text_corrections.sql` | For each changed key: UPDATE of the global v1 row plus INSERT … ON CONFLICT DO NOTHING. 10 INSERTs for new keys. Idempotent. | By hand, `psql -1 -v ON_ERROR_STOP=1`, recorded in `schema_migrations` |
| 0147 `modules/16-help-system/migrations/0147_help_text_corrections_followup.sql` | Corrects the text of two global rows that exist only in older module migrations: `admin.grading.rerun` and `admin.integrations.embed-origins.add` (the second had an example with a real company domain, from `modules/12-embed-sdk/migrations/0072_embed_help_seed.sql`). | Same |

Why 0147: migration 0146 was built from the YAML. The two rows are not in the YAML, so the production check query found them after 0146.

**How to check (expect 0 rows).** The word "wipro" appears here only because this query looks for it:

```sql
SELECT count(*) FROM help_content WHERE tenant_id IS NULL AND (long_md ~* '(opus|sonnet|wipro|anthropic|claude)' OR short_text ~* '(opus|sonnet|wipro|anthropic|claude)');
```

Help rows went from 185 to 195. There were 0 duplicate global keys, no tenant override rows and no row with a version other than 1.

## Deploy

**Stage 1 (2026-10-02, about 23:40 IST / 18:10 UTC).** VPS `git pull` `6336f61` to `8cc46c2`. 0 `claude` processes. Migrations 0146 and 0147 applied. Built `assessiq-api` and `assessiq-frontend`. Recreated `assessiq-api`, `assessiq-worker` and `assessiq-frontend` (`up -d --no-deps --force-recreate`). Marketing not rebuilt (no change).

**Stage 2 (about 00:00 IST 2026-10-03 / 18:25 UTC 2026-10-02).** VPS pull `8cc46c2` to `c788ed7`. 0 `claude` processes. Built `assessiq-api` only. Recreated `assessiq-api` and `assessiq-worker`. Later the clone was pulled to `5f258d4` (docs only, no rebuild).

**Checks (all passed).**
- 24 containers before and after each stage; api and frontend healthy; 0 error lines in the api and worker logs.
- `/`, `/pricing`, `/try`, `/admin`, `/admin/login`, `/candidate/login`, `/api/health` and `/take/x` return 200.
- Live `index.html` links `/brand/favicon/app.webmanifest` and `https://assessiq.in/brand/social/app-og.png`. The manifest returns `"name": "AssessIQ"` with `application/manifest+json`. The PNG is 28,044 bytes, `image/png`.
- Live bundles contain "valid for 7 days", "Single-use link · valid 7 days", the four corrected help ids, "Plan & usage", "Where to find results", "Find your licensed sets" and "up to 1,000 rows". The API image has the new sanitizer lines.
- Stage 2: `argon2` in the image was 0.40.3 before and 0.45.1 after. Inside the container, a hash made by 0.40.3 verifies and a wrong input is rejected.
- CI on `main`: success for `f40400c`, `8cc46c2`, `c788ed7` and `5f258d4`. CI failed on the four commits before this session (`6336f61` to `274bbc6`). The likely cause is the stale help seed `0011_seed_help_content.sql`, which `8113192` regenerated. This is not proven.

**Tests at the end of the session.** Typecheck 0 errors (all packages). Lint 0 errors, 20 warnings. `@assessiq/web` 64, `@assessiq/admin-dashboard` 102, `@assessiq/help-system` 93, `@assessiq/ui-system` 44. Module 06 sanitizer file 12 (the database-backed module 06 suite was not run). Module 01 `argon2-compat` 3 and `totp` 16. Playwright `take-runner-mocked` 3 of 3.

## How to verify

On the live site:
1. Open `/admin/login`, sign in as an admin, open Users and open the invite dialog. Make sure the text says the link is valid for 7 days.
2. Open an invitation link. Make sure the page says "valid 7 days" and shows no "Phase 0" footer.
3. Open Settings. Make sure the header says "Plan & usage" and a card says "How evaluation and usage work".
4. Open the Grading menu item. Make sure the page says "Where to find results".
5. Open the admin guide. Make sure it mentions licensed sets, sections and timers, and invites of up to 1,000 rows.
6. Open a certificate in the admin drawer. Make sure the verify link starts with the host of the page you are on.
7. In a browser, open `/brand/favicon/app.webmanifest`. Make sure the name is "AssessIQ".
8. Take an assessment that has two numeric questions in a row. Make sure the second box is empty.
9. Hover a help marker on the four corrected ids (expiring session banner, completion modal, share to LinkedIn, content source). Make sure text shows.

Commands:
1. Run the mocked spec from `apps/web`: `pnpm exec playwright test e2e/take-runner-mocked.spec.ts --project=chromium`.
2. Run the sanitizer test in `modules/06-attempt-engine` (`sanitize-content-for-candidate.test.ts`), the help-system tests and `modules/01-auth` `argon2-compat.test.ts` with `pnpm --filter <package> test`.
3. Run the help check query from § Migrations on production. Expect 0.

## Rollback

- **Stage 1 (code).** Use the code rollback procedure in `docs/06-deployment.md` § Rollback and staging with the previous SHA `6336f61`. Rebuild and recreate api, worker and frontend.
- **Migrations 0146 and 0147.** No rollback. They change help text only, and an older build reads the same rows.
- **Stage 2 (argon2).** Use the same procedure with `8cc46c2`. Rebuild and recreate api and worker. Recovery-code hashes made by the new version were not tested on 0.40.3; only the old-hash-on-new-library direction is tested.

## Review corrections

The lead corrected agent output before commit:
1. Brand files moved from the `public/` root to `public/brand/`, because of the Caddy routing rule.
2. One help sentence about recovery codes corrected (the code gives 10 one-time codes).
3. A stale comment removed in `tenant-settings.tsx`.
4. "Up to 1,000 rows" added to the admin guide.
5. Follow-up migration 0147 written after the production check query found two rows outside the YAML.

## Old task or feature checked

- **RS1:** RCA 2026-05-24 (help id prefix mismatch) and RCA 2026-10-01 (invite TTL) compared. Same classes. The 7-day TTL stays the server value.
- **N11:** the old option "drop the step type" was rejected under rule A.
- **RS2 RV12:** `/admin/me` and `/api/auth/whoami` compared. `/admin/me` does not exist and `whoami` has no retention field, so the call was removed.
- **RV14:** the radar component is kept for FR11. Only its use in the cohort report stopped.
- **RS3:** keys kept. The 44 keys with no screen are untouched.
- **N10:** the batch 7 notes (N7 leftovers) were read. N10 finishes the argon2 part.
- **N12:** the old skipped take specs (`take-happy-path`, `take-timer-expiry`) were compared. They need a real backend. The new spec mocks the API.

## Open items

| ID | Item | Who |
|---|---|---|
| RV16 | Four small admin items (dashboard counters, a placeholder line in attempt detail, type lists in generation history and the wizard, a role-mismatch message) | Claude |
| RV21 | Help content for eight page prefixes (two need a UI id without a hyphen first) | Claude |
| N14 | Check the `pnpm audit` count (the N10 run reported 42 high and 2 critical; batch 6 recorded 0 high) | Claude |
| N13 | Astro 5 upgrade for the marketing site, then `astro-og-canvas` 0.13 and `canvaskit-wasm` 0.42 | Claude |
| N15 | Validate the scenario answer shape at save | Claude |
| N17 | Remove stale header comments in `billing.tsx` and `grading-jobs.tsx` and the unused `_Code` helper in `admin-guide.tsx` | Claude |
| RV41d | Check the "Money: never used" line in `docs/02-data-model.md` against the billing tables | Claude |
| RS4 | Marketing truth pass 2 | Claude |
| RS6 | Feature review (plan tiers first) | Claude |
| RV11 | Help-content admin page (waits for FR14) | Claude |
| RO3 | Decision on the "Organisation code" text on candidate login (RV23) | Owner |
| RV33 | Approval of the project `CLAUDE.md` edit | Owner |
| N12b | One click-through of the ordering authoring flow on the live site | Owner |
| RV41c | Three memory notes | Owner |

## Related docs

- `docs/06-deployment.md` § "RS1–RS5 + N10–N12 deploy".
- `docs/RCA_LOG.md` (eight entries dated 2026-10-02).
- `docs/03-api-contract.md` (candidate attempt row, scenario mcq steps).
- `docs/07-help-system.md` § "Help text correction pass (2026-10-02)".
- `docs/08-ui-system.md` § "Brand consumer copies, static file routing and theme fixture key (2026-10-02)".
- `modules/06-attempt-engine/SKILL.md`.
- `docs/plans/PILOT_BATCH_8.md` (the batch before this one).
