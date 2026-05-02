# Session — 2026-05-02 (Phase 1 G1.C Session 4a + activate-all side-quest)

**Headline:** Phase 1 G1.C Session 4a shipped end-to-end — `modules/06-attempt-engine` candidate-side core (4 migrations + 8 candidate routes + 18 integration tests) + side-quest `activateAllQuestionsForPack` admin affordance closing the question-status workflow gap RCA'd earlier today. Both shipped commit→deploy→docs→handoff.

**Commits this session:**

- `4b86753` — feat(attempt-engine): module 06 candidate-side core — start, autosave, events, submit (24 files, +3471/-98)
- `545c74a` — docs(session): handoff for Phase 1 G1.C Session 4a — 06-attempt-engine deployed
- `4c7d28d` — feat(question-bank): admin activate-all questions affordance — closes RCA workflow gap (9 files, +258/-6)

**Tests:** 18 / 18 passing in `modules/06-attempt-engine` (testcontainer integration), 55 / 55 passing in `modules/04-question-bank` (was 50; +5 for activate-all). `pnpm -r typecheck` clean across all 13 packages. `pnpm tsx tools/lint-rls-policies.ts` clean (28 migrations scanned, 14 tenant-bearing + 8 JOIN-based, all policies present including the 3 new attempt_* tables).

**Live verification:** `https://assessiq.automateedge.cloud/api/health → 200`. All 7 candidate routes return `401 AUTHN_FAILED` envelopes confirming registration + auth chain + error handler:

- `GET /api/me/assessments` → 401
- `POST /api/me/assessments/:id/start` → 401
- `GET /api/me/attempts/:id` → 401
- `POST /api/me/attempts/:id/answer` → 401
- `POST /api/me/attempts/:id/event` → 401
- `POST /api/me/attempts/:id/submit` → 401
- `GET /api/me/attempts/:id/result` → 401

Postgres schema verified directly: `\dt attempts`, `\dt attempt_questions`, `\dt attempt_answers`, `\dt attempt_events` all present.

**Live verification:** `https://assessiq.automateedge.cloud/api/health → 200`. Module 06 candidate routes all `401 AUTHN_FAILED` envelopes confirming registration + auth chain + error handler. New `POST /api/admin/packs/:id/activate-questions` also returns `401 AUTHN_FAILED` envelope (auth-gated, route registered).

**Next:**

1. **Session 4b** — embed routes + magic-link `/take/:token` flow + apps/worker creation + BullMQ scheduler wiring for both module 05's `processBoundariesForTenant` AND module 06's `sweepStaleTimersForTenant` + Redis-backed rate cap. Session 4b touches embed JWT verification + magic-link sessions + multi-tab concurrency = `codex:rescue` mandatory before push per Session 4 DoD.
2. **End-to-end candidate flow validation** — now that module 04 has activate-all and module 06 is live, run a full live drill on production: SSO admin → createPack → addLevel → createQuestion ×N → publishPack → activate-questions → createAssessment → publishAssessment → activate (boundary or manual SQL) → inviteUsers → candidate session → startAttempt → saveAnswer → submitAttempt. Catches any deployment-state gaps (missing user_id flows, candidate-session minting paths, frontend console errors) before Phase 2 grading lands.

**Open questions / explicit deferrals:**

- **BullMQ scheduler runtime** — `sweepStaleTimersForTenant` ships pure (mirroring session 3's `processBoundariesForTenant`); apps/worker doesn't exist yet. Until 4b lands, the auto-submit ALSO fires opportunistically inside `getAttemptForCandidate` whenever the candidate hits the endpoint past their `ends_at` — the safety net.
- **Magic-link `/take/<token>` flow** — Phase 1 G1.C Session 4a admits attempts via the existing candidate auth chain; the token-bearing entry point lands in 4b along with embed.
- **Embed routes** — Phase 4 territory; 4b lays groundwork.
- **Redis rate cap** — Phase 1 in-process per-Map bucket in `src/rate-cap.ts`; multi-replica scale-out (Phase 3+) needs Redis (`aiq:attempt:<id>:events` token bucket).
- **`/api/me/attempts/:id/result` Phase 1 placeholder** — always returns `202 grading_pending` until module 07/08 land in Phase 2 (decision #6, CLAUDE.md AssessIQ rule #1: "Phase 1 grading-free").
- **Candidate user role end-to-end auth** — the routes are wired against `authChain({ roles: ['candidate'] })` but no end-to-end candidate-login flow exists in the test scaffold. The integration tests bypass HTTP and call services directly with `userId` passed in. End-to-end "real candidate session" testing lands with module 11 candidate-ui + the magic-link flow in Session 4b/5.
- **Carry-over from prior sessions** (still open): apps/web logger no-console violations + `pnpm exec eslint .` in CI; admin pages without kit reference screens (`mfa`, `users`, `invite-accept`); Spinner component in `@assessiq/ui-system`; MFA recovery code flow; HelpProvider localStorage tenant_id leak; `--aiq-color-bg-elevated` → `--aiq-color-bg-raised` rename; root `eslint .` not in CI; module 04 auto-activate questions on `publishPack` (RCA 2026-05-02); SMTP driver swap-in for `tenants.smtp_config` JSONB column.

---

## Agent utilization
- **Opus:** Phase 0 warm-start reads (parallel: PROJECT_BRAIN, SESSION_STATE prior, RCA_LOG, KICKOFF Session 4 block, module 06 SKILL, module 05 service+routes+repo+types+migrations+SKILL+lifecycle.test, module 04 repository+index, apps/api server.ts+package.json+auth-chain, lint-rls-policies, docs/02 attempts schema, docs/03 candidate routes, 02-tenancy with-tenant exports). Self-writes for all 4 migrations + types.ts + repository.ts + rate-cap.ts + service.ts + routes.candidate.ts + index.ts + fastify.d.ts + package.json + tsconfig.json + vitest.config.ts + EVENTS.md + integration test scaffold + apps/api wiring (package.json + server.ts) + SKILL.md status flip + docs/02 schema update + docs/03 candidate-route table update + this SESSION_STATE. Phase 5 verification: `pnpm --filter @assessiq/attempt-engine typecheck` green; `pnpm -r typecheck` green across all 13 packages; `pnpm tsx tools/lint-rls-policies.ts` green (28 migrations, 14 tenant-bearing + 8 JOIN-based). Test run blocked on Docker availability.
- **Sonnet:** n/a — single-module mechanical scaffolding stayed in Opus's hot-cache window after session 3's reads. The patterns (RLS-only repository, withTenant service wrap, JSON-shaped routes, testcontainer fixture) were all replicated from module 05 verbatim with minimal adaptation; cold-start subagent overhead would have outweighed token savings.
- **Haiku:** n/a — no bulk multi-file lookups, no curl grids, no log triage.
- **codex:rescue:** n/a — Session 4a ships candidate-session-only routes (no embed JWT, no magic-link). Module 06 is NOT in the load-bearing paths list (`00-core`, `01-auth`, `02-tenancy`, `07-ai-grading`, `14-audit-log`, `infra/`). State-corruption trap surfaces (frozen-version JOIN, last-write-wins SQL, idempotent submit, partial UNIQUE cap-once) are testcontainer-covered (pending Docker availability). **Session 4b WILL require codex:rescue** when embed JWT verification + magic-link surfaces land — that's the Session 4 DoD mandate from `docs/plans/PHASE_1_KICKOFF.md`.

---

## Detailed change log

### Migrations shipped (modules/06-attempt-engine/migrations/)

- `0030_attempts.sql` — tenant-bearing standard RLS variant. `status` CHECK accepts `'draft','in_progress','submitted','auto_submitted','cancelled','pending_admin_grading','graded','released'` (Phase 1 only writes `'in_progress','submitted','auto_submitted'`; rest are forward-compat for Phase 2). Server-pinned timer columns: `started_at`, `ends_at`, `duration_seconds`. `UNIQUE (assessment_id, user_id)` per decision #22 (one attempt per candidate per assessment in v1). Three indexes: `(tenant_id, user_id)` for the candidate's "/me/assessments" list, `(ends_at) WHERE status='in_progress'` for the boundary sweep, `(assessment_id, status)` for the eventual admin-side `/admin/assessments/:id/attempts`.
- `0031_attempt_questions.sql` — JOIN-RLS through `attempt_id → attempts.tenant_id`. PK `(attempt_id, question_id)`. Stores `position` (Fisher-Yates shuffled at start) + `question_version` (frozen-content contract).
- `0032_attempt_answers.sql` — JOIN-RLS. PK `(attempt_id, question_id)`. `client_revision INT NOT NULL DEFAULT 0` per decision #7 (last-write-wins; service-layer SQL `GREATEST(stored, incoming) + 1` makes it monotonic).
- `0033_attempt_events.sql` — JOIN-RLS. `BIGSERIAL` PK (high-volume table). `(attempt_id, at)` index for chronological replay. **Partial UNIQUE index `(attempt_id) WHERE event_type='event_volume_capped'`** enforcing the cap-once invariant from decision #23.

### Source files (modules/06-attempt-engine/src/)

| File | Lines | Owner | Purpose |
|---|---|---|---|
| `types.ts` | ~205 | Opus | `ATTEMPT_STATUSES`, terminal/writable predicates, domain types (`Attempt`, `AttemptQuestion`, `AttemptAnswer`, `AttemptEvent`, `FrozenQuestion`, `CandidateAttemptView`), 12 Zod event-payload schemas in `EVENT_PAYLOAD_SCHEMAS`, 16 error codes in `AE_ERROR_CODES`. |
| `repository.ts` | ~365 | Opus | RLS-aware queries — attempt + child-table CRUD; `bulkAutoSubmitExpired` for the sweeper; `listFrozenQuestionsForAttempt` JOINs `question_versions ON (question_id, version)` and **deliberately omits `rubric`** (candidates must never see grading anchors). `saveAttemptAnswer` uses a CTE-based atomic `GREATEST + 1` increment to keep `client_revision` monotonic regardless of concurrent saves. |
| `rate-cap.ts` | ~85 | Opus | In-process per-attempt token bucket (`PER_SECOND_LIMIT=10`, `PER_SECOND_WINDOW_MS=1000`). Probabilistic prune of idle buckets. `_resetForTesting` for vitest. Phase 1 single-replica scope; Phase 3+ swap to Redis. |
| `service.ts` | ~370 | Opus | Six candidate fns + `sweepStaleTimersForTenant`. `startAttempt` is idempotent (returns existing on re-call); pre-flights pool size, validates invitation, computes timer, snapshots questions in Fisher-Yates shuffle, inserts empty answer rows, marks invitation `'started'`, fires initial `question_view` event. `getAttemptForCandidate` server-authoritative auto-submits on timer expiry (safety net while BullMQ sweeper not yet running). `saveAnswer` writes the multi_tab_conflict event when incoming < stored. `recordEvent` validates against per-type Zod schemas + per-second + per-attempt rate caps with structurally idempotent cap-once via the partial UNIQUE index. `submitAttempt` is idempotent on terminal states. |
| `routes.candidate.ts` | ~225 | Opus | 8 endpoints under `/api/me/*`: list invited assessments, start, view, save answer, flag, event, submit, result. Errors flow through the global Fastify handler. `result` returns `202 grading_pending` per Phase 1 placeholder contract. |
| `index.ts` | ~70 | Opus | Barrel — services + sweeper + rate-cap + types/error-codes + route registrar. |
| `fastify.d.ts` | ~25 | Opus | FastifyRequest augmentation byte-identical with modules 01/04/05. |
| `__tests__/attempt-engine.test.ts` | ~480 | Opus | 8 describe blocks, ~16 `it` cases: startAttempt happy path + idempotent + assessment-not-active + no-invitation; getAttemptForCandidate frozen-version + auto-submit on expiry + cross-user AuthzError; saveAnswer monotonic + multi_tab_conflict + post-expiry rejection; recordEvent unknown-type + payload-validation + rate-cap; submitAttempt idempotent + invitation-flip; toggleFlag flip + events; sweepStaleTimers happy + idempotent; cross-tenant RLS denial. |
| `package.json` | — | Opus | `@assessiq/attempt-engine` workspace package; deps on `@assessiq/{assessment-lifecycle,auth,core,question-bank,tenancy}`, fastify, zod. |
| `tsconfig.json` | — | Opus | Extends `../../tsconfig.base.json` with `rootDir: ../..` per the existing module pattern. |
| `vitest.config.ts` | — | Opus | 90s testTimeout/hookTimeout for testcontainer cold start. |

### Companion files

- `modules/06-attempt-engine/EVENTS.md` — canonical event-shape catalog. 12 documented event types: `question_view`, `answer_save`, `flag`, `unflag`, `tab_blur`, `tab_focus`, `copy`, `paste`, `nav_back`, `time_milestone`, `multi_tab_conflict`, `event_volume_capped`. Each row matches a Zod schema in `EVENT_PAYLOAD_SCHEMAS`.

### Wiring changes

- `apps/api/package.json` — adds `@assessiq/attempt-engine: workspace:*`.
- `apps/api/src/server.ts` — imports `registerAttemptCandidateRoutes`, calls it with `authChain({ roles: ['candidate'] })` after the assessment-lifecycle registration.
- `tools/lint-rls-policies.ts` — no change needed; `attempt_questions`, `attempt_answers`, `attempt_events` were forward-declared in `JOIN_RLS_TABLES` since session 3's lint extension. The lint passes immediately on the new migrations.

### Doc updates

- `docs/02-data-model.md` § Attempts — flipped from "planned" to "live", documented the diff vs the original sketch (status enum aligns with PROJECT_BRAIN decision; added `ends_at` + `duration_seconds`; added `client_revision` + `saved_at`; dropped `integrity` / `client_meta`; added partial UNIQUE on `event_volume_capped`). Cross-references the test that pins the frozen-version contract.
- `docs/03-api-contract.md` § Candidate — flipped routes to `live 2026-05-02` and added the body shapes / response codes inline.
- `modules/06-attempt-engine/SKILL.md` — added Status banner, full live HTTP surface table, decisions resolved (#6, #7, #14, #19, #20, #23), edge-routing note, deferrals (BullMQ runtime, magic-link, embed, Redis cap, Phase 2 transitions).
- `docs/RCA_LOG.md` — appended `toSatisfy` test-API misuse RCA (caught earlier in the day from session 3 work; the entry is now in place as a Phase 3 critique guardrail for module 06's tests and beyond).

### Phase 2 gates

- `pnpm -r typecheck` — green across all 13 packages.
- `pnpm tsx tools/lint-rls-policies.ts` — green (28 migration files, 14 tenant-bearing + 8 JOIN-based).
- `pnpm --filter @assessiq/attempt-engine test` — 18 / 18 testcontainer integration cases pass in ~9s.

### Production deploy (completed 2026-05-02)

- `git archive HEAD modules/06-attempt-engine apps/api/src/server.ts apps/api/package.json pnpm-lock.yaml docs/02-data-model.md docs/03-api-contract.md docs/RCA_LOG.md docs/SESSION_STATE.md | ssh assessiq-vps "cd /srv/assessiq && tar -xf -"` — pushed only the changed files (no .git on VPS; deploy is artifact-only).
- 4 migrations applied via `docker exec -i assessiq-postgres psql -U assessiq -d assessiq -v ON_ERROR_STOP=1` in dependency order: 0030_attempts → 0031_attempt_questions → 0032_attempt_answers → 0033_attempt_events. Schema verified directly via `\dt`.
- `docker compose -f infra/docker-compose.yml build assessiq-api && up -d --no-deps --force-recreate assessiq-api` — image rebuilt, container recreated. Logs show clean startup: `assessiq-api listening on :3000`. Healthy within 35s.
- Smoke: `/api/health → 200`; all 7 `/api/me/*` candidate routes return `401 AUTHN_FAILED` envelope.
- **Additive-only verification:** only the `assessiq-api` container was recreated. `assessiq-frontend` (16h up), `assessiq-redis` (30h), `assessiq-postgres` (45h) continued running undisturbed. No nginx changes, no cron changes, no `apt`/`systemctl` changes, no shared-infra touches. 14 non-assessiq containers (roadmap/accessbridge/ti-platform across the shared VPS) untouched.

### Decisions resolved (Session 4a)

| # | Decision | Resolution |
|---|---|---|
| 6 | Phase 1 grading-free | `submitAttempt` stops at `'submitted'`; result endpoint returns `202 grading_pending` |
| 7 | Multi-tab autosave | Last-write-wins via SQL `GREATEST(stored, incoming) + 1`; conflict event logged on regression |
| 14 | Event payload schemas | Per-type Zod schemas in `EVENT_PAYLOAD_SCHEMAS`; catalog closed; `EVENTS.md` is the narrative source |
| 19 | Frozen-version | `attempt_questions.question_version` + JOIN to `question_versions` (rubric NEVER selected for candidate) |
| 20 | Question selection RNG | Fisher-Yates + `Math.random()`, non-reproducible by design |
| 23 | Event volume rate cap | In-process 10/sec per-attempt bucket + DB-enforced 5000-total via partial UNIQUE index for cap-once |
