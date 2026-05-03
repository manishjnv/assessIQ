# 03 — API Contract

> Base URL: `https://assessiq.automateedge.cloud/api`
> All requests are JSON. All authenticated requests carry either a session cookie (`aiq_sess`) or `Authorization: Bearer aiq_live_<key>`. Tenant context is derived from the session/key — never passed in URL or body.

## Convention

- **Versioning:** path-based, `v1` is implicit at `/api`. Future breaking changes go to `/api/v2`.
- **Errors:** all errors return `{ "error": { "code": "string", "message": "string", "details": {...} } }` with proper HTTP status.
- **Pagination:** `?page=1&pageSize=50` (max 200) for list endpoints; response includes `{ items, page, pageSize, total }`.
- **Idempotency:** state-changing endpoints accept `Idempotency-Key` header; repeated keys within 24h return the cached response.
- **Timestamps:** all returned in ISO 8601 UTC.

## Endpoint catalog

### Auth

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/auth/google/start`   | Initiates Google OIDC; 302 to Google |
| `GET`  | `/auth/google/cb`      | OIDC callback; sets pre-MFA session cookie |
| `POST` | `/auth/totp/verify`    | Verifies TOTP code; promotes session to `totp_verified` |
| `POST` | `/auth/totp/enroll/start` | Generates TOTP secret + QR (returns once) |
| `POST` | `/auth/totp/enroll/confirm` | Confirms enrollment with first code |
| `POST` | `/auth/totp/recovery`  | Login via recovery code |
| `POST` | `/auth/logout`         | Destroys session |
| `GET`  | `/auth/whoami`         | Returns `{ user, tenant, roles, mfa_status }` |

### Magic-link (candidate, mode B)

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/take/:token`         | Renders landing; marks invitation viewed |
| `POST` | `/take/start`          | Mints session, creates `attempt`, returns assessment shape |

### Admin — Tenants & users

> **Status (2026-05-01, Phase 0 closure — auth route layer + first API deploy live):** `assessiq-api` container is live behind Caddy split-route at `https://assessiq.automateedge.cloud/api/*` + `/embed*`. The Fastify route layer wrapping `@assessiq/auth` shipped in commits `58eba33` (route layer + Dockerfile) + `335d055` (dev-auth shim swap). All `Auth` table endpoints below are LIVE in code; the `Admin api-keys`, `Admin embed-secrets`, and `/embed` endpoints are LIVE in code. Live drill verification: `/embed` HS256 + replay defense PASSED (Drill C alg=none → 401, Drill D replay → 200 then 401 with Redis cache populated); `/api/auth/google/start` route + tenant resolution PASSED but Drill B (curl 302) is DEFERRED until `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` are added to `/srv/assessiq/.env` (currently returns 401 `"Google SSO is not configured"` cleanly). The `/admin/users/*` slice and `/admin/invitations` POST also live; `acceptInvitation` mints real sessions via `@assessiq/auth.sessions.create`. The `import` route remains a 501 stub returning `details.code = 'BULK_IMPORT_PHASE_1'`. `/admin/tenant` is 02-tenancy Phase 1 work. `GET /api/admin/embed-secrets` intentionally NOT shipped (library lacks `listEmbedSecrets`; Phase 1 follow-up). `assessiq-frontend` Dockerfile + Drill 1 (browser full-stack) deferred to Phase 1+.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET`  | `/admin/tenant`        | Current tenant settings + branding | Phase 1 |
| `PATCH`| `/admin/tenant`        | Update tenant name, branding, settings | Phase 1 |
| `GET`  | `/admin/users`         | List users (filter by role, status, search; pageSize cap 100 — stricter than the global 200 cap per `03-users` SKILL § 9) | live |
| `POST` | `/admin/users`         | Create user record (status defaults to `pending`; no email sent — see `inviteUser` for the happy path) | live |
| `GET`  | `/admin/users/:id`     | Get user detail | live |
| `PATCH`| `/admin/users/:id`     | Update role, status, name, metadata; enforces last-admin invariant (HTTP 409 `LAST_ADMIN`) and status-state-machine (HTTP 422 `INVALID_STATUS_TRANSITION`); sweeps Redis sessions on disable | live |
| `DELETE` | `/admin/users/:id`   | Soft delete; cascades to pending invitations for the user's email; sweeps Redis sessions; enforces last-admin invariant | live |
| `POST` | `/admin/users/:id/restore` | Restore a soft-deleted user (clears `deleted_at`); does NOT recreate invitations or sessions | live |
| `POST` | `/admin/users/import`  | **501 stub** — body ignored; returns `details.code = 'BULK_IMPORT_PHASE_1'` | stub |
| `POST` | `/admin/invitations`   | Issue admin/reviewer invitation (candidate role → 501 `CANDIDATE_INVITATION_PHASE_1`); response carries the invitation row ID + email + role + expires_at but **never** the plaintext token (per `03-users` SKILL § 2) | live |
| `POST` | `/invitations/accept`  | **Pre-auth** (no session required). Body: `{token: string}` (43–64 char base64url). Validates → marks invitation accepted (atomic single-use) → flips user `pending → active` → mints a session via `01-auth` (currently mocked — see `03-users` SKILL § 12). Sets `aiq_sess` cookie (httpOnly, sameSite=lax, secure in prod). Response body is `{user, expiresAt}` — sessionToken is cookie-only (no body bearer leak) | live |
| `GET`  | `/admin/invitations`   | List invitations | Phase 1 |
| `POST` | `/admin/users/:id/totp/reset` | Force TOTP re-enrollment | Phase 1 (after 01-auth) |

#### Error contracts (live endpoints)

| `details.code` | HTTP | Where |
|---|---|---|
| `LAST_ADMIN` | 409 | `PATCH /admin/users/:id` (demote/disable last admin); `DELETE /admin/users/:id` (delete last admin) |
| `INVALID_STATUS_TRANSITION` | 422 | `PATCH /admin/users/:id` (e.g. disabled→pending, active→pending) |
| `USER_EMAIL_EXISTS` | 409 | `POST /admin/users` (collision on `(tenant_id, lower(email))`) |
| `USER_DISABLED` / `USER_DELETED` | 409 | `POST /admin/invitations` (re-invite hits disabled or soft-deleted user) |
| `INVITATION_NOT_FOUND` | 404 | `POST /invitations/accept` |
| `INVITATION_EXPIRED` | 409 | `POST /invitations/accept` (expires_at < now AND not yet accepted) |
| `INVITATION_ALREADY_USED` | 409 | `POST /invitations/accept` (atomic mark-accepted returned zero rows) |
| `BULK_IMPORT_PHASE_1` | 501 | `POST /admin/users/import` |
| `CANDIDATE_INVITATION_PHASE_1` | 501 | `POST /admin/invitations` with `role: 'candidate'` |
| `ASSESSMENT_INVITATION_PHASE_1` | 501 | `POST /admin/invitations` with non-empty `assessmentIds` |
| `VALIDATION_FAILED` | 400 | Schema validation (Fastify `validation` array surfaced under `details.validation`) |

`AUTHN_FAILED` (401) and `AUTHZ_FAILED` (403) come from the dev-auth shim today (`x-aiq-test-tenant` / `x-aiq-test-user-id` / `x-aiq-test-user-role` headers; production hard-fails until 01-auth Window 4 lands).

### Admin — Question bank

> **Status: live as of 2026-05-01 (Phase 1 G1.A Session 1).** All 15 routes registered into `apps/api/src/server.ts` via `registerQuestionBankRoutes(app, { adminOnly: authChain({roles:['admin']}) })`. Smoke verified live: `GET /api/admin/packs` returns 401 AUTHN_FAILED without session. JSON import is the Phase 1 format; CSV deferred to Phase 2. The `archive`, `levels/:id` PATCH, and `questions/:id/restore` rows are Phase 1 service-method extensions added in the same PR — same admin-only auth gate.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/packs`                       | List question packs (paginated; filter by `domain`, `status`) |
| `POST` | `/admin/packs`                       | Create pack (returns 201) |
| `GET`  | `/admin/packs/:id`                   | Pack with levels (`{ pack, levels }`) |
| `PATCH`| `/admin/packs/:id`                   | Update pack metadata (name, domain, description) |
| `POST` | `/admin/packs/:id/publish`           | Transition draft → published; snapshots all questions; bumps `pack.version` and each `question.version` |
| `POST` | `/admin/packs/:id/archive`           | Transition published → archived (rejected if any active assessment references the pack — `PACK_HAS_ASSESSMENTS`) |
| `POST` | `/admin/packs/:id/activate-questions` | Bulk-flip every `status='draft'` question in this pack to `active`. Returns `{ activated, alreadyActive, archived }`. Throws `NO_DRAFT_QUESTIONS_TO_ACTIVATE` if no draft rows exist (idempotency surface — admin UI renders "already done"). Pack must be `status='published'`. **live 2026-05-02** |
| `POST` | `/admin/packs/:id/levels`            | Add level (returns 201) |
| `PATCH`| `/admin/levels/:id`                  | Update level fields (label, description, duration, default_question_count, passing_score_pct) |
| `GET`  | `/admin/questions`                   | List questions (filter by `pack_id`, `level_id`, `type`, `status`, `tag`, `search`) |
| `POST` | `/admin/questions`                   | Create question (returns 201) |
| `GET`  | `/admin/questions/:id`               | Get question (latest version) |
| `PATCH`| `/admin/questions/:id`               | Update — creates new version automatically (snapshot-before-update) |
| `GET`  | `/admin/questions/:id/versions`      | List version snapshots (most-recent first) |
| `POST` | `/admin/questions/:id/restore`       | Restore from a prior version (body: `{ version: number }`); snapshots current then bumps |
| `POST` | `/admin/questions/import`            | Bulk import from JSON (Phase 1) — CSV deferred to Phase 2 |

### Admin — Assessments & invitations

> **Status: live as of 2026-05-02 (Phase 1 G1.B Session 3).** All 11 routes below registered into `apps/api/src/server.ts` via `registerAssessmentLifecycleRoutes(app, { adminOnly: authChain({roles:['admin']}) })`. Smoke verified live: `GET /api/admin/assessments` returns 401 AUTHN_FAILED without session, full lifecycle + cross-tenant RLS exercised by 69 testcontainer integration tests in `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts`. The `GET /:id`, `POST /:id/reopen`, `GET /:id/preview`, `GET /:id/invitations`, and `DELETE /admin/invitations/:id` rows are Phase 1 service-method extensions added in the same PR — same admin-only auth gate. `GET /admin/assessments/:id/attempts` belongs to module 06-attempt-engine and is NOT shipped here; it stays in the table as the canonical contract line for Group G1.C.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/assessments`              | List assessments (paginated; filter by `status`, `pack_id`) |
| `POST` | `/admin/assessments`              | Create draft assessment (returns 201) |
| `GET`  | `/admin/assessments/:id`          | Get assessment by id (extension) |
| `PATCH`| `/admin/assessments/:id`          | Update — only allowed in `draft` status |
| `POST` | `/admin/assessments/:id/publish`  | `draft → published` — runs pool-size pre-flight (count active questions ≥ `question_count` else 422 `POOL_TOO_SMALL`) |
| `POST` | `/admin/assessments/:id/close`    | `active → closed` — illegal on `draft` (state-machine reject) |
| `POST` | `/admin/assessments/:id/reopen`   | `closed → published` if `now < closes_at`; else 422 `REOPEN_PAST_CLOSES_AT` (extension) |
| `GET`  | `/admin/assessments/:id/preview`  | Admin sample of the question pool — does NOT create attempt or snapshot (extension) |
| `GET`  | `/admin/assessments/:id/invitations` | List invitations for an assessment (paginated; filter by `status`) (extension) |
| `POST` | `/admin/assessments/:id/invite`   | Bulk invite users (body: `{ user_ids: string[] }`); per-user skip reasons returned in `skipped[]` (returns 201) |
| `DELETE`| `/admin/invitations/:id`         | Revoke invitation — sets status to `expired`; idempotent on already-expired (extension; returns 204) |
| `GET`  | `/admin/assessments/:id/attempts` | List all attempts (status filter) — **NOT in 05; lands with module 06-attempt-engine (Group G1.C)** |

### Admin — Grading & review

> **Status (2026-05-03, Phase 2 G2.A Session 1.b — LIVE in commit `5aec6ad`):** All 10 admin endpoints below registered into `apps/api/src/server.ts` via `registerGradingRoutes(app, { adminOnly: authChain({roles:['admin']}), adminFreshMfa: authChain({roles:['admin'], freshMfaWithinMinutes: 5}) })`. Smoke verified live: 11/11 Haiku checks PASS (every endpoint returns 401 AUTHN_FAILED without session — none 404). Service handlers under `modules/07-ai-grading/src/handlers/admin-*.ts`, registrar at `routes.ts`. Grading runtime at `runtimes/claude-code-vps.ts` spawns `claude -p` per D1-D8 in `docs/05-ai-pipeline.md`. Override never replaces — INSERTs new `gradings` row with `grader='admin_override'`, `override_of` FK, `override_reason`. Multi-tenancy guard: `/accept` validates every `proposal.attempt_id === URL attemptId` AND every `proposal.question_id ∈ attempt_questions` for the attempt. D7 single-flight is in-process `Map<attemptId>`; same-attempt OR other-attempt 409. Skill SHAs at deploy time: `anchors=1f04c875`, `band=15c14f96`, `escalate=f3588256` (claude CLI v2.1.119 on the VPS).

| Method | Path | Purpose | Status |
|---|---|---|---|
| `POST` | `/admin/attempts/:id/grade`           | Trigger sync AI grading. D1 mode + D7 heartbeat + D7 single-flight. Returns `{ proposals: GradingProposal[] }` — does NOT write `gradings` rows (D8 accept-before-commit). 409 `AIG_HEARTBEAT_STALE` if session idle > 60s. 409 `AIG_GRADING_IN_PROGRESS` on single-flight reject. 503 `AIG_RUNTIME_FAILURE` on `claude` subprocess error. | **live 2026-05-03** |
| `POST` | `/admin/attempts/:id/accept`          | Commit accepted proposals. Body: `{ proposals: Array<GradingProposal & { edits?: AcceptEdits }> }`. C1 guard: every `proposal.attempt_id` MUST match URL id. Pre-loop: every `proposal.question_id ∈ attempt_questions` for the attempt. Idempotent on `(attempt_id, question_id, prompt_version_sha)` per D7 — re-call returns existing rows. Status derivation: ratio ≥ 0.85 → `correct`, ≤ 0.15 → `incorrect`, else `partial`; AI runtime failures (`AIG_*` error_class) → `review_needed`; rubric error_class flows through ratio. Flips `attempts.status='graded'` after batch insert. | **live 2026-05-03** |
| `GET`  | `/admin/attempts/:id`                 | Full attempt detail with `{ attempt, answers, frozen_questions, gradings }`. Idempotent claim semantic on read: transitions `submitted → pending_admin_grading` if currently `submitted` (no-op otherwise). Rubric column EXCLUDED from the frozen_questions response (admin grading path uses a different loader that includes rubric — candidates never see anchors/bands either way). | **live 2026-05-03** |
| `POST` | `/admin/attempts/:id/release`         | Transition `graded → released`. 422 `AIG_ATTEMPT_NOT_GRADEABLE` if status is not `graded`. Best-effort `13-notifications.sendResultReleasedEmail` via dynamic-import indirection — notification failure logs warn, never blocks the release. | **live 2026-05-03** |
| `POST` | `/admin/attempts/:id/rerun`           | Re-trigger grading on an already-graded or pending attempt. Body: `{ forceEscalate?: boolean }` (default true). When `forceEscalate=true`, runtime sets `GradingInput.force_escalate = true` so every AI-gradeable question routes through Stage 3 (grade-escalate skill / Opus) regardless of Stage 2's `needs_escalation` flag. Same heartbeat + single-flight gates as `/grade`. | **live 2026-05-03** |
| `POST` | `/admin/gradings/:id/override`        | Admin manual score correction. **Requires fresh MFA (5 min).** Body: `{ score_earned, reasoning_band?, ai_justification?, error_class?, reason }` — `reason` is mandatory. **D8 invariant: INSERTs a NEW row with `grader='admin_override'`, `override_of=<original.id>`, `override_reason`. NEVER UPDATEs the original.** Inherits `prompt_version_sha`/`label`/`model` from original (D4). 404 `AIG_GRADING_NOT_FOUND` if id not found / RLS-blocked. | **live 2026-05-03** |
| `GET`  | `/admin/dashboard/queue`              | Grading queue snapshot — attempts with `status IN ('submitted','pending_admin_grading')`. JOIN: attempts → assessments → levels → users. RLS-scoped. Optional `?status=...&limit=...` filters. | **live 2026-05-03** |
| `GET`  | `/admin/grading-jobs`                 | D3 forward-compat stub. Always returns `{ items: [] }` in `claude-code-vps` mode (Phase 1 has no grading_jobs table). Real impl lands when `anthropic-api` mode ships. | **live 2026-05-03 (stub)** |
| `POST` | `/admin/grading-jobs/:id/retry`       | D3 forward-compat stub. Always throws 503 `AIG_RUNTIME_NOT_IMPLEMENTED` in claude-code-vps mode. Use `/admin/attempts/:id/rerun` instead. | **live 2026-05-03 (stub)** |
| `GET`  | `/admin/settings/billing`             | D6 tenant grading budget — `{ monthly_budget_usd, used_usd, period_start, alert_threshold_pct }`. Returns default `{ 0, 0, null, 80 }` shape if no `tenant_grading_budgets` row exists. Phase 1 informational only (Max plan is flat-rate); Phase 2 `anthropic-api` mode enforces the gate at runtime. | **live 2026-05-03** |

#### Grading endpoints — error contract (`details.code`)

| `details.code` | HTTP | Where |
|---|---|---|
| `AIG_MODE_NOT_CLAUDE_CODE_VPS` | 503 | `/grade`, `/rerun` (mode != claude-code-vps) |
| `AIG_HEARTBEAT_STALE` | 409 | `/grade`, `/rerun` (session idle > 60s) |
| `AIG_GRADING_IN_PROGRESS` | 409 | `/grade`, `/rerun` (single-flight: same-attempt OR other-attempt) |
| `AIG_ATTEMPT_NOT_GRADEABLE` | 422 | `/grade` (wrong status), `/release` (not 'graded'), `/rerun` (terminal status) |
| `AIG_ATTEMPT_NOT_FOUND` | 404 | `/grade`, claim/release (RLS-filtered or absent) |
| `AIG_GRADING_NOT_FOUND` | 404 | `/override` (id not found / RLS-blocked) |
| `AIG_INVALID_BODY` | 422 | `/accept` (proposal.attempt_id mismatch URL OR proposal.question_id ∉ attempt_questions) |
| `AIG_SCHEMA_VIOLATION` | 503 | runtime: stream-json missing tool_use OR Zod parse fail on submit_anchors / submit_band |
| `AIG_RUNTIME_FAILURE` | 503 | runtime: `claude` subprocess timeout (120s) / non-zero exit / spawn error |
| `AIG_ESCALATION_FAILURE` | 503 | runtime: Stage 3 specific failure (caught + degraded — proposal still ships with `error_class='escalation_failure'`, Stage 2 band primary) |
| `AIG_SKILL_NOT_FOUND` | 503 | runtime: `~/.claude/skills/<name>/SKILL.md` absent on the VPS |
| `AIG_RUNTIME_NOT_IMPLEMENTED` | 503 | `/grading-jobs/:id/retry` in claude-code-vps mode; runtime-selector default branch on unknown mode |
| `AIG_FRESH_MFA_REQUIRED` | 401 | `/override` route layer (`requireFreshMfa({maxAge: 5min})` middleware reject) |
| `VALIDATION_FAILED` | 400 | All routes (Zod body / query parse fail) — `details.issues` carries the Zod issue list |

### Admin — Dashboard & reports

> **Status: 4 scoring endpoints LIVE (shipped G2.B Session 3, 2026-05-01 in commit `<G2B_SHA>`).** Registered via `registerScoringRoutes(app, { adminOnly: authChain({roles:['admin']}) })`.
> The remaining 3 stub endpoints (`summary`, `topic-heatmap`, `export.csv`) are still planned/deferred.
>
> **What changed.** `GET /api/admin/attempts/:id/score` computes on demand if no `attempt_scores` row exists; otherwise returns the cached row. The compute path: sums gradings (DISTINCT ON graded_at DESC for overrides), runs `computeSignals()` + `deriveArchetype()`, upserts into `attempt_scores`. `POST /admin/attempts/:id/accept` now also fires `computeAttemptScore(tenantId, attemptId)` non-fatally after committing gradings.
>
> **Why.** Separate the "write" path (grading commit) from the "read" path (score queries). Avoids re-aggregating gradings at every leaderboard / cohort-stats query.
>
> **Considered and rejected.** (a) Automatic background recompute on every grading write — rejected per D1/ambient-AI lint. (b) Server-sent events for live score updates — deferred Phase 3. (c) Cross-tenant leaderboard — deferred (DPDP review, P2.D13).
>
> **Not included.** `summary` (KPI banner), `topic-heatmap` (tag rollup), `export.csv` — all Phase 2/3. Public leaderboard for candidates — DPDP review required.
>
> **Downstream impact.** 10-admin-dashboard reads `auto_pct`, `archetype`, `pending_review` from this module. 15-analytics reads `auto_pct + computed_at` for CSV export. 07-ai-grading's `handleAdminAccept` calls `computeAttemptScore` after every accept cycle.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET`  | `/admin/attempts/:id/score`           | Return cached `AttemptScore` row or compute on demand. **Does NOT require fresh MFA.** Response: `{ attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, archetype_signals, computed_at }`. 404 `SCORING_ATTEMPT_NOT_FOUND` if attempt absent / RLS-blocked. | **live 2026-05-01** |
| `GET`  | `/admin/reports/cohort/:assessmentId` | Cohort-level stats for an assessment from `attempt_scores`. Response: `{ attempt_count, average_pct, p50, p75, p90, archetype_distribution: Record<string,number> }`. `attempt_count=0` → all percentile fields null + `archetype_distribution={}`. | **live 2026-05-01** |
| `GET`  | `/admin/reports/individual/:userId`   | All scored attempts for a user across assessments. Response: `IndividualScore[]` (each row: `attempt_id, assessment_id, auto_pct, archetype, computed_at`). RLS-scoped to tenant. | **live 2026-05-01** |
| `GET`  | `/admin/reports/leaderboard/:assessmentId?topN=10&anonymize=false` | Top-N attempts ordered by `auto_pct DESC`. `topN` range: 1–200 (default 10). `anonymize=true` redacts `candidate_name` and `candidate_email` to null. **Admin-only.** No public cross-tenant view (P2.D13). Response: `LeaderboardRow[]` (each: `rank, attempt_id, candidate_name, candidate_email, auto_pct, archetype, computed_at`). | **live 2026-05-01** |
| `GET`  | `/admin/dashboard/summary`            | Headline KPIs for current tenant | **planned** |
| `GET`  | `/admin/reports/topic-heatmap`        | Strong/weak topics across team | **planned** |
| `GET`  | `/admin/reports/export.csv`           | CSV export of attempts (with filters) | **planned** |

#### Scoring endpoints — error contract

| `details.code` | HTTP | Where |
|---|---|---|
| `SCORING_ATTEMPT_NOT_FOUND` | 404 | `/admin/attempts/:id/score` — attempt absent / RLS-blocked |
| `VALIDATION_FAILED` | 400 | `/admin/reports/leaderboard/:id` — invalid `topN` / `anonymize` query params |


### Admin — Webhooks, API keys, embed secrets

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/api-keys`                | List API keys (no plaintext) |
| `POST` | `/admin/api-keys`                | Create — returns plaintext **once** |
| `DELETE`| `/admin/api-keys/:id`           | Revoke |
| `GET`  | `/admin/embed-secrets`           | List embed secrets |
| `POST` | `/admin/embed-secrets`           | Create — returns plaintext **once** |
| `POST` | `/admin/embed-secrets/:id/rotate`| Rotate (90-day grace) |
| `GET`    | `/admin/webhooks`                          | List webhook endpoints for tenant — **live 2026-05-03** |
| `POST`   | `/admin/webhooks`                          | Create endpoint — returns `{ endpoint, secret }` (secret ONCE); `audit.*` events require fresh MFA (≤5 min) → `401 FRESH_MFA_REQUIRED` otherwise — **live 2026-05-03** |
| `DELETE` | `/admin/webhooks/:id`                      | Delete webhook endpoint — **live 2026-05-03** |
| `POST`   | `/admin/webhooks/:id/test`                 | Send synthetic `test.ping` event — **live 2026-05-03** |
| `GET`    | `/admin/webhooks/deliveries`               | Delivery history (optional `?endpointId=<uuid>&status=pending\|delivered\|failed`) — **live 2026-05-03** |
| `POST`   | `/admin/webhooks/deliveries/:id/replay`    | Replay a delivery (append-only, new row) — **live 2026-05-03** |
| `GET`    | `/admin/webhook-failures`                  | Convenience alias: deliveries with `status=failed` — **live 2026-05-03** |
| `POST`   | `/admin/webhook-failures/:id/retry`        | Convenience alias for replay — **live 2026-05-03** |
| `GET`    | `/admin/notifications`                     | Short-poll in-app notifications (`?since=<ISO cursor>&limit=<n>`) — any-role (admin+reviewer) — **live 2026-05-03** |
| `POST`   | `/admin/notifications/:id/mark-read`       | Mark notification read — any-role — **live 2026-05-03** |

### Admin — Audit & help authoring

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/audit`                   | Audit log (filter by actor, action, entity) |
| `GET`  | `/admin/help/export?locale=`     | Export all help rows for translation (admin only) — **live 2026-05-02** |
| `PATCH`| `/admin/help/:key`               | Update help text per locale (creates new version) — **live 2026-05-02** |
| `POST` | `/admin/help/import?locale=`     | Bulk upsert help rows from translation (admin only) — **live 2026-05-02** |

### Admin — Worker observability

> **Status: live 2026-05-02 (Session 4b.2 — Worker hardening).** Three admin-gated routes that surface BullMQ queue state for the `assessiq-cron` queue (the single queue driven by `apps/api/src/worker.ts`). Mounted via `registerAdminWorkerRoutes(app, { adminOnly: authChain({ roles: ['admin'] }) })` in [apps/api/src/server.ts](../apps/api/src/server.ts). All three return 401 `AUTHN_FAILED` without a session and 403 `AUTHZ_FAILED` for non-admin roles.
>
> **Tenant scoping:** queue stats are infra-global. BullMQ has no per-tenant column — `assessiq-cron` is shared across all tenants. The two current job types (`assessment-boundary-cron`, `attempt-timer-sweep`) iterate over all tenants internally and carry NO `tenant_id` in their job payload, so the `/failed` endpoint reveals no cross-tenant data today. When a future job ships that DOES carry a `tenant_id` payload, the `/failed` handler MUST gain a per-tenant filter on those job names — see the comment block in [apps/api/src/routes/admin-worker.ts](../apps/api/src/routes/admin-worker.ts) above the failed-job route.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET`  | `/admin/worker/stats`             | Queue depth snapshot — `{queue, fetched_at, cached, counts: {waiting, active, delayed, completed, failed}}`. 5-second in-process TTL cache; second call within the window returns `cached: true`. Single Redis round-trip via `Queue.getJobCounts()`. | **live 2026-05-02** |
| `GET`  | `/admin/worker/failed`            | Recent failed jobs (capped at 50, no pagination). Each entry: `{id, name, attempts_made, failed_reason, stacktrace_tail, data, timestamp, processed_on, finished_on}`. `data` runs through a key-substring redactor (mirrors [LOG_REDACT_PATHS](../modules/00-core/src/log-redact.ts)) — values for keys whose lowercased name contains any of `password / secret / token / apikey / api_key / recovery / cookie / authorization / auth / session / aiq_sess / id_token / refresh_token / client_secret / totp / answer / candidate` are replaced with `"[Redacted]"`, recursive to depth 3. `stacktrace_tail` is the last 1024 chars of the deepest stack frame. | **live 2026-05-02** |
| `POST` | `/admin/worker/failed/:id/retry`  | Re-enqueue a failed job by id. Returns `200 {id, retried: true}` on success, `404 NOT_FOUND` if no job with that id exists, `409 INVALID_STATE` if the job is not in failed state (already completed, active, or otherwise unretryable). BullMQ's own `Job.retry('failed')` enforces the state precondition. | **live 2026-05-02** |

#### Worker observability error contracts

| `details.code` | HTTP | Where |
|---|---|---|
| `NOT_FOUND` | 404 | `POST /admin/worker/failed/:id/retry` (job id not found in queue) |
| `INVALID_STATE` | 409 | `POST /admin/worker/failed/:id/retry` (job is not in failed state — `Job.retry()` threw) |
| `AUTHN_FAILED` | 401 | All three routes (no session) |
| `AUTHZ_FAILED` | 403 | All three routes (non-admin role) |

### Candidate

All routes mounted under `/api/me/*`, gated by the candidate auth chain (`requireAuth({ roles: ['candidate'] })`). RLS scopes every read/write to the candidate's own tenant; service-layer ownership check denies cross-user reads with `AUTHZ_FAILED { code: AE_NOT_OWNED_BY_USER }`.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET`  | `/api/me/assessments`             | List active assessments the candidate is invited to | **live 2026-05-02** |
| `POST` | `/api/me/assessments/:id/start`   | Begin attempt — creates `attempt`, freezes question set into `attempt_questions`, returns `201 Attempt` (idempotent — re-call returns existing) | **live 2026-05-02** |
| `GET`  | `/api/me/attempts/:id`            | Server-authoritative attempt view — `{ attempt, questions[], answers[], remaining_seconds }`. Auto-submits the attempt if `ends_at` has passed. | **live 2026-05-02** |
| `POST` | `/api/me/attempts/:id/answer`     | Autosave one answer (last-write-wins, decision #7) — body `{ question_id, answer, client_revision?, edits_count?, time_spent_seconds? }`; returns `204` + `X-Client-Revision` header | **live 2026-05-02** |
| `POST` | `/api/me/attempts/:id/flag`       | Toggle flag on a question — body `{ question_id, flagged }`; returns `200 { flagged }` | **live 2026-05-02** |
| `POST` | `/api/me/attempts/:id/event`      | Push behavioral event (catalog: `modules/06-attempt-engine/EVENTS.md`) — body `{ event_type, question_id?, payload? }`; returns `201 AttemptEvent` or `204` if rate-cap dropped | **live 2026-05-02** |
| `POST` | `/api/me/attempts/:id/submit`     | Final submit (idempotent terminal) — Phase 1 stops at `submitted`; returns `202 { attempt_id, status: 'submitted', estimated_grading_seconds: null }` | **live 2026-05-02** |
| `GET`  | `/api/me/attempts/:id/result`     | View result — Phase 1 returns `202 { status: 'grading_pending' }` until module 07/08 land in Phase 2 | **live (placeholder) 2026-05-02** |

### Embed

> **Phase 4 pre-flight note (2026-05-03).** The `/embed` surface is implemented in Phase 4 (Week 11-12). Decisions pinned in `modules/12-embed-sdk/SKILL.md` § Decisions captured (2026-05-03). Key implementation contracts:
> - **Cookie name:** `aiq_embed_sess` (distinct from `aiq_sess`); `SameSite=None; Secure; HttpOnly` (D7).
> - **Embed surface scope:** candidate-take-only (`/take/*`); no admin or results views in v1 (D1).
> - **Session type:** `sessions.session_type='embed'` distinguishes embed sessions from standard sessions (D6).
> - **CSP override:** `/embed` handler sets `Content-Security-Policy: frame-ancestors <tenant.embed_origins>` per-request; the global Caddy `frame-ancestors 'none'` would otherwise block the iframe (D8).

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/embed?token=<JWT>`           | Embed-mode landing; verifies HS256 JWT, mints `aiq_embed_sess` cookie (`SameSite=None`), sets per-tenant CSP `frame-ancestors`, redirects to `/take/*?embed=true` |
| `GET`  | `/embed/health`                | Health check for host apps to ping before iframe load |
| `GET`  | `/embed/sdk.js`                | Self-contained embed SDK (≤3 KB gzipped); registers `window.AssessIQ.mount()` — Phase 4 |
| `GET`  | `/embed/test-mint`             | Dev-only JWT minter; gated by `ENABLE_EMBED_TEST_MINTER=1` + `NODE_ENV≠production` + admin session — Phase 4 |

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health`        | Liveness — returns `{ status: "ok" }` |
| `GET`  | `/ready`         | Readiness — checks DB + Redis + queue |
| `GET`  | `/help/:key`     | Public help content fetch (anonymous, globals-only) — **live 2026-05-02** |
| `GET`  | `/api/help`      | Authenticated page-batch fetch (any role) — **live 2026-05-02** |
| `GET`  | `/api/help/:key` | Authenticated single-key fetch with locale fallback — **live 2026-05-02** |
| `POST` | `/api/help/track`| Telemetry (anonymous, deterministic 10% sample) — **live 2026-05-02** |

---

## Worked example — Admin creates an assessment and invites SOC L1 cohort

```http
# 1. Authenticate (browser does this; abbreviated)
GET /api/auth/whoami
→ 200 { "user": { "id":"u_...", "role":"admin" }, "tenant": { "id":"t_...","slug":"wipro-soc" }, "mfa_status":"verified" }

# 2. List published packs
GET /api/admin/packs?status=published
→ 200 { "items": [ { "id":"pack_soc_2026q2", "name":"SOC Skills 2026 Q2", "domain":"soc", "levels": [...] } ], ... }

# 3. Create assessment from L1 level
POST /api/admin/assessments
Content-Type: application/json
{
  "pack_id": "pack_soc_2026q2",
  "level_id": "lvl_soc_l1",
  "name": "SOC L1 Q2 Skills Check",
  "question_count": 12,
  "randomize": true,
  "opens_at": "2026-05-01T03:30:00Z",
  "closes_at": "2026-05-15T18:30:00Z"
}
→ 201 { "id": "assess_...", "status": "draft" }

# 4. Publish
POST /api/admin/assessments/assess_.../publish
→ 200 { "id":"assess_...", "status":"published" }

# 5. Invite the L1 cohort
POST /api/admin/assessments/assess_.../invite
{ "user_ids": ["u_l1_alpha","u_l1_beta","u_l1_gamma"] }
→ 202 { "invited": 3, "skipped": 0 }
```

## Worked example — Candidate takes assessment

```http
# 1. Land on magic link (no session yet)
GET /take/abc123def456...
→ 200 (HTML landing page; sets pre-attempt session cookie)

# 2. Begin
POST /api/take/start
{ "token": "abc123def456..." }
→ 200 {
  "attempt_id": "att_...",
  "assessment": { "name":"SOC L1 Q2 Skills Check", "duration_seconds": 1800 },
  "questions": [
    { "id":"q_1","type":"mcq","topic":"...","content": {...} },
    ...
  ],
  "ends_at": "2026-04-29T11:30:00Z"
}

# 3. Auto-save an answer
POST /api/me/attempts/att_.../answer
{ "question_id":"q_1", "answer": 2, "time_spent_seconds": 47, "edits_count": 1 }
→ 204

# 4. Submit
POST /api/me/attempts/att_.../submit
→ 202 { "attempt_id":"att_...", "status":"grading", "estimated_grading_seconds": 90 }

# 5. Poll for result
GET /api/me/attempts/att_.../result
→ 202 { "status":"grading" }
... after grading completes ...
→ 200 { "status":"released", "score": { "earned": 78, "max": 100, "auto_pct": 78 }, "by_question": [...] }
```

## Worked example — Webhook payload (host integration)

When a host app has registered for `attempt.graded`:

```http
POST <host_endpoint>
Content-Type: application/json
X-AssessIQ-Event: attempt.graded
X-AssessIQ-Delivery: del_<uuid>
X-AssessIQ-Signature: sha256=<hmac of body using webhook secret>
X-AssessIQ-Timestamp: 2026-04-29T11:32:14Z

{
  "event": "attempt.graded",
  "tenant_id": "t_...",
  "attempt_id": "att_...",
  "assessment_id": "assess_...",
  "user": { "id":"u_...","email":"jane.doe@x.com","name":"Jane Doe","external_id":"EMP-12345" },
  "score": { "earned": 78, "max": 100, "auto_pct": 78, "pending_review": false },
  "archetype": "methodical_diligent",
  "submitted_at": "2026-04-29T11:30:00Z",
  "graded_at": "2026-04-29T11:31:50Z",
  "links": {
    "result": "https://assessiq.automateedge.cloud/api/admin/attempts/att_..."
  }
}
```

**Host verification:**
```js
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
if (!timingSafeEqual(received, expected)) reject();
if (Math.abs(Date.now() - Date.parse(timestamp)) > 5*60*1000) reject();   // replay window
```

**Retry policy:** 5 attempts, exponential backoff (1m, 5m, 30m, 2h, 12h). After final failure, delivery marked `failed`; admin can replay from UI.

## Worked example — Embed JWT (host issuing)

```js
// Host backend — Node example
import jwt from "jsonwebtoken";

function buildAssessIQEmbedUrl(tenantId, user, assessmentId) {
  const payload = {
    iss: "wipro-internal-portal",
    aud: "assessiq",
    sub: user.id,
    tenant_id: tenantId,
    email: user.email,
    name: user.fullName,
    assessment_id: assessmentId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: crypto.randomUUID()
  };
  const token = jwt.sign(payload, process.env.ASSESSIQ_EMBED_SECRET, { algorithm: "HS256" });
  return `https://assessiq.automateedge.cloud/embed?token=${encodeURIComponent(token)}`;
}
```

## OpenAPI spec

A formal OpenAPI 3.1 spec lives at `infra/openapi.yaml`, kept in sync with this doc. Generated from Fastify route schemas via `fastify-swagger`. Tenants can pull it from `/api/openapi.yaml` (auth required).
