# 12 — Test coverage map

*Type: reference* — This page maps test coverage for each module and lists the high-risk gaps.

**Status:** the per-module audit is from 2026-05-15 and is not current. Later sections hold updates up to 2026-10-03.

## Audit scope

| Item | Value |
| --- | --- |
| Audit date | 2026-05-15 |
| Method | File shape only. No `vitest --coverage` run |
| When to re-run | When the test:source ratio of a module changes materially |
| Modules audited | 19 |
| Well-covered | 5 |
| Partial | 13 |
| Thin | 1 |
| None | 0 |
| Not applicable | 0 |
| High-risk gaps | 3 (2 high and 1 medium, all on load-bearing modules) |

> **Note (2026-10-02):** the repo now has 21 modules. This audit does not cover `19-billing` and `20-data-rights`.

## Per-module coverage

| Module | Source files | Test files | Test:source | Test runner | Critical-path coverage |
| --- | --- | --- | --- | --- | --- |
| 00-core | 8 | 6 | 0.75 | vitest | **well-covered**. Config, errors, ids, logger, time and request-context are tested. Every public export has a dedicated test |
| 01-auth | 18 | 7 | 0.39 | vitest | **partial**. Covered: google-sso, sessions, totp, embed-jwt, middleware, api-keys, candidate-login. `magic-link.ts` and `crypto-util.ts` have no dedicated tests. Rate-limit and session-loader get indirect coverage at best |
| 02-tenancy | 7 | 2 | 0.29 | vitest | **partial**. `tenancy.test.ts` covers the CRUD service. `audit-writes.test.ts` covers audit integration. `tenantContextMiddleware` (BEGIN/SET LOCAL/COMMIT/ROLLBACK lifecycle) and the `withTenant` transaction wrapper have **no dedicated tests**. Every request passes through these isolation primitives |
| 03-users | 10 | 2 | 0.20 | vitest | **partial**. `users.test.ts` and `audit-writes.test.ts`. Invitations, normalize, redis-sweep, import, invariants and audit-redact have no tests |
| 04-question-bank | 6 | 6 | 1.00 | vitest | **well-covered**. Tests exist for generate-body-validation, generation-attempts-route, audit-writes, question-bank CRUD, score-attempt-route and bulk-status-route |
| 05-assessment-lifecycle | 9 | 3 | 0.33 | vitest | **partial**. Covered: lifecycle (state machine and core service), invite-email, audit-writes. `boundaries.ts`, `tokens.ts` and `repository.ts` have no dedicated tests |
| 06-attempt-engine | 7 | 2 | 0.29 | vitest | **partial**. `attempt-state-machine.test.ts` covers the critical state-machine invariants. `attempt-engine.test.ts` covers the core service. `routes.candidate.ts`, `routes.take.ts` and `rate-cap.ts` have no tests |
| 07-ai-grading | 22 | 21 | 0.95 | vitest (unit) and vitest (eval harness) | **well-covered**. 13 unit tests: single-flight, skill-sha, VPS runtime, auto-weight, concurrency, eval-runner, stream-json-parser, generate-rubric, citation, stderr, tenant-mode, handlers, audit-writes. 8 eval harness tests: CLI, score-goldens, inspect-render, cleanup-stale, cleanup-orphaned, score-candidate-runtime, stage3-watch, extract-fixtures. A lint sentinel CI guard also exists |
| 08-rubric-engine | 4 | 1 | 0.25 | vitest | **well-covered**. `rubric-engine.test.ts` exercises all 4 public exports (`validateRubric`, `sumAnchorScore`, `computeReasoningScore`, `finalScore`) against the worked example in `docs/05-ai-pipeline.md`. The module is small and focused on purpose |
| 09-scoring | 6 | 2 | 0.33 | vitest | **partial**. `scoring.test.ts` and `audit-writes.test.ts`. `archetype.ts` (archetype classification) and `routes.ts` have no direct tests |
| 10-admin-dashboard | 33 | 3 | 0.09 | vitest and playwright (e2e) | **thin**. The ratio 0.09 is the lowest in the codebase. Tested: `admin-dashboard` render smoke, `attempt-detail-error` edge case, `generation-attempts-score` UI. 16 page components and all supporting components have no tests. The module has no backend service layer. Playwright had no baselines at audit time |
| 11-candidate-ui | 19 | 5 | 0.26 | vitest and playwright (e2e) | **partial**. Smoke tests exist for CandidateShell, CandidateSessionBanner, CompletionModal, MyCertificates and components. `AttemptTimer`, `QuestionNavigator`, `AutosaveIndicator`, `IntegrityBanner` and `CandidateHelp` have no tests. Playwright had no baselines at audit time |
| 12-embed-sdk | 7 | 4 | 0.57 | vitest | **partial**. origin-csp, embed-jwt-db, embed-verify and session-mint cover all 4 security-critical paths. The other files are likely index and type re-exports |
| 13-notifications | 17 | 4 | 0.24 | vitest | **partial**. Covered: email-send-flow, notifications (core), audit-writes, candidate-login-link. Webhook delivery, in-app short-poll, i18n formatting and SES retry paths have no tests |
| 14-audit-log | 8 | 1 | 0.13 | vitest | **partial**. `audit.test.ts` is a testcontainer integration test with 9 cases. The cases include **append-only enforcement** (UPDATE and DELETE are both blocked at DB level), tenant isolation, redaction, RequestContext capture and list pagination. `archive-job.ts` (S3 export), `webhook-fanout.ts` (event delivery) and `routes.ts` (admin audit API) have no tests |
| 15-analytics | 16 | 4 | 0.25 | vitest | **partial**. Covered: service, analytics (report queries), activity, activity-candidate. Reporting export paths, MV refresh and CSV/PDF generation have no direct tests |
| 16-help-system | 8 | 3 | 0.38 | vitest | **partial**. Tested: help-system (core lookup and content serving) and audit-writes. Tooltip and drawer assembly get partial coverage through the help-system test |
| 17-ui-system | 26 | 7 | 0.27 | vitest and playwright (e2e) | **partial**. Tested: Spinner, Placeholder, ProgressBar, LeaderboardList, StackedBarChart, ActivityHeatmap, reduced-motion (36/36 pass at Phase 14 close). Untested: Button, Card, Chip, Field, Icon, Num, Modal, Drawer, Table, Sidebar, StatCard, ScoreRing, Sparkline, ThemeProvider, Tooltip. Playwright had no baselines at audit time |
| 18-certification | 11 | 13 | 1.18 | vitest | **well-covered**. Tests: types, credential-id, crypto (HMAC), repository, service, pdf, admin-reissue, list-mine, share-linkedin, public-repository and 3 more. 79/79 passed at Phase 5 close |

## High-risk gaps

| Module | Gap | Risk |
| --- | --- | --- |
| 01-auth | `magic-link.ts` (candidate token generation, expiry and reuse guard) and `crypto-util.ts` (HMAC primitives shared with session signing) have no dedicated tests. The `rate-limit.ts` middleware has no tests. Magic-link is the only candidate auth path when Google SSO is not used | **HIGH** |
| 02-tenancy | The `tenantContextMiddleware` BEGIN/SET LOCAL/COMMIT/ROLLBACK lifecycle and the `withTenant` wrapper have no dedicated tests. Every request passes through these primitives. A silent misconfiguration would break multi-tenant isolation at the DB layer | **HIGH** |
| 14-audit-log | `archive-job.ts` (S3 export), `webhook-fanout.ts` (event delivery) and `routes.ts` (admin audit API) have no tests. The testcontainer integration test covers the append-only core. The module is load-bearing | **MEDIUM** |
| 10-admin-dashboard | 33 source files and 3 test files (ratio 0.09). All admin page components have no tests. The blast radius is UI regressions only (no backend service layer) | **LOW** |
| 08-rubric-engine | All 4 public exports are tested against the worked example. Coverage of edge cases is **unclear**: zero-weight anchors, missing synonym fields and malformed rubric JSON. The module has one test file and runs in the production grading path. Flag it for the next rubric-engine investment session | **MEDIUM** |

## Test runners

| Runner | Scope | Notes |
| --- | --- | --- |
| vitest | All 19 audited modules and `apps/api` | One `vitest.config.ts` for each module and one root workspace `vitest.config.ts`. **Versions (N19, 2026-10-03): vitest 4.1.11, `@vitest/coverage-v8` 4.1.11, testcontainers 11.14.0** |
| playwright (e2e) | `apps/web` | Real-backend suite since 2026-10-03 (RS11). See "E2E suite (RS11, 2026-10-03)" below. The older note "5 unauthenticated routes, no baselines" is history |

No jest config exists in the repo.

## Test-investment guidance

| Item | Detail |
| --- | --- |
| G3.D `audit-writes.test.ts` pattern | Each module in the G3.D auditInTx sweep has an `audit-writes.test.ts` that validates the auditInTx call paths. The modules are 02-tenancy, 03-users, 04-question-bank, 05-lifecycle, 09-scoring, 13-notifications, 16-help-system and 07-ai-grading. This is real coverage, but only of audit integration, not of the whole module surface |
| Playwright e2e | When baselines exist (Phase 15 next step), modules 10, 11 and 17 gain e2e coverage for golden-path flows. E2E does not replace missing unit and integration tests for state machines and service logic |
| Investment order (highest risk first) | 01-auth magic-link and rate-limit; 02-tenancy middleware transaction flow; 14-audit-log archive, fanout and routes; 03-users service gaps; 06-attempt-engine routes; 08-rubric-engine edge cases; 10-admin-dashboard critical admin flows |

## Batch 5 update (2026-10-02)

- **`apps/api` is now in CI.**
  - The root `vitest.config.ts` includes only `modules/**` and `packages/**`. CI never ran `apps/api` tests, and six drifted.
  - `28992d1` fixed them. `e2d4c49` added a "Test (apps/api)" step (`pnpm --filter @assessiq/api test`).
  - Some tests start Postgres or Redis testcontainers.
  - The Test runners table says `apps/api` takes part in vitest. Before this batch, only a local run covered it.
- **`20-data-rights` now has tests.** `e5090b1` adds 11 DB integration tests: erasure, export, retention, erased list. This module had 0 tests (item E7). The "20-data-rights" status in the audit above is out of date.
- **Dependency audit gate (D6).**
  - CI runs `pnpm audit --prod --audit-level=critical` (blocking) and `--audit-level=high || true` (informational).
  - Dependabot (`.github/dependabot.yml`): npm weekly with minor and patch grouped, github-actions monthly.
  - First run: 0 critical, 17 high (nodemailer <10.0.6, fastify <5.12.2, fast-uri <3.1.7, find-my-way <9.7.0). Not fixed yet (N4).
- **New tests in this batch.** `sections-locked.test.ts` (05), `sections-summary.test.ts` (06), `section-scores.test.ts` (09), `eval-gate.test.ts` and `grading-quality.test.ts` (07), `generation-batches-route.test.ts` (04), high-stakes cases in `integrity-route.test.ts` (05), `claude-code-vps.runtime.test.ts` and `least-ai.test.ts` (07), `evaluations-queue.test.tsx` (10).
- **Still open.** The admin dashboard (10) is still thin. The eval harness never runs in CI (D5). E2E in CI is E13, last.

## Tool versions (N19, 2026-10-03)

| Item | Detail |
| --- | --- |
| Upgrades | vitest 2.1 to 4.1.11 in every workspace; `@vitest/coverage-v8` 4.1.11; testcontainers 10 to 11.14.0 |
| Lockfile-only bumps | browserslist, brace-expansion, js-yaml, ip-address, grpc-js, protobufjs, tmp, form-data, ws |
| Commits | `0efd0f9` to `ad4a835`, `a951e5a` |
| Harness fixes | Module 13 `vi.mock` factories use `function` (vitest 4 cannot `new` an arrow mock). Module 17 sets `testTimeout` to 30 s (the axe test) |
| Reason | `pnpm audit --audit-level high` without `--prod` showed 42 high and 2 critical findings, all in dev tools. Now: 6 high and 0 critical |
| Findings left | 6 high: the pinned lighthouse chain of `@lhci/cli` (extract-zip, basic-ftp, tmp 0.1) and the vite 5 of Storybook 8.6. Storybook waits for FR18 |
| `--prod` result | Unchanged: 0 high, 0 critical, 5 moderate |
| Not bumped | jsdom, eslint, typescript-eslint, Node, pnpm, TypeScript, Storybook |
| Timing-sensitive tests | Module 06 rate-cap and module 01 totp constant-time. They can fail under load. They behave the same at baseline |

## E2E suite (RS11, 2026-10-03)

| Item | Detail |
| --- | --- |
| Stack | `apps/web/e2e/local-stack.sh` (with `seed-db.sh`) starts throwaway Postgres and Redis containers named `assessiq-e2e-*`. It applies migrations in the order of `tools/test-support/apply-all-migrations.ts`. It starts the API and the worker with `ENABLE_E2E_TEST_MINTER=true` (local only), and the web dev server. `--down` removes exactly its own containers |
| Run guide | `apps/web/e2e/README.md` |
| Roles in the factories | The platform-only content model needs a `super_admin` to create packs, levels and questions. It needs a tenant admin to create assessments and invitations and to publish |
| CI | The `e2e` job is rewritten (commit `09595fa`). It starts its own `postgres` and `redis` services and needs no repo variables. It is advisory (`continue-on-error`). Promote it to required when it is green on GitHub (E13) |
| N12 | `ordering-admin.spec.ts` closes the admin-side check of N12 in a local real-backend browser run. The click on the live site is still the owner's |
| Not included | Visual baselines, leaderboard and email-log steps (FU-D23) |

| Spec | Status | Note |
| --- | --- | --- |
| `admin-workflow.spec.ts` | 19 pass, 1 skip | Step 12a is skipped. It needs the VPS Claude runtime |
| `take-happy-path.spec.ts` | pass | Un-skipped. Runs on the real backend |
| `take-timer-expiry.spec.ts` | pass | Un-skipped. Runs on the real backend |
| `ordering-admin.spec.ts` (new) | pass | Author, publish, take, deterministic score, admin view, for `ordering` and `structured_case` |
| `take-runner-mocked.spec.ts` | pass | Mocked API (N12 candidate part) |
| `a11y.spec.ts` | 404-page test fails | axe `landmark-one-main` and `region`. The gap existed before. Roadmap N25 |

## CI guards and new tests (RS10 and session q, 2026-10-03)

**CI steps added (`e645d81`).**

- `react-hooks/rules-of-hooks` at error level in ESLint (RV69). Only that rule. The React Compiler rules are not adopted.
- The `apps/web` unit tests run in CI (RV70). Before, 11 files ran nowhere.
- `pnpm lint:mv-tenant-filter` and `pnpm lint:mv-tenant-filter:self-test` (RV72).
- CHECK C of `tools/lint-deploy-procedure.ts` compares `ConfigSchema` keys with `.env.example` (RV75). Self-test C-5.

**New tests.**

| File | What it checks |
| --- | --- |
| `modules/02-tenancy/src/__tests__/with-tenant-on-commit.test.ts` | Hooks run after COMMIT and release. They never run on rollback. `onCommit` returns false outside `withTenant` |
| `modules/12-embed-sdk/src/__tests__/jit-user.test.ts` | Database tests for the JIT user rules: create, repeat, concurrent double call, erased, soft-deleted or disabled, admin, mixed-case admin, other tenant |
| `apps/api/src/__tests__/routes/reviewer-role-removed.test.ts` | 400 on invite, user create and PATCH with `reviewer`. 403 for a reviewer session on notifications, webhooks and TOTP enrol |
| `modules/00-core/src/__tests__/aes-gcm.test.ts` | Legacy-layout vectors for both layouts, base64 embed output, previous-key fallback, tamper and short-input rejection |
| `modules/01-auth/src/__tests__/rate-limit-tiered.test.ts` | Six call-shape tests rewritten as behaviour tests |
| `modules/11-candidate-ui` tests | `CompletionModal` and `MyCertificates` tests updated |

**Totals (2026-10-03).**

| Suite | Result |
| --- | --- |
| Modules | 2556 of 2557 pass. The one failure is the `totp.test.ts` constant-time timing flake (pre-existing) |
| `apps/api` | 138 pass |
| `apps/web` | 73 pass |

The `candidate-login` floor test flaked once under Docker load. A Redis error makes the rate check fail closed and return before the 200 ms floor. It passes alone, 23 of 23.

## Lints and self-tests added in session r (2026-10-03)

**CI steps (commit `ea906d4`, RV71 and RV74).** Each tool has a `:self-test` run.

| Lint | Rule |
| --- | --- |
| `pnpm lint:doc-anchors` and `lint:doc-anchors:self-test` | Every `NN-name.md#anchor` in docs, code and skills must match a real heading. The `KNOWN_STALE` list is empty |
| `vitest-coverage` | Each module `vitest.config` follows the coverage rules |
| `skill-mount` | The skill directories match the compose mount |
| `public-collisions` | Names in `public/` do not collide with SPA routes |
| `ui-api-contract` (RV74) | 167 UI calls are checked against 225 server routes. The allowlist `tools/ui-api-contract.allowlist.txt` has 4 entries, all for `help-content.tsx` (FR14/FU-D1) |

**Other self-tests.** Run both by hand. Neither is in CI.

- `.claude/hooks/push-adversarial-gate.test.sh`: 5 cases, including a chained push and a missing `jq` (N3, `60477e0`).
- `tools/ops/assessiq-backup-check.sh`: 11 cases (RV73).

**New unit tests.** FU-C17 strict rubric rules in 08 (`strictRubricIssues`), FU-B6 business events in 13, N21 type reads in 06/07/09, the `release.ts` structure test (`74f1f46`).

**Totals (2026-10-03, session r).**

| Suite | Result |
| --- | --- |
| Typecheck | 0 errors |
| Lint | 0 errors (20 old warnings) |
| Modules 04, 06, 08, 09, 13 | 963 pass |
| Module 07 | 404 pass |
| `apps/api` | 138 pass, 7 todo |

**Flaky under Docker load.** `totp.test.ts` and the candidate-login timing floor test.

## Session S15 tests (2026-10-17)

### Phone first-question timing (RW-79, S15)

| Item | Detail |
| --- | --- |
| Playwright project | `mobile` in `apps/web/playwright.config.ts` (`devices['Pixel 5']`, `testMatch` `phone-first-question.spec.ts`). The `chromium` project ignores the spec |
| Spec | `apps/web/e2e/phone-first-question.spec.ts` |
| Throttle | CDP `Network.emulateNetworkConditions`: 150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up. CPU 4x slower |
| Flow | Invitation link `/take/<token>`, then Begin is visible, then consent and click, then "Question 1 of" |
| Runs | 5 runs, a fresh browser context for each. The test asserts median below 20 000 ms |
| Advisory mode | `PHONE_FLOW_ADVISORY=1` logs the median and does not fail |
| Run command | `playwright test --project=mobile phone-first-question`, against a production build (`vite preview` on 4173 with `E2E_API_PROXY`) |
| Fixture | `provisionInvitations({label, count, makeQuestions, questionCount})` in `apps/web/e2e/fixtures/factories.ts`. It creates pack, level and questions, publishes, creates and publishes the assessment, invites N minted candidates and waits for the worker to set the assessment to active |
| Dev-email-sink dependency | The API never returns the plaintext token. The fixture reads each `/take/<token>` link from the dev email sink (`ASSESSIQ_DEV_EMAILS_LOG`, else `~/.assessiq/dev-emails.log`). The API must run on the same machine |
| CI | Step "Phone first-question timing (RW-79)" in the `e2e` job of `.github/workflows/ci.yml`. It has `continue-on-error: true` and `PHONE_FLOW_ADVISORY=1`. Comment in file: advisory until 2026-10-31. On that date, remove both and make it required |

| Measurement (median) | Landing | Begin | Total |
| --- | --- | --- | --- |
| Baseline | 4729 ms | 3084 ms | 7813 ms |
| After lazy chunks | - | - | 7186 ms |
| Final, agent run | - | - | 5108 ms |
| Final, orchestrator rerun | 2827 ms | 1299 ms | 4209 ms (runs 4209, 4557, 4410, 3987, 3830) |

**Not measured.** The path from the result-released email (`/candidate/login?tenant=<slug>`). Real devices and real networks.

### Candidate progress tests (RW-84, S15)

| Test file | Cases |
| --- | --- |
| `modules/06-attempt-engine/src/__tests__/candidate-progress.test.ts` | Testcontainers. Two released and one unreleased attempt, the "Other" bucket, `review_needed` exclusion, a second candidate sees nothing |
| `apps/api/src/__tests__/routes/me-progress.test.ts` | 401 without a session, response shape |
| `modules/11-candidate-ui/src/__tests__/MyProgress.test.tsx` | 5 UI cases (spinner, empty, rows, single point, error and Retry) |

`apps/api` tests are outside the root `pnpm test`. Run them from `apps/api`.

### Logged-in Lighthouse and axe (RW-82, S15)

| Item | Detail |
| --- | --- |
| Workflow | `.github/workflows/lighthouse.yml` boots postgres and redis, seeds with `apps/web/e2e/seed-db.sh`, starts the API and the worker with `ENABLE_E2E_TEST_MINTER`, builds the web app, and runs the public `lhci:run` (advisory, `continue-on-error`). Then it serves a preview on 4173 (with `E2E_API_PROXY`) and runs `lhci:authed`. Reports upload always |
| Authed Lighthouse | `apps/web/e2e/lighthouse-authed.mjs`. It provisions an attempt with the factories, mints admin and candidate sessions, writes a temporary lhci config for each role with `settings.extraHeaders.Cookie`, and audits `/admin`, `/admin/assessments`, `/admin/attempts/:id`, `/candidate/results` and `/take/attempt/:id` |
| Threshold | `apps/web/lighthouserc.authed.json`: `minScore` 0.85 on performance, accessibility, best-practices and seo |
| Axe spec | `apps/web/e2e/a11y-authed.spec.ts` (project `chromium`). `AxeBuilder` tags `wcag2a`, `wcag2aa`, `best-practice`. Serious and critical findings fail the test. Moderate and minor findings are logged |
| Required or advisory | The axe spec is REQUIRED: it is in the e2e spec list of `ci.yml`. The authed Lighthouse step is ADVISORY (`continue-on-error`) |
| Flip date | 2026-10-31. The workflow header proposes it: after two weeks of green runs, drop `continue-on-error` and make the check required at 0.85 |

Local scores (desktop, production build) after the contrast fixes:

| Page | Performance | Accessibility | Best practices | SEO |
| --- | --- | --- | --- | --- |
| `/admin` | 0.89 | 1.00 | 0.99-1.00 | 0.91 |
| `/admin/assessments` | 0.84 | 1.00 | 1.00 | 0.91 |
| `/admin/attempts/:id` | 0.81-0.82 | 0.96 | 1.00 | 0.91 |
| `/candidate/results` | 0.97-0.98 | 1.00 | 1.00 | 0.91 |
| `/take/attempt/:id` | 0.96-0.97 | 1.00 | 1.00 | 0.91 |

**Why the gate stays advisory.** The admin pages miss 0.85 on performance because of the bundle size. Fix the bundle before the flip date.

**Not included.** Fixes for the moderate findings `region` (AdminShell) and `page-has-heading-one` (`/take/attempt/:id`). Visual-regression baselines (Linux or Docker only, none committed). Contrast token changes: [08-ui-system.md](08-ui-system.md) § "Contrast tokens darkened for WCAG AA (RW-82, S15)".

### Per-question statistics tests (RW-60, S15)

| Test file | Cases |
| --- | --- |
| `modules/15-analytics/src/__tests__/question-stats.test.ts` | 12 cases. Nine use the database and the route: exposure and attempts counts, newest grading wins, `point_biserial` NULL on zero variance, ordered gradient with no flag under 30 attempts, flag for a top-level item that 30+ candidates pass, roll-up over clones in all tenants, scope `tenant` without clones, `stats` null with no attempts, and the errors (404 `QUESTION_NOT_FOUND`, 400 bad id, 403 for a non super admin). Three pure cases test `computeMiscalibrated`: lowest-level item nobody passes, inverted gradient beyond the 0.15 margin only, never under 30 attempts |
| `modules/10-admin-dashboard/src/__tests__/question-stats-card.test.tsx` | 2 cases. No volume shows a note and no table. The "Noise" and "Miscalibrated" chips and the sample-size note |
| `tools/lint-mv-tenant-filter.ts` | Self-test covers both view names and the exact allow marker for super-admin roll-ups |

### Start a test test (RW-83, S15)

| Test file | Cases |
| --- | --- |
| `modules/10-admin-dashboard/src/__tests__/start-test.test.tsx` | 5 cases. Paste parsing (emails, names, invalid entries). Sets and candidates list, and the button waits for a set and a candidate. The create, publish, invite and import calls run in order with the right bodies. A failed publish shows the failed step and the assessment link. Invalid pasted entries are listed |

### Per-question feedback tests (RW-80, S15)

| Test file | Cases |
| --- | --- |
| `modules/02-tenancy/src/__tests__/result-feedback-level.test.ts` | 8 cases. Default `none` and the settings mapping. One update writes one audit row, and the same level is a no-op. Five invalid values are rejected without a write. The database CHECK rejects other values |
| `apps/api/src/__tests__/routes/admin-tenant-settings-feedback-level.test.ts` | 9 cases. Admin with fresh MFA sets the level. Stale TOTP gives 401. `reviewer` and `candidate` give 403. No session gives 401. Three invalid bodies give 400 `INVALID_RESULT_FEEDBACK_LEVEL`. Inactive tenant gives 409 |
| `modules/06-attempt-engine/src/__tests__/candidate-feedback.test.ts` | 8 cases. Presence and absence of each field at every level. Unreleased attempt gives not ready. Another user's attempt gives 404. Unit tests of `plainWords`. Secret fields never appear |
| `modules/11-candidate-ui/src/__tests__/AttemptFeedback.test.tsx` | 4 cases. Fetch on expand, error with Retry, empty state, and the explanation and expected-answer rows |
| `modules/06-attempt-engine/src/__tests__/candidate-result.test.ts` | Changed: the list result now expects `feedback_level: "none"` |

**Not included.** A browser test of the settings radio cards. A test with real AI-justification text from production gradings.

### Design-pass screenshot script (RW-81, S15)

**What.** `apps/web/e2e/design-pass-screenshots.mjs` is a Playwright script, not a test. Run it with `tsx` from `apps/web`: `tsx e2e/design-pass-screenshots.mjs seed`, then `shoot before` or `shoot after`, then `cleanup`.

| Mode | Action |
| --- | --- |
| `seed` | Creates real data with the e2e factories (`e2e/fixtures/factories.ts`): packs with long names, MCQ and written questions, assessments, attempts. Saves ids in `state.json` |
| `shoot before` / `shoot after` | Logs in as admin, super admin and candidate. Screenshots every routed page at 1440x900 and 390x844 and records horizontal overflow |
| `cleanup` | Removes the seeded data |

**Needs.** The local API on port 3000 with `ENABLE_E2E_TEST_MINTER`, and `vite preview --port 4175` (`E2E_API_PROXY=http://127.0.0.1:3000`) serving a production build.

**Outputs** (in `docs/testing/screenshots/S15/`): `before/` (102 PNGs), `after/` (103), `CRITIQUE.md` (numbered measurable gaps and a before/after list), `overflow.json`, `state.json`. The folder is local only because `docs/` is gitignored.

**Overflow check.** Before: one page overflowed, the take page header `.aiq-attempt-top` at 390 px (564 px wide). After: none.

**Gates run.** Typecheck clean (modules 10, 11, 17 and web). Lint 0 errors. `lint:ui-labels` 0 hits. Help-id guard 5/5. Vitest: 17 (70 tests), 10 (175), 11 (130), web (87). The `MyCertificates` snapshot changed (colour only).

**Why.** The page tests use small fixtures. Only real data at a phone width shows clipping and overflow.

**Considered and rejected.** Adding the screenshots to `visual.spec.ts` (baselines must be made in the Playwright image and the pages change often). A CI job (the stack needs a seeded database).

**NOT included.** Pixel comparison. Automatic failure on overflow (the script only reports it). The `visual.spec.ts` baseline regeneration (owner item 8 in [08-ui-system.md](08-ui-system.md) § "Design pass on live-data pages (RW-81, S15)").

**Impact.** The API can drop connections while it runs, so the script retries factory calls. Run it again after any layout change.
