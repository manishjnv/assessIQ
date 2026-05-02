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

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/admin/attempts/:id/grade`           | Manually trigger AI grading |
| `GET`  | `/admin/attempts/:id`                 | Full attempt detail with answers + gradings |
| `POST` | `/admin/attempts/:id/release`         | Release results to candidate |
| `POST` | `/admin/gradings/:id/override`        | Override AI grade — body: `{ score_earned, reason }` (requires fresh MFA) |
| `GET`  | `/admin/grading-jobs`                 | List grading jobs (status filter) |
| `POST` | `/admin/grading-jobs/:id/retry`       | Re-run failed job |

### Admin — Dashboard & reports

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/dashboard/summary`            | Headline KPIs for current tenant |
| `GET`  | `/admin/dashboard/queue`              | Awaiting-review queue |
| `GET`  | `/admin/reports/cohort/:assessmentId` | Cohort-level results |
| `GET`  | `/admin/reports/topic-heatmap`        | Strong/weak topics across team |
| `GET`  | `/admin/reports/individual/:userId`   | Individual progression |
| `GET`  | `/admin/reports/export.csv`           | CSV export of attempts (with filters) |

### Admin — Webhooks, API keys, embed secrets

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/api-keys`                | List API keys (no plaintext) |
| `POST` | `/admin/api-keys`                | Create — returns plaintext **once** |
| `DELETE`| `/admin/api-keys/:id`           | Revoke |
| `GET`  | `/admin/embed-secrets`           | List embed secrets |
| `POST` | `/admin/embed-secrets`           | Create — returns plaintext **once** |
| `POST` | `/admin/embed-secrets/:id/rotate`| Rotate (90-day grace) |
| `GET`  | `/admin/webhooks`                | List webhook endpoints |
| `POST` | `/admin/webhooks`                | Register endpoint |
| `POST` | `/admin/webhooks/:id/test`       | Send test event |
| `GET`  | `/admin/webhook-deliveries`      | Delivery history (per endpoint) |

### Admin — Audit & help authoring

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/audit`                   | Audit log (filter by actor, action, entity) |
| `GET`  | `/admin/help/export?locale=`     | Export all help rows for translation (admin only) — **live 2026-05-02** |
| `PATCH`| `/admin/help/:key`               | Update help text per locale (creates new version) — **live 2026-05-02** |
| `POST` | `/admin/help/import?locale=`     | Bulk upsert help rows from translation (admin only) — **live 2026-05-02** |

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

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/embed?token=<JWT>`           | Embed-mode landing; mints session and serves SPA |
| `GET`  | `/embed/health`                | Health check for host apps to ping before iframe load |

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
