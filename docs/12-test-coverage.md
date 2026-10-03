# 12 — Test Coverage Map

> **Audit date:** 2026-05-15. File-shape-based — no `vitest --coverage` run.
> Re-run this audit whenever a module's test:source ratio changes materially.

## Summary

19 modules audited / well-covered: 5 / partial: 13 / thin: 1 / none: 0 / n/a: 0.

> **Note (2026-10-02):** the repo now has 21 modules. Modules `19-billing` and `20-data-rights` are not covered by this audit.
**High-risk gaps: 3** (2 high on load-bearing modules, 1 medium on load-bearing module).

---

## Per-Module Coverage Table

| module | source files | test files | test:source | test runner(s) | critical-path coverage |
|---|---|---|---|---|---|
| 00-core | 8 | 6 | 0.75 | vitest | **well-covered** — config, errors, ids, logger, time, request-context all tested; every public export has a dedicated test |
| 01-auth | 18 | 7 | 0.39 | vitest | **partial** — google-sso, sessions, totp, embed-jwt, middleware, api-keys, candidate-login covered; `magic-link.ts` and `crypto-util.ts` have no dedicated tests; rate-limit and session-loader are indirectly exercised at best |
| 02-tenancy | 7 | 2 | 0.29 | vitest | **partial** — `tenancy.test.ts` covers CRUD service; `audit-writes.test.ts` covers audit integration; `tenantContextMiddleware` (BEGIN/SET LOCAL/COMMIT/ROLLBACK lifecycle) and `withTenant` transaction wrapper have **no dedicated tests** — these are the runtime isolation primitives every request passes through |
| 03-users | 10 | 2 | 0.20 | vitest | **partial** — `users.test.ts` + `audit-writes.test.ts`; invitations, normalize, redis-sweep, import, invariants, audit-redact all untested |
| 04-question-bank | 6 | 6 | 1.00 | vitest | **well-covered** — generate-body-validation, generation-attempts-route, audit-writes, question-bank CRUD, score-attempt-route, bulk-status-route — all major surface areas mapped to tests |
| 05-assessment-lifecycle | 9 | 3 | 0.33 | vitest | **partial** — lifecycle (state machine + core service), invite-email, audit-writes covered; `boundaries.ts`, `tokens.ts`, `repository.ts` have no dedicated tests |
| 06-attempt-engine | 7 | 2 | 0.29 | vitest | **partial** — `attempt-state-machine.test.ts` covers the critical state-machine invariants; `attempt-engine.test.ts` covers core service; `routes.candidate.ts`, `routes.take.ts`, `rate-cap.ts` untested |
| 07-ai-grading | 22 | 21 | 0.95 | vitest (unit) + vitest (eval harness) | **well-covered** — 13 unit tests (single-flight, skill-sha, VPS runtime, auto-weight, concurrency, eval-runner, stream-json-parser, generate-rubric, citation, stderr, tenant-mode, handlers, audit-writes) + 8 eval harness tests (CLI, score-goldens, inspect-render, cleanup-stale, cleanup-orphaned, score-candidate-runtime, stage3-watch, extract-fixtures); lint sentinel CI guard also present |
| 08-rubric-engine | 4 | 1 | 0.25 | vitest | **well-covered** — despite single test file, `rubric-engine.test.ts` exercises all 4 public exports (`validateRubric`, `sumAnchorScore`, `computeReasoningScore`, `finalScore`) against the worked example from `docs/05-ai-pipeline.md`; module is intentionally small and focused |
| 09-scoring | 6 | 2 | 0.33 | vitest | **partial** — `scoring.test.ts` + `audit-writes.test.ts`; `archetype.ts` (archetype classification) and `routes.ts` have no direct tests |
| 10-admin-dashboard | 33 | 3 | 0.09 | vitest + playwright (e2e, no baselines yet) | **thin** — 3 tsx test files for 33 source files (0.09 ratio, lowest in codebase); only `admin-dashboard` render smoke, `attempt-detail-error` edge case, and `generation-attempts-score` UI tested; 16 page components and all supporting components untested; note: no backend service layer in this module |
| 11-candidate-ui | 19 | 5 | 0.26 | vitest + playwright (e2e, no baselines yet) | **partial** — CandidateShell, CandidateSessionBanner, CompletionModal, MyCertificates, components smoke tested; `AttemptTimer`, `QuestionNavigator`, `AutosaveIndicator`, `IntegrityBanner`, `CandidateHelp` untested |
| 12-embed-sdk | 7 | 4 | 0.57 | vitest | **partial** — origin-csp, embed-jwt-db, embed-verify, session-mint cover all 4 security-critical paths; remaining files are likely index/type re-exports; critical security path is covered |
| 13-notifications | 17 | 4 | 0.24 | vitest | **partial** — email-send-flow, notifications (core), audit-writes, candidate-login-link covered; webhook delivery, in-app short-poll, i18n formatting, and SES retry paths untested |
| 14-audit-log | 8 | 1 | 0.13 | vitest | **partial** — `audit.test.ts` is a testcontainer integration test covering 9 cases including **append-only enforcement** (UPDATE + DELETE both blocked at DB level), tenant isolation, redaction, RequestContext capture, and list pagination; `archive-job.ts` (S3 export), `webhook-fanout.ts` (event delivery), and `routes.ts` (admin audit API) are completely untested |
| 15-analytics | 16 | 4 | 0.25 | vitest | **partial** — service, analytics (report queries), activity, activity-candidate covered; reporting export paths, MV refresh, and CSV/PDF generation not directly tested |
| 16-help-system | 8 | 3 | 0.38 | vitest | **partial** — help-system (core lookup + content serving) and audit-writes tested; tooltip and drawer assembly paths partially covered via help-system test |
| 17-ui-system | 26 | 7 | 0.27 | vitest + playwright (e2e, no baselines yet) | **partial** — Spinner, Placeholder, ProgressBar, LeaderboardList, StackedBarChart, ActivityHeatmap, reduced-motion tested (36/36 pass at Phase 14 close); Button, Card, Chip, Field, Icon, Num, Modal, Drawer, Table, Sidebar, StatCard, ScoreRing, Sparkline, ThemeProvider, Tooltip all untested |
| 18-certification | 11 | 13 | 1.18 | vitest | **well-covered** — types, credential-id, crypto (HMAC), repository, service, pdf, admin-reissue, list-mine, share-linkedin, public-repository + 3 more; 79/79 passing at Phase 5 close |

---

## High-Risk Gap Table

| module | gap | risk severity |
|---|---|---|
| 01-auth | `magic-link.ts` (candidate token generation/expiry/reuse guard) and `crypto-util.ts` (HMAC primitives shared with session signing) have no dedicated tests; `rate-limit.ts` middleware untested; magic-link is the sole candidate auth path when Google SSO is not used | **HIGH** |
| 02-tenancy | `tenantContextMiddleware` BEGIN/SET LOCAL/COMMIT/ROLLBACK lifecycle and `withTenant` transaction wrapper have no dedicated tests — these are the runtime isolation primitives every request passes through; silent misconfiguration would break multi-tenant isolation at the DB layer | **HIGH** |
| 14-audit-log | `archive-job.ts` (S3 export path), `webhook-fanout.ts` (event delivery), and `routes.ts` (admin audit API) untested; append-only core IS covered by the testcontainer integration test; load-bearing append-only module | **MEDIUM** |
| 10-admin-dashboard | 33 source files, 3 test files (0.09 ratio); all admin page components untested; blast radius is contained to UI regressions (no backend service layer) | **LOW** |
| 08-rubric-engine | All 4 public exports tested against the spec-worked example; edge-case inputs (zero-weight anchors, missing synonym fields, malformed rubric JSON) coverage is **unclear** — single test file, used in production grading path | **MEDIUM** (flag for next rubric-engine investment session) |

---

## Test Runner Summary

| runner | participates | notes |
|---|---|---|
| vitest | all 19 modules + `apps/api` | per-module `vitest.config.ts`; root workspace `vitest.config.ts`. **Versions (N19, 2026-10-03): vitest 4.1.11, `@vitest/coverage-v8` 4.1.11, testcontainers 11.14.0.** |
| playwright (e2e) | `apps/web` | **Real-backend suite since 2026-10-03 (RS11).** See "E2E suite" at the end of this page. The older note "5 unauthenticated routes, no baselines" is history. |

No jest configs anywhere in the repo.

---

## Notes for Future Test-Investment Sessions

1. **G3.D `audit-writes.test.ts` pattern** — each module that went through the G3.D auditInTx sweep (02-tenancy, 03-users, 04-question-bank, 05-lifecycle, 09-scoring, 13-notifications, 16-help-system, 07-ai-grading) has an `audit-writes.test.ts` that validates auditInTx call paths. This is real coverage but only of the audit integration, not the broader module surface.

2. **Playwright e2e** — once baselines are captured (Phase 15 next step), modules 10, 11, and 17 gain meaningful e2e coverage for their golden-path flows. This does not replace missing unit/integration tests for state machines and service logic.

3. **Prioritized investment order** (highest risk first): 01-auth magic-link + rate-limit → 02-tenancy middleware transaction flow → 14-audit-log archive/fanout/routes → 03-users service gaps → 06-attempt-engine routes → 08-rubric-engine edge cases → 10-admin-dashboard critical admin flows.


---

## Batch 5 update (2026-10-02)

- **`apps/api` is now in CI.** The root `vitest.config.ts` includes only `modules/**` and `packages/**`, so `apps/api` tests were never run by CI and six drifted. `28992d1` fixed them; `e2d4c49` added a "Test (apps/api)" step (`pnpm --filter @assessiq/api test`). Some tests start Postgres or Redis testcontainers. The Test Runner Summary above says apps/api participates in vitest, but until this batch only a local run covered it.
- **`20-data-rights` now has tests.** `e5090b1` adds 11 DB integration tests: erasure, export, retention, erased list. This was a 0-test compliance module (item E7). The "20-data-rights" row in the table above is out of date.
- **Dependency audit gate (D6).** CI runs `pnpm audit --prod --audit-level=critical` (blocking) and `--audit-level=high || true` (informational). Dependabot (`.github/dependabot.yml`): npm weekly with minor and patch grouped, github-actions monthly. First run: 0 critical, 17 high (nodemailer <10.0.6, fastify <5.12.2, fast-uri <3.1.7, find-my-way <9.7.0). Not fixed yet (N4).
- **New tests in this batch.** `sections-locked.test.ts` (05), `sections-summary.test.ts` (06), `section-scores.test.ts` (09), `eval-gate.test.ts` and `grading-quality.test.ts` (07), `generation-batches-route.test.ts` (04), high-stakes cases in `integrity-route.test.ts` (05), `claude-code-vps.runtime.test.ts` and `least-ai.test.ts` (07), `evaluations-queue.test.tsx` (10).
- **Still open.** The admin dashboard (10) is still thin. The eval harness never runs in CI (D5). e2e in CI is E13, last.

## Tool versions (N19, 2026-10-03)

- **What.** vitest 2.1 to 4.1.11 in every workspace; `@vitest/coverage-v8` 4.1.11; testcontainers 10 to 11.14.0. Lockfile-only bumps for browserslist, brace-expansion, js-yaml, ip-address, grpc-js, protobufjs, tmp, form-data and ws. Commits `0efd0f9` to `ad4a835`, `a951e5a`.
- **Harness fixes.** Module 13 `vi.mock` factories use `function` (vitest 4 cannot `new` an arrow mock). Module 17 sets `testTimeout` to 30 s (the axe test).
- **Why.** `pnpm audit --audit-level high` without `--prod` showed 42 high and 2 critical findings, all in dev tools. Now 6 high and 0 critical. The 6 left are the pinned lighthouse chain of `@lhci/cli` (extract-zip, basic-ftp, tmp 0.1) and the vite 5 of Storybook 8.6. Storybook waits for FR18. `--prod` is unchanged: 0 high, 0 critical, 5 moderate.
- **Not bumped.** jsdom, eslint, typescript-eslint, Node, pnpm, TypeScript, Storybook.
- **Known timing-sensitive tests.** Module 06 rate-cap and module 01 totp constant-time. They can fail under load. They behave the same at baseline.

## E2E suite (RS11, 2026-10-03)

- **Stack.** `apps/web/e2e/local-stack.sh` (with `seed-db.sh`) starts throwaway Postgres and Redis containers named `assessiq-e2e-*`. It applies migrations in the order of `tools/test-support/apply-all-migrations.ts`, starts the API and the worker with `ENABLE_E2E_TEST_MINTER=true` (local only) and the web dev server. `--down` removes exactly its own containers. Run guide: `apps/web/e2e/README.md`.
- **Roles in the factories.** The platform-only content model needs a `super_admin` to create packs, levels and questions, and a tenant admin to create assessments, invitations and to publish.

| Spec | Status | Note |
|---|---|---|
| `admin-workflow.spec.ts` | 19 pass, 1 skip | Step 12a is skipped: it needs the VPS Claude runtime |
| `take-happy-path.spec.ts` | pass | Un-skipped; runs on the real backend |
| `take-timer-expiry.spec.ts` | pass | Un-skipped; runs on the real backend |
| `ordering-admin.spec.ts` (new) | pass | Author, publish, take, deterministic score, admin view, for `ordering` and `structured_case` |
| `take-runner-mocked.spec.ts` | pass | Mocked API (N12 candidate part) |
| `a11y.spec.ts` | 404-page test fails | axe `landmark-one-main` and `region`; a gap that existed before; roadmap N25 |

- **N12.** `ordering-admin.spec.ts` closes the admin-side check of N12 in a local real-backend browser run. The click on the live site is still the owner's.
- **CI.** The `e2e` job is rewritten (commit `09595fa`): it starts its own `postgres` and `redis` services and needs no repo variables. It is advisory (`continue-on-error`). Promote it to required after it is green on GitHub (E13).
- **Not included.** Visual baselines, leaderboard and email-log steps (FU-D23).

## CI guards and new tests (RS10 and session q, 2026-10-03)

**CI steps added (`e645d81`).**
- `react-hooks/rules-of-hooks` at error level in ESLint (RV69). Only that rule. The React Compiler rules are not adopted.
- The `apps/web` unit tests run in CI (RV70). Before, 11 files ran nowhere.
- `pnpm lint:mv-tenant-filter` and `pnpm lint:mv-tenant-filter:self-test` (RV72).
- CHECK C of `tools/lint-deploy-procedure.ts` compares `ConfigSchema` keys with `.env.example` (RV75). Self-test C-5.

**New tests.**
- `modules/02-tenancy/src/__tests__/with-tenant-on-commit.test.ts`: hooks run after COMMIT and release; never on rollback; `onCommit` returns false outside `withTenant`.
- `modules/12-embed-sdk/src/__tests__/jit-user.test.ts`: database tests for the JIT user rules (create, repeat, concurrent double call, erased, soft-deleted or disabled, admin, mixed-case admin, other tenant).
- `apps/api/src/__tests__/routes/reviewer-role-removed.test.ts`: 400 on invite, user create and PATCH with `reviewer`; 403 for a reviewer session on notifications, webhooks and TOTP enrol.
- `modules/00-core/src/__tests__/aes-gcm.test.ts`: legacy-layout vectors for both layouts, base64 embed output, previous-key fallback, tamper and short-input rejection.
- `modules/01-auth/src/__tests__/rate-limit-tiered.test.ts`: six call-shape tests rewritten as behaviour tests.
- `modules/11-candidate-ui` `CompletionModal` and `MyCertificates` tests updated.

**Totals (2026-10-03).** Modules 2556 of 2557 pass. The one failure is the `totp.test.ts` constant-time timing flake (pre-existing). apps/api 138 pass. apps/web 73 pass. The `candidate-login` floor test flaked once under Docker load: a Redis error makes the rate check fail closed and return before the 200 ms floor. It passes alone, 23 of 23.

## Lints and self-tests added in session r (2026-10-03)

**CI steps (commit `ea906d4`, RV71 and RV74).** Each tool has a `:self-test` run.
- `pnpm lint:doc-anchors` and `lint:doc-anchors:self-test`: every `NN-name.md#anchor` in docs, code and skills must match a real heading. The `KNOWN_STALE` list is empty.
- `vitest-coverage` lint: each module `vitest.config` follows the coverage rules.
- `skill-mount` lint: the skill directories match the compose mount.
- `public-collisions` lint: names in `public/` do not collide with SPA routes.
- `ui-api-contract` (RV74): 167 UI calls are checked against 225 server routes. The allowlist `tools/ui-api-contract.allowlist.txt` has 4 entries, all for `help-content.tsx` (FR14/FU-D1).

**Other self-tests.**
- `.claude/hooks/push-adversarial-gate.test.sh` (5 cases, including a chained push and a missing `jq`; N3, `60477e0`). Run it by hand; it is not in CI.
- `tools/ops/assessiq-backup-check.sh` self-test (11 cases; RV73). Run it by hand.

**New unit tests.** FU-C17 strict rubric rules in 08 (`strictRubricIssues`), FU-B6 business events in 13, N21 type reads in 06/07/09, the `release.ts` structure test (`74f1f46`).

**Totals (2026-10-03, session r).** Typecheck 0 errors. Lint 0 errors (20 old warnings). Modules 04, 06, 08, 09, 13: 963 pass. Module 07: 404 pass. apps/api: 138 pass, 7 todo.

**Flaky under Docker load.** `totp.test.ts` and the candidate-login timing floor test.
