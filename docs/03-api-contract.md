# 03 — API Contract

> Base URL: `https://assessiq.automateedge.cloud/api`
> All requests are JSON. All authenticated requests carry either a session cookie (`aiq_sess`) or `Authorization: Bearer aiq_live_<key>`. Tenant context is derived from the session/key — never passed in URL or body.

## Convention

- **Versioning:** path-based, `v1` is implicit at `/api`. Future breaking changes go to `/api/v2`.
- **Errors:** all errors return `{ "error": { "code": "string", "message": "string", "details": {...} } }` with proper HTTP status.
- **Pagination:** `?page=1&pageSize=50` (max 200) for list endpoints; response includes `{ items, page, pageSize, total }`.
- **Idempotency:** state-changing endpoints accept `Idempotency-Key` header; repeated keys within 24h return the cached response.
- **Timestamps:** all returned in ISO 8601 UTC.

## Rate-limit response headers

All routes return rate-limit headers:

```
X-RateLimit-Limit: <bucket-max>      (IP, user, or tenant — most-constrained)
X-RateLimit-Remaining: <n>           (remaining in the most-constrained bucket)
Retry-After: <seconds>               (only on 429)
```

> As of 2026-05-15, the `X-RateLimit-Bypass`, `X-RateLimit-Limit-User`, `X-RateLimit-Remaining-User`, `X-RateLimit-Limit-Tenant`, and `X-RateLimit-Remaining-Tenant` headers are removed. The four-tier role-aware IP bucket design means there is no bypass state to observe — see `docs/04-auth-flows.md` § Role-aware IP rate limiting.

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

### Candidate magic-link login (Phase 5, 2026-05-13)

> **Status: LIVE 2026-05-13.** Routes in `apps/api/src/routes/auth/candidate.ts`. Implementation in `modules/01-auth/src/candidate-login.ts`. Migration `0076_candidate_login_tokens.sql` applied to production. See `docs/04-auth-flows.md` § Flow 6 for the full sequence diagram.

These two endpoints implement passwordless email sign-in for candidates who want to view their certificates at `/candidate/certificates`. They are distinct from the assessment-taking magic link (`/take/:token`) — that link is invitation-scoped and single-use-per-attempt; these routes are identity-scoped and produce a 30-day reusable session.

---

#### `POST /api/auth/candidate/request-link`

Accepts a candidate's email address and tenant slug, resolves the slug to a `tenant_id` (system role, slug→id only), and — if a matching `users` row exists in that tenant under RLS — generates a CSPRNG token, stores its sha256 hash in `candidate_login_tokens`, and dispatches a sign-in email containing the plaintext token as a query parameter on the verify-link URL.

**Auth:** none required. Route is unauthenticated (auth-establishing).

**Body:**
```json
{ "email": "string", "tenant_slug": "string" }
```

Both fields are required strings. If either field is missing or empty the endpoint returns 204 (no structural information leaked).

**Why `tenant_slug` is required (Fix 1 — 2026-05-13):** The original implementation used a BYPASSRLS system-role `SELECT` across ALL tenants to find a user by email. This leaked tenant existence — an attacker could probe whether an email is registered in any tenant by observing response timing or email-send behaviour. The new implementation requires the caller to supply `tenant_slug`. The slug is resolved to a `tenant_id` using the existing `getTenantBySlug()` system-role helper (slug→id is not sensitive; tenant slugs appear in admin SSO URLs). The user lookup then runs inside `withTenant(tenant_id, …)` under RLS, so only rows owned by that tenant are visible. An email registered in a different tenant is invisible.

The web client (`CandidateLogin.tsx`) currently hardcodes `tenant_slug: 'wipro-soc'` (the only production tenant). A TODO comment marks where per-subdomain detection ships in Phase 6.

**Response 204:** always — regardless of whether the email matched, the slug was valid, or the rate limit was exceeded. This is intentional anti-enumeration.

**Response 400:** `VALIDATION_FAILED` — request body is not JSON.

**Token properties:**
- Generated: `crypto.randomBytes(32).toString('hex')` — 64-character hex string, 256 bits entropy
- Stored: `sha256(token).hex` in `candidate_login_tokens.token_hash` — plaintext never persisted
- TTL: 15 minutes (`expires_at = now() + interval '15 minutes'`)
- Single-use: enforced by `consumed_at IS NULL` predicate on the verify path

**Audit:** emits `auth.candidate.login_link_requested` to `audit_log` when a token is successfully created (`actor_kind='system'`, `entity_type='candidate_login_token'`, inside the resolved tenant's `withTenant` transaction). No audit row is emitted when the email is not found (to avoid timing correlation).

**Rate-limit key:** `aiq:rl:cand-login:<ip>:<sha256(lower(email))>` — 5 requests per (IP, email) per 60-minute fixed-window Redis counter; the email is SHA-256 hashed before use as the key suffix so the raw email is never written to Redis. On exceed the endpoint still returns 204 (anti-enumeration — no 429 here).

**Constant-time floor:** Both match and no-match paths are bounded to ≥ 200 ms via `Promise.all([work, sleep(200)])` in `requestCandidateLoginLinkSystem`. This prevents timing-based enumeration of registered emails even across the slug-miss fast path.

---

#### `POST /api/auth/candidate/verify-link`

Validates the token from the sign-in email, consumes it atomically, mints a 30-day candidate session, sets the cookie, and returns a JSON instruction the SPA uses to navigate.

**Why POST, not GET.** Email-preview crawlers (Gmail, Outlook, Slack, Teams) prefetch link URLs with GET to render previews / scan for malware. A GET endpoint would consume the single-use token on prefetch, locking out the real candidate. The email link therefore targets a SPA route at `/candidate/login/verify?token=…` (idempotent on GET — it returns HTML); the SPA reads `?token=` from the URL and POSTs it here. Crawlers don't execute JS or POST, so the token survives prefetch.

**Auth:** none required. Token IS the credential.

**Request:** `Content-Type: application/json`, body `{ token: string }` — the plaintext token from the email link.

**Success path (token valid, unconsumed, not expired):**
1. Compute `sha256(token).hex`
2. **(Fix 4 — 2026-05-13)** If an `aiq_sess` cookie is present on the incoming request, call `sessions.destroy(priorToken)` fire-and-forget (`.catch()` — never blocks the mint). This eliminates session-fixation: any pre-existing session (stale or attacker-planted) is invalidated before the new one is minted.
3. `UPDATE candidate_login_tokens SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING user_id, tenant_id` — atomic single-use enforcement
4. `sessions.create({ userId, tenantId, role: 'candidate', totpVerified: true, expiresAt: now + 30d, skipIdleEviction: true })`
5. Set `aiq_sess` cookie: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
6. Return `200 { ok: true, redirect: '/candidate/certificates' }`

**Failure path (token invalid, expired, already consumed, or missing from body):**
- Return `200 { ok: false, error: 'invalid_link' }` — HTTP 200 because the failure is part of the protocol, not a transport-level error. The SPA reads `ok: false` and navigates to `/candidate/login?error=invalid_link`.
- No error detail is leaked beyond the `invalid_link` code.

**Cache-Control:** `no-store` on every response — both success and failure paths must not be cached by any intermediary.

**Session properties:**
- Cookie name: `aiq_sess` (same as admin sessions; role-discriminated server-side)
- Lifetime: **30-day fixed** (not sliding); `last_seen_at` is updated but `expires_at` is not extended
- `totpVerified`: `true` — magic link is the auth factor; no TOTP step
- `session_type`: `standard`

**Audit:** emits `auth.candidate.login_verified` on success (`actor_kind='user'`, `entity_type='session'`, `entity_id=session.id`, payload includes `{tokenId, ip}`). No audit row on failure (to avoid timing oracle via audit-log side-channel).

**What is NOT included:**
- No refresh or re-issue of the same token — each sign-in requires a new `POST /request-link` cycle
- No TOTP step — the magic link itself is the sole factor for candidate sessions
- No sliding-window session extension — the 30-day window is fixed at mint time

---

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
| `POST` | `/admin/packs`                       | Create pack (returns 201). `slug` is **optional** — auto-generated from `name` (NFKD lowercase, hyphens, 64-char cap) when omitted. Collision appends `-2` … `-10` suffix. Explicit slug still validated against `/^[a-z0-9-]{3,80}$/`. **fix 2026-05-04** |
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
| `POST` | `/admin/packs/:id/levels/:levelId/generate` | **AI question generation** — generates SOC-grounded `ai_draft` questions for the given level. Body: `{ count?: number (1–10, default 5), topic_focus?: string }`. Returns `{ questionIds: string[], generated: number, skillSha: string }`. Requires `AI_PIPELINE_MODE=claude-code-vps`. Single-flight: 409 `GRADING_IN_PROGRESS` if generation already in flight for this pack/level. Questions land as `status='ai_draft'` with `knowledge_base_sources` provenance. **live 2026-05-08** |
| `POST` | `/admin/questions/bulk-update-status` | Bulk-flip a batch of questions to `active` or `archived` (admin grid action). Body: `{ ids: string[] (1–200 UUIDs), status: 'active' \| 'archived' }`. Returns `{ updated: string[], notFound: string[] }`. Service filters source statuses (`active` only accepts `ai_draft`; `archived` accepts `ai_draft` \| `draft` \| `active`); ids in disallowed source states OR cross-tenant ids land in `notFound`. Always writes a single `bulk_status` summary audit row (G3.D). 400 `INVALID_BULK_SIZE` for empty / >200 ids; 400 `VALIDATION_ERROR` for non-UUID id or bad status. **live 2026-05-11** |

### Admin — Rubric generation & generation attempts

> **Status: live.** Routes registered in `modules/04-question-bank/src/routes.ts` via `registerQuestionBankRoutes(app, { adminOnly: authChain({roles:['admin']}) })`. All routes are admin-only; tenant scope enforced via RLS + `withTenant`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/admin/questions/:id/generate-rubric` | Generate a rubric proposal for a question. **Does NOT persist** — call `save-rubric` to commit. Returns a rubric object. Requires `AI_PIPELINE_MODE=claude-code-vps`. |
| `POST` | `/admin/questions/:id/save-rubric` | Persist a rubric for a question. Body: `{ rubric: <rubric object> }` (required — 400 `INVALID_PARAM` if absent). Validates that all anchor weights sum to 100 (server-side). Saves as a new rubric version. Returns the updated rubric. |
| `POST` | `/admin/packs/:id/generate-missing-rubrics` | Find the first question in the pack with `rubric IS NULL` and `type IN ('subjective', 'scenario')`, generate a proposal, and return it with a pagination cursor. **Does NOT auto-save.** Response: `{ proposal: <rubric>, cursor: { currentQuestionId, nextQuestionId, remainingCount } }`. Call repeatedly until `cursor.nextQuestionId` is null. |
| `GET`  | `/admin/generation-attempts` | Cross-pack AI question-generation history. Query params (all optional): `status` (`success`\|`partial`\|`failed`\|`running`), `model` (substring match, ILIKE), `pack_id` (UUID), `level_id` (UUID), `since` (ISO-8601, filters `started_at ≥ since`), `limit` (1–100, default 50), `offset` (default 0). Response: `{ items: GenerationAttempt[], total, limit, offset }`. Each item: `id, status, count_requested, count_inserted, error_code, error_message, stderr_tail, skill_sha, model, chunks_planned, chunks_failed, dedupe_dropped, duration_ms, started_at, finished_at, pack_id, level_id, user_id`. |
| `GET`  | `/admin/packs/:packId/levels/:levelId/generation-attempts` | Most recent 5 generation attempts for a specific pack + level. Useful for diagnosing why a "Generate" click produced 0 rows without SSH access. Response: `Array<{ id, status, count_requested, count_inserted, error_code, error_message, stderr_tail, model, duration_ms, started_at, finished_at }>`. |
| `POST` | `/admin/generation-attempts/:id/score` | Server-side structural + runtime eval scoring for a single generation attempt. **Read-only — no writes to any table.** Resolves attempt via RLS (404 if absent or cross-tenant), loads inserted questions, runs `scoreQuestion` per question, compares per-type pass rates against `eval/baseline.json` regression thresholds. Response: `{ structural: <per-type breakdown>, runtime: <metrics>, verdict: "pass" \| "regression" \| "warning" \| "n/a" }`. |

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
| `GET`  | `/admin/audit`                   | Audit log. Query params (all optional): `actorUserId` (UUID), `actorKind` (`user`\|`system`), `action` (string), `entityType` (string), `entityId` (UUID), `from` (ISO date), `to` (ISO date), `page` (default 1), `pageSize` (default 50, max 200). |
| `GET`  | `/admin/audit/export.csv`        | Stream audit log as CSV. Same query params as `GET /admin/audit` (all optional). Response: `Content-Type: text/csv`, `Content-Disposition: attachment; filename="audit-<tenantPrefix>.csv"`. **live 2026-05-03** |
| `GET`  | `/admin/audit/export.jsonl`      | Stream audit log as JSON Lines. Same query params. Response: `Content-Type: application/x-ndjson`, `Content-Disposition: attachment; filename="audit-<tenantPrefix>.jsonl"`. **live 2026-05-03** |
| `GET`  | `/admin/audit/archives`          | List S3 audit archives for the tenant. **Phase 4 placeholder** — returns `{ archives: [], note: "S3 archive not configured (Phase 4)" }` when `S3_BUCKET` is unset. **live (stub) 2026-05-03** |
| `POST` | `/admin/audit/archives/:date/restore` | Restore (stream-download) an audit archive for the given date. `:date` format: `YYYY-MM-DD`. **Phase 4 placeholder** — returns `503 S3_NOT_CONFIGURED` when `S3_BUCKET` is unset. **live (stub) 2026-05-03** |
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

### Admin — Super (cross-tenant platform operations)

> **Status: LIVE 2026-05-08 (commit `e70d267`).** Implemented in `apps/api/src/routes/admin-super.ts`. Registered via `registerAdminSuperRoutes(app)` in `apps/api/src/server.ts`. Gate: `authChain({ roles: ['super_admin'] })` — tenant admins and reviewers cannot reach these endpoints.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `PATCH` | `/api/admin/super/tenants/:tenantId/ai-generate-mode` | Flip `ai_generate_mode` for a target tenant | **live 2026-05-08** |

#### `PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode`

Flips `tenant_settings.ai_generate_mode` for the named tenant. Used by platform operators during the Stage 3 generation-mode rollout.

**Auth:** `super_admin` only. Tenant admin, reviewer, and candidate sessions all receive `403 AUTHZ_FAILED`.

**Path params:** `tenantId` — UUID of the target tenant.

**Body:** `{ mode: "omnibus" | "sharded" | null }`

| `mode` value | Meaning |
|---|---|
| `"omnibus"` | Whole-pack AI generation (pre-Stage-3 default) |
| `"sharded"` | Type-sharded generation (Stage 3 rollout) |
| `null` | Remove per-tenant override; tenant falls back to platform default |

**Response 200:**
```json
{
  "tenantId": "uuid",
  "ai_generate_mode": "sharded",
  "previous": "omnibus",
  "updatedAt": "2026-05-08T10:30:00Z",
  "auditId": "uuid"
}
```

- `previous` — the value before this call (for undo / audit display)
- `auditId` — UUID of the `audit_log` row committed atomically with the `UPDATE`

**Response 400:** `details.code = 'INVALID_MODE'` — `mode` not in `"omnibus" | "sharded" | null`.
**Response 403:** `AUTHZ_FAILED` — caller is not `super_admin`.
**Response 404:** target tenant's `tenant_settings` row is absent.

**Audit:** Emits `tenant_settings.ai_generate_mode.updated` (ACTION_CATALOG in `modules/14-audit-log/src/types.ts`). The `UPDATE` and the `audit_log` INSERT share a single Postgres transaction — the UPDATE rolls back if the INSERT fails.

**Design ref:** `docs/design/2026-05-10-stage-3-promotion-rollout.md` §3.

**Source:** `apps/api/src/routes/admin-super.ts:41`, `modules/02-tenancy/src/service.ts` (`updateAiGenerateMode`).

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

> **Status: LIVE 2026-05-03 (Phase 4 commit `b20858b`).** Full implementation in `apps/api/src/routes/auth/embed.ts`. Decisions pinned in `modules/12-embed-sdk/SKILL.md` § Decisions captured (2026-05-03). All 4 `/embed` routes below are live and verified (smoke tests: `/embed` → 400 without token ✅, `/embed/health` → 200 ✅, `/embed/sdk.js` → 200 ✅).
>
> Key implementation contracts:
> - **Cookie name:** `aiq_embed_sess` (distinct from `aiq_sess`); `SameSite=None; Secure; HttpOnly` (D7). The API server bridges the embed cookie to the standard cookie name via an `onRequest` hook so all downstream auth-chain middleware sees `aiq_sess` without modification.
> - **Embed surface scope:** candidate-take-only (`/take/*`); no admin or results views in v1 (D1).
> - **Session type:** `sessions.session_type='embed'` distinguishes embed sessions from standard sessions (D6). Migration `0071_tenants_embed_metadata.sql` adds the column.
> - **CSP override:** `/embed` handler sets `Content-Security-Policy: frame-ancestors <tenant.embed_origins>` per-request AND removes `X-Frame-Options`; the global Caddy `frame-ancestors 'none'` would otherwise block the iframe (D8). Per-tenant `embed_origins` stored as TEXT[] column on `tenants` (migration `0070_embed_origins.sql`).
> - **Privacy gate (D13):** `POST /api/admin/embed-secrets` returns `403 EMBED_REGISTRATION_REQUIRES_PRIVACY_DISCLOSURE` if `tenants.privacy_disclosed = FALSE`.
> - **JIT user resolution:** if the JWT `sub` is a known email, resolves to existing user; else creates a guest user in the tenant. Never exposes a user's password hash.
> - **Attempt flagging:** `startAttempt({ embedOrigin: true })` sets `attempts.embed_origin = TRUE` (migration `0073_attempt_embed_origin.sql`).
> - **Dev minter:** `POST /embed/sdk-mint` is triple-gated: `ENABLE_EMBED_TEST_MINTER=1` env var + `NODE_ENV !== 'production'` + admin session. Not enabled in production.
> - **Host SDK:** `packages/embed-sdk/` is the public npm package (`@assessiq/embed`). `AssessIQEmbed.mount(selector, opts)` mounts the iframe and wraps the postMessage bus.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET`  | `/embed?token=<JWT>`           | Embed-mode landing; verifies HS256 JWT (D5: exp-iat ≤ 600s), resolves/creates JIT user, mints `aiq_embed_sess` cookie (`SameSite=None; Secure; HttpOnly`), sets per-tenant CSP `frame-ancestors`, starts attempt with `embed_origin=true`, redirects to `/take/a/:id?embed=true` | **live 2026-05-03** |
| `GET`  | `/embed/health`                | Health check for host apps to ping before iframe load — returns `{ status: 'ok' }` | **live 2026-05-03** |
| `GET`  | `/embed/sdk.js`                | Self-contained UMD embed SDK; registers `window.AssessIQ.mount()`. `Cache-Control: public, max-age=3600` | **live 2026-05-03** |
| `POST` | `/embed/sdk-mint`              | Dev-only JWT minter; triple-gated: `ENABLE_EMBED_TEST_MINTER=1` + `NODE_ENV≠production` + admin session. Not enabled in production | **live (dev-only gate)** |

### Admin — Embed origins & webhook secrets

> **Status: LIVE 2026-05-03 (Phase 4 commit `b20858b`).** Implemented in `apps/api/src/routes/embed-admin.ts`. All 4 routes gated by `authChain({ roles: ['admin'] })`. The `DELETE /api/admin/embed-secrets/:id` endpoint and the privacy-disclosure gate on `POST /api/admin/embed-secrets` are additions to the existing `embed-secrets.ts` route file.
>
> **What changed in Phase 4 on the existing `embed-secrets` routes:**
> - `POST /api/admin/embed-secrets`: now returns `403 EMBED_REGISTRATION_REQUIRES_PRIVACY_DISCLOSURE` if `tenants.privacy_disclosed = FALSE` (D13). Writes `embed_secret.created` audit event.
> - `POST /api/admin/embed-secrets/:id/rotate`: writes `embed_secret.rotated` audit event.
> - `DELETE /api/admin/embed-secrets/:id`: NEW. Sets `status='revoked'`, writes `embed_secret.revoked` audit event. Returns 204.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET`    | `/api/admin/embed-origins`            | List current `tenants.embed_origins[]` for the tenant | **live 2026-05-03** |
| `POST`   | `/api/admin/embed-origins`            | Add an origin to `tenants.embed_origins[]`. Body: `{ origin: string }`. Validates: must be a valid HTTPS URL (or `http://localhost:<port>`); no `*`; no bare domain without protocol; must not duplicate. Returns 204. | **live 2026-05-03** |
| `DELETE` | `/api/admin/embed-origins`            | Remove an origin. Body: `{ origin: string }`. Returns 204. | **live 2026-05-03** |
| `POST`   | `/api/admin/webhook-secrets/rotate`   | Rotate `tenant_settings.webhook_secret`; returns plaintext **once**. Returns 200 `{ secret }`. | **live 2026-05-03** |
| `DELETE` | `/api/admin/embed-secrets/:id`        | Revoke an embed secret. Sets `status='revoked'`, writes audit. Returns 204. | **live 2026-05-03** |

#### Embed admin error contracts

| `details.code` | HTTP | Where |
|---|---|---|
| `EMBED_REGISTRATION_REQUIRES_PRIVACY_DISCLOSURE` | 403 | `POST /api/admin/embed-secrets` when `tenants.privacy_disclosed = FALSE` (D13) |
| `EMBED_ORIGIN_INVALID` | 400 | `POST /api/admin/embed-origins` (not a valid https:// or localhost URL) |
| `EMBED_ORIGIN_DUPLICATE` | 409 | `POST /api/admin/embed-origins` (origin already in array) |
| `EMBED_ORIGIN_NOT_FOUND` | 404 | `DELETE /api/admin/embed-origins` (origin not in array) |
| `AUTHN_FAILED` | 401 | All routes (no session) |
| `AUTHZ_FAILED` | 403 | All routes (non-admin role) |
| `VALIDATION_FAILED` | 400 | Body schema parse failure |

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health`        | Liveness — returns `{ status: "ok" }` |
| `GET`  | `/ready`         | Readiness — checks DB + Redis + queue |
| `GET`  | `/help/:key`     | Public help content fetch (anonymous, globals-only) — **live 2026-05-02** |
| `GET`  | `/api/help`      | Authenticated page-batch fetch (any role) — **live 2026-05-02** |
| `GET`  | `/api/help/:key` | Authenticated single-key fetch with locale fallback — **live 2026-05-02** |
| `POST` | `/api/help/track`| Telemetry (anonymous, deterministic 10% sample) — **live 2026-05-02** |
| `POST` | `/api/_log`       | Frontend log ingest. Body: `{ entries: [{level: "info"\|"warn"\|"error", msg: string (≤200 chars), ts: number, fields?: {…}}] }` (1–50 items). Returns `204`. No auth required. Rate-limited: 600 req/min/IP. (`apps/api/src/routes/_log.ts:80`) — **live** |
| `GET`  | `/verify/:credentialId`         | Public certificate verify HTML page (no auth, no tenant context). Returns 200 with green/red badge; 404 if credential not found or malformed; 429 if rate limit exceeded (60 req/IP/hour). Renders OG/Twitter meta tags in `<head>` pointing at `/og.png` so LinkedIn/Twitter previews render as rich cards. Fire-and-forget `verification_views` counter increment, deduped per (IP, credential) per hour. (`modules/18-certification/src/routes-public.ts`) — **live 2026-05-11** |
| `GET`  | `/verify/:credentialId/og.svg`  | OG/social-preview image as SVG (1200×630). Returns `image/svg+xml`, `Cache-Control: public, max-age=3600`. Used by Twitter, Facebook, Mastodon, Slack. 404 on missing/malformed credential. — **live 2026-05-11** |
| `GET`  | `/verify/:credentialId/og.png`  | OG/social-preview image as PNG (1200×630), rasterized from the SVG via `@resvg/resvg-js`. Returns `image/png`, `Cache-Control: public, max-age=3600`. Used by LinkedIn (which rejects SVG previews). 404 on missing/malformed credential. — **live 2026-05-13** |

### Dev / Test (internal, gated)

> **These routes do NOT exist in the production module graph.** `POST /api/dev/mint-session` is only registered when `ENABLE_E2E_TEST_MINTER=true` (a conditional dynamic `await import(...)` in `apps/api/src/server.ts`). Setting this env var in production is a misconfiguration.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `POST` | `/api/dev/mint-session` | E2E test session minter — find-or-create a user by `(tenantSlug, email, role)` and return a fully-verified `aiq_sess` cookie | **dev/CI only** |

#### `POST /api/dev/mint-session`

Provides Playwright E2E specs with a real session cookie without requiring Google SSO + TOTP.

**Security gates (all three must hold simultaneously):**
1. `ENABLE_E2E_TEST_MINTER=true` env var
2. Route file is a conditional dynamic import — it is **not present in the prod module graph** when the var is absent
3. `super_admin` role is intentionally excluded — only `admin`, `reviewer`, `candidate` may be minted

**Body:** `{ email: string, role: "admin"|"reviewer"|"candidate", tenantSlug: string }`

**Security invariants (source: `apps/api/src/routes/dev/mint-session.ts`):**
- When the email matches an existing user, the minted session uses the user's **current DB role** — never the caller-supplied `role`. Prevents privilege escalation.
- When no user exists, `role` must be `"candidate"`. Admin/reviewer accounts must be seeded via the real invitation flow.
- `tenantId` is derived from `tenantSlug` via a trusted slug lookup — never taken from the HTTP body.

**Response 200:** Sets `aiq_sess` cookie (httpOnly, secure in prod, sameSite=lax). Body: `{ sessionId, userId, expiresAt }`.

**Audit:** Every successful mint writes `dev.mint_session` to `audit_log` (ACTION_CATALOG in `modules/14-audit-log/src/types.ts`). Fail-closed — if the audit write fails, the request fails.

**Source:** `apps/api/src/routes/dev/mint-session.ts:129`.

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

---

## Admin — Reports & Exports (Phase 3 G3.C, module 15-analytics)

All routes require admin session. Served at `/api/admin/reports/*`.

### `GET /api/admin/reports/topic-heatmap`

Returns per-topic average score buckets for a given pack.

**Query params:** `packId` (required UUID), `from` (optional ISO date), `to` (optional ISO date)

**Response 200:**
```json
{
  "topics": [
    { "topicId": "uuid", "topicLabel": "string", "avgPct": 75, "bucket": "good", "n": 42 }
  ]
}
```
`bucket` is one of `"poor" | "fair" | "good" | "excellent"` (25/50/75/100 band scoring).

**Response 400:** `packId` missing or malformed.

---

### `GET /api/admin/reports/archetype-distribution/:assessmentId`

Returns count of each archetype for a given assessment.

**Path params:** `assessmentId` (UUID)

**Response 200:**
```json
{
  "items": [
    { "archetype": "Practitioner", "count": 12 }
  ]
}
```

---

### `GET /api/admin/reports/cost-by-month`

Returns per-month grading cost (API token spend). In Phase 3 (`claude-code-vps` mode) always returns empty shape.

**Query params:** `year` (optional YYYY integer, defaults to current year)

**Response 200 (Phase 3 — claude-code-vps):**
```json
{
  "items": [],
  "mode": "claude-code-vps",
  "message": "Cost data is only available in Anthropic API mode."
}
```

**Response 200 (Phase 4 — anthropic-api):**
```json
{
  "items": [
    { "month": "2026-01", "inputTokens": 1200000, "outputTokens": 80000, "estimatedUsdCents": 450 }
  ]
}
```

---

### `GET /api/admin/reports/exports/attempts.csv`

Streams all scored attempts as CSV (RFC 4180). Capped at `EXPORT_ROW_CAP = 10_000` rows.

**Query params (all optional):** `from` (ISO date), `to` (ISO date), `assessmentId` (UUID), `userId` (UUID)

**Response 200:** `Content-Type: text/csv`, `Content-Disposition: attachment; filename="attempts.csv"`, streaming body.

**Columns:** `attempt_id, assessment_name, user_id, submitted_at, total_earned, total_max, auto_pct, pending_review, archetype`

**Audit:** `action: 'attempt.exported'` written to audit log on each call.

---

### `GET /api/admin/reports/exports/attempts.jsonl`

Same data as attempts.csv but as JSON Lines (one JSON object per line, `\n` delimited).

**Query params:** same as `attempts.csv`.

**Response 200:** `Content-Type: application/x-ndjson`, streaming body.

**Audit:** `action: 'attempt.exported'` written to audit log.

---

### `GET /api/admin/reports/exports/topic-heatmap.csv`

Exports the topic heatmap report as CSV.

**Query params:** `packId` (required UUID), `from` (optional ISO date), `to` (optional ISO date)

**Response 200:** `Content-Type: text/csv`, streaming body.

**Columns:** `topic_id, topic_label, avg_pct, bucket, n`

**Response 400:** `packId` missing or malformed.

---

### `GET /api/admin/cycles/:cycleId/cohort-report`

Returns a detailed cohort report for an assessment. The URL parameter is named `cycleId` (matching the Phase 3 plan spec) and maps to `assessment_id` in the database. Reads `attempt_summary_mv` (materialized view).

**Data freshness:** depends on the last `REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv` invocation. Nightly BullMQ job runs at 02:00 UTC. Platform operators can force a refresh via `POST /api/admin/analytics/refresh` below.

**Auth:** admin session required. Tenant isolation enforced via application-layer `WHERE tenant_id = ?` filter — the MV has no RLS.

**Path params:** `cycleId` — UUID of the assessment.

**Query params:** `archetype` (optional string) — filters the `attempts[]` array to that archetype label only. Summary statistics (`total_attempts`, percentiles, `archetype_distribution`) always cover the full cohort regardless of this filter.

**Response 200:**
```json
{
  "cycle_id": "uuid",
  "total_attempts": 42,
  "graded_count": 38,
  "released_count": 35,
  "archetype_distribution": { "methodical_diligent": 12, "practitioner": 8 },
  "avg_total_score": 73.5,
  "p50_total_score": 75.0,
  "p90_total_score": 92.0,
  "band_avg": { "L1": 73.5 },
  "attempts": [
    { "attempt_id": "uuid", "user_id": "uuid", "total_score": 92.0, "archetype": "methodical_diligent" }
  ]
}
```

- `attempts[]` capped at 500 rows, ordered by `total_score DESC`.
- Unknown `cycleId` returns a valid 200 with `total_attempts: 0` and empty arrays — no 404 is emitted.

**Response 400:** `cycleId` is not a valid UUID.

**Source:** `modules/15-analytics/src/routes.ts:305` (commit `a455bd3`).

---

### `POST /api/admin/analytics/refresh`

Triggers `REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv`. All analytics and cohort-report endpoints read this MV — use this endpoint after a large grading run or bulk import to avoid waiting for the nightly 02:00 UTC BullMQ job.

**Auth:** `super_admin` only (not tenant admin — the refresh acquires a non-exclusive table lock and is a platform-operator action).

**Body:** none.

**Response 200:** `{ ok: true, duration_ms: number }`

**Notes:** Auto-refresh on every attempt write is intentionally deferred; see `modules/15-analytics/SKILL.md` for rationale.

**Source:** `modules/15-analytics/src/routes.ts:339`.

---

## Admin — Activity (Phase 9, module 15-analytics)

All routes require admin session; tenant-scoped via `withTenant` (RLS). Served at `/api/admin/activity/*`. Each endpoint owns its full vertical slice under [`modules/15-analytics/src/activity/`](../modules/15-analytics/src/activity/) (one file per endpoint).

**Decision (locked `db020d1`):** backend returns raw `question_packs.domain` slugs (e.g. `"soc"`, `"devops"`, `"cloud-architect"`). Frontend maps slugs → display names. No schema migration in v1.1.

### `GET /api/admin/activity/stats`

3 stat-card metrics over a date window. Quartile breakdown for avgScore.

**Query params:** `from` (optional `YYYY-MM-DD`), `to` (optional `YYYY-MM-DD`), `groupBy` (optional `domain` \| `level`, default `domain`). Defaults: `to = today`, `from = today − 30 days`.

**Response 200:**
```json
{
  "data": {
    "from": "2026-04-13",
    "to":   "2026-05-13",
    "groupBy": "domain",
    "completions":      { "total": 142, "breakdown": [{ "key": "soc", "value": 61, "pct": 0.43 }, ...] },
    "activeCandidates": { "total": 2418, "breakdown": [{ "key": "soc", "value": 984, "pct": 0.41 }, ...] },
    "avgScore":         { "total": 76.4, "breakdown": [
      { "key": "top_quartile",     "value": 92.1, "pct": 0.32 },
      { "key": "above_median",     "value": 78.4, "pct": 0.36 },
      { "key": "below_median",     "value": 61.2, "pct": 0.22 },
      { "key": "bottom_quartile",  "value": 48.7, "pct": 0.10 }
    ] }
  }
}
```

- `avgScore.breakdown` is **always quartile-based** regardless of `groupBy` (quartiles of `auto_pct` over the period).
- `completions.breakdown` and `activeCandidates.breakdown` honour `groupBy`.
- Data source: `attempt_summary_mv` LEFT JOIN `question_packs` LEFT JOIN `levels`. Explicit MV tenant filter enforced by `tools/lint-mv-tenant-filter.ts`.

**Source:** [`modules/15-analytics/src/activity/stats.ts`](../modules/15-analytics/src/activity/stats.ts).

---

### `GET /api/admin/activity/heatmap`

365-day GitHub-style daily completion counts with TS-computed streak math.

**Query params:** `from` (optional `YYYY-MM-DD`), `to` (optional `YYYY-MM-DD`). Defaults: `to = today`, `from = today − 365 days` (full calendar year).

**Response 200:**
```json
{
  "data": {
    "from": "2025-05-14",
    "to":   "2026-05-13",
    "days": [
      { "date": "2025-05-14", "count": 0 },
      { "date": "2025-05-15", "count": 3 }
    ],
    "totals": { "total": 1284, "avgPerDay": 3.5, "activeDays": 218 },
    "streaks": { "current": 42, "longest": 71 }
  }
}
```

- `days[]` is **zero-filled** to exactly `to − from + 1` entries (one per calendar day, UTC).
- Counts include attempts with `status ∈ {submitted, auto_submitted, graded, released, pending_admin_grading}`.
- **Data source: live `attempts` table** (NOT `attempt_summary_mv`) — same-day completions must appear immediately; MV is nightly-refreshed.
- Streak computation is in TypeScript (O(N) iteration), not SQL.

**Source:** [`modules/15-analytics/src/activity/heatmap.ts`](../modules/15-analytics/src/activity/heatmap.ts).

---

### `GET /api/admin/activity/timeline`

52-week stacked-bar dataset: weekly completions × question-pack domain.

**Query params:** `from` (optional `YYYY-MM-DD`), `to` (optional `YYYY-MM-DD`). Defaults: `to = today`, `from = today − 364 days` (exactly 52 weeks).

**Response 200:**
```json
{
  "data": {
    "from": "2025-05-15",
    "to":   "2026-05-13",
    "domains": ["soc", "devops", "cloud-architect", "other"],
    "bars": [
      {
        "weekStart": "2025-05-12",
        "weekEnd":   "2025-05-18",
        "segments":  [12, 4, 0, 1],
        "total":     17
      }
    ]
  }
}
```

- `domains[]` is ordered by total count DESC. Up to 8 distinct domains; tail collapses to a single `"other"` slot when more than 8 distinct domains appear in the range.
- `segments[i]` always corresponds to `domains[i]`.
- `bars[]` is zero-filled across every ISO week in the range (Mon → Sun, UTC).
- Data source: `attempt_summary_mv` JOIN `question_packs`. Explicit MV tenant filter enforced.

**Source:** [`modules/15-analytics/src/activity/timeline.ts`](../modules/15-analytics/src/activity/timeline.ts).

---

### `GET /api/admin/activity/leaderboard`

Catalog-wide **question-pack** ranking by submission volume, with prior-period delta. One row per `question_packs.id` — a pack with multiple assessment cycles rolls up to a single leaderboard entry. (Per-assessment grouping was considered and rejected during Phase 9 review: it produced duplicate-pack-name rows in the Phase 11 page when a pack had >1 assessment cycle.)

**Query params:** `period` (optional `week` \| `month` \| `quarter`, default `week`), `page` (optional int ≥ 1, default 1), `pageSize` (optional int in `[1, 50]`, default 10).

**Response 200:**
```json
{
  "data": {
    "period": "week",
    "from": "2026-05-07",
    "to":   "2026-05-13",
    "priorFrom": "2026-04-30",
    "priorTo":   "2026-05-06",
    "page": 1,
    "pageSize": 10,
    "totalRanked": 24,
    "items": [
      {
        "rank": 1,
        "packId":   "uuid",
        "packName": "SOC Skills 2026Q2",
        "domain":   "soc",
        "currentCount": 4200,
        "priorCount":   3750,
        "deltaPct": 12.0,
        "direction": "up"
      }
    ]
  }
}
```

- `deltaPct` is `null` when `priorCount = 0` and `currentCount > 0` (new entry — no baseline). Otherwise rounded to 1 decimal.
- `direction ∈ {"up", "down", "flat"}` with a ±0.5% dead-band around zero to suppress noise.
- **Data source: live `attempts` table** (NOT MV) — week-over-week deltas require fresh data; MV is too stale.
- Two-CTE query: both `current_period` and `prior_period` JOIN `assessments` and `GROUP BY ass.pack_id`. LEFT JOIN on `pack_id`; packs with no prior-period submissions still appear with `priorCount: 0`.
- `totalRanked` counts `DISTINCT ass.pack_id` over the current period (not assessment cycles).
- Pagination DOS guards: `page ≤ 1000`, `pageSize ≤ 50`.

**Source:** [`modules/15-analytics/src/activity/leaderboard.ts`](../modules/15-analytics/src/activity/leaderboard.ts).

---

## Candidate Activity (module 15 — Phase 10)

All routes require candidate session; user-scoped (`WHERE user_id = $session.userId`) and tenant-scoped via `withTenant` (RLS). Served at `/api/me/activity/*`. Each endpoint owns its full vertical slice under [`modules/15-analytics/src/activity-candidate/`](../modules/15-analytics/src/activity-candidate/).

**Why (Phase 10):** mirrors admin activity endpoints with candidate-safe semantics — own data only, no cross-user comparison, DPDP-safe.

### `GET /api/me/activity/stats`

Query: `?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=domain|level` (all optional; default window = last 30 days).

Response:
```json
{
  "data": {
    "from": "2026-04-14",
    "to": "2026-05-14",
    "groupBy": "domain",
    "completions":      { "total": 3, "breakdown": [{ "key": "soc", "value": 3, "pct": 100 }] },
    "avgScore":         { "total": 72.5, "breakdown": [{ "key": "soc", "value": 72.5, "pct": 100 }] },
    "assessmentsTaken": { "total": 2 }
  }
}
```

- `completions` — submitted attempts in the date window (user-scoped).
- `avgScore` — mean `best_score` across completed packs; breakdown by domain or level.
- `assessmentsTaken` — distinct `pack_id` count (not attempt count).
- Stat card #2 is `assessmentsTaken` (distinct packs, not "active candidates").

**Source:** [`modules/15-analytics/src/activity-candidate/stats.ts`](../modules/15-analytics/src/activity-candidate/stats.ts).

### `GET /api/me/activity/heatmap`

Query: `?from=YYYY-MM-DD&to=YYYY-MM-DD` (defaults to last 365 days).

Response: same shape as admin heatmap but filtered to `user_id = $session.userId`.

```json
{
  "data": {
    "from": "2025-05-14",
    "to": "2026-05-14",
    "days": [{ "date": "2026-05-01", "count": 2 }],
    "currentStreakWeeks": 2,
    "longestStreakWeeks": 5
  }
}
```

**Source:** [`modules/15-analytics/src/activity-candidate/heatmap.ts`](../modules/15-analytics/src/activity-candidate/heatmap.ts).

### `GET /api/me/activity/timeline`

Query: `?from=YYYY-MM-DD&to=YYYY-MM-DD` (defaults to last 52 weeks).

Response: same shape as admin timeline, user-scoped.

```json
{
  "data": {
    "from": "2025-05-12",
    "to": "2026-05-11",
    "weeks": [{ "weekStart": "2026-05-05", "series": [{ "domain": "soc", "count": 2 }] }]
  }
}
```

**Source:** [`modules/15-analytics/src/activity-candidate/timeline.ts`](../modules/15-analytics/src/activity-candidate/timeline.ts).

### `GET /api/me/activity/leaderboard`

Query: `?page=1&pageSize=10` (max pageSize 50).

**Semantics:** candidate's own attempts ranked by best score per pack — not a peer comparison. DPDP-safe (no cross-user data).

Response:
```json
{
  "data": {
    "items": [
      {
        "rank": 1,
        "packId": "uuid",
        "packName": "SOC Analyst L1",
        "attemptCount": 3,
        "bestScore": 88,
        "rankInPack": 1,
        "totalCandidatesInPack": 12
      }
    ],
    "totalItems": 2,
    "page": 1,
    "pageSize": 10
  }
}
```

- `rankInPack` / `totalCandidatesInPack` — candidate's rank among all who completed this pack within the tenant (anonymized count, no names exposed).
- Items sorted by `bestScore DESC`.

**Source:** [`modules/15-analytics/src/activity-candidate/leaderboard.ts`](../modules/15-analytics/src/activity-candidate/leaderboard.ts).

---


> **Status: 501 Not Implemented — Phase 5 Session 2+**
> All endpoints below are registered in `modules/18-certification/src/routes.ts` and return `501 Not Implemented` until the issuance engine and PDF generator ship. The contracts below are the authoritative design; implementations must match them exactly.

### Candidate-facing

---

#### `GET /api/certificates`

List all certificates belonging to the authenticated candidate (newest first).

**Auth:** candidate session required.

**Query params:** `limit` (default 20, max 100), `offset` (default 0).

**Response 200:**
```json
{
  "items": [
    {
      "id": "uuid",
      "credential_id": "AIQ-2026-05-A7F3K9",
      "tier": "distinction",
      "course_title": "SOC Analyst Foundations",
      "level": "L1",
      "display_name": "Jane Smith",
      "issued_at": "2026-05-11T10:00:00Z",
      "revoked_at": null,
      "pdf_downloads": 3,
      "linkedin_shares": 1,
      "verification_views": 12
    }
  ],
  "total": 1
}
```

**Source:** `modules/18-certification/src/routes.ts` — `GET /api/certificates`.

---

#### `GET /api/certificates/:credentialId/pdf`

Download the PDF for a certificate. `credentialId` is matched case-insensitively (normalised to uppercase).

**Auth:** candidate session required; cert must belong to the calling user.

**Response 200:** `application/pdf` stream.
Headers: `Content-Disposition: attachment; filename="<credentialId>.pdf"`, `Cache-Control: no-cache, no-store, must-revalidate`.
Increments `pdf_downloads` counter.

**Response 404:** cert not found or not owned by caller.

**Response 410:** cert is revoked — do NOT serve PDFs for revoked certs.

**Source:** `modules/18-certification/src/routes.ts` — `GET /api/certificates/:credentialId/pdf`.

---

#### `POST /api/certificates/:credentialId/share-linkedin`

Increment the `linkedin_shares` counter. Fire-and-forget from the frontend before opening the LinkedIn share URL.

**Auth:** candidate session required.

**Body:** none.

**Response 204:** no content.

**Source:** `modules/18-certification/src/routes.ts` — `POST /api/certificates/:credentialId/share-linkedin`.

---

### Admin-facing

> All admin endpoints require tenant-context middleware (CLAUDE.md rule #4). Tenant scope is derived from the session — never passed in URL or body.

---

#### `GET /api/admin/certificates`

List all certificates for the calling tenant (paginated, filterable).

**Auth:** admin session + tenant-context middleware.

**Query params:** `candidate_id?` (UUID), `tier?` (completion|distinction|honors), `revoked?` (true|false), `limit` (default 20, max 100), `offset` (default 0).

**Response 200:**
```json
{ "items": [ /* Certificate objects */ ], "total": 42 }
```

**Source:** `modules/18-certification/src/routes.ts` — `GET /api/admin/certificates`.

---

#### `POST /api/admin/certificates/:id/revoke`

Revoke a certificate. Sets `revoked_at` + `revoke_reason`. The verify page continues to render (red badge); PDF download returns 410.

**Auth:** admin session + tenant-context middleware.

**Body:**
```json
{ "revoke_reason": "string (1–1000 chars, required)" }
```

**Response 200:** updated Certificate object.

**Response 404:** cert not found in calling tenant.

**Response 409:** cert already revoked.

**Source:** `modules/18-certification/src/routes.ts` — `POST /api/admin/certificates/:id/revoke`.

---

#### `POST /api/admin/certificates/:id/reissue`

Re-snapshot `display_name` from the current `users` record and recompute `signed_hash`. Does NOT rotate `credential_id` or `issued_at` — doing so would break shared LinkedIn URLs and invalidate previously verified HMAC signatures.

**Auth:** admin session + tenant-context middleware.

**Body:** none.

**Response 200:** updated Certificate object.

**Response 404:** cert not found in calling tenant.

**Source:** `modules/18-certification/src/routes.ts` — `POST /api/admin/certificates/:id/reissue`.
