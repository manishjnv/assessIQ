# 12 — Test Coverage Map

> **Audit date:** 2026-05-15. File-shape-based — no `vitest --coverage` run.
> Re-run this audit whenever a module's test:source ratio changes materially.

## Summary

19 modules audited / well-covered: 5 / partial: 13 / thin: 1 / none: 0 / n/a: 0.
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
| vitest | all 19 modules + `apps/api` | per-module `vitest.config.ts`; root workspace `vitest.config.ts` |
| playwright (e2e) | `apps/web` | scaffolded at commit `10f1540`; 5 unauthenticated routes; **no baselines yet** — not contributing live coverage |

No jest configs anywhere in the repo.

---

## Notes for Future Test-Investment Sessions

1. **G3.D `audit-writes.test.ts` pattern** — each module that went through the G3.D auditInTx sweep (02-tenancy, 03-users, 04-question-bank, 05-lifecycle, 09-scoring, 13-notifications, 16-help-system, 07-ai-grading) has an `audit-writes.test.ts` that validates auditInTx call paths. This is real coverage but only of the audit integration, not the broader module surface.

2. **Playwright e2e** — once baselines are captured (Phase 15 next step), modules 10, 11, and 17 gain meaningful e2e coverage for their golden-path flows. This does not replace missing unit/integration tests for state machines and service logic.

3. **Prioritized investment order** (highest risk first): 01-auth magic-link + rate-limit → 02-tenancy middleware transaction flow → 14-audit-log archive/fanout/routes → 03-users service gaps → 06-attempt-engine routes → 08-rubric-engine edge cases → 10-admin-dashboard critical admin flows.
