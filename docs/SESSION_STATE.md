# Session — 2026-05-02 (Phase 1 G1.C Session 4a + activate-all + Session 4b.1 worker)

**Headline:** Phase 1 G1.C Session 4a shipped end-to-end — `modules/06-attempt-engine` candidate-side core (4 migrations + 8 candidate routes + 18 integration tests) + side-quest `activateAllQuestionsForPack` admin affordance closing the question-status workflow gap + Session 4b.1 `apps/worker` BullMQ scheduler runtime making boundary cron + timer sweep autonomous. All four sub-sessions shipped commit→deploy→docs→handoff. assessiq-worker live in production, ticking every 30s/60s.

**Commits this session:**

- `4b86753` — feat(attempt-engine): module 06 candidate-side core — start, autosave, events, submit (24 files, +3471/-98)
- `545c74a` — docs(session): handoff for Phase 1 G1.C Session 4a — 06-attempt-engine deployed
- `4c7d28d` — feat(question-bank): admin activate-all questions affordance — closes RCA workflow gap (9 files, +258/-6)
- `05e5505` — docs(session): handoff update — activate-all affordance shipped
- `2675e2f` — feat(worker): apps/worker BullMQ scheduler — boundary cron + timer sweep autonomy (8 files, +611/-8)

**Tests:** 18 / 18 passing in `modules/06-attempt-engine` (testcontainer integration), 55 / 55 passing in `modules/04-question-bank` (was 50; +5 for activate-all), 28 / 28 passing in `apps/api` (was 26; +2 for the worker integration smoke — pg + redis testcontainer pair). `pnpm -r typecheck` clean across all 13 packages. `pnpm tsx tools/lint-rls-policies.ts` clean (28 migrations scanned, 14 tenant-bearing + 8 JOIN-based, all policies present including the 3 new attempt_* tables).

**Live verification:** `https://assessiq.automateedge.cloud/api/health → 200`. All 7 candidate routes return `401 AUTHN_FAILED` envelopes confirming registration + auth chain + error handler:

- `GET /api/me/assessments` → 401
- `POST /api/me/assessments/:id/start` → 401
- `GET /api/me/attempts/:id` → 401
- `POST /api/me/attempts/:id/answer` → 401
- `POST /api/me/attempts/:id/event` → 401
- `POST /api/me/attempts/:id/submit` → 401
- `GET /api/me/attempts/:id/result` → 401

Postgres schema verified directly: `\dt attempts`, `\dt attempt_questions`, `\dt attempt_answers`, `\dt attempt_events` all present.

**Live verification:** `https://assessiq.automateedge.cloud/api/health → 200`. Module 06 candidate routes all `401 AUTHN_FAILED` envelopes. `POST /api/admin/packs/:id/activate-questions` → `401 AUTHN_FAILED`. `assessiq-worker` container `Up 26 minutes`, `bull:assessiq-cron:completed` ZSET capped at 50 entries (the `removeOnComplete: 50` ceiling — confirms ≥50 ticks have completed cleanly), 2 repeatables registered (`assessment-boundary-cron` 60s, `attempt-timer-sweep` 30s). No error log lines in the worker.

**Next:**

1. **Session 4b.2** — magic-link `/take/<token>` flow. Needs: (a) `01-auth` extension to mint a candidate session from an invitation token (or a token-scoped `req.candidate` shape), (b) `06-attempt-engine` route for `GET /take/:token` + `POST /take/:token/start`, (c) candidate-session minting that's bounded to the assessment in question. **codex:rescue mandatory before push** — magic-link tokens are pre-auth credentials and the verify path is security-adjacent.
2. **Session 4b.3** — embed routes (`/embed?token=<JWT>`). Phase 4 territory but the JWT verify path is touched in Session 4b. Likely lands together with 4b.2.
3. **End-to-end candidate flow validation on production** — now that activate-all + worker are live, run a full live drill: SSO admin → createPack → addLevel → createQuestion ×N → publishPack → activate-questions → createAssessment → publishAssessment → wait ~60s for boundary cron to flip published→active (or trigger manually) → inviteUsers → candidate session → startAttempt → saveAnswer → submitAttempt. Catches deployment-state gaps before Phase 2 grading lands.
4. **Phase 1.5 carry-overs** (still open): Redis-backed rate cap (in-process bucket today); apps/web logger no-console; admin pages without kit reference screens; Spinner component in `@assessiq/ui-system`; MFA recovery code flow; SMTP driver for `tenants.smtp_config`; HelpProvider localStorage tenant_id leak; `--aiq-color-bg-elevated` → `--aiq-color-bg-raised` rename; root `eslint .` not in CI.

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
- **Opus:** Phase 0 warm-start reads + self-writes for all four sub-sessions (Session 4a module 06; activate-all side-quest in module 04; Session 4b.1 apps/worker BullMQ scheduler). All patterns inherited from sessions 3/4a hot-cache (RLS-only repository, withTenant service wrap, testcontainer fixture, system-role bypass for cross-tenant reads, BullMQ Queue+Worker pattern). Phase 5 verification: `pnpm -r typecheck` green across 13 packages; `pnpm tsx tools/lint-rls-policies.ts` green (28 migrations, 14 tenant-bearing + 8 JOIN-RLS); module 04 55/55, module 06 18/18, apps/api 28/28 (+2 worker tests). Production deploys: 5 commits, 4 production deploys (each additive-only), no other-app disturbance across 14 non-assessiq containers on the shared VPS.
- **Sonnet:** n/a — single-developer hot-cache window covered all four sub-sessions. Subagent cold-start (~20-30s) plus cache loss would have outweighed token savings on each surface; total tool-call budget across all four sessions stayed within ~40 calls.
- **Haiku:** n/a — no bulk multi-file lookups; one-off greps and structured smoke tests stayed direct.
- **codex:rescue:** n/a for all four sub-sessions. Session 4a is candidate-session-only (no embed JWT, no magic-link). Activate-all is admin-CRUD only. Session 4b.1 is cron-only — no JWTs, no candidate auth, no security-adjacent surface. Module 06 + apps/worker are NOT in the load-bearing paths list. State-corruption trap surfaces are all testcontainer-covered. **Session 4b.2 (magic-link) WILL require codex:rescue** before push — that's the Session 4 DoD mandate from `docs/plans/PHASE_1_KICKOFF.md`.

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
