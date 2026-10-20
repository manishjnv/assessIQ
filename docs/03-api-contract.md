# 03 — API Contract

*Type: reference* — This page lists the REST endpoints, their inputs, outputs and error codes.

This page is the reference for the AssessIQ REST API. It lists each endpoint with its authorisation, request, response and error codes.
Conventions come first. Endpoints follow, grouped by area, then the feature sections for reports, billing, entitlements and scoring.
Dated notes sit in the History line of the endpoint they change.

> Base URL: `https://assessiq.in/api`
> All requests are JSON. All authenticated requests carry either a session cookie (`aiq_sess`) or `Authorization: Bearer aiq_live_<key>`. Tenant context is derived from the session/key — never passed in URL or body.

## Contents
- [Convention](#convention)
- [Request validation (RW-36b, Zod)](#request-validation-rw-36b-zod)
- [Rate-limit response headers](#rate-limit-response-headers)
- [Endpoint catalog](#endpoint-catalog)
  - [Auth](#auth)
  - [Candidate magic-link login (Phase 5, 2026-05-13)](#candidate-magic-link-login-phase-5-2026-05-13)
  - [Magic-link (candidate, mode B)](#magic-link-candidate-mode-b)
  - [Public — Contact form](#public--contact-form)
  - [Admin — Tenants & users](#admin--tenants--users)
  - [Admin — Question bank](#admin--question-bank)
  - [Admin — Rubric generation & generation attempts](#admin--rubric-generation--generation-attempts)
  - [Admin — Assessments & invitations](#admin--assessments--invitations)
  - [Admin — Grading & review](#admin--grading--review)
  - [Admin — Dashboard & reports](#admin--dashboard--reports)
  - [Admin — Webhooks, API keys, embed secrets](#admin--webhooks-api-keys-embed-secrets)
  - [Admin — Audit & help authoring](#admin--audit--help-authoring)
  - [Admin — Worker observability](#admin--worker-observability)
  - [Admin — Super (cross-tenant platform operations)](#admin--super-cross-tenant-platform-operations)
  - [Candidate](#candidate)
  - [Embed](#embed)
  - [Admin — Embed origins & webhook secrets](#admin--embed-origins--webhook-secrets)
  - [Public](#public)
  - [Dev / Test (internal, gated)](#dev--test-internal-gated)
- [Worked examples](#worked-examples)
  - [Worked example — Admin creates an assessment and invites SOC L1 cohort](#worked-example--admin-creates-an-assessment-and-invites-soc-l1-cohort)
  - [Worked example — Candidate takes assessment](#worked-example--candidate-takes-assessment)
  - [Worked example — Webhook payload (host integration)](#worked-example--webhook-payload-host-integration)
  - [Worked example — Embed JWT (host issuing)](#worked-example--embed-jwt-host-issuing)
- [Business events for webhooks (FU-B6, 2026-10-03)](#business-events-for-webhooks-fu-b6-2026-10-03)
- [Admin — Reports & Exports (Phase 3 G3.C, module 15-analytics)](#admin--reports--exports-phase-3-g3c-module-15-analytics)
  - [`GET /api/admin/reports/topic-heatmap`](#get-apiadminreportstopic-heatmap)
  - [`GET /api/admin/reports/archetype-distribution/:assessmentId`](#get-apiadminreportsarchetype-distributionassessmentid)
  - [`GET /api/admin/reports/cost-by-month`](#get-apiadminreportscost-by-month)
  - [`GET /api/admin/assessments/:id/results.csv`](#get-apiadminassessmentsidresultscsv)
  - [`GET /api/admin/attempts/:id/integrity`](#get-apiadminattemptsidintegrity)
  - [`GET /api/admin/reports/exports/attempts.csv`](#get-apiadminreportsexportsattemptscsv)
  - [`GET /api/admin/reports/exports/attempts.jsonl`](#get-apiadminreportsexportsattemptsjsonl)
  - [`GET /api/admin/reports/exports/topic-heatmap.csv`](#get-apiadminreportsexportstopic-heatmapcsv)
  - [`GET /api/admin/reports/cohort/:assessmentId/breakdown` (FU-C4, 2026-10-06)](#get-apiadminreportscohortassessmentidbreakdown-fu-c4-2026-10-06)
  - [`GET /api/admin/cycles/:cycleId/cohort-report`](#get-apiadmincyclescycleidcohort-report)
  - [`POST /api/admin/analytics/refresh`](#post-apiadminanalyticsrefresh)
- [Admin — Activity (Phase 9, module 15-analytics)](#admin--activity-phase-9-module-15-analytics)
  - [`GET /api/admin/activity/stats`](#get-apiadminactivitystats)
  - [`GET /api/admin/activity/heatmap`](#get-apiadminactivityheatmap)
  - [`GET /api/admin/activity/timeline`](#get-apiadminactivitytimeline)
  - [`GET /api/admin/activity/leaderboard`](#get-apiadminactivityleaderboard)
- [Candidate Activity (module 15 — Phase 10)](#candidate-activity-module-15--phase-10)
  - [`GET /api/me/activity/stats`](#get-apimeactivitystats)
  - [`GET /api/me/activity/heatmap`](#get-apimeactivityheatmap)
  - [`GET /api/me/activity/timeline`](#get-apimeactivitytimeline)
  - [`GET /api/me/activity/leaderboard`](#get-apimeactivityleaderboard)
- [Certificates (module 18-certification)](#certificates-module-18-certification)
  - [Candidate-facing](#candidate-facing)
  - [Admin-facing](#admin-facing)
- [Admin — Billing (Phase A1, module 19-billing)](#admin--billing-phase-a1-module-19-billing)
  - [`GET /api/billing/usage`](#get-apibillingusage)
- [Admin — Super Billing (Phase A2, module 19-billing)](#admin--super-billing-phase-a2-module-19-billing)
  - [`GET /api/admin/super/tenants/:tenantId/billing`](#get-apiadminsupertenantstenantidbilling)
  - [`GET /api/admin/super/tenants/:tenantId/billing/export.csv`](#get-apiadminsupertenantstenantidbillingexportcsv)
  - [`PATCH /api/admin/super/tenants/:tenantId/plan`](#patch-apiadminsupertenantstenantidplan)
- [Entitlements and publish-time enforcement](#entitlements-and-publish-time-enforcement)
  - [Phase B1 — generation endpoints re-gated to super_admin](#phase-b1--generation-endpoints-re-gated-to-super_admin)
  - [Phase B1 (cont.) — question-bank authoring re-gated to super_admin](#phase-b1-cont--question-bank-authoring-re-gated-to-super_admin)
  - [Phase B1 — tenant entitlement endpoints](#phase-b1--tenant-entitlement-endpoints)
  - [Phase B2 — publish-time enforcement](#phase-b2--publish-time-enforcement)
- [Scoring and result release (2026-10-01)](#scoring-and-result-release-2026-10-01)
  - [Candidate (`/api/me/*`, candidate session)](#candidate-apime-candidate-session)
  - [Company (tenant) admin (`/api/admin/*`, admin session)](#company-tenant-admin-apiadmin-admin-session)
  - [Platform evaluation queue (`/api/admin/super/evaluations*`, `super_admin` only)](#platform-evaluation-queue-apiadminsuperevaluations-super_admin-only)
  - [2026-10-01 (later): invitations, webhooks, evaluation flow, option shuffle](#2026-10-01-later-invitations-webhooks-evaluation-flow-option-shuffle)
- [OpenAPI spec](#openapi-spec)

## Convention

- **Versioning:** path-based, `v1` is implicit at `/api`. Future breaking changes go to `/api/v2`.
- **Errors:** all errors return `{ "error": { "code": "string", "message": "string", "details": {...} } }` with proper HTTP status.
- **Pagination:** `?page=1&pageSize=50` (max 200) for list endpoints; response includes `{ items, page, pageSize, total }`.
- **Idempotency:** state-changing endpoints accept `Idempotency-Key` header; repeated keys within 24h return the cached response.
- **Timestamps:** all returned in ISO 8601 UTC.
- **Multipart (RW-97, S11, 2026-10-16):** `@fastify/multipart` 9.4.0 is registered for the whole API in `apps/api/src/server.ts` (limits: `fileSize` 4 MB, `files` 1, `fields` 10). Only the routes that call `req.file()` read a file. A multipart request to any other JSON-only route now reaches the handler with an undefined body, not a `415`. Routes with a Zod body schema answer `400`. Route `config` keys such as `skipAuth` are declared in `apps/api/src/types.d.ts` (see RCA 2026-10-16).

## Request validation (RW-36b, Zod)

Every mutating route (POST, PUT, PATCH, DELETE) validates its path params, query and body with a Zod schema before any service call. The schemas live in `apps/api/src/routes/_schemas.ts` (shared helpers in `_validate.ts`). `tools/lint-route-validation.ts` warns when a handler reads `req.body` without a parse (`pnpm lint:route-validation`, warn mode).

**400 shape.** A failed parse returns the standard error envelope with HTTP 400:

```json
{ "error": {
    "code": "VALIDATION_FAILED",
    "message": "<first issue message>",
    "details": {
      "code": "<domain code, e.g. INVALID_SCOPE; default INVALID_BODY | INVALID_PARAMS | INVALID_QUERY>",
      "part": "body | params | query",
      "issues": [ { "path": "field.name", "message": "..." } ]
    } } }
```

`details.code` keeps the domain code each route used before RW-36b, so clients that branch on it are unaffected. Value rules that need the database stay in the service layer with their existing codes. These rules are slug uniqueness, tier set, retention range 1-3650, name normalisation and CSV content.

**New limits** (before, these had no bound, or only the service checked them): company `name` max 200 (`POST /api/admin/super/companies`, code `NAME_TOO_LONG`); platform domain `name` max 200; plan `tier` max 32; import `assessment_id` max 64; `slug` max 63; `adminEmail` max 254.

**Non-object body.** A lifecycle body (`reason`, `confirm_last_admin`) that is not a JSON object, for example an array or a string, now returns 400 `INVALID_BODY`. Before, it was read as `{}`.

**Common rules.** Unknown body keys are ignored (not rejected). A missing body counts as `{}`. Every `:tenantId`, `:userId`, `:invitationId`, `:id` path param must be a UUID, except the worker job id (opaque string, 1-200 chars). Lifecycle bodies (`reason`, `confirm_last_admin`) must be a JSON object; `confirm_last_admin` must be a boolean; `reason` rules (non-empty, max 500, no control characters) stay under `INVALID_REASON`.

**Public anti-enumeration endpoints do not return 400.** `POST /api/auth/candidate/request-link` (204), `/api/auth/candidate/verify-link` (200 `ok:false`), `/api/auth/login/email/request` (200 `ok:true`) and `/api/auth/login/email/verify` (200 `ok:false`) parse with a schema. They answer a malformed body with the same neutral response as before. A probe therefore cannot tell a bad shape from a bad value.

| Endpoint | Part | Schema and limits | `details.code` |
| --- | --- | --- | --- |
| `PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode` | body | `mode`: `"omnibus"`, `"sharded"` or `null` (required) | `INVALID_MODE` |
| `PATCH /api/admin/super/tenants/:tenantId` | body | `name`: required string, not blank, max 200 | `MISSING_NAME`, `NAME_TOO_LONG` |
| `POST /api/admin/super/companies` | body | `name` required, max 200; `slug` required, max 63, `[a-z0-9-]+`; `adminEmail` required, max 254, contains `@`; `domain`, `adminName` optional (non-strings ignored) | `MISSING_NAME`, `NAME_TOO_LONG`, `INVALID_SLUG`, `MISSING_ADMIN_EMAIL` |
| `POST /api/admin/super/tenants/:tenantId/{invitations/resend,suspend,resume,archive,unarchive}` | params, body | `tenantId` UUID; lifecycle body (`reason?`, max 500) | `INVALID_PARAMS`, `INVALID_REASON` |
| `GET /api/admin/super/tenants` | query | `include_archived`: string, max 16 chars (`1` or `true` = on) | `INVALID_QUERY` |
| `GET /api/admin/super/tenants/:tenantId/users` | params, query | `tenantId` UUID; `include_disabled`, `include_deleted`: string, max 16 | `INVALID_PARAMS`, `INVALID_QUERY` |
| `POST /api/admin/super/users/:userId/{disable,reenable,restore}`, `DELETE /api/admin/super/users/:userId`, `DELETE /api/admin/super/users/invitations/:invitationId` | params, body | id UUID; lifecycle body with optional boolean `confirm_last_admin` | `INVALID_PARAMS`, `INVALID_BODY`, `INVALID_REASON` |
| `PATCH /api/admin/super/users/:userId` | params, body | `name?` not blank, max 200; `role?` must be `"admin"`; `email?` string, max 254 (format checked after trim and lowercase); `confirmEmailIdentityChange?` boolean; `reason?` | `MISSING_NAME`, `NAME_TOO_LONG`, `INVALID_ROLE`, `INVALID_EMAIL` |
| `POST /api/admin/super/domains` | body | `name` required, not blank, max 200; `description` optional (non-string ignored) | `MISSING_REQUIRED` |
| `PATCH /api/admin/super/domains/:id` | params, body | `id` UUID; `status`: `"active"` or `"archived"` | `INVALID_STATUS` |
| `PATCH /api/admin/super/tenants/:tenantId/plan` | params, body | `tier?` string, max 32; `includedCredits?` number or `null` | `INVALID_TIER`, `INVALID_CREDITS` |
| `POST` / `DELETE /api/admin/super/tenants/:tenantId/entitlements` | params, body | `scopeType`, `scopeId`: required strings, not blank, max 200 | `INVALID_SCOPE` |
| `PATCH /api/admin/tenant` | body | `name`: required string, max 500 raw (2-120 after normalisation, service) | `MISSING_NAME`, `INVALID_NAME_LENGTH` |
| `PATCH /api/admin/tenant-settings/result-release-mode` | body | `mode`: `"manual"` or `"auto"` | `INVALID_RESULT_RELEASE_MODE` |
| `PATCH /api/admin/tenant-settings/retention-days` | body | `retention_days`: required number (range 1-3650 in service) | `MISSING_RETENTION_DAYS` |
| `POST /api/admin/retention/run-now` | query | `dryRun`, `maxPerTenant`: strings, max 10 (positive integer rule stays `INVALID_MAX_PER_TENANT`) | `INVALID_QUERY` |
| `GET /api/admin/erased-candidates` | query | `since` max 64, `adminId` max 64, `limit` max 10 chars (1..500 in handler) | `INVALID_QUERY` |
| `GET /api/admin/users` | query | `page`, `pageSize` max 10 chars; `role`, `status` max 32; `search` max 200; `includeDeleted` max 10 | `INVALID_QUERY` |
| `POST /api/admin/users` | body | `email` string max 254; `name` string max 200; `role` `"admin"` or `"candidate"`; `metadata?` object | `INVALID_EMAIL`, `NAME_TOO_LONG`, `INVALID_ROLE`, `INVALID_BODY` |
| `PATCH /api/admin/users/:id` | params, body | `id` UUID; `name?` max 200; `role?`; `status?` `"active"`, `"disabled"` or `"pending"`; `metadata?` object | `INVALID_PARAMS`, `NAME_TOO_LONG`, `INVALID_ROLE`, `INVALID_STATUS`, `INVALID_BODY` |
| `POST /api/admin/users/import` | body | `csv` required string; `assessment_id?` non-empty string, max 64 | `INVALID_PARAM` |
| `POST /api/admin/users/:userId/{disable,reenable,restore,erase}`, `DELETE /api/admin/users/:userId`, `DELETE /api/admin/users/invitations/:invitationId` | params, body | id UUID; lifecycle body (`reason?`, max 500) | `INVALID_PARAMS`, `INVALID_REASON` |
| `GET /api/admin/users/:id`, `GET /api/admin/users/:userId/data-export` | params | id UUID | `INVALID_PARAMS` |
| `POST /api/admin/worker/failed/:id/retry` | params | `id`: string, 1-200 chars (BullMQ job id) | `INVALID_PARAMS` |
| `POST /api/admin/embed-secrets/:id/rotate`, `DELETE /api/admin/embed-secrets/:id` | params | `id` UUID | `INVALID_PARAMS` |
| `POST /api/auth/login/select` | body | `userId`: required string, 1-64 chars | `MISSING_USER_ID` |
| `POST /embed/sdk-mint` (dev only) | body | `assessmentId`: required string, 1-64 chars | `MISSING_PARAM` |

**Existing Fastify JSON schemas are kept, not replaced.** These routes already validate with Fastify (AJV): `POST /api/auth/totp/enroll/confirm|verify|recovery`, `POST /api/admin/invitations`, `POST /api/invitations/accept`, `POST /api/contact`, `POST /api/_log`, `POST /api/admin/embed-secrets`, `POST|DELETE /api/admin/embed-origins` and `POST /api/admin/api-keys`. `DELETE /api/admin/api-keys/:id` keeps its manual `INVALID_ID` ("id must be a uuid") check; no Zod was added to `api-keys.ts`. The global handler maps those failures to `VALIDATION_FAILED` too. Routes with no input (`POST /api/auth/logout`, `POST /api/auth/totp/enroll/start`, `POST /api/admin/webhook-secrets/rotate`) have no schema.

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
| `POST` | `/auth/totp/recovery-codes/regenerate` | Replace all recovery codes after a current TOTP code (RW-45; see below) |
| `POST` | `/auth/logout`         | Destroys session |
| `GET`  | `/auth/whoami`         | Returns `{ user, tenant, roles, mfa_status }` |

#### `POST /api/auth/totp/recovery-codes/regenerate` (RW-45, S10, 2026-10-15)

An admin replaces all recovery codes after proving a current TOTP code. Source: `apps/api/src/routes/auth/totp.ts`.

**Auth:** `authChain` with roles `admin` and `super_admin`, `credentialEndpoint: true` (credential rate-limit tier). The session must be TOTP-verified.

**Body:** `{ "code": "123456" }`. The code is 6 digits. The route reuses the existing `codeBodySchema` (Fastify JSON schema, like the other TOTP routes).

**Response 200:** `{ "codes": ["...", "... (10 items)"] }`. The server shows the codes once. It stores only hashes.

**Errors:**
- `400` bad body, or the user has no TOTP enrolment.
- `401` `INVALID_CODE`, or the session is not TOTP-verified.
- `403` role is not `admin` or `super_admin`.
- `423` `ACCOUNT_LOCKED`. The existing 5-failure TOTP lockout applies.

**Behaviour.** A wrong code changes nothing, so the old recovery codes stay valid. A correct code deletes the old codes and inserts 10 new ones in one transaction. The same transaction writes one `auth.recovery.regenerated` audit row (`after: { issued: 10 }`).

**Not included:** a recovery-code fallback instead of a TOTP code (a stolen recovery code could then mint more codes).

#### Auth note: session-status cache

**History:** added in the 2026-10-02 batch 3 notes.

Every authenticated request now consults a 30 s positive-only Redis cache for the user/tenant active check. Suspend, disable, delete, erase take effect at once on the normal path; worst case 30 s. Details in 04 "Session-status cache". Responses are unchanged.

### Candidate magic-link login (Phase 5, 2026-05-13)

> **Status: LIVE 2026-05-13.** Routes in `apps/api/src/routes/auth/candidate.ts`. Implementation in `modules/01-auth/src/candidate-login.ts`. Migration `0076_candidate_login_tokens.sql` applied to production. See `docs/04-auth-flows.md` § Flow 6 for the full sequence diagram.

These two endpoints implement passwordless email sign-in for candidates who want to view their certificates at `/candidate/certificates`. They differ from the assessment-taking magic link (`/take/:token`). That link is invitation-scoped and single-use-per-attempt. These routes are identity-scoped and produce a 30-day reusable session.


#### `POST /api/auth/candidate/request-link`

The endpoint accepts the email address of a candidate and a tenant slug. It resolves the slug to a `tenant_id` (system role, slug→id only). If a matching `users` row exists in that tenant under RLS, it does three things. It generates a CSPRNG token. It stores the sha256 hash of the token in `candidate_login_tokens`. It sends a sign-in email with the plaintext token as a query parameter on the verify-link URL.

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

**Rate-limit key:** `aiq:rl:cand-login:<ip>:<sha256(lower(email))>` — 5 requests per (IP, email) per 60-minute fixed-window Redis counter. The code hashes the email with SHA-256 before it uses the email as the key suffix, so Redis never holds the raw email. On exceed the endpoint still returns 204 (anti-enumeration — no 429 here).

**Constant-time floor:** Both match and no-match paths are bounded to ≥ 200 ms via `Promise.all([work, sleep(200)])` in `requestCandidateLoginLinkSystem`. This prevents timing-based enumeration of registered emails even across the slug-miss fast path.


#### `POST /api/auth/candidate/verify-link`

The endpoint validates the token from the sign-in email and consumes it atomically. It then mints a 30-day candidate session and sets the cookie. It returns a JSON instruction that the SPA uses to navigate.

**Why POST, not GET.** Email-preview crawlers (Gmail, Outlook, Slack, Teams) prefetch link URLs with GET to render previews / scan for malware. A GET endpoint would consume the single-use token on prefetch, locking out the real candidate. The email link therefore targets a SPA route at `/candidate/login/verify?token=…` (idempotent on GET, because it returns HTML). The SPA reads `?token=` from the URL and POSTs it here. Crawlers do not execute JS or POST, so the token survives prefetch.

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

### Magic-link (candidate, mode B)

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/take/:token`         | Renders landing; marks invitation viewed |
| `POST` | `/take/start`          | Two modes (R4, 2026-10-01): `{ token, preview: true }` returns the landing summary (now with `assessment.pass_mark_pct`, Z-16) and creates NOTHING; `{ token, consent: true }` (the Begin click) mints the session, records consent, creates the `attempt` and starts the clock |

#### `POST /take/start` modes (R4)

The attempt timer (`attempts.started_at` / `ends_at`) starts when the candidate clicks **Begin assessment** after the pre-test screen, never when the link is opened.

- **Preview** - body `{ "token": "...", "preview": true }`. Read-only: no attempt row, no session cookie, no timer. Marks the invitation `viewed` only.
  `200 { attempt_id: string | null, resumed: boolean, candidate: { name }, assessment: { id, name, duration_seconds, question_count, company_name } }`. `attempt_id` is non-null only when the candidate already began (resume).
- **Begin** - body `{ "token": "...", "consent": true }`. First call: appends a `consent_events` row (`purpose='data_processing'`, `lawful_basis='consent'`, policy version, ip, UA), then creates the attempt (`started_at = now`, `ends_at = started_at + level duration`) and sets the `aiq_sess` cookie. `201` with the same shape as preview plus `attempt_id`.
  Without `consent: true` and with no existing attempt: `422 CONSENT_REQUIRED` (no attempt, no cookie).
  Resume (attempt already exists): `consent` not required, `201` returns the SAME attempt with its ORIGINAL `ends_at`; calling Begin twice never resets the clock.
- Errors unchanged: generic `404 INVITATION_NOT_FOUND`; `410 ALREADY_SUBMITTED`. A non-`active` assessment with no existing attempt also returns the generic 404 (in preview too).
- **Test type (Z-89).** The preview and Begin responses add `assessment.delivery_mode` (`"real"` or `"mock"`). The admin sets it on the invitation. The attempt copies it from the invitation on the server. The request body is never read for it.
- **Desktop-only gate (Z-87).** Optional body field `device`: `{ coarsePointerOnly: boolean, maxTouchPoints: number, screenWidth: number }` (a malformed value is ignored). For a REAL invitation, Begin from a phone or tablet returns `403 DEVICE_NOT_ALLOWED` with the message "Please open this link on a laptop or desktop computer to take this test". The server checks `Sec-CH-UA-Mobile: ?1`, the user agent and `device`. The check runs before the session cookie and before any attempt. The invitation stays valid and unused. Preview is not blocked, so the page can show the message. A mock invitation is never blocked.
- **Readiness gate (Z-91).** Optional body field `readiness`: `{ browser: { name, version }, screenWidth, screenHeight, downlinkMbps: number | null, rttMs: number | null }`. A NEW attempt on a REAL invitation needs it. The server evaluates it. If it is missing or fails, the answer is `422 READINESS_FAILED` with `error.failed: [{ check: "screen" | "browser" | "network", message }]` (missing: message "Run the readiness check first", `failed: []`). On success the attempt stores `{ passed, at, signals, failed }` in `attempts.readiness`. A mock is never refused; a sent value is stored. A resume needs no check. The camera is not checked (Wave 2).
- Order of checks at Begin: device (403), consent (422 `CONSENT_REQUIRED`), readiness (422 `READINESS_FAILED`), session and attempt.
- Backward compatibility: the response gained fields only (`resumed`, `candidate`, `assessment.question_count`, `assessment.company_name`). The only caller is the SPA landing.

### Public — Contact form

> **Status: LIVE 2026-05-24.** Routes in `apps/api/src/routes/contact.ts`. Email sent via `modules/13-notifications/src/email/contact.ts` using the platform SMTP transport (Brevo). No tenant context; no session required.

#### `POST /api/contact`

Accepts a contact enquiry from the public marketing site and delivers it to `connect@assessiq.in` via the platform SMTP transport (Brevo).

**Auth:** none — public and unauthenticated (`config: { skipAuth: true }`).

**Rate-limit:** per-IP credential bucket (same tier as `/auth/login`, `/auth/totp/verify`) via `authChain({ requireSession: false, credentialEndpoint: true })`. This is intentional — the endpoint hits an external SMTP relay on each submission; the tighter cap prevents relay abuse.

**Body:**

```json
{
  "name":             "string (1–100 chars, required)",
  "email":            "string (3–320 chars, required)",
  "message":          "string (1–5000 chars, required)",
  "company_website":  "string (0–200 chars, optional — honeypot)",
  "cf_turnstile_response": "string (Cloudflare Turnstile token; verified server-side, fail-closed)"
}
```

`additionalProperties: false` — any extra fields return 400.

**Honeypot (`company_website`):** included in the JSON schema so Fastify accepts it without a 400. When non-empty the handler returns `200 { ok: true }` immediately without sending (silent bot drop — avoids revealing the mechanism to scrapers).

**Handler logic:**

1. Honeypot check — silent drop if `company_website` is non-empty.
2. Whitespace trim + empty guard → `400 CONTACT_EMPTY`.
3. Basic email shape regex → `400 CONTACT_BAD_EMAIL`.
4. **Cloudflare Turnstile** — server-side verify the `cf_turnstile_response` token via Cloudflare `siteverify` (using `TURNSTILE_SECRET`). **Fail-closed:** missing/invalid token, or a `siteverify` network/parse error → `403 TURNSTILE_FAILED`. If `TURNSTILE_SECRET` is unset: rejected in production (fail-closed), skipped in non-prod (dev) with a WARN.
5. Global submission budget — in-memory per-process cap (20/hour across all IPs) protecting the shared Brevo quota from a distributed flood → `429 RATE_LIMITED` when exceeded.
6. `sendContactEnquiry({ name, email, message })` — strips CR/LF from `name` before subject header, HTML-escapes all fields in the HTML body. Recipient hardcoded `connect@assessiq.in`; `replyTo` = submitter so the team can reply directly.
7. SMTP null-fallback: if `SMTP_URL` is unset, the enquiry is dropped to `webhook.log` with WARN (no throw) — handler still returns `200 { ok: true }`.

**Responses:**

| Status | Body | Condition |
|---|---|---|
| `200` | `{ "ok": true }` | Sent successfully (or honeypot triggered, or SMTP unset) |
| `400` | `{ "error": { "code": "CONTACT_EMPTY" \| "CONTACT_BAD_EMAIL", "message": "..." } }` | Validation failure |
| `400` | `{ "error": { "code": "VALIDATION_FAILED", "message": "...", "details": { "validation": [...] } } }` | Fastify schema validation failure (for example, field over maxLength) |
| `403` | `{ "error": { "code": "TURNSTILE_FAILED", "message": "..." } }` | Turnstile token missing/invalid (fail-closed) |
| `429` | rate-limit headers | Per-IP credential bucket exceeded |
| `429` | `{ "error": { "code": "RATE_LIMITED", "message": "..." } }` | Global 20/hour submission budget exceeded |
| `502` | `{ "error": { "code": "SEND_FAILED", "message": "Could not send your message. Please email connect@assessiq.in directly." } }` | SMTP transport threw (Brevo down, auth error, etc.) |

**Email delivery:** `from: config.EMAIL_FROM`, `to: connect@assessiq.in`, `replyTo: <submitter email>`. Plain-text + HTML multipart. `name` has CR/LF stripped before use in the `Subject` header (email-header-injection defense). All user-supplied fields are HTML-escaped in the HTML body.

### Admin — Tenants & users

> **Status (2026-05-01, Phase 0 closure — auth route layer + first API deploy live):** The `assessiq-api` container is live behind the Caddy split-route at `https://assessiq.automateedge.cloud/api/*` + `/embed*`. The Fastify route layer wrapping `@assessiq/auth` shipped in commits `58eba33` (route layer + Dockerfile) + `335d055` (dev-auth shim swap). All `Auth` table endpoints below are LIVE in code; the `Admin api-keys`, `Admin embed-secrets`, and `/embed` endpoints are LIVE in code. Live drill verification: `/embed` HS256 + replay defense PASSED (Drill C alg=none → 401, Drill D replay → 200 then 401 with Redis cache populated); The `/api/auth/google/start` route + tenant resolution PASSED. Drill B (curl 302) is DEFERRED until someone adds `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` to `/srv/assessiq/.env`. The route currently returns 401 `"Google SSO is not configured"` cleanly. The `/admin/users/*` slice and `/admin/invitations` POST also live; `acceptInvitation` mints real sessions via `@assessiq/auth.sessions.create`. The `import` route remains a 501 stub returning `details.code = 'BULK_IMPORT_PHASE_1'`. `/admin/tenant` is 02-tenancy Phase 1 work. `GET /api/admin/embed-secrets` intentionally NOT shipped (library lacks `listEmbedSecrets`; Phase 1 follow-up). `assessiq-frontend` Dockerfile + Drill 1 (browser full-stack) deferred to Phase 1+.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET`  | `/admin/tenant`        | Current tenant settings + branding | Phase 1 |
| `PATCH`| `/admin/tenant`        | Update tenant name, branding, settings | Phase 1 |
| `GET`  | `/admin/users`         | List users (filter by role, status, search; pageSize cap 100 — stricter than the global 200 cap per `03-users` SKILL § 9). Each item carries `totp_enrolled: boolean` since RW-91 (S10, 2026-10-16); true when the user has a TOTP secret | live |
| `POST` | `/admin/users`         | Create user record (no email sent). **Status is role-derived:** `role:'candidate'` → `active` immediately (candidates have no invite/login flow — they authenticate only via per-assessment magic links); `admin` → `pending` (must accept an emailed invite, see `inviteUser`). `role:'reviewer'` is rejected with 400 `INVALID_ROLE` (role removed 2026-10-03). No `status` field is accepted, so an active admin cannot be minted here. Optional candidate `designation` rides in `metadata.designation` (free-text, no schema column). | live |
| `GET`  | `/admin/users/:id`     | Get user detail | live |
| `PATCH`| `/admin/users/:id`     | Update role, status, name, metadata; enforces last-admin invariant (HTTP 409 `LAST_ADMIN`) and status-state-machine (HTTP 422 `INVALID_STATUS_TRANSITION`); sweeps Redis sessions on disable | live |
| `DELETE` | `/admin/users/:id`   | Soft delete; cascades to pending invitations for the user's email; sweeps Redis sessions; enforces last-admin invariant | live |
| `POST` | `/admin/users/:id/restore` | Restore a soft-deleted user (clears `deleted_at`); does NOT recreate invitations or sessions | live |
| `POST` | `/admin/users/import`  | **Bulk candidate CSV import (live 2026-10-01).** Admin only; authChain rate limit. JSON body `{ csv: string, assessment_id?: string }`. CSV: UTF-8 (BOM stripped), header row required with `name`,`email` (case-insensitive; extra columns ignored), max 1000 data rows, max 512 KB; values trimmed, emails lowercased + shape-validated, in-file duplicates deduped (first wins), blank lines ignored. Each valid row creates a `candidate` (status `active`) in the admin's tenant; an email already in this tenant as a candidate is reused (`existing`); a non-candidate email is skipped (`EXISTING_USER_NOT_CANDIDATE`). One bad row never aborts the rest. With `assessment_id` (must be `published`/`active`, checked BEFORE any user is created → 409 `INVALID_STATE_TRANSITION`, 404 cross-tenant), all created+existing candidates go through the existing `inviteUsers` (same skip reasons for example, `INVITATION_EXISTS`, `USER_INACTIVE`; same queued emails). Response 200: `{ created, existing, invited, skipped: [{ row, email, reason }], warning? }` — `row` is the spreadsheet row (header = 1); skip reasons: `INVALID_EMAIL`, `MISSING_NAME`, `NAME_TOO_LONG`, `DUPLICATE_IN_FILE`, `EXISTING_USER_NOT_CANDIDATE`, `INSERT_FAILED`, plus invite reasons. `warning` ("Email plan sends ~300/day shared; some invites may be delayed") is present when `invited` > 150. Errors (400 `ValidationError`): `INVALID_PARAM` (csv not a string / bad assessment_id), `CSV_MISSING_COLUMNS`, `CSV_TOO_MANY_ROWS`, `CSV_TOO_LARGE`, `CSV_MALFORMED` (unterminated quote). Audit: exactly ONE `audit_log` row per request (`user.created`, `after = { kind:'bulk_import', rows_total, created, existing, skipped }` — counts only, no names/emails) written in the same tx as the user inserts; invites additionally write their normal per-invitation `assessment.invite` rows. Replaces the former 501 stub (no longer returns `BULK_IMPORT_PHASE_1`). | live |
| `POST` | `/admin/invitations`   | Issue admin invitation (role enum `admin \| candidate`; `reviewer` → 400 `INVALID_ROLE` since 2026-10-03; candidate role → 501 `CANDIDATE_INVITATION_PHASE_1`); response carries the invitation row ID + email + role + expires_at but **never** the plaintext token (per `03-users` SKILL § 2) | live |
| `POST` | `/invitations/accept`  | **Pre-auth** (no session required). Body: `{token: string}` (43–64 char base64url). Validates → marks invitation accepted (atomic single-use) → flips user `pending → active` → mints a session via `01-auth` (currently mocked — see `03-users` SKILL § 12). Sets `aiq_sess` cookie (httpOnly, sameSite=lax, secure in prod). Response body is `{user, expiresAt}` — sessionToken is cookie-only (no body bearer leak) | live |
| `GET`  | `/admin/invitations`   | List invitations | Phase 1 |
| `POST` | `/admin/users/:id/totp/reset` | Force TOTP re-enrollment. **Live (RW-91, S10, 2026-10-16):** see "`POST /api/admin/users/:userId/totp/reset`" in the catalog below | live |

#### Error contracts (live endpoints)

| `details.code` | HTTP | Where |
|---|---|---|
| `LAST_ADMIN` | 409 | `PATCH /admin/users/:id` (demote/disable last admin); `DELETE /admin/users/:id` (delete last admin) |
| `INVALID_STATUS_TRANSITION` | 422 | `PATCH /admin/users/:id` (for example, disabled→pending, active→pending) |
| `USER_EMAIL_EXISTS` | 409 | `POST /admin/users` (collision on `(tenant_id, lower(email))`) |
| `USER_DISABLED` / `USER_DELETED` | 409 | `POST /admin/invitations` (re-invite hits disabled or soft-deleted user) |
| `INVITATION_NOT_FOUND` | 404 | `POST /invitations/accept` |
| `INVITATION_EXPIRED` | 409 | `POST /invitations/accept` (expires_at < now AND not yet accepted) |
| `INVITATION_ALREADY_USED` | 409 | `POST /invitations/accept` (atomic mark-accepted returned zero rows) |
| `CANDIDATE_INVITATION_PHASE_1` | 501 | `POST /admin/invitations` with `role: 'candidate'` |
| `ASSESSMENT_INVITATION_PHASE_1` | 501 | `POST /admin/invitations` with non-empty `assessmentIds` |
| `VALIDATION_FAILED` | 400 | Schema validation (Fastify `validation` array surfaced under `details.validation`) |

`AUTHN_FAILED` (401) and `AUTHZ_FAILED` (403) come from the dev-auth shim today (`x-aiq-test-tenant` / `x-aiq-test-user-id` / `x-aiq-test-user-role` headers; production hard-fails until 01-auth Window 4 lands).

#### `POST /api/admin/users/:userId/totp/reset` (RW-91, S10, 2026-10-16)

A tenant admin clears the two-factor setup of another user in the same organisation. Source: `apps/api/src/routes/admin-users-totp-reset.ts`. The super-admin variant is the next section.

**Auth:** `authChain` with role `admin` and `freshMfaWithinMinutes: 15`. The handler also checks the fresh TOTP itself (see Behaviour).

**Body:** `{ "reason": "text" }`. The reason is required, 1 to 500 characters.

**Response 204:** no body.

**Errors:**
- `400` bad params or body.
- `401` `FRESH_TOTP_REQUIRED`. The session has no TOTP check in the last 15 minutes.
- `403` caller is not an admin, or the target is a `super_admin` (`SUPER_ADMIN_TARGET`).
- `404` the user is in another tenant or does not exist.
- `409` `SELF_RESET_FORBIDDEN`. An admin cannot reset their own two-factor here.

**Behaviour.** The handler checks the fresh TOTP for every configuration, also when `MFA_REQUIRED=false`. The generic middleware check depends on `MFA_REQUIRED` for non-super roles, so the route does not rely on it. `adminResetTotp` clears the secret, deletes the recovery codes and the sessions of the target. After the reset returns, the route sends the notice email `totp_reset_notice` (see [13-email-system.md](13-email-system.md)). A send failure is logged and never fails the reset.

**Not included:** a recovery-code fallback, and a link or the actor name in the notice. Flow: [04-auth-flows.md](04-auth-flows.md) § "Self-service MFA".

#### Tenant-admin user lifecycle endpoints (Phase C)

These five endpoints are gated by `adminOnly` (tenant `admin` role, `totpVerified`). RLS enforces tenant scoping — a `userId` that belongs to a different tenant is invisible and returns `404`. The LAST_ADMIN invariant is enforced unconditionally (no override path).

##### `POST /api/admin/users/:userId/disable`

Disables a user account. Sweeps all active Redis sessions for the target user after the DB commit.

**Auth:** `admin` role + `totpVerified`.

**Body:** `{ reason?: string }`

**Response 200:** `{ userId, status: "disabled", previousStatus: "active" }`

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `CANNOT_DISABLE_SELF` | 400 | Caller is attempting to disable their own account |
| `LAST_ADMIN` | 409 | Target is the last active admin in the tenant |
| `INVALID_REASON` | 400 | reason is wrong type, too long, or contains control chars |

**Audit action emitted:** `user.disabled`.

**Source:** `apps/api/src/routes/admin-users.ts:169`, `modules/03-users/src/service.ts` (`updateUser`).


##### `POST /api/admin/users/:userId/reenable`

Re-enables a previously disabled user account. Sets `status` back to `active`.

**Auth:** `admin` role + `totpVerified`.

**Body:** `{ reason?: string }`

**Response 200:** `{ userId, status: "active", previousStatus: "disabled" }`

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `INVALID_REASON` | 400 | reason is wrong type, too long, or contains control chars |

**Audit action emitted:** `user.reenabled`.

**Source:** `apps/api/src/routes/admin-users.ts:210`.


##### `DELETE /api/admin/users/:userId`

Soft-deletes a user (sets `deleted_at = now()`). Cascades to pending invitations for the user's email (deletes `user_invitations` rows where `lower(email) = lower(target.email) AND accepted_at IS NULL`). Sweeps Redis sessions after commit.

**Auth:** `admin` role + `totpVerified`.

**Body:** `{ reason?: string }`

**Response 200:** `{ userId, deleted: true }`

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `CANNOT_DELETE_SELF` | 400 | Caller is attempting to delete their own account |
| `LAST_ADMIN` | 409 | Target is the last active admin in the tenant |
| `INVALID_REASON` | 400 | reason is wrong type, too long, or contains control chars |

**Audit actions emitted:** `user.deleted` in `audit_log` (through `auditInTx` in the service-layer transaction). Also `user.soft_deleted` in the lifecycle operational JSONL log (through `logLifecycleEvent` in the route handler). The two action names are catalogued as equivalent — see [`modules/14-audit-log/src/types.ts:157`](modules/14-audit-log/src/types.ts#L157).

**Source:** `apps/api/src/routes/admin-users.ts:304`, `modules/03-users/src/service.ts` (`softDelete`).


##### `POST /api/admin/users/:userId/restore`

Restores a soft-deleted user by clearing `deleted_at`. Does NOT recreate invitations or sessions — the user must be re-invited or log in again.

**Auth:** `admin` role + `totpVerified`.

**Body:** `{ reason?: string }`

**Response 200:** `{ userId, status }` — `status` reflects the user's current `users.status` (for example, `"active"` or `"disabled"` — whatever it was before soft-delete).

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `INVALID_REASON` | 400 | reason is wrong type, too long, or contains control chars |

**Audit action emitted:** `user.restored`.

**Source:** `apps/api/src/routes/admin-users.ts:242`, `modules/03-users/src/service.ts` (`restore`).


##### `DELETE /api/admin/users/invitations/:invitationId`

Cancels a pending (unaccepted) invitation. Deletes the `user_invitations` row and, if the associated user record is still `status='pending'`, also deletes that `users` row (`cascadedPendingUser: true` in the response).

**Auth:** `admin` role + `totpVerified`.

**Path params:** `invitationId` — UUID of the invitation.

**Body:** `{ reason?: string }`

**Response 200:**
```json
{ "invitationId": "uuid", "email": "...", "cascadedPendingUser": true, "cancelledUserId": "uuid" }
```

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `INVITATION_NOT_FOUND` | 404 | No invitation row with this id (or cross-tenant — RLS makes it invisible) |
| `INVITATION_ALREADY_ACCEPTED` | 409 | `accepted_at IS NOT NULL` — invitation was already used |
| `INVALID_REASON` | 400 | reason is wrong type, too long, or contains control chars |

**Audit action emitted:** `user.invitation_cancelled`.

**Source:** `apps/api/src/routes/admin-users.ts:265`, `modules/03-users/src/service.ts` (`cancelInvitation`).

#### DPDP data-rights endpoints (Module 20, 2026-05-29)

Admin-mediated data-subject rights for **candidates** (who never log in — they are reached only via single-purpose magic links, so there is no candidate-facing portal). Both endpoints need the `admin` role. Under the DPDP the tenant is the **data fiduciary** for its own candidates. Postgres RLS confines every statement to the tenant of the caller, so a cross-tenant `userId` resolves to `USER_NOT_FOUND`. (This deliberately widens the originally-planned `super_admin`-only erase gate; see `modules/20-data-rights/SKILL.md` D-route note.)

##### `GET /api/admin/users/:userId/data-export`

Right of access / portability. The endpoint returns a JSON bundle of everything the platform holds for the candidate. It builds the bundle synchronously (no S3, no worker), because the narrow candidate PII surface does not need async generation. The admin's browser downloads it as `assessiq-data-export-<userId>.json`; nothing is stored server-side.

**Auth:** `admin` role + `totpVerified`.

**Response 200:** `DataExportBundle`
```json
{
  "manifest": { "schemaVersion": 1, "generatedAt": "ISO", "userId": "uuid" },
  "profile": { "id", "name", "email", "role", "createdAt", "erasedAt": null },
  "attempts": [ { "id", "assessmentId", "status", "startedAt", "submittedAt", "total_earned", "total_max", "auto_pct" } ],
  "answers": [ { "questionId", "type", "answer", "savedAt" } ],
  "certificates": [ { "credentialId", "issuedAt" } ],
  "consents": [ { "purpose", "policyVersion", "grantedAt", "withdrawnAt", "lawfulBasis", "createdAt" } ],
  "auditEvents": [ { "action", "entityType", "at", "before", "after" } ]
}
```
`auditEvents` are the rows where the candidate is the **entity**; PII in `before`/`after` was already redacted at write time (14-audit-log `redact.ts`), so the bundle carries no raw audit PII.

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `USER_NOT_FOUND` | 404 | No user with this id in the caller's tenant (RLS-invisible cross-tenant ids included) |

**Audit action emitted:** `user.data.exported` (best-effort access log, written after the read).

**Source:** `apps/api/src/routes/admin-users.ts` (route), `modules/20-data-rights/src/export.ts` (`exportCandidateData`).

##### `POST /api/admin/users/:userId/erase`

Right to erasure. Tombstones the candidate's PII in a single transaction: `users.name`/`email` → deterministic `sha256(id)`-derived pseudonyms + `erased_at = now()`; `attempt_answers.answer` → `"[erased]"` for every answer **not positively confirmed MCQ**; `sessions.ip`/`user_agent` → NULL. Never DELETEs rows. **Certificates are never mutated** — the issued name snapshot is part of the HMAC payload, so public `/verify/:credentialId` keeps working (D5). Idempotent: re-erasing an already-erased candidate is a no-op returning `alreadyErased: true`.

**Auth:** `admin` role + `totpVerified`.

**Body:** `{ reason: string }` — **required** (non-empty, ≤500 chars, no control chars). Recorded in the audit `after` payload.

**Response 200:** `ErasureReceipt`
```json
{ "userId", "erasedAt", "alreadyErased": false,
  "tombstone": { "name": "deleted_user_…", "email": "deleted+…@erased.assessiq.local" },
  "attemptAnswersErased": 0, "sessionsRedacted": 0, "certificatesPreserved": 0 }
```

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `REASON_REQUIRED` | 400 | body had no `reason` |
| `INVALID_REASON` | 400 | reason wrong type / too long / control chars |
| `ERASE_NOT_CANDIDATE` | 400 | target user's role is not `candidate` (admin/super_admin erasure is out of scope — handled manually) |
| `USER_NOT_FOUND` | 404 | No candidate with this id in the caller's tenant |

**Audit action emitted:** `user.pii.erased` (`auditInTx`, same transaction as the tombstone; `after` carries counts + reason only, never raw name/email).

**Source:** `apps/api/src/routes/admin-users.ts` (route), `modules/20-data-rights/src/erasure.ts` (`eraseCandidatePii`).

> **Reviewer role removed (2026-10-03, RV60).** Invites, user create/update and super-admin edit-admin return 400 `INVALID_ROLE` for `reviewer`. Notifications and the results CSV are admin only. See `docs/04-auth-flows.md` § "Reviewer role removed". The dev minter section still names `reviewer` in its body type, for legacy rows only.

### Admin — Question bank

> **Status: live as of 2026-05-01 (Phase 1 G1.A Session 1).** All 15 routes registered into `apps/api/src/server.ts` via `registerQuestionBankRoutes(app, { adminOnly: authChain({roles:['admin']}) })`. Smoke verified live: `GET /api/admin/packs` returns 401 AUTHN_FAILED without session. JSON import is the Phase 1 format; CSV deferred to Phase 2. The `archive`, `levels/:id` PATCH, and `questions/:id/restore` rows are Phase 1 service-method extensions added in the same PR — same admin-only auth gate.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/packs`                       | List question packs (paginated; filter by `domain`, `status`, `search`). `search` is a case-insensitive **substring** match on pack name OR slug (**fix 2026-05-25** — was silently dropped at both the route and the repository, so the Question Bank search box did nothing). Each item carries `question_count` (all questions), `level_count` (levels defined — **added 2026-05-25**) and `completed_count` (tenant attempts that finished — status ∈ `submitted`/`auto_submitted`/`pending_admin_grading`/`graded`/`released`), all RLS-scoped. **2026-05-21** |
| `POST` | `/admin/packs`                       | Create pack (returns 201). `slug` is **optional** — auto-generated from `name` (NFKD lowercase, hyphens, 64-char cap) when omitted. Collision appends `-2` … `-10` suffix. Explicit slug still validated against `/^[a-z0-9-]{3,80}$/`. **fix 2026-05-04** |
| `GET`  | `/admin/packs/:id`                   | Pack with levels (`{ pack, levels }`) |
| `PATCH`| `/admin/packs/:id`                   | Update pack metadata (name, domain, description) |
| `POST` | `/admin/packs/:id/publish`           | Transition draft → published; snapshots all questions; bumps `pack.version` and each `question.version`. **Auto-activates** every `draft` question (→ `active`) in the same transaction (**2026-05-25** — "published = usable"; reverses the 2026-05-02 decoupling so no separate `activate-questions` click is needed). `ai_draft` (unreviewed AI) and `archived` questions are left untouched. The `pack.published` audit `after` now also carries `activated_questions`. **Auto-sync (2026-05-25):** after the publish tx commits, every tenant clone of this pack (`question_packs WHERE source_pack_id = :id`, non-archived) is re-synced in place via the B3 engine (`resyncSetForTenant(..., actorKind:'system')`). Best-effort & non-throwing (publish already succeeded; the manual `…/resync` endpoint remains as a fallback). A non-platform pack with no clones is a no-op. Admin-in-the-loop (super_admin click) — no cron/webhook. |
| `POST` | `/admin/packs/:id/revise`            | **(2026-05-25, super_admin)** Transition published → draft so the master can be edited, then re-published as a new version ("Revise → publish new version"). Rejected unless `published` (`PACK_NOT_PUBLISHED`). Does **not** bump `pack.version` — the subsequent `…/publish` does, so a revise→publish pair advances the version exactly once. Audit `pack.revised`. Already-published assessments are unaffected (frozen at their own publish, migration 0096); in-flight attempts are pinned via `attempt_questions`. |
| `POST` | `/admin/packs/:id/archive`           | Transition draft **or** published → archived (soft-delete; the only delete path in Phase 1). Rejected if already archived (`PACK_ALREADY_ARCHIVED`) or if any active assessment references the pack (`PACK_HAS_ASSESSMENTS`). **fix 2026-05-24** — draft packs are now archivable; previously archive required `published` (`PACK_NOT_PUBLISHED`), which left empty/junk auto-created drafts uncleanable. |
| `POST` | `/admin/packs/:id/activate-questions` | Bulk-flip every `status='draft'` question in this pack to `active`. Returns `{ activated, alreadyActive, archived }`. Throws `NO_DRAFT_QUESTIONS_TO_ACTIVATE` if no draft rows exist. Pack must be `status='published'`. **Now an edge-case affordance (2026-05-25):** publish auto-activates, so this only matters for drafts ADDED to an already-published pack; the pack-detail UI surfaces the "Activate drafts" button only when a level has draft questions. **live 2026-05-02** |
| `POST` | `/admin/packs/:id/levels`            | Add level (returns 201) |
| `PATCH`| `/admin/levels/:id`                  | Update level fields (label, description, duration, default_question_count, passing_score_pct) |
| `GET`  | `/admin/questions`                   | List questions (filter by `pack_id`, `level_id`, `type`, `status`, `tag`, `search`, and the EXP-5 filters `q`, `stage_id`, `subject_id`, `unit_id`, `outcome_id`, `difficulty_min`, `difficulty_max`, `origin`, `rights_status`, `review_state`, `language`, `has_solution`, `has_passage`; see "Question list filters and facets"). `pack_id` is supported on the server (RW-97 uses it to list the questions of a pack that have no rubric). Each list item carries `difficulty_params` (an object or `null`); its `warnings` array is `[{ code, message }]` and the wizard Review step shows it (RW-96, S11) |
| `POST` | `/admin/questions`                   | Create question (returns 201). Optional `answer_guidance` (string ≤280; candidate-facing hint; omit/blank → per-type default) (0098) **`type` enum (2026-10-03):** `mcq`, `subjective`, `kql`, `scenario`, `log_analysis`, `numeric`, `multi_select`, `ordering`, `structured_case`. `structured_case` content is checked by `StructuredCaseContentSchema` (shape: see 02). |
| `GET`  | `/admin/questions/facets`            | EXP-5. Counts per facet value for the same filters as the list. See "Question list filters and facets" |
| `GET`  | `/admin/questions/:id`               | Get question (latest version). Response includes `answer_guidance` (string or null) (0098) |
| `PATCH`| `/admin/questions/:id`               | Update — `content`/`rubric` create a new version (snapshot-before-update); `topic`/`points`/`answer_guidance` are metadata-only (NO version bump). `answer_guidance: null` clears it to the per-type default (0098) |
| `GET`  | `/admin/questions/:id/versions`      | List version snapshots (most-recent first) |
| `POST` | `/admin/questions/:id/restore`       | Restore from a prior version (body: `{ version: number }`); snapshots current then bumps |
| `POST` | `/admin/questions/import`            | Bulk import from JSON (Phase 1) — CSV deferred to Phase 2 |
| `POST` | `/admin/packs/:id/levels/:levelId/generate` | **AI question generation** — generates SOC-grounded `ai_draft` questions for the given level. Body: `{ count?: number (1–10, default 5), topic_focus?: string }`. Returns `{ questionIds: string[], generated: number, skillSha: string }`. Requires `AI_PIPELINE_MODE=claude-code-vps`. Single-flight: 409 `GRADING_IN_PROGRESS` if generation already in flight for this pack/level. Questions land as `status='ai_draft'` with `knowledge_base_sources` provenance. **live 2026-05-08** — **⚠ Phase B1: re-gated to `super_admin`; tenant admins receive 403.** **`topic_focus` (2026-10-03, RV62):** at most 200 characters after trim, no control characters; otherwise 400 `INVALID_PARAM`. The value reaches the generation skill input as `topic_focus` (it was always null before). Since RW-46/RW-92 (S10, 2026-10-15) the generate wizard has a Topic focus field and the domain routes forward it to the prompt (see the detached generation section). |
| `POST` | `/admin/questions/bulk-update-status` | Bulk-flip a batch of questions to `active` or `archived` (admin grid action). Body: `{ ids: string[] (1–200 UUIDs), status: 'active' \| 'archived' }`. Returns `{ updated: string[], notFound: string[] }`. Service filters source statuses (`active` only accepts `ai_draft`; `archived` accepts `ai_draft` \| `draft` \| `active`); ids in disallowed source states OR cross-tenant ids land in `notFound`. Always writes a single `bulk_status` summary audit row (G3.D). 400 `INVALID_BULK_SIZE` for empty / >200 ids; 400 `VALIDATION_ERROR` for non-UUID id or bad status. **live 2026-05-11** |

#### Framework seeds (RW-57 part 1, S10, 2026-10-15)

A super admin loads curriculum frameworks from JSON files that ship with the api. Both routes use `superAdminOnly`. `routes.ts` passes the real chain. The handler also checks the role, as defence in depth. Board files for CBSE, ICSE and IB shipped in RW-57 part 2 (S10, 2026-10-16). They are bundled in `modules/04-question-bank/src/framework-seeds.ts` with `sample`, so the list route now returns four items.

**UI calls (RW-57 part 2).** The Platform page section "Curriculum frameworks" calls these two routes through `modules/10-admin-dashboard/src/api/frameworks.ts` (`listFrameworkSeedsApi`, `loadFrameworkSeedApi`). It adds no new route. See [08-ui-system.md](08-ui-system.md) § "Platform page: Curriculum frameworks".

`GET /api/admin/super/frameworks/seeds` returns `{ items: [{ code, name, board, version, nodeCount, loadedVersion }] }`. `loadedVersion` is `null` when the seed is not loaded.

`POST /api/admin/super/frameworks/seeds/:code/load` loads one seed. The `code` param matches `^[a-z0-9-]+$`. It returns `{ frameworks, nodesCreated, nodesUpdated, nodesUnchanged }`.

- The load is idempotent. A node is matched by the framework slug plus (parent, node code).
- One `framework.seed_loaded` audit row is written for each load.
- An unknown `code` returns 404.
- An invalid seed returns 400. The message has the schema path. Nothing is written.

#### Question import (RW-58, S10, 2026-10-16)

A super admin imports questions from a CSV or XLSX file. The file is staged and validated first. The admin fixes rows. A commit then creates one draft pack. Source: `modules/04-question-bank/src/import-routes.ts`. Logic: `src/import/{parse,templates,staging,commit}.ts`. Schema: [02-data-model.md](02-data-model.md) § "Question import".

**Auth:** all six routes use `superAdminOnly`. The routes run in the tenant of the session (`req.session.tenantId`), under RLS. The routes call no AI.

| Route | Body or query | Success |
| --- | --- | --- |
| `POST /api/admin/super/question-imports` | Either `multipart/form-data` (RW-97) or the JSON body `{ file_name, format, content_base64, domain, pack_name? }`. `format` is `csv` or `xlsx`. The limit is 4 MB. `pack_name` defaults to the file name without its extension. See "Multipart request" below | 201 report |
| `GET /api/admin/super/question-imports/templates/:type` | `:type` is a question type from the registry. Query `format=csv\|xlsx` (default `csv`) | The file, as an attachment named `question-import-<type>.<format>` |
| `GET /api/admin/super/question-imports/:id` | none | 200 report |
| `PATCH /api/admin/super/question-imports/:id/rows/:row` | `{ values?, skip? }`. One of the two is required. `values` is a map of column to string (each up to 20 000 characters) | 200 report |
| `POST /api/admin/super/question-imports/:id/commit` | none | 200 `{ importId, packId, committed }` |
| `POST /api/admin/super/question-imports/:id/discard` | none | 200 report |

**Organisation upload (EXP-17, 2026-10-19).** Admins of any tenant use the same five routes under `/api/admin/question-imports` (`POST` upload, `GET /templates/:type`, `GET /:id`, `PATCH /:id/rows/:row`, `POST /:id/commit`, `POST /:id/discard`). They use the `adminOnly` guard. Row Level Security limits every call to the caller's tenant, so another tenant gets `404 IMPORT_NOT_FOUND`. S34 adds `GET /api/admin/question-imports` (the tenant's own uploads: id, file_name, format, status, row_count, error_count, rights_status, created_at, committed_pack_id, question_count, withdrawn_count; discarded imports are hidden) and `POST /api/admin/question-imports/:id/withdraw` (withdraws every question the import made in one transaction; `200 { importId, withdrawn }`; idempotent; `404 IMPORT_NOT_FOUND` across tenants; `409 IMPORT_NOT_COMMITTED` for a staged import; one `question.withdrawn` audit row per question, ids only). The upload also takes an optional `source_ref` (max 500 characters) that fills rows with no `source_ref` cell. Upload, template download, list, row edit and commit use the plan gate `question_upload` (Pro tier or higher): `403 TIER_NOT_INCLUDED`, a no-op while `PLAN_TIERS_ENFORCED` is false. Read (`GET /:id`), discard and withdraw stay on the plain admin chain, so a lapsed plan cannot remove the takedown path. List and withdraw also apply the review rule: platform imports only for a `super_admin`, organisation imports only for an `admin` (`403` otherwise). The screen is `/admin/org-question-upload`.
- The upload body adds two required fields: `content_warranty` (must be `true`; the uploader states they hold the rights) and `rights_status` (`original`, `derived_from_source` or `licensed`). In multipart, send both as text fields (`content_warranty=true`). A missing or false warranty, or any other rights value, answers `400 INVALID_PARAM`.
- The uploader's `rights_status` replaces the file cell on every row, and the origin is always `tenant_upload`. A row edit cannot change either value.
- The commit creates a draft pack owned by the caller's tenant. Every question starts `review_state = 'in_review'`, so it stays away from candidates until the organisation verifies it (EXP-18 routes).
- `question_imports` records `upload_rights_status`, `warranty_accepted_by` and `warranty_accepted_at`. The audit row `question_import.staged` also carries `content_warranty: true`.
- Not included: plan quotas (billing has no question or pack count limit).

**Organisation upload, list, withdraw and plan gate (EXP-17 UI, 2026-10-19).**
- `GET /api/admin/question-imports` lists the caller's own uploads (imports that carry an uploader `rights_status`), newest first, at most 100, discarded ones hidden. Reply `{ items: [{ id, file_name, format, status, row_count, error_count, rights_status, created_at, committed_pack_id, question_count, withdrawn_count }] }`. A platform (super-admin) import never appears here.
- `POST /api/admin/question-imports/:id/withdraw` withdraws every question that import made, in one transaction, with the same service step as the single-question withdraw (`withdrawInTx`: archive, `rights_status = 'withdrawn'`, pack version bump, takedown propagation). Reply `{ importId, withdrawn }`, where `withdrawn` counts questions changed by THIS call. A second call answers 200 with `withdrawn: 0` (idempotent). `404 IMPORT_NOT_FOUND` for another tenant or a platform import. `409 IMPORT_NOT_COMMITTED` for a staged or discarded import. The question ids come from `question_source.import_id`, which the commit writes for every question. Audit: one `question.withdrawn` row per question (ids and states only, no free text). There is no import-level audit action, because the action list lives in module 14.
- The upload accepts an optional `source_ref` text field (up to 500 characters). It fills the `source_ref` of every row that has no value of its own.
- **Plan gate.** All eight organisation routes (upload, list, template, report, row edit, commit, discard, withdraw) run `requireTier('question_upload')` after the admin chain. `question_upload` needs tier `pro` (internal always passes). While `PLAN_TIERS_ENFORCED` is false the gate does nothing. When it is true and the tier is Free, the answer is `403` with `details.code = 'TIER_NOT_INCLUDED'`. The page treats that answer from the list call as locked. Wiring: `orgUploadGuard` option of `registerQuestionBankRoutes`, set in `apps/api/src/server.ts`.

**Multipart request (RW-97, S11, 2026-10-16).**
- Send `Content-Type: multipart/form-data`. The text fields are `format` (`csv` or `xlsx`), `domain` and `pack_name` (optional). A `file_name` field is optional. The file part is named `file`.
- **Field order rule.** Put every text field BEFORE the `file` part. The handler reads the stream in order. A field after the file part is not seen.
- The file name defaults to the file part name. The Zod limits are the same as for the JSON body. The report is the same.
- `413` `FILE_TOO_LARGE` when the file is over 4 MB. The server checks both the plugin error and the truncated flag.
- A missing `file` part answers `400` `INVALID_PARAM`.
- The JSON body still works. Callers that already use it need no change.

**Report shape.** The upload, `GET`, `PATCH` and discard routes return it:

```json
{
  "importId": "uuid",
  "status": "staged | committed | discarded",
  "counts": { "total": 0, "ok": 0, "error": 0, "duplicate": 0, "skip": 0 },
  "rows": [
    { "row": 1, "decision": "ok | error | duplicate | skip",
      "errors": [{ "row": 1, "column": "text", "message": "..." }],
      "raw": {}, "normalized": {} }
  ]
}
```

**Behaviour.**
- The file limit is 2 MB (decoded) and 2000 data rows. The header row must have a `type` column.
- The parser reads CSV (RFC 4180) in the file itself. It reads XLSX with `exceljs` 4.4, a pure-JS dependency added in this change.
- The templates come from the question type registry (`importColumns`). The code has no switch for each type.
- Staging validates each row with `coerceContent` and `contentSchema`. It sets `content_hash` to the sha256 of the type plus the canonical content. A row is `duplicate` when its hash matches a non-archived question in the same domain, or an earlier row of the same file.
- The same file (same sha256) uploaded again while a staged import exists returns that staged import, not a second one.
- A commit creates one draft pack with `source = 'import'`. It adds levels named `L<position>` and draft questions for the `ok` rows. Rows with `error`, `duplicate` or `skip` are left out. One audit row is written.
- Audit actions: `question_import.staged`, `question_import.committed`, `question_import.discarded`.

**Errors.**
- `400` `INVALID_PARAM` for a bad body, params or query.
- `400` for a file that cannot be used. Codes: `IMPORT_CSV_MALFORMED`, `IMPORT_XLSX_UNREADABLE`, `IMPORT_XLSX_EMPTY`, `IMPORT_TOO_LARGE`, `IMPORT_TOO_MANY_ROWS`, `IMPORT_MISSING_TYPE_COLUMN`, `IMPORT_DOMAIN_NOT_FOUND`.
- `400` `IMPORT_NO_OK_ROWS` on a commit with no `ok` row.
- `413` `FILE_TOO_LARGE` on a multipart upload over 4 MB.
- `403` caller is not a super admin.
- `404` `IMPORT_NOT_FOUND` or `IMPORT_ROW_NOT_FOUND`. The import is not in the tenant of the session.
- `409` `IMPORT_NOT_STAGED` on a commit, fix or discard of an import that is not `staged`.

**Not included.**
- Rubric drafting on the server. The UI drafts rubrics after a commit with the existing `generate-rubric` and `save-rubric` routes (RW-97). The import routes call no AI.
- Removal of the JSON base64 body. It stays for existing callers.
- Category linking.
- A stored hash column on `questions`. The hash lives on `question_import_rows` only.

**Import v2 (EXP-4, 2026-10-17).** The routes, bodies and limits (4 MB, 2000 rows, super admin only) do not change. The templates, the report and the commit change.
- **New template columns,** after `negative_marks`: `exam_stage`, `subject_path`, `difficulty`, `difficulty_scale`, `rights_status`, `origin`, `source_ref`, `source_url`, `seed_ref`, `language`, `pyq_year`, `pyq_shift`. The type columns follow.
- **`rights_status` is required** for CSV and XLSX rows: `original`, `derived_from_source`, `scraped_raw`, `licensed` or `metadata_only`. `withdrawn` is not importable. **Breaking change:** a v1 file without the column still parses, but every row is a row error (`rights_status`) until the value is added. Fix a row through the `PATCH` route, or re-upload. GIFT, Aiken and QTI cannot carry the column, so their rows are saved as `original`.
- **`origin`** is one of `original_human`, `ai_original`, `ai_seeded`, `derived_from_source`, `scraped_raw`, `licensed` (`tenant_upload` is closed until EXP-17). If empty it follows `rights_status`: `scraped_raw` gives `scraped_raw`, `derived_from_source` gives `derived_from_source`, `licensed` gives `licensed`, the others give `original_human`. `scraped_raw` rights need `scraped_raw` origin.
- **`difficulty` and `difficulty_scale`.** Scales: `words` (easy 2, medium 3, hard 4), `1-3` (1, 3, 5) and `1-5` (identity). With no scale, a number 1 to 5 uses `1-5` and any other label uses `words`. The raw label goes to `question_source.source_difficulty_raw`; the mapped value goes to `questions.difficulty_est`. An unknown label or scale is a row error.
- **`exam_stage`** is the name or code of a stage node of the framework `exam-structure`. **`subject_path`** is `Subject/Unit/Outcome` (one to three parts) in `subject-map`. Names match the node label or code, ignoring case. An unknown name is a row error, never skipped.
- **`language`** is a code such as `en` (default) or `hi`. `pyq_year` is 1950 to 2100. `source_url` must start with `http://` or `https://`.
- **Report additions.** Each row has `dupClass` (`exact`, `normalised`, `similar` or `null`). The report has `duplicateClasses` (`{ exact, normalised, similar }` counts) and `checksRun` (the classes that ran). `exact` and `normalised` rows have `decision = "duplicate"` and are left out of the commit. A `similar` row stays `ok`: it is a warning for the admin. `similar` runs only when `pg_trgm` is installed in the database; otherwise `checksRun` has no `similar`.
- **Commit additions.** Every committed question gets a `question_source` row (origin, rights, references, raw difficulty, `content_hash`, `normalised_text_hash`, `import_id` = the import id, `uploaded_by` = the actor, `pyq_year`, `pyq_shift`), `questions.difficulty_est` and `language_primary`, and `question_taxonomy` links to the stage node and the deepest subject node. `scraped_raw` rows import; the publish gate (`RIGHTS_NOT_CLEARED`) still blocks a pack that holds one.
- **Help ids.** `admin.question_import.columns`, `.rights_status`, `.difficulty`, `.duplicates` (migration `0195`).

**UI calls.** The page `/admin/question-import` calls these routes through `modules/10-admin-dashboard/src/api/question-imports.ts`. See [08-ui-system.md](08-ui-system.md) § "Question import page".

#### `POST /api/admin/super/questions/:id/withdraw` (04): question takedown (EXP-2)

**History:** added 2026-10-17 with migration 0194.

- **What.** Super admin only. Sets `question_source.rights_status = 'withdrawn'` and `questions.status = 'archived'` in one transaction. It bumps the pack `version` and writes one `question.withdrawn` audit row. `:id` must be a UUID.
- **Response.** `200 { id, status: "archived", rights_status: "withdrawn" }`.
- **Errors.** `400 INVALID_PARAM` for a bad id. `403` for a caller who is not a super admin. `404 QUESTION_NOT_FOUND` when the question is not in the tenant of the session.
- **Why.** A rights holder can ask for a takedown. The item must leave circulation now, and leave every clone at the next re-sync. Attempts and assessments frozen before the takedown keep the frozen version.
- **Takedown propagation (EXP-19).** When the question belongs to the platform tenant, the same transaction also archives every tenant clone and sets its `rights_status` to `withdrawn`. It writes one `question.takedown_propagated` audit row for each affected tenant (the row carries the clone tenant id, actor kind `system`). A repeat call changes nothing and writes no rows. The response does not change. A tenant with no clone is untouched. Frozen assessment pools are not changed (EXP-20).
- **Related rules.** A withdrawn question cannot be set back to `active` or `draft` (`PATCH /api/admin/questions/:id` returns `409 QUESTION_WITHDRAWN`). Clone-on-use and re-sync skip withdrawn masters, and re-sync marks existing clones withdrawn.
- **Publish gate.** `POST /api/admin/packs/:id/publish` returns `422 RIGHTS_NOT_CLEARED` (with `details.question_ids`, up to 50) when a non-archived question has no `question_source` row or has `rights_status = 'scraped_raw'`.
- **Question payload.** Every question object now carries `difficulty_est` (1 to 5 or null), `review_state` (or null), `language_primary` and `content_i18n` (or null). The rights fields are not in the payload yet (they are in the QTI export file `provenance.json`).
- **Considered and rejected.** A `DELETE` route (the row must stay for audit and clone sync). A body with a reason (no place to store it yet).
- **Not included.** An undo route, a bulk withdraw, a UI.

#### Question review routes (EXP-18 part 2, 2026-10-18)

**History:** added 2026-10-18. No migration. All three routes use the `adminOnly` chain (rate limit, session, tenant context, role `admin`; a `super_admin` session passes the role hierarchy). The handler and the service both check the role and the owner of the question set.

**Who may act.** Role `admin` or `super_admin` only (`403` otherwise). The question set must belong to the tenant of the session (`404` for another tenant: RLS hides it, and the service checks `question_packs.tenant_id` again). A PLATFORM question set (tenant slug `platform`) only by a `super_admin`. An organisation question set only by an `admin` of that organisation (`403` for a `super_admin` session that is not on the platform tenant).

| Route | Body | Response | Errors |
| --- | --- | --- | --- |
| `GET /api/admin/packs/:id/review?state=&page=&pageSize=` | `state`: `open` (default: in_review, needs_fix, disputed), `all`, `in_review`, `verified`, `disputed`, `needs_fix`, `none`. `pageSize` 1 to 100 (default 25) | `200 { pack: { id, name, status, is_platform }, counts: { in_review, verified, disputed, needs_fix, none }, total, items: [{ id, level_id, type, topic, points, status, review_state, content, rubric, answer_guidance, origin, rights_status, source_ref, source_url }] }`. Archived and withdrawn questions are left out. `content` includes the answer key, so the read has the same authorisation as the actions | `400 INVALID_PARAM` · `403` · `404 PACK_NOT_FOUND` |
| `POST /api/admin/questions/:id/review` | `{ action: "verify" \| "needs_fix" \| "dispute" \| "withdraw", note?: string (max 1000) }`. `note` is required for `needs_fix` and `dispute` (Z-52 gap 7). Any non-empty note is stored in the append-only table `question_review_notes` in the same transaction; the audit row carries `note_id`, never the text. `dispute` on a platform master also sets its tenant clones to `disputed` (audit action text `disputed_propagated`, ids only) | `200 { id, review_state, status, changed }`. `changed` is false for a repeat Verify | `400 INVALID_PARAM` · `400 REVIEW_NOTE_REQUIRED` · `403` · `404 QUESTION_NOT_FOUND` · `409 QUESTION_WITHDRAWN` (verify or needs_fix on a withdrawn question) |
| `POST /api/admin/packs/:id/review/verify-all` | `{ confirm: true, expected_count?: number, expected_ids?: uuid[] }`. At least one of the two is required. `expected_count` is the number the admin saw in the confirm step. `expected_ids` (Z-52) is the exact set the admin saw: when present, the operation affects exactly that set | `200 { verified }` | `400 INVALID_PARAM` (no `confirm: true`, neither field, bad uuid) · `403` · `404 PACK_NOT_FOUND` · `409 REVIEW_COUNT_CHANGED` (`details.expected`, `details.actual`; with `expected_ids` also `details.new_count`, `details.gone_count`; nothing is written) · `409 DEADLOCK_RETRY` (`details.retry: true`; the request rolled back, repeat it) |

- **What.** Verify sets `verified`. Needs fix sets `needs_fix`. Withdraw runs the same steps as `POST /api/admin/super/questions/:id/withdraw` (archive, `rights_status = 'withdrawn'`, pack version bump, takedown propagation for a platform question), but an organisation admin can use it on the organisation's own questions. Bulk verify changes only `in_review` questions of the set.
- **Audit.** Each state change writes `question.review_changed` (actor, time, `before.review_state`, `after.review_state`, `after.note`, `after.bulk`). Withdraw writes `question.withdrawn` with `before.review_state`. Bulk verify writes one row for each question.
- **Why a separate route and not `PATCH /api/admin/questions/:id`.** The patch route has no check for who may set a review state, and a state change must not bump the question version.
- **Considered and rejected.** A route for each action (one route with an `action` field keeps the audit and checks in one place). A `confirm` token from the server (the count check gives the same protection without state). Bulk verify of `needs_fix` or `disputed` questions (each needs its own look).
- **Z-52 (2026-10-19).** (1) Needs fix on a PLATFORM question also sets every live tenant clone (`source_question_id`) to `needs_fix` in the same transaction, with one `actor_kind = system` audit row per tenant (`after.action = needs_fix_propagated`). It is not reversed when the master is verified again: the tenant admin reviews the clone. (2) `POST /api/admin/questions/:id/restore` (restore version) sets a `verified` question back to `in_review` (audit `after.action = content_restored`), the same rule as a content edit. (3) A Postgres deadlock (`40P01`) on a review write, on the publish pool lock or on the invite lock returns `409 DEADLOCK_RETRY`; rows are locked in id order everywhere, so this is a backstop. (4) `expected_ids`, see the verify-all row. `expected_count` alone works as before.
- **Not included.** Candidate or organisation disputes, an undo route, automatic rescoring (proposal: `docs/design/2026-10-19-answer-key-rescore-proposal.md`).

### Review queue, review notes and affected attempts (S34, Z-52 gaps 6 and 7, EXP-12)

| Route | Request | Response | Errors |
| --- | --- | --- | --- |
| `GET /api/admin/review-queue?state=&page=&pageSize=` | `state`: `open` (default), `all`, `in_review`, `verified`, `disputed`, `needs_fix`, `none`. `pageSize` 1 to 100 (default 25). Scope is the caller's own tenant: a `super_admin` sees the platform tenant, an `admin` sees their organisation | `200 { counts: { in_review, verified, disputed, needs_fix, none }, total, items: [{ id, pack_id, pack_name, type, topic, status, version, review_state, origin, rights_status, updated_at, latest_note: { note, state, created_at } \| null }] }`. No content, rubric or answer key. Archived and withdrawn rows are left out. Newest change first | `400 INVALID_PARAM` · `403` |
| `GET /api/admin/questions/:id/review-notes` | none. Same authorisation as the review actions | `200 { latest, items: [{ id, version, state, note, author_user_id, created_at }] }`, newest first, at most 100 | `400` · `403` · `404 QUESTION_NOT_FOUND` (also a question of another tenant, or a platform question for an organisation admin) |
| `GET /api/admin/questions/:id/affected-attempts` | none. Module 06, `adminOnly` | `200 { question_id, current_version, total, items: [{ attempt_id, assessment_id, assessment_name, candidate_user_id, status, question_version, submitted_at }] }`. Read only. Finished attempts (`submitted`, `auto_submitted`, `pending_admin_grading`, `graded`, `released`) that froze an older version of the question than the current one. Newest first, at most 200; `total` is the full count. No answers, scores, names or emails. Marks are never changed | `400` · `404 QUESTION_NOT_FOUND` |

An answer-key correction is an edit of the question: it creates a new question version, and attempts and frozen pools keep the version they used. Rescoring is not built (owner decision pending).
- **UI.** Page `/admin/question-bank/:id/review`. See [08-ui-system.md](08-ui-system.md) § "Question review page".

#### Question list filters and facets (EXP-5, 2026-10-17)

`GET /api/admin/questions` and `GET /api/admin/questions/facets` (any admin; RLS scopes both to the session tenant). Both read the same query parameters. Every parameter is optional and all are combined with AND.

| Parameter | Meaning |
| --- | --- |
| `q` | Words to search for in the normalised question text (stem, options, other strings; the rationale is not searched). Up to 200 characters, no control characters. Case-insensitive. Exact word match first; when nothing matches, near matches (typing mistakes). Sorted by closeness when set |
| `stage_id`, `subject_id`, `unit_id`, `outcome_id` | A taxonomy node id (UUID). The node must have that kind (a wrong kind matches nothing). Matches questions linked to the node or any descendant, through `question_taxonomy` |
| `difficulty_min`, `difficulty_max` | Integers 1 to 5, inclusive. Questions with no `difficulty_est` never match a range. `min` greater than `max` is a 400 |
| `origin`, `rights_status`, `review_state`, `language` | Comma list, up to 20 values, OR inside one parameter. Origin and rights values are the `question_source` values; `review_state` accepts `none` for questions never reviewed; `language` is `language_primary` |
| `has_solution` | `true` = the `rationale` text is not blank; `false` = absent or blank |
| `has_passage` | `true` = the question has a `passage_id` (migration 0211, shared passage); `false` = stand-alone question. Not a facet: no counts. Any other value is a 400 `INVALID_PARAM` (EXP-6 tail) |

Existing parameters (`pack_id`, `level_id`, `type`, `status`, `tag`, `search`, `domain_id`, `category_id`, `page`, `pageSize`) are unchanged.

- **List response.** Same shape as before: `{ items, page, pageSize, total }`. `total` now comes from one query (`count(*) OVER ()`).
- **Facets response.** `{ total, type, status, origin, rights_status, review_state, language, difficulty, has_solution, stage, subject, unit, outcome }`. The first eight are `[{ value, count }]`, most common first. A missing value shows as `none` (for example no rights row, no review state, no difficulty). `has_solution` values are `true` and `false`. The four node facets are `[{ node_id, code, label, count }]`; a question counts once for every ancestor of its linked nodes, so a subject count includes its topics and subtopics.
- **A facet ignores its own filter.** With `origin=ai_original` the origin counts still show every origin, while the other facets and `total` obey it. This keeps every option visible.
- **Errors.** `400 INVALID_PARAM` (`details.param` names the parameter) for a bad UUID, a number outside 1 to 5, an unknown origin, rights or review value, a `has_solution` that is not `true` or `false`, or a `q` that is too long.
- **Why.** Review and assembly of thousands of exam items need to find an item by its words and by exam, subject, difficulty, source and review state (plan 2026-10-17, section 6).
- **Considered and rejected.** One endpoint that returns items and facets together (a facet call is wanted without a page of rows, and the list stays backward compatible). Cursor paging (the pack page loads up to 500 rows). A `has_passage` filter (no passage table yet).
- **Not included.** Draws by outcome node (see below), saved filters, candidate-facing search.
- **Draws by `outcome` nodes.** Not done in module 04. The assessment draw reads `questions.domain_id` and `questions.category_id`, not `question_taxonomy`: `modules/05-assessment-lifecycle/src/service/blueprint.ts` (`resolveBlueprintNodes` accepts only `unit` nodes and maps them to a `categories` row), the frozen pool in `05/src/repository.ts` and `service/lifecycle.ts`, and the per-attempt draw in `modules/06-attempt-engine/src/repository.ts` (lines 929, 1001, 1026) and `service.ts` (line 336). An outcome node has no category row, so the draw needs a taxonomy-based pool query in modules 05 and 06. It stays a separate task.

#### `POST /api/admin/domains` and `POST /api/admin/categories` (04): super_admin only (RW-56)

**History:** added in the S9 notes of 2026-10-11.

- **What.** Auth changes from `admin` (`adminOnly`) to `super_admin` (`superAdminOnly`), commit `99d97b3`. A tenant admin now gets 403. A super admin still gets 201. The `GET` routes do not change: tenant admins still read and use domains and categories.
- **Why.** Owner decision: tenants never author taxonomy. Domains and categories are shared structure. They belong to the platform, like packs and questions.
- **Considered and rejected.** (1) Keep tenant-local taxonomy writes: this conflicts with the owner decision and with the curriculum taxonomy (RW-55). (2) Add a new super-admin route for the same action: the existing path with a stricter guard is a smaller change.
- **Not included.** No change to `/api/admin/super/domains`, to the `GET` routes, or to existing tenant-local rows. The same commit removes the decommissioned `reviewer` role from the billing session type (RV60). That is a type change only.
- **Impact.** Any client that calls these two routes as a tenant admin now fails with 403. The admin UI has no such call. Four gate tests are in `modules/04-question-bank/src/__tests__/taxonomy-write-gate.test.ts`. Rows added by later S9 tasks go under this heading.

#### Curriculum framework routes and node blueprint criteria (04, 05; RW-55)

**History:** added in the S9 notes of 2026-10-11.

Commits `76daf4c` (routes) and `2e23622` (blueprint). Schema: `docs/02-data-model.md` § "Curriculum frameworks".

**`GET /api/admin/frameworks[?status=active|all]`**
- **Auth:** `adminOnly` (admin or super_admin). Runs in `withTenant`, so RLS returns platform (NULL-tenant) rows plus the caller's own rows.
- **Query:** `status` is `active` (default) or `all`. Any other value gives 400 `INVALID_PARAM`.
- **Response 200:** `{ "items": [ { "id", "slug", "name", "source", "status", "tenant_id" } ] }`, ordered by `name`, `slug`. `tenant_id` is `null` for platform frameworks.

**`GET /api/admin/frameworks/:id/nodes[?kind=]`**
- **Auth:** `adminOnly`, `withTenant`.
- **Params and query:** `id` is a UUID. `kind` is one of `board`, `stage`, `grade`, `subject`, `unit`, `outcome`, `criterion`. A bad value gives 400 `INVALID_PARAM`.
- **Response 200:** `{ "items": [ { "id", "parent_id", "kind", "code", "label", "position", "syllabus_edition", "external_id", "status", "tenant_id" } ] }`, ordered by `parent_id` (NULL first), `position`, `label`. The list is flat. The client builds the tree from `parent_id`. An unknown or invisible framework id gives an empty list, not 404.

**Blueprint criterion shape (`POST/PATCH /api/admin/assessments`, `settings.blueprint`).** A criterion is now `{ category_id?, node_id?, type, count }`. At least one of `category_id` and `node_id` is required. `domain_id` is optional when every criterion has `node_id`; the domain comes from the unit node. The server resolves `node_id` to `(domain_id, category_id)` at write time and stores the resolved shape. The stored blueprint has `category_id` on every criterion, and `node_id` where the client sent one. Existing `category_id`-only blueprints work as before. Four new 400 codes:

| Code | Cause |
|---|---|
| `BLUEPRINT_NODE_UNRESOLVED` | Node missing, not visible to the tenant, or no category for it in this tenant. |
| `BLUEPRINT_NODE_KIND_UNSUPPORTED` | Node kind is not `unit`. |
| `BLUEPRINT_NODE_MISMATCH` | `category_id` and `node_id` on one criterion point at different categories. |
| `BLUEPRINT_MIXED_DOMAINS` | Criteria resolve to more than one domain, or conflict with `domain_id`. |

**Z-43: draw by taxonomy node.** A criterion `node_id` may now also name a `subject`, `unit` or `outcome` node. A `unit` node that maps to a category of the tenant keeps the old behaviour (resolved to `category_id`). Any other accepted node is stored as `{ node_id, type, count, difficulty_min?, difficulty_max? }` with no `category_id`. Such a criterion draws questions linked through `question_taxonomy` to that node or any descendant (parent_id walk, depth cap 10, never crosses a framework), active only (withdrawn questions are archived), tenant-scoped by RLS. `difficulty_min` and `difficulty_max` (1..5) filter `questions.difficulty_est`. `domain_id` is required unless a criterion resolves through a unit category; the pack and level come from it. Count, preview, publish pre-flight, the frozen pool and the attempt draw all follow the node. Points and negative marks are unchanged. Two new 400 codes: `BLUEPRINT_NODE_EMPTY` (no active question under the node, checked at write time) and `BLUEPRINT_DOMAIN_REQUIRED`. `BLUEPRINT_NODE_KIND_UNSUPPORTED` now means a kind other than `subject`, `unit` or `outcome`. The preview criterion carries `node_id` instead of `category_id` for these criteria. **Not included.** Taxonomy links are read live, so a link change after publish moves the frozen draw (the frozen set itself does not change). Per-section `category_ids` filters are unchanged. **Frozen assessments read live taxonomy.** A node draw on a published (frozen) assessment reads live `question_taxonomy` links, live `parent_id` and live `difficulty_est`. A taxonomy edit after publish can change which frozen questions a candidate is drawn from. It can never add a question outside the frozen set. Descendants deeper than 10 levels are not included. Write time also rejects `difficulty_min` greater than `difficulty_max`, and a difficulty range on a criterion that resolves to a category (unit with category, or `category_id`), with 400 `BLUEPRINT_DIFFICULTY_INVALID`.

**Why.** Curriculum frameworks (RW-55) need an addressable unit id that a blueprint can name. **Considered and rejected.** (1) Store only `node_id` in the blueprint: the draw, count, preview and frozen pool would then change. (2) Resolve at draw time: frozen pools must not move after publish. **Not included.** No write routes for frameworks or nodes (RW-61). No `outcome` or `criterion` draws. **Impact.** Clients that read a stored blueprint can rely on `domain_id` and `category_id` being present.

#### RW-68: no API shape change (2026-10-11)

**History:** added in the S9 notes of 2026-10-11.

- **What.** The registry refactor (RW-68) changes no route, status code or response shape. One schema widens: `McqAnswerPayloadSchema.selected` now allows 0-7 entries (was 0-3), because mcq options allow 8.
- **Why.** The old cap of 3 contradicted the option limit. Stage 1 (`5125b3c`) fixed it while moving the schema into the registry.
- **Considered and rejected.** Keeping the cap of 3: it would reject valid picks.
- **Not included.** No new routes, no new error codes.
- **Impact.** Stored answers stay valid, since the change is a widening. Clients that send up to 3 picks work as before.

### Admin — Rubric generation & generation attempts

> **Status: live.** Routes registered in `modules/04-question-bank/src/routes.ts` via `registerQuestionBankRoutes(app, { adminOnly: authChain({roles:['admin']}) })`. All routes were admin-only; tenant scope enforced via RLS + `withTenant`.
>
> **⚠ Phase B1 (2026-05-18, commits `2ba822d` + `9f073a5`) — generation endpoints re-gated to `super_admin`.** The 6 AI generation and generation-history routes below now require `roles:['super_admin']`. Tenant admins receive `403 AUTHZ_FAILED`. Nav and SPA routes are also super-admin-only as defence-in-depth. The backend is authoritative. `save-rubric` and all CRUD/import/publish/assemble/status routes remain on `roles:['admin']` unchanged. See § Phase B1 — generation endpoints re-gated to super_admin below for the full listing.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/admin/questions/:id/generate-rubric` | Generate a rubric proposal for a question. **Does NOT persist** — call `save-rubric` to commit. Returns a rubric object. Requires `AI_PIPELINE_MODE=claude-code-vps`. **⚠ Phase B1: `super_admin` only.** |
| `POST` | `/admin/questions/:id/generate-answer-guidance` | Generate a candidate-facing answer-format hint proposal (feature #4, all 5 types). **Does NOT persist** — returns `{ proposal: string, skillSha, promptSha, model }`; the admin reviews it and PATCHes `{ answer_guidance }` to save. The generator receives an answer-key-FREE stem (never the correct option / expected findings / sample solution / step answers). Requires `AI_PIPELINE_MODE=claude-code-vps`. **`super_admin` only.** (0098/Phase B) |
| `POST` | `/admin/questions/:id/save-rubric` | Persist a rubric for a question. Body: `{ rubric: <rubric object> }` (required — 400 `INVALID_PARAM` if absent). Validates that all anchor weights sum to 100 (server-side). Saves as a new rubric version. Returns the updated rubric. |
| `POST` | `/admin/packs/:id/generate-missing-rubrics` | Find the first question in the pack with `rubric IS NULL` and `type IN ('subjective', 'scenario')`, generate a proposal, and return it with a pagination cursor. **Does NOT auto-save.** Response: `{ proposal: <rubric>, cursor: { currentQuestionId, nextQuestionId, remainingCount } }`. Call repeatedly until `cursor.nextQuestionId` is null. **⚠ Phase B1: `super_admin` only.** |
| `GET`  | `/admin/generation-attempts` | Cross-pack AI question-generation history. Query params (all optional): `status` (`success`\|`partial`\|`failed`\|`running`), `model` (substring match, ILIKE), `pack_id` (UUID), `level_id` (UUID), `since` (ISO-8601, filters `started_at ≥ since`), `limit` (1–100, default 50), `offset` (default 0), `sort` (allowlist: `started_at`\|`status`\|`duration_ms`\|`model`), `dir` (`asc`\|`desc`; default `started_at desc`; `sort` maps through a fixed column allowlist server-side, invalid → default). Response: `{ items: GenerationAttempt[], total, limit, offset }`. Each item: `id, status, count_requested, count_inserted, error_code, error_message, stderr_tail, skill_sha, model, chunks_planned, chunks_failed, dedupe_dropped, citation_dropped, difficulty_dropped, duration_ms, started_at, finished_at, pack_id, level_id, level_label, user_id`. **2026-05-30 (`31261c2`):** `level_label` resolves the difficulty level (`L1`/`L2`/`L3`) via a correlated subselect `(SELECT label FROM levels WHERE levels.id = generation_attempts.level_id)` — a subselect not a JOIN, because `levels` also has a `pack_id` column which would make `pack_id`/`status` in the WHERE clause ambiguous (`null` if the level row was deleted). `citation_dropped` + `difficulty_dropped` complete the post-generation drop-reason trio (with the already-present `dedupe_dropped`) so the history Details panel can explain any `count_inserted < count_requested` gap. Columns pre-date this change (migrations `0043`, `0087`); only the projection + admin UI were widened. **Not** added to the per-level endpoint below (keeps its narrower projection); no schema change so `02-data-model.md` is unaffected. **⚠ Phase B1: `super_admin` only.** |
| `GET`  | `/admin/packs/:packId/levels/:levelId/generation-attempts` | Most recent 5 generation attempts for a specific pack + level. Useful for diagnosing why a "Generate" click produced 0 rows without SSH access. Response: `Array<{ id, status, count_requested, count_inserted, error_code, error_message, stderr_tail, model, duration_ms, started_at, finished_at }>`. **⚠ Phase B1: `super_admin` only.** |
| `POST` | `/admin/generate/start` | **Detached generation (RW-93, S10, 2026-10-15).** Same body and checks as `POST /admin/generate`. Returns 202 `{ attempt_id }` and runs detached. Details: section "Detached generation routes and `topic_focus`". **`super_admin` only.** |
| `GET`  | `/admin/generation-attempts/:id` | Poll one attempt: `{ id, status, count_requested, count_inserted, error_code, error_message, duration_ms, started_at, finished_at }`. 404 for an unknown or other-tenant id; 400 for a non-UUID. **`super_admin` only.** |
| `POST` | `/admin/generation-attempts/:id/score` | Server-side structural + runtime eval scoring for a single generation attempt. **Read-only — no writes to any table.** Resolves attempt via RLS (404 if absent or cross-tenant), loads inserted questions, runs `scoreQuestion` per question, compares per-type pass rates against `eval/baseline.json` regression thresholds. Response: `{ structural: <per-type breakdown>, runtime: <metrics>, verdict: "pass" \| "regression" \| "warning" \| "n/a" }`. **⚠ Phase B1: `super_admin` only.** |

#### Generation batches (04, super admin)

**History:** added in the 2026-10-02 batch 5 notes.
All three use the same guard as the other generate routes. `id` must be a uuid (else 400 `INVALID_PARAM`).
- `GET /api/admin/generation-batches/active` returns `{ batch: Batch | null }`, the caller's newest `active` batch.
- `PUT /api/admin/generation-batches/:id`, body `{ domainId?: uuid|null, level?: string<=10|null, categories: object[] (max 50), completedCategoryIds?: uuid[] (max 50) }`. Upsert. `completed_category_ids` is unioned with the stored value. Returns `{ batch }`. 409 if the id belongs to another user or tenant (never says which).
- `PATCH /api/admin/generation-batches/:id`, body `{ status: "done"|"dismissed" }`. Returns `{ ok: true }`. 404 if not found for this user.
- `Batch` = `{ id, domainId, level, categories, completedCategoryIds, status, updatedAt }`.
- **Why.** Durable wizard plan, see 02 migration 0142.
- **Not included.** No list-all, no delete.

#### Detached generation routes and `topic_focus` (04; RW-92, RW-93; S10, 2026-10-15)

**History:** added in the S9 notes of 2026-10-11.

*Type: reference.*

- **`POST /api/admin/generate/start`** (`super_admin` only). The body and the checks are the same as for `POST /api/admin/generate`, through the shared `resolveGenerateArgs`: `domain_id` (UUID), `level` (`L1` to `L3`), `count` (1 to 30), optional `type_counts`, `category_id`, `batch_id`, and `topic_focus`. The route mints a uuidv7 attempt id and starts `generateQuestions` detached in the API process. The same single-flight lock and the same `generation_attempts` row (with that id) apply. It waits at most 300 ms for an early error. Responses: 202 `{ attempt_id }`; 409 `AIG_GRADING_IN_PROGRESS` (lock held); 503 `AIG_LOCK_UNAVAILABLE`; 501 (wrong `AI_PIPELINE_MODE`); 400 `INVALID_PARAM`.
- **`GET /api/admin/generation-attempts/:id`** (`super_admin` only, tenant-scoped). Returns `{ id, status, count_requested, count_inserted, error_code, error_message, duration_ms, started_at, finished_at }`. `status` is `running`, `success`, `partial` or `failed`. It answers 404 for an unknown id or an id of another tenant, and 400 for an id that is not a UUID.
- **`POST /api/admin/generate`** is unchanged: it still holds the request until the run ends.
- **`topic_focus` (RW-92).** Free text. The server trims it. The maximum is 200 characters. Control characters are not allowed. Otherwise the answer is 400 `INVALID_PARAM` with param `topic_focus`. The domain route `POST /api/admin/generate` and `/generate/start` parse it through one shared helper. Before this change the domain route dropped it silently; only the legacy per-pack route read it. The value now reaches the prompt (see `docs/05-ai-pipeline.md`).
- **Why.** A run of 152 s was cut by the edge at about 100 to 125 s (RCA 2026-10-15).
- **Considered and rejected.** A queue or worker (hard rule 1). SSE or websockets (edge buffering). A new table (`generation_attempts` already holds the state). A replacement of the sync route.
- **Not included.** Cancel; resume after an API restart.
- **Impact.** Module 10 uses the two routes (`docs/08-ui-system.md`). The history routes above are unchanged. No schema change.

### Admin — Assessments & invitations

> **Status: live as of 2026-05-02 (Phase 1 G1.B Session 3).** All 11 routes below registered into `apps/api/src/server.ts` via `registerAssessmentLifecycleRoutes(app, { adminOnly: authChain({roles:['admin']}) })`. Smoke verified live: `GET /api/admin/assessments` returns 401 AUTHN_FAILED without session, full lifecycle + cross-tenant RLS exercised by 69 testcontainer integration tests in `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts`. The `GET /:id`, `POST /:id/reopen`, `GET /:id/preview`, `GET /:id/invitations`, and `DELETE /admin/invitations/:id` rows are Phase 1 service-method extensions added in the same PR — same admin-only auth gate. `GET /admin/assessments/:id/attempts` belongs to module 06-attempt-engine and is NOT shipped here; it stays in the table as the canonical contract line for Group G1.C.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/assessments`              | List assessments (paginated; filter by ONE `status`, `pack_id`). **2026-10-19 (Q44):** the admin UI tabs All / Drafts / Live (published+active) / Finished (closed+cancelled) call this once per status and merge client-side; UI `?status=drafts|live|finished`, old `draft|published|active|closed` links map to the tabs; API unchanged. **2026-05-30:** each item now includes two optional display fields: `level_label` (string, from `levels.label` via LEFT JOIN, for example, "L1") and `domain` (string, the bound pack's domain as a **human name** — `domains.name` resolved server-side from `question_packs.domain` via a correlated subselect, for example, "SOC", "Application Security", with COALESCE-fallback to the raw slug when no `domains` row matches). Both are `null` only if level/pack FK is dangling. Used by the admin list page's Level + Domain columns. Additive — existing callers unaffected. Domain is sourced from the bound pack (uniform for blueprint and non-blueprint) rather than `settings.blueprint.domain_id`; resolved server-side (not via the FE static `DOMAIN_LABELS` map) so it tracks super-admin domain renames. **2026-05-30b:** `cancelled` assessments are now EXCLUDED by default (no `status` filter → `status <> 'cancelled'`); they remain reachable via explicit `?status=cancelled`. |
| `POST` | `/admin/assessments`              | Create draft assessment (returns 201). **Blueprint restriction:** if the request body carries `settings.blueprint`, the caller must be `super_admin`; a tenant admin receives `403 AuthzError` ("Blueprint assessments are restricted to super_admin"). See § Blueprint authoring restriction below. |
| `POST` | `/admin/assessments/from-set`     | **Step 2:** create a draft assessment from a licensed PLATFORM-library set. Body: `{ source_pack_id, level_position, name, question_count, opens_at, closes_at?, randomize?, description?, settings? }`. License-checked (`403 NOT_LICENSED`), cloned-on-use into the tenant (idempotent), then created from the clone (returns 201). **Defense-in-depth:** any `settings.blueprint` field in the request body is stripped before delegating (even though this route is `adminOnly` — see § Blueprint authoring restriction). |
| `GET`  | `/admin/assessments/:id`          | Get assessment by id. **2026-05-29:** response now includes two optional fields joined from related tables: `level_label` (string, from `levels.label` — the human-readable level code, for example, "L1") and `pack_name` (string, from `question_packs.name`). Both are `null` if the JOIN misses (should not happen on well-formed data). Used by the admin detail page header. All other callers of this endpoint are unaffected — the fields are additive. |
| `PATCH`| `/admin/assessments/:id`          | Update — only allowed in `draft` status. **Blueprint restriction:** if the request body carries `settings.blueprint`, the caller must be `super_admin`; a tenant admin receives `403 AuthzError` ("Blueprint assessments are restricted to super_admin"). |
| `POST` | `/admin/assessments/:id/publish`  | `draft → published` — runs pool-size pre-flight (count active questions ≥ `question_count` else 422 `POOL_TOO_SMALL`). **EXP-18: 422 `QUESTIONS_NOT_VERIFIED` (`details.count`, `details.question_ids`, ids only, max 50) while an active question of the (pack, level) pool has `review_state` `in_review`, `disputed` or `needs_fix`; NULL and `verified` pass.** **EXP-18 part 2: the race with a review write is closed (rows are share-locked, then the frozen pool is re-checked in the same transaction).** **B2: 403 `NOT_ENTITLED` if pack is not entitled for the tenant's plan.** |
| `POST` | `/admin/assessments/:id/close`    | `active → closed` — illegal on `draft` (state-machine reject) |
| `POST` | `/admin/assessments/:id/reopen`   | `closed → published` if `now < closes_at`; else 422 `REOPEN_PAST_CLOSES_AT` (extension). **B2: 403 `NOT_ENTITLED` if pack is not entitled for the tenant's plan.** |
| `POST` | `/admin/assessments/:id/cancel`   | **2026-05-30 (extension).** Soft-retire → terminal `cancelled` state. Legal from `draft`/`published`/`active`/`closed` (state machine extended so a running/finished assessment can be cancelled); `cancelled → *` rejected with 422 `INVALID_STATE_TRANSITION`. Preserves attempts + invitations + audit; the row just drops out of the default list. Returns the updated assessment. Audited as `assessment.cancelled`. |
| `DELETE`| `/admin/assessments/:id`         | **2026-05-30 (extension).** Hard-delete the assessment (returns 204). Allowed ONLY when the assessment has **zero attempts**; otherwise 422 `ASSESSMENT_HAS_ATTEMPTS` (caller should cancel instead). `assessment_invitations` + `assessment_frozen_pool` cascade away (`ON DELETE CASCADE`); `attempts` FK is `RESTRICT` (the DB backstop, also catches a count→delete TOCTOU race → mapped to the same 422). `audit_log` is append-only and retained. RLS confines the delete to the caller's tenant. Audited as `assessment.deleted` (before-payload `{status,pack_id,level_id}`). |
| `POST` | `/admin/assessments/clear-empty-drafts` | **2026-10-19 (extension, Q44).** Bulk hard-delete of EMPTY drafts. Body `{ids: string[]}` (uuid, min 1, max 100, strict). Empty = `status='draft'` AND zero attempts AND zero invitations. One tenant transaction; tenant and user come from the session only. Returns `{deleted: string[], skipped: [{id, reason}]}` where reason is `not_draft` / `has_attempts` / `has_invitations` / `not_found` (unknown or other-tenant ids are `not_found`). Each delete is audited as `assessment.deleted` before the delete, with `after: {bulk: true}`. Never deletes a non-draft. |
| `GET`  | `/admin/assessments/:id/preview`  | Admin sample of the question pool — does NOT create attempt or snapshot (extension). **RV63 (2026-10-03, `afc5069`):** for a published, closed or reopened assessment with rows in `assessment_frozen_pool`, the counts and the sample come from the frozen pool (what candidates draw), and the response carries `frozen: true`. Draft, and assessments frozen before migration 0096, keep the live pool (`frozen` false or absent). Question text in the sample is the live row; ids and counts are the frozen set. |
| `GET`  | `/admin/assessments/:id/invitations` | List invitations for an assessment (paginated; filter by `status`). **2026-05-29:** each invitation row now includes additional optional fields from LEFT JOINs: `user_name` (string\|null), `user_email` (string\|null), `attempt_id` (UUID\|null), `attempt_status` (string\|null), `started_at` (ISO timestamp\|null), `submitted_at` (ISO timestamp\|null), `total_earned` (number\|null), `total_max` (number\|null), `auto_pct` (number\|null), `pending_review` (boolean\|null). All additive — single-row reads (findById, findByToken, findByAssessmentAndUser) are unaffected and do not return these fields. |
| `POST` | `/admin/assessments/:id/invite`   | Bulk invite users (body: `{ user_ids: string[], delivery_mode?: "real" | "mock" }`; **Z-89:** `delivery_mode` defaults to the assessment's own and is stored on the invitation; any other value is `400 INVALID_PARAM`; a re-invite of a never-started invitation can switch it); per-user skip reasons returned in `skipped[]` (returns 201). **EXP-18 part 2: 422 `QUESTIONS_NOT_VERIFIED` (`details.count`, `details.question_ids`) while a question of the assessment's frozen pool is `in_review`, `disputed` or `needs_fix`; the same block applies to the resend and re-open routes below. NULL passes.** |
| `DELETE`| `/admin/invitations/:id`         | Revoke invitation — sets status to `expired`; idempotent on already-expired (extension; returns 204) |
| `GET`  | `/admin/assessments/:id/attempts` | List all attempts (status filter) — **NOT in 05; lands with module 06-attempt-engine (Group G1.C)** |

#### Assessment lifecycle endpoints — error contract (`details.code`)

| `details.code` | HTTP | Where |
|---|---|---|
| `POOL_TOO_SMALL` | 422 | `/publish` — active question count < `question_count` for this assessment |
| `REOPEN_PAST_CLOSES_AT` | 422 | `/reopen` — `now ≥ closes_at`; cannot reopen a window that has already ended |
| `NOT_ENTITLED` | 403 | `/publish`, `/reopen` — assessment's question pack not entitled for the tenant's plan (B2); see § Phase B2 — publish-time enforcement for body shape |
| `AUTHN_FAILED` | 401 | All routes — no session |
| `AUTHZ_FAILED` | 403 | All routes — caller is not a tenant admin |

#### Blueprint authoring restriction (2026-05-24)

**What:** Both `POST /admin/assessments` (create) and `PATCH /admin/assessments/:id` (update) now require `role=super_admin` when the request body carries `settings.blueprint`. A tenant admin receives `403 AuthzError` with message "Blueprint assessments are restricted to super_admin".

**Why:** Blueprint mode lets an assessment author compose the domain question pool of the tenant by per-criterion quota. This is a platform-operator capability, not a company-admin capability. Blueprints define cross-tenant pool structure. If a tenant admin could set `settings.blueprint`, the quota arrangements could conflict with platform licensing invariants.

**`POST /admin/assessments/from-set` defense-in-depth:** this route is `adminOnly` (not `super_admin`) and is the correct entry point for tenant admins building assessments from licensed sets. As an additional safeguard, it strips any `settings.blueprint` from the delegated body before it creates the assessment. So even if a client sends a request with `settings.blueprint`, the clone-and-create path never writes it.

**Downstream:** the admin-dashboard hides the "Blueprint" mode button on the New Assessment form for non-super-admin sessions (FE defense-in-depth; the backend gate is authoritative).


#### `POST /api/admin/sets/:sourcePackId/import` (2026-05-24)

**Purpose:** Clone a licensed PLATFORM-library set into the caller's Question Bank without creating an assessment ("Add to workspace"). This is the explicit workspace-import action distinct from the implicit clone-on-use that happens inside `POST /admin/assessments/from-set`.

**Auth:** `adminOnly` (`roles:['admin']`).

**Path params:** `sourcePackId` — UUID of the platform-library pack to clone. Validated as UUID format; returns `400 INVALID_PARAM` if not a valid UUID.

**Flow:**
1. `assertLicensedForSourcePack(tenantId, sourcePackId)` — checks the caller's tenant has an active entitlement whose `scope_type='domain'` matches `question_packs.domain` of the source, OR `scope_type='pack'` matches the source UUID exactly. Returns `403 NOT_LICENSED` if no active entitlement covers the source.
2. `materializeSetForTenant(tenantId, sourcePackId)` — advisory-locked clone (`pg_advisory_xact_lock(tenant, source)`); reuses an existing clone if the unique index `question_packs_tenant_source_uniq` finds one (idempotent). The clone engine rejects non-platform packs (source must be owned by the `platform` tenant) and unpublished sources (`status ≠ 'published'`); either condition returns `403 NOT_LICENSED`.
3. Returns `201` with the clone metadata.

**Response 201:**
```json
{
  "cloned_pack_id": "uuid",
  "slug": "soc-analyst-l1-l3-clone",
  "reused": false,
  "question_count": 42
}
```
`reused: true` when an existing clone was found rather than a new one created (idempotent re-import). `question_count` reflects the cloned pack's question total at clone time.

**Errors:**
| `details.code` | HTTP | Condition |
|---|---|---|
| `INVALID_PARAM` | 400 | `sourcePackId` is not a valid UUID |
| `NOT_LICENSED` | 403 | No active entitlement covers the source pack, OR source is not a platform pack, OR source is not published |
| `AUTHN_FAILED` | 401 | No session |
| `AUTHZ_FAILED` | 403 | Caller is not a tenant admin |

**Source:** `modules/04-question-bank/src/routes.ts` (`POST /admin/sets/:sourcePackId/import`), `modules/19-billing/src/service.ts` (`assertLicensedForSourcePack`), `modules/04-question-bank/src/clone.ts` (`materializeSetForTenant`).

#### `POST /api/admin/sets/:sourcePackId/resync` (2026-05-25)

Pull a newer platform-master version into the tenant's EXISTING clone of a licensed set (in-place content refresh — B3). Surfaced in the Question Bank "Licensed sets" section as an **Update** button when `update_available` (clone `source_version` < master `version`).

**Auth:** company tenant admin (`adminOnly`). License re-checked server-side (`assertLicensedForSourcePack`) before any write — same gate as import; a lapsed license → `403 NOT_LICENSED`.

**Path params:** `sourcePackId` — UUID of the PLATFORM source pack (not the clone). `400 INVALID_PARAM` if malformed.

**Behavior:** the route compares master↔clone by `questions.source_question_id`. It does four things. It **adds** new master questions (version=2 + `qv{v1}`, taxonomy-remapped by slug, skip-unresolvable). It **version-bumps** changed content/rubric: it makes a new `question_versions` snapshot at the current version of the clone question. Future attempts resolve the new content through `MAX(qv.version)`. In-flight attempts stay frozen. It **applies metadata-only** changes (level/domain/category/points/topic/type) without a version bump. It **archives** questions that the master removed. Then it bumps the clone `question_packs.version` and records `source_version`. Idempotent: if the clone is already at/above the master version it returns `updated:false` and writes nothing. Runs under `assessiq_system` with a per-`(tenant,source)` advisory lock; one `tenant.pack_resynced` audit row in the same tx (only when something changed).

**Response 200:**
```json
{ "updated": true, "from_version": 1, "to_version": 2, "added": 3, "changed": 5, "archived": 1, "skipped": 0 }
```

**Errors:** `403 NOT_LICENSED`; `404` `CLONE_NOT_FOUND` (no clone of this set in the tenant) / `SOURCE_PACK_NOT_FOUND`; `400 INVALID_PARAM`; `401 AUTHN_FAILED`.

**Caveat (decided 2026-05-25):** future attempts draw the refreshed content, even on an existing PUBLISHED assessment that uses this clone. The reason: the attempt engine serves the latest active snapshot at attempt start and does NOT pin a version for each assessment. In-flight/started attempts are never disrupted (their `attempt_questions` snapshot is frozen). This matches how editing a pack's questions already behaves.

**Source:** `modules/05-assessment-lifecycle/src/routes.ts`, `modules/05-assessment-lifecycle/src/service.ts` (`resyncLicensedSet`), `modules/04-question-bank/src/clone.ts` (`resyncSetForTenant` / `resyncClonedPack`).

> **FU-C13 (2026-10-06) — difficulty tags are now read back.** Every route that returns a `Question` also returns the four Phase-A columns from migration 0086. These routes are `GET /admin/questions/:id`, the pack question list and the create/update/status responses. The columns are: `cognitive_level` (`remember|understand|apply|analyze|evaluate|create|null`), `nice_task_id` (string|null), `difficulty_params` (object|null), `attack_technique` (string[]|null). All null on human-authored rows and on rows generated before 2026-05-23. The question editor header and the pack question rows show `Bloom` and `NICE` chips when set. **Why:** the generator wrote the tags but nothing read them (RS6 FR20). **Rejected:** an editor for the tags (the generator is the writer; Phase C will measure them). **Not included:** `difficulty_params` and `attack_technique` in the UI (returned only). **Downstream:** `Question` type in `modules/04-question-bank/src/types.ts`; help keys `admin.question.editor.difficulty`, `admin.question_bank.pack.difficulty`.

> **FU-C8 (2026-10-06) — behaviour and integrity card.** The attempt page card (`AttemptIntegrityCard`) now shows the live recorded-event counts (`GET /admin/attempts/:id/integrity`). After the result is released to the company, it also shows the behaviour radar from `GET /admin/attempts/:id/score` -> `score.archetype_signals`. It shows the disclaimer text too. No archetype label is shown to tenant admins (owner decision 2026-10-03). The individual report links each attempt row to the attempt page. Help ids moved under the page prefix (`admin.attempts.detail.integrity`, `admin.attempts.detail.behaviour`, migration 0159). **Rejected:** a second radar on the individual report (one card, one place). **Not included:** a score or an automatic flag (FR11 result: never).

#### `PATCH /api/admin/assessments/:id/integrity`

**History:** added in the 2026-10-02 batch 3 notes.

- Auth: admin session (`adminOnly`), tenant-scoped. Body, strict (unknown keys rejected): `{ "fullscreen": boolean, "block_copy_paste": boolean }`; both required. Bad body: 400 `VALIDATION_ERROR`, `details.code = INVALID_PARAM`, `param = body`. Unknown id: 404 `ASSESSMENT_NOT_FOUND`.
- Effect: merges only `settings.integrity` (`jsonb_set`, one UPDATE); blueprint and other settings keys are untouched. Allowed in ANY status, including published. The candidate view reads settings live, so the change applies to attempts that start afterwards. A student in the middle of a test gets the change on the next page load. Audit: `assessment.updated` with `before/after { integrity }`. Returns the updated assessment.
- Why: switches could be set only on the create form. Rejected: a general PATCH of settings (wider surface, would let a published blueprint change). Not included: the tab-leave warning is not switchable.

#### `GET /api/admin/assessments/:id/invitations` paging

**History:** added in the 2026-10-02 batch 3 notes.

`page` (1-based) and `pageSize` (cap 100) were already accepted. The admin UI now uses them: 100 per page, "Showing x-y of N", Previous/Next. The page number stops at the last real page when rows shrink. The picker and has-attempts guard use ids gathered across all pages. No API shape change; `total` in the response is the paging source.

#### `PATCH /api/admin/assessments/:id/reminders` (admin)

**History:** added in the 2026-10-02 batch 4 notes.

- **What.** Body `{ enabled: boolean, hours_before?: int 1..168 }`, strict. Allowed in any assessment status. Merged into `settings.reminders` server-side; audited as `assessment.updated`; returns the assessment. 400 `INVALID_PARAM` (param `body`) on a bad body.
- **Why a dedicated route.** Works on a published assessment without re-sending the whole settings object (same pattern as `/integrity`).
- `GET /api/admin/assessments/:id/invitations` rows gain `reminded_at` (nullable).

#### `POST /api/invitations/accept`: 429 behaviour

**History:** added in the 2026-10-02 batch 4 notes.

- **What.** A per-IP brake that counts FAILED redemptions only (unknown, expired or used token): 30 per 60 s per client IP (`INVITE_FAIL_MAX`). A valid accept is never blocked or counted. Only a failure past the cap returns 429 `scope=ip` with `Retry-After: 60`, instead of the specific error (so it is not an oracle).
- **Why.** Replaces the old FIXME. Tokens are 256-bit so guessing is infeasible; the brake bounds DB lookups and log noise from scanners. The first version checked the limit before it redeemed the token. This let one scanner lock a whole campus NAT out of valid accepts (codex revise). The code now redeems first.
- **Not included.** No per-token or per-email limit; the route-level limiters are unchanged.

#### `PATCH /api/admin/assessments/:id/grading` (05, admin)

**History:** added in the 2026-10-02 batch 5 notes.
- **What.** Body `{ "high_stakes": boolean }`, strict (extra keys give 400). Works in any assessment status. Merges only `settings.high_stakes`. Audited as `assessment.updated`. Returns the full assessment.
- **Errors.** 400 `INVALID_PARAM` (param `body`) on a bad body; 404 `ASSESSMENT_NOT_FOUND` (also for another tenant's id).
- **Why.** Same pattern as `/integrity` and `/reminders`: one setting key, any status, no sections-lock side effects.
- **Not included.** Per-question flag; tenant default.
- **Impact.** Takes effect for AI grading runs started afterwards (07 reads it live). `settings.high_stakes` is also accepted at create/update.

#### `POST /api/admin/assessments`, `POST .../from-set`, `PATCH /api/admin/assessments/:id`: `passing_score_pct` (Z-16)

**History:** added 2026-10-17.
- **What.** Optional integer `passing_score_pct`, 1 to 100. On create it defaults to the level's value (clamped to 1..100). On `PATCH` it works only while the assessment is `draft`. After publish any `PATCH` returns `409 ASSESSMENT_NOT_DRAFT` (existing rule, server side). `0`, negatives, values above 100, decimals and non-numbers return `400 INVALID_PARAM` with `details.param = "passing_score_pct"`. Assessment payloads now include `passing_score_pct`.
- **Why.** The pass mark is per assessment, and the certificate follows it (see `docs/14-credentialing.md`).
- **Not included.** A separate Distinction threshold (fixed at 90). Honors.
- **Impact.** Candidate result payloads carry `pass_mark_pct` (below). The welcome preview carries `assessment.pass_mark_pct`.

#### Retake policy (Z-39): `max_attempts`, `settings.score_counts`, extra attempt, re-open, attempt fields

**History:** added 2026-10-18 (migration `0203`).
- **What.**
  - `POST /api/admin/assessments`, `POST .../from-set` and `PATCH /api/admin/assessments/:id` accept `max_attempts`: `null` or `1` = one attempt (the default, no retake), a whole number `2` to `10` = attempts allowed. Anything else (0, 11, decimals, strings) returns `422 INVALID_PARAM` with `details.param = "max_attempts"`. A `PATCH` works only while the assessment is `draft` (the existing `409 ASSESSMENT_NOT_DRAFT`). The assessment payload carries `max_attempts`.
  - `settings.score_counts` is `"latest"` (default when absent) or `"best"`. Any other value returns `422 INVALID_PARAM` (`settings.score_counts`). It decides which attempt the invitations list shows for a candidate who sat the test more than once.
  - `POST /api/admin/invitations/:id/extra-attempt` body `{ reason }` (required, 1 to 500 characters, trimmed) gives ONE candidate ONE more attempt than `max_attempts` allows. Response `200 { invitation, attempts_used, attempts_allowed }`. One audit row per grant (`assessment.invitation.extra_attempt_granted`, `after.reason`) in the same transaction as the counter. Errors: `404 INVITATION_NOT_FOUND` (also another tenant, by RLS), `409 ASSESSMENT_NOT_ACTIVE` (draft, closed, cancelled), `409 EXTRA_ATTEMPT_LIMIT` (10 extra attempts already), `422 INVALID_PARAM` (reason).
  - `POST /api/admin/invitations/:id/reopen` re-opens a `submitted` invitation for the next attempt: new link by email, 7 days, status `pending`, audit `assessment.invitation.reopened`. Errors: `409 ATTEMPTS_EXHAUSTED` (attempts used is not below `max_attempts` plus extras), `409 RETAKE_NOT_AVAILABLE` (not submitted, or an attempt is unfinished), `409 ASSESSMENT_NOT_ACTIVE`, `409 USER_INACTIVE`, `502 INVITATION_EMAIL_FAILED` (the new link is saved).
  - `GET /api/admin/assessments/:id/invitations` items add `attempts_used`, `attempts_allowed`, `can_reopen`, `can_grant_extra`. There is still ONE row per candidate: the attempt that counts (`score_counts`).
  - `POST /take/start` preview and start responses add `assessment.attempt_number` and `assessment.attempts_allowed` (the page shows "Attempt n of m" when `attempts_allowed` is above 1). A finished invitation with attempts left is no longer `410`; it previews the next attempt. `410` stays when no attempt is left.
  - `POST /api/me/assessments/:id/start` accepts `{ new_attempt: true }` (the Try again button). Without it the call keeps its old meaning (returns the latest attempt). With it a new attempt starts only while attempts are left, else `409 AE_ATTEMPTS_EXHAUSTED`; an unfinished attempt is resumed, never duplicated. The `Attempt` payload adds `attempt_number`.
  - `GET /api/me/attempts/:id/result` (released) adds `retake: { assessment_id, attempt_number, attempts_allowed, can_retake }`. `can_retake` is true only for the latest attempt of an active assessment with attempts left.
- **Why.** Owner decision 2026-10-17 (Z-39): the organisation admin sets the maximum attempts. The result page needs a real rule instead of "ask your organisation".
- **Considered and rejected.** A global retake setting (organisations differ). Automatic retakes. A candidate-triggered retake with no admin limit.
- **Not included.** Cooling-off timers, paid retakes, a different question draw per retake. Changing `max_attempts` after publish.
- **Impact.** Module 18: one certificate per assessment and candidate (the first pass keeps it). Modules 07, 09, 15 that join `attempts` by `(assessment_id, user_id)` now see one row per attempt. Help rows `admin.assessments.max_attempts`, `.score_counts`, `.extra_attempt`, `.invitations.reopen`, `candidate.result.retake`.

#### `PATCH /api/admin/assessments/:id` and create: `SECTIONS_LOCKED` (409)

**History:** added in the 2026-10-02 batch 5 notes.
- **What.** If `settings.sections` would change and any attempt exists: `409 { error: { details: { code: "SECTIONS_LOCKED" } } }`, message "Sections cannot be changed after students have started this test."
- **Not included.** Other settings keys are not affected.

### Admin — Grading & review

> **Status (2026-05-03, Phase 2 G2.A Session 1.b — LIVE in commit `5aec6ad`):** All 10 admin endpoints below registered into `apps/api/src/server.ts` via `registerGradingRoutes(app, { adminOnly: authChain({roles:['admin']}), adminFreshMfa: authChain({roles:['admin'], freshMfaWithinMinutes: 5}) })`. Smoke verified live: 11/11 Haiku checks PASS (every endpoint returns 401 AUTHN_FAILED without session — none 404). Service handlers under `modules/07-ai-grading/src/handlers/admin-*.ts`, registrar at `routes.ts`. Grading runtime at `runtimes/claude-code-vps.ts` spawns `claude -p` per D1-D8 in `docs/05-ai-pipeline.md`. Override never replaces — INSERTs new `gradings` row with `grader='admin_override'`, `override_of` FK, `override_reason`. Multi-tenancy guard: `/accept` validates every `proposal.attempt_id === URL attemptId` AND every `proposal.question_id ∈ attempt_questions` for the attempt. D7 single-flight is in-process `Map<attemptId>`; same-attempt OR other-attempt 409. Skill SHAs at deploy time: `anchors=1f04c875`, `band=15c14f96`, `escalate=f3588256` (claude CLI v2.1.119 on the VPS).

> **Superseded 2026-10-01 (platform evaluation queue):** for company admins `grade`, `accept`, `rerun` and `grading-jobs/:id/retry` below now answer `403 AI_EVALUATION_BY_ASSESSIQ` (AI evaluation runs from `/api/admin/super/evaluations*`); `GET /admin/attempts/:id` is read-only; `release` and `override` need the evaluation released to the company first. The heartbeat window in the rows below is 5 minutes in code (not 60 s). Current contract: § Scoring and result release at the end of this doc.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `POST` | `/admin/attempts/:id/grade`           | Trigger sync AI grading. D1 mode + D7 heartbeat + D7 single-flight. Returns `{ proposals: GradingProposal[] }` — does NOT write `gradings` rows (D8 accept-before-commit). **2026-10-01:** also runs deterministic MCQ scoring first; for an attempt with only MCQ questions the click finalises it (graded + billed, no AI) and returns `{ proposals: [], attempt: { id, status: "graded" } }` (`attempt` is absent otherwise). `auto_submitted` attempts are now gradeable. 409 `AIG_HEARTBEAT_STALE` if session idle > 60s. 409 `AIG_GRADING_IN_PROGRESS` on single-flight reject. 503 `AIG_RUNTIME_FAILURE` on `claude` subprocess error. **Phase 2 cache (2026-05-29, commit `96b71a6`):** ALSO sets `attempts.grading_started_at = NOW()` on entry, writes `attempts.ai_proposals = proposals_jsonb` + nulls the marker at batch completion. On any thrown error a catch best-effort nulls the marker (so the FE banner does not stick on a failed run). Recovery path for "client got CF/proxy 504/524 on the 4-minute synchronous response" — proposals are persisted server-side regardless of whether the response reached the browser. Cache is review-state only — admin Accept click is still required to write `gradings` rows. | **live 2026-05-29** |
| `POST` | `/admin/attempts/:id/accept`          | Commit accepted proposals. Body: `{ proposals: Array<GradingProposal & { edits?: AcceptEdits }> }` — exported as `ACCEPT_BODY_SCHEMA` from `routes.ts`, regression-guarded by `accept-contract.test.ts`. C1 guard: every `proposal.attempt_id` MUST match URL id. Pre-loop: every `proposal.question_id ∈ attempt_questions` for the attempt. Idempotent on `(attempt_id, question_id, prompt_version_sha)` per D7 — re-call returns existing rows. Status derivation: ratio ≥ 0.85 → `correct`, ≤ 0.15 → `incorrect`, else `partial`; AI runtime failures (`AIG_*` error_class incl. new `AIG_STAGE1_DEGRADED`) → `review_needed`; rubric error_class flows through ratio. **Completion-gate (2026-05-28, commit `defb9f9`):** flips `attempts.status='graded'` AND fires `recordGradedAttempt` (billing, same-tx) **only when** every AI-gradeable question (subjective \| scenario \| log_analysis) has a non-overridden `gradings` row by `grader IN ('ai','admin_override')`. MCQ/KQL excluded from the denominator (scored deterministically by `09-scoring.computeAttemptScore`, no `gradings` row). Partial accepts return `attempt.status = "pending_admin_grading"`; the per-batch audit honestly records `attempt_status_now`. Response: `{ gradings, attempt: { id, status: "graded" \| "pending_admin_grading" } }`. | **live 2026-05-28** |
| `GET`  | `/admin/attempts/:id`                 | Full attempt detail with `{ attempt, answers, frozen_questions, gradings, ai_proposals, grading_started_at }`. Idempotent claim semantic on read: transitions `submitted → pending_admin_grading` if currently `submitted` (no-op otherwise). Each `frozen_questions[]` row now carries `rubric: { anchors: [{id, concept, weight, synonyms?}], … } \| null` (added 2026-05-29, commit `d5ad835`) so the admin review UI can render anchor concepts + weights on grading cards and the concept-coverage highlight view. Admin-only route gate; candidates never reach this endpoint. **Phase 2 cache (2026-05-29, commit `96b71a6`):** `ai_proposals: GradingProposal[] \| null` carries the latest grade-batch result so the FE can hydrate proposals state on page load even when the original `/grade` POST response was lost to a proxy timeout. `grading_started_at: ISO-8601 \| null` is the in-flight marker; FE shows "Grading in progress" banner while set, auto-polls this endpoint every 15s, and treats > 10 min as stalled (likely API SIGKILL — FE re-enables Grade-all). | **live 2026-05-29** |
| `POST` | `/admin/attempts/:id/release`         | Transition `graded → released`. 422 `AIG_ATTEMPT_NOT_GRADEABLE` if status is not `graded`. **422 `AIG_ATTEMPT_NOT_RELEASABLE_ERASED` if the attempt's candidate has been DPDP/GDPR-erased (`users.erased_at IS NOT NULL`) — fail-closed gate added 2026-05-30 (commit `d324bba`), checked inside the same `withTenant` tx BEFORE the transition, so cert issuance + result-released email are also skipped.** Best-effort `13-notifications.sendResultReleasedEmail` via dynamic-import indirection — notification failure logs warn, never blocks the release. | **live 2026-05-03**, erasure gate **2026-05-30** |
| `POST` | `/admin/attempts/:id/rerun`           | Re-trigger grading on an already-graded or pending attempt. Body: `{ forceEscalate?: boolean }` (default true). When `forceEscalate=true`, runtime sets `GradingInput.force_escalate = true` so every AI-gradeable question routes through Stage 3 (grade-escalate skill / Opus) regardless of Stage 2's `needs_escalation` flag. Same heartbeat + single-flight gates as `/grade`. | **live 2026-05-03** |
| `POST` | `/admin/gradings/:id/override`        | Admin manual score correction. **Requires fresh MFA (5 min).** Body: `{ score_earned, reasoning_band?, ai_justification?, error_class?, reason }` — `reason` is mandatory. **D8 invariant: INSERTs a NEW row with `grader='admin_override'`, `override_of=<original.id>`, `override_reason`. NEVER UPDATEs the original.** Inherits `prompt_version_sha`/`label`/`model` from original (D4). 404 `AIG_GRADING_NOT_FOUND` if id not found / RLS-blocked. | **live 2026-05-03** |
| `GET`  | `/admin/dashboard/queue`              | Grading queue snapshot — attempts with `status IN ('submitted','auto_submitted','pending_admin_grading')` (`auto_submitted` added 2026-10-03). JOIN: attempts → assessments → levels → users. RLS-scoped. Optional `?status=...&limit=...` filters (`limit` 1 to 100). Response: `{ items, counts }`. `counts` (added 2026-10-03) = `{ in_queue, awaiting_evaluation, ready_to_publish }`: totals for the whole tenant, not capped by `limit` and not changed by `status`. `in_queue` = the list predicate; `awaiting_evaluation` = `in_queue` + `graded` with no evaluation release; `ready_to_publish` = `graded` with the evaluation released. | **live 2026-05-03** |
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
| `AIG_ATTEMPT_NOT_RELEASABLE_ERASED` | 422 | `/release` (candidate DPDP/GDPR-erased — `users.erased_at IS NOT NULL`; gate added 2026-05-30) |
| `AIG_ATTEMPT_NOT_FOUND` | 404 | `/grade`, claim/release (RLS-filtered or absent) |
| `AIG_GRADING_NOT_FOUND` | 404 | `/override` (id not found / RLS-blocked) |
| `AIG_INVALID_BODY` | 422 | `/accept` (ACCEPT_BODY_SCHEMA fail: missing `proposals` array / empty array / proposal field shape; OR proposal.attempt_id mismatch URL; OR proposal.question_id ∉ attempt_questions) |
| `AIG_STAGE1_DEGRADED` | n/a | runtime tag on `band.error_class` when Stage 1 (`submit_anchors`) failed schema validation even after tolerant coercion. Surfaces via `deriveStatus()` → `review_needed`. The admin sees a band-only verdict and is expected to Re-run or Override. Never persisted on a separate field — read from `gradings.error_class`. |
| `AIG_SCHEMA_VIOLATION` | 503 | runtime: stream-json missing tool_use OR Zod parse fail on submit_anchors / submit_band |
| `AIG_RUNTIME_FAILURE` | 503 | runtime: `claude` subprocess timeout (120s) / non-zero exit / spawn error |
| `AIG_ESCALATION_FAILURE` | 503 | runtime: Stage 3 specific failure (caught + degraded — proposal still ships with `error_class='escalation_failure'`, Stage 2 band primary) |
| `AIG_SKILL_NOT_FOUND` | 503 | runtime: `~/.claude/skills/<name>/SKILL.md` absent on the VPS |
| `AIG_RUNTIME_NOT_IMPLEMENTED` | 503 | `/grading-jobs/:id/retry` in claude-code-vps mode; runtime-selector default branch on unknown mode |
| `AIG_FRESH_MFA_REQUIRED` | 401 | `/override` route layer (`requireFreshMfa({maxAge: 5min})` middleware reject) |
| `VALIDATION_FAILED` | 400 | All routes (Zod body / query parse fail) — `details.issues` carries the Zod issue list |

#### `AIG_EVAL_GATE` (409, 07)

**History:** added in the 2026-10-02 batch 5 notes.
- **What.** Returned by grade-all and re-run (including super-admin evaluations) before any AI call. This happens only when `AI_EVAL_GATE=enforce` (or an unknown value) and the current grading skill shas match no blessed baseline. `details.current = { anchors, band, escalate }`. In `warn` (default) it is only logged as `grading.eval_gate.unapproved`.
- **Not included.** Question generation is never gated.

#### `AIG_ESCALATION_FAILURE` on high-stakes grading (07)

**History:** added in the 2026-10-02 batch 5 notes.
- **What.** Not a new route. For a high-stakes assessment, a failed Stage 3 now returns this code on the proposal. Status then derives to `review_needed`, and the FE keeps the proposal out of "Accept all".

#### `GET /api/admin/super/eval-gate` (07, super admin)

**History:** added in the 2026-10-02 batch 5 notes.
- **Response.** `{ mode: "off"|"warn"|"enforce", approved: boolean, current: {anchors, band, escalate}, baseline_date: string|null }`. Read-only. `baseline_date` is the file name (date) of the approving baseline.

#### `GET /api/admin/super/grading-quality?days=90` (07, super admin)

**History:** added in the 2026-10-02 batch 5 notes.
- **Query.** `days` integer 1..730, default 90. Bad query gives 400.
- **Response.** `{ days, items: [{ prompt_version_sha, ai_grades, overrides, override_rate, mean_abs_band_delta, mean_abs_score_delta_pct }] }`. `override_rate` is null with no AI rows. Cross-tenant aggregate, no candidate data, read-only transaction.

#### Admin attempt detail: `section_scores`

**History:** added in the 2026-10-02 batch 5 notes.
- **What.** `GET /api/admin/attempts/:id` adds `section_scores: [{ index, name, earned, max }]`, from 09 `getSectionScoresForAttempt`. Empty array when the assessment has no sections or the score is not visible (not released to the tenant).
- **Impact.** The attempt page shows a "Section scores" table (score and %).

#### `cli_version` and `stage_inputs` on accept (07; RW-41)

**History:** added in the S9 notes of 2026-10-11.

Commit `45e95e0`. The accept body (`POST /api/admin/attempts/:id/accept` and `POST /api/admin/super/evaluations/:attemptId/accept`) may carry optional `cli_version` (string, max 200) and `stage_inputs` (`{anchors, band, escalate}`, max 64 KiB) on each proposal. The route schema accepts them so older and newer clients both pass validation. **The server ignores them.** It copies both values from the server-side `attempts.ai_proposals` cache for the same `question_id` and writes them to `gradings`. A client cannot set or change them. **Why.** Provenance must not depend on the browser. **Not included.** No response field and no UI. Details: `docs/05-ai-pipeline.md` D4 and `docs/02-data-model.md` Grading & scoring.

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
| `GET`  | `/admin/attempts/:id/score`           | Return cached `AttemptScore` row or compute on demand. **Does NOT require fresh MFA.** Response: `{ score: { attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, archetype_signals, computed_at } \| null }`. **Since 2026-10-01 (`76c3014`): `score` is `null` until the result is released to the tenant** (`status = 'released'`, or `'graded'` with `evaluation_released_at` set), and also `null` (200, not 404) when the attempt is absent or RLS-blocked. The cohort / individual / leaderboard reports below apply the same rule. | **live 2026-05-01; release gate 2026-10-01** |
| `GET`  | `/admin/reports/cohort/:assessmentId` | Cohort-level stats for an assessment from `attempt_scores`. Response: `{ attempt_count, average_pct, p50, p75, p90, archetype_distribution: Record<string,number> }`. `attempt_count=0` → all percentile fields null + `archetype_distribution={}`. | **live 2026-05-01** |
| `GET`  | `/admin/reports/individual/:userId`   | All scored attempts for a user across assessments (RW-20). Response: `{ report: IndividualReport }` where `IndividualReport` includes user name (optional), cohort details, and array of `IndividualScore` rows (each: `attempt_id, assessment_id, auto_pct, archetype, computed_at`). RLS-scoped to tenant. | **live 2026-05-01; response shape updated RW-20** |
| `GET`  | `/admin/reports/leaderboard/:assessmentId?topN=10&anonymize=false` | Top-N attempts ordered by `auto_pct DESC`. `topN` range: 1–200 (default 10). `anonymize=true` redacts `candidate_name` and `candidate_email` to null. **Admin-only.** No public cross-tenant view (P2.D13). Response: `LeaderboardRow[]` (each: `rank, attempt_id, candidate_name, candidate_email, auto_pct, archetype, computed_at`). | **live 2026-05-01** |
| `GET`  | `/admin/dashboard/summary`            | Headline KPIs for current tenant | **planned** |
| `GET`  | `/admin/reports/topic-heatmap`        | Strong/weak topics across team | **live 2026-05-xx (15-analytics), no admin UI caller — see FU-C5 note below** |
| `GET`  | `/admin/reports/export.csv`           | CSV export of attempts (with filters) | **live as `/admin/reports/exports/attempts.{csv,jsonl}` (15-analytics), no admin UI caller** |

> **FU-C5 (2026-10-06): which report routes have a UI, which are parked.** The three rows above were stale ("planned"). `modules/15-analytics/src/routes.ts` has shipped `topic-heatmap`, `archetype-distribution/:assessmentId`, `cost-by-month`, `exports/attempts.csv`, `exports/attempts.jsonl` and `exports/topic-heatmap.csv` since Phase 3 G3.C. None of the six has an `modules/10-admin-dashboard` caller today (checked 2026-10-06: no match for any of these paths under `modules/10-admin-dashboard/src`). You can reach them only by a direct API call. `cost-by-month` is additionally empty-shape in `claude-code-vps` mode (D2, see `docs/05-ai-pipeline.md`). The cohort/individual routes just above (live, UI-backed) are a *separate*, independent implementation in 09-scoring — see `modules/15-analytics/SKILL.md` D4.

> **FU-C1 (2026-10-06) — `GET /admin/dashboard/queue` `counts` extended; Evaluation status page.** `counts` (07 `countGradingQueue`) now also returns `oldest_waiting_submitted_at` (ISO or null; `MIN(submitted_at)` of attempts not yet `graded`, same query) and `by_assessment[]` (`{ assessment_id, assessment_name, in_queue, awaiting_evaluation, ready_to_publish }`, one row per assessment with a counted attempt, same status list, RLS-scoped). The page `/admin/grading-jobs` ("Evaluation status", menu label renamed from "Grading") reads `?limit=1`. It shows the three counts, the age of the oldest waiting attempt, the per-assessment rows and a short explainer. Read-only: no new AI call path. Why: tenants had no view of queue position (RS6 FR8). Rejected: a new route (the dashboard query already had the counts); a promised turnaround number (none is defined, so the text tells the user to contact the operator). Not included: per-candidate position; a `pending_admin_grading` status change (FR8 status review still open). Downstream: `dashboard.tsx` ignores the new fields; help keys `admin.grading.jobs.{counts,oldest,by_assessment}` (migration `0158`).

#### Scoring endpoints — error contract

| `details.code` | HTTP | Where |
|---|---|---|
| `SCORING_ATTEMPT_NOT_FOUND` | 404 | `/admin/attempts/:id/score` — attempt absent / RLS-blocked |
| `VALIDATION_FAILED` | 400 | `/admin/reports/leaderboard/:id` — invalid `topN` / `anonymize` query params |

#### `GET /api/admin/assessments/:id/results.csv`: section columns

**History:** added in the 2026-10-02 batch 5 notes.
- **What.** After the existing columns, one column per section named `Section: <name> (%)` (names from `settings.sections`). Blank when the row's score is not visible. Sort and other params unchanged.
- **Not included.** No per-section rank or earned/max columns.

### Admin — Webhooks, API keys, embed secrets

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/api-keys`                | List API keys (no plaintext) |
| `POST` | `/admin/api-keys`                | Create — returns plaintext **once** |
| `DELETE`| `/admin/api-keys/:id`           | Revoke |
| `GET`  | `/admin/embed-secrets`           | List embed secrets |
| `POST` | `/admin/embed-secrets`           | Create — returns plaintext **once** |
| `POST` | `/admin/embed-secrets/:id/rotate`| Rotate (90-day grace) |
| `GET`    | `/admin/email-queue`                       | This tenant's bulk emails held back by the daily cap (`EMAIL_BULK_DAILY_CAP`, default 250, IST day): `{ queuedCount, nextSendAt \| null, dailyCap, sentToday }`. Admin session, tenant from the session. Sign-in codes are never held — **live 2026-10-19** |
| `GET`    | `/admin/webhooks`                          | List webhook endpoints for tenant — **live 2026-05-03** |
| `POST`   | `/admin/webhooks`                          | Create endpoint — returns `{ endpoint, secret }` (secret ONCE); `audit.*` events require fresh MFA (≤5 min) → `401 FRESH_MFA_REQUIRED` otherwise — **live 2026-05-03** |
| `DELETE` | `/admin/webhooks/:id`                      | Delete webhook endpoint — **live 2026-05-03** |
| `POST`   | `/admin/webhooks/:id/test`                 | Send synthetic `test.ping` event — **live 2026-05-03** |
| `GET`    | `/admin/webhooks/deliveries`               | Delivery history (optional `?endpointId=<uuid>&status=pending\|delivered\|failed`) — **live 2026-05-03** |
| `POST`   | `/admin/webhooks/deliveries/:id/replay`    | Replay a delivery (append-only, new row) — **live 2026-05-03** |
| `GET`    | `/admin/webhook-failures`                  | Convenience alias: deliveries with `status=failed` — **live 2026-05-03** |
| `POST`   | `/admin/webhook-failures/:id/retry`        | Convenience alias for replay — **live 2026-05-03** |
| `GET`    | `/admin/notifications`                     | Short-poll in-app notifications (`?since=<ISO cursor>&limit=<n>`) — admin only (the any-role option `anyRoleAuth` was removed 2026-10-03) — **live 2026-05-03** |
| `POST`   | `/admin/notifications/:id/mark-read`       | Mark notification read — admin only (since 2026-10-03) — **live 2026-05-03** |

### Admin — Audit & help authoring

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/audit`                   | Audit log. Query params (all optional): `actorUserId` (UUID), `actorKind` (`user`\|`system`), `action` (string), `entityType` (string), `entityId` (UUID), `from` (ISO date), `to` (ISO date), `page` (default 1), `pageSize` (default 50, max 200). Response `{ rows, total, page, pageSize }`. 400 on a bad query. **mounted 2026-10-09 (FU-B1)** |
| `GET`  | `/admin/audit/export.csv`        | Stream audit log as CSV. Same query params as `GET /admin/audit` (all optional). Response: `Content-Type: text/csv`, `Content-Disposition: attachment; filename="audit-<tenantPrefix>.csv"`. **live 2026-05-03** |
| `GET`  | `/admin/audit/export.jsonl`      | Stream audit log as JSON Lines. Same query params. Response: `Content-Type: application/x-ndjson`, `Content-Disposition: attachment; filename="audit-<tenantPrefix>.jsonl"`. **live 2026-05-03** |
| `GET`  | `/admin/audit/archives`          | List S3 audit archives for the tenant. **Phase 4 placeholder** — returns `{ archives: [], note: "S3 archive not configured (Phase 4)" }` when `S3_BUCKET` is unset. **live (stub) 2026-05-03** |
| `POST` | `/admin/audit/archives/:date/restore` | Restore (stream-download) an audit archive for the given date. `:date` format: `YYYY-MM-DD`. **Phase 4 placeholder** — returns `503 S3_NOT_CONFIGURED` when `S3_BUCKET` is unset. **live (stub) 2026-05-03** |
| `GET`  | `/admin/help?locale=`            | List help rows: `{ entries: HelpEntry[] }`, the newest active version per (tenant arm, key, locale); globals plus the caller's company overrides. Admin. — **live 2026-10-06 (FU-D1)** |
| `GET`  | `/admin/help/export?locale=`     | Export help rows for translation (admin only). Since 2026-10-06 one row per (tenant arm, key, locale): the newest active version. — **live 2026-05-02** |
| `PATCH`| `/admin/help/:key`               | Company override: new version of the caller's tenant row (creates new version) — **live 2026-05-02** |
| `PATCH`| `/admin/help/global/:key`        | **super_admin only.** New version of the GLOBAL row (`tenant_id IS NULL`); body `{ audience, locale?, shortText, longMd? }`; runs under `assessiq_system` (the app role cannot insert a NULL tenant row); one `help.content.updated` audit row with `after.scope = "global"` in the same tx. 400 `INVALID_HELP_KEY` on a bad key. — **live 2026-10-06 (FU-D2)** |
| `POST` | `/admin/help/import?locale=`     | Bulk upsert help rows from translation (admin only) — **live 2026-05-02** |

> **FU-D1/D2/D3 (2026-10-06) — help authoring page aligned.** `modules/10-admin-dashboard/src/pages/help-content.tsx` called four paths that never existed (`/admin/help-content*`, RV74 allowlist). It now calls the rows above; the four allowlist lines are gone. Why a list route: export was the only list and returned every version. Rejected: renaming the server routes to `/help-content` (breaks the translation import tooling). Not included: Markdown rendering in the editor; a diff view between versions; a tenant-side menu entry. The FR14 owner decision of 2026-10-03 says only the platform edits help. So the "Help content" menu entry is super-admin only. You can still reach the company-override route by URL. Downstream: `modules/16-help-system/SKILL.md` § "Admin authoring routes".

> **FU-B1 (2026-10-09) — the five audit routes are mounted.** `modules/14-audit-log/src/routes.ts` existed since Phase 3 G3.A. But `apps/api/src/server.ts` never called `registerAuditRoutes`, so the table above described routes that answered 404 in production. The mount uses the admin chain (`authChain({ roles: ['admin'] })`): no session 401, candidate 403, tenant admin 200. Every read goes through `withTenant` (RLS, tenant id from the session, never from the URL). No route writes `audit_log`; the append-only invariant is unchanged. The two archive routes stay stubs: list answers `{ archives: [] }` and restore answers `503 S3_NOT_CONFIGURED` until the S3 archive exists (FU-B4 parked). Rejected: a super-admin cross-tenant view (the routes read one tenant; a platform view is a separate design). Not included: the "Audit trail" admin page (FU-B2, kit gap approval open); the `admin.audit*` help text still says "available soon" (FU-B3). Test: `apps/api/src/__tests__/routes/audit-routes.test.ts` (15 cases: 401, 403, 200, 400, file headers, stub codes). Adversarial review (codex, 2026-10-09) found one High: the two exports ignored `Readable.push()` backpressure. A slow client therefore made the cursor loop buffer the whole tenant log in memory. Fixed in `modules/14-audit-log/src/service.ts` (`lineStream`): each row write waits for the consumer. The code remembers a read that arrives while nothing waits (no lost wake-up). The code cuts off a consumer that reads nothing for 60 s (`EXPORT_IDLE_TIMEOUT_MS`), so the cursor transaction rolls back and the DB client is released. Output (header line, newest-first order, EOF) is unchanged. Test: `modules/14-audit-log/src/__tests__/export-backpressure.test.ts` (4 cases). Not proven by these tests: real RLS or real session loading (both are mocked); the module 14 RLS tests cover the policy. Downstream: `modules/14-audit-log/SKILL.md` § Status.

### Admin — Worker observability

> **FU-D9/FU-D10 (2026-10-06) — the routes now have a screen.** The Platform page (`/admin/platform`, super admin) has a "Background jobs" section (`modules/10-admin-dashboard/src/pages/platform/BackgroundJobsSection.tsx`). The section reads `GET /admin/worker/stats` and `GET /admin/worker/failed`. It posts `/admin/worker/failed/:id/retry`. Help keys moved from `admin.worker*` to `admin.platform.jobs*` by migration `0158` so they load under the page prefix. Why a section, not a tab: the design kit has no tab recipe; the Platform page is a stack of sections. Rejected: a separate `/admin/worker` page (one more menu entry for three routes). Not included: pagination of failed jobs (server caps at 50), auto-refresh (manual Refresh button). Downstream: none; the routes are unchanged.


> **Status: live 2026-05-02 (Session 4b.2 — Worker hardening).** Three admin-gated routes show BullMQ queue state for the `assessiq-cron` queue (the single queue that `apps/api/src/worker.ts` drives). Mounted via `registerAdminWorkerRoutes(app, { adminOnly: authChain({ roles: ['admin'] }) })` in [apps/api/src/server.ts](../apps/api/src/server.ts). All three return 401 `AUTHN_FAILED` without a session and 403 `AUTHZ_FAILED` for non-admin roles.
>
> **Tenant scoping:** queue stats are infra-global. BullMQ has no per-tenant column — `assessiq-cron` is shared across all tenants. The two current job types (`assessment-boundary-cron`, `attempt-timer-sweep`) iterate over all tenants internally. They carry NO `tenant_id` in their job payload, so the `/failed` endpoint reveals no cross-tenant data today. If a future job DOES carry a `tenant_id` payload, the `/failed` handler MUST gain a per-tenant filter on those job names. See the comment block in [apps/api/src/routes/admin-worker.ts](../apps/api/src/routes/admin-worker.ts) above the failed-job route.
> **Gate change (FR17, 2026-10-03, commit `59a4816`):** all three worker routes now require `super_admin` (`authChain({ roles: ['super_admin'] })` in `apps/api/src/server.ts`). A tenant admin gets 403. The queue is shared by every tenant. No screen uses these routes. The `roles: ['admin']` text above is the original 2026-05-02 gate.
>

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
| `GET` | `/api/admin/super/ai-generate-mode` | Platform-wide default a tenant falls back to when its override is null (FU-D27) | **live 2026-10-06** |
| `POST` | `/api/admin/super/companies` | Provision new company tenant + send first-admin invitation | **live 2026-05-17** |
| `POST` | `/api/admin/super/tenants/:tenantId/invitations/resend` | Re-issue a pending admin invitation for an existing tenant | **live 2026-05-20** |
| `GET` | `/api/admin/super/tenants` | List all provisioned tenants (A2: `usage`; Phase B: `admin_count`, `reviewer_count`; `admin_invitation_expires_at`; Edit-admin: `admin_user_id`, `admin_role`, `admin_invitation_id`; `?include_archived=true`) | **live 2026-05-17** · Edit-admin fields **PR-pending** |
| `GET` | `/api/admin/super/tenants/:tenantId/billing` | Full billing detail for one tenant (A2) | **live 2026-05-17** |
| `GET` | `/api/admin/super/tenants/:tenantId/billing/export.csv` | Export all billing events as CSV (A2) | **live 2026-05-17** |
| `PATCH` | `/api/admin/super/tenants/:tenantId/plan` | Update a tenant's tier and/or credit allowance (A2) | **live 2026-05-17** |
| `GET` | `/api/admin/super/tenants/:tenantId/entitlements` | List all entitlement rows for a tenant (incl. revoked) (B1) | **live 2026-05-18** |
| `POST` | `/api/admin/super/tenants/:tenantId/entitlements` | Grant a domain or pack entitlement (idempotent; reactivates revoked) (B1) | **live 2026-05-18** |
| `DELETE` | `/api/admin/super/tenants/:tenantId/entitlements` | Revoke an entitlement (JSON body — see below) (B1) | **live 2026-05-18** |
| `POST` | `/api/admin/super/tenants/:tenantId/suspend` | Tenant lifecycle: `active → suspended` (revokes all sessions) | **live 2026-05-20** |
| `POST` | `/api/admin/super/tenants/:tenantId/resume` | Tenant lifecycle: `suspended → active` | **live 2026-05-20** |
| `POST` | `/api/admin/super/tenants/:tenantId/archive` | Tenant lifecycle: `active\|suspended → archived` (revokes all sessions) | **live 2026-05-20** |
| `POST` | `/api/admin/super/tenants/:tenantId/unarchive` | Tenant lifecycle: `archived → active` | **live 2026-05-20** |
| `GET` | `/api/admin/super/domains` | List the platform domain library (all statuses) for the management UI | **live 2026-05-25** |
| `POST` | `/api/admin/super/domains` | Create a platform domain + propagate to every tenant (fresh MFA) | **live 2026-05-25** |
| `PATCH` | `/api/admin/super/domains/:id` | Archive/reactivate a platform domain + propagate (catalog-only; fresh MFA) | **live 2026-05-25** |
| `GET` | `/api/admin/super/frameworks/seeds` | List the bundled framework seeds with the loaded version | **live (RW-57 part 1, S10, 2026-10-15)** |
| `POST` | `/api/admin/super/frameworks/seeds/:code/load` | Load one bundled framework seed (idempotent) | **live (RW-57 part 1, S10, 2026-10-15)** |
| `POST` | `/api/admin/super/question-imports` | Upload a CSV or XLSX file (multipart, or JSON base64). Stages and validates it | **live (RW-58, S10, 2026-10-16; multipart RW-97, S11)** |
| `GET` | `/api/admin/super/question-imports/templates/:type` | Download the CSV or XLSX template of one question type | **live (RW-58, S10, 2026-10-16)** |
| `GET` | `/api/admin/super/question-imports/:id` | Read the report of one import | **live (RW-58, S10, 2026-10-16)** |
| `PATCH` | `/api/admin/super/question-imports/:id/rows/:row` | Fix or skip one row | **live (RW-58, S10, 2026-10-16)** |
| `POST` | `/api/admin/super/question-imports/:id/commit` | Create one draft pack from the ok rows | **live (RW-58, S10, 2026-10-16)** |
| `POST` | `/api/admin/super/question-imports/:id/discard` | Discard a staged import | **live (RW-58, S10, 2026-10-16)** |
| `POST` | `/api/admin/super/questions/:id/withdraw` | Take a question down: rights withdrawn, status archived | **live (EXP-2, 2026-10-17)** |
| `GET` | `/api/admin/super/tenants/:tenantId/users` | List users + pending invitations for a tenant (Phase C) | **live 2026-05-20** |
| `POST` | `/api/admin/super/users/:userId/disable` | Super-admin user disable; LAST_ADMIN override path | **live 2026-05-20** |
| `POST` | `/api/admin/super/users/:userId/reenable` | Super-admin user reenable | **live 2026-05-20** |
| `DELETE` | `/api/admin/super/users/:userId` | Super-admin soft-delete; LAST_ADMIN override path | **live 2026-05-20** |
| `POST` | `/api/admin/super/users/:userId/restore` | Super-admin restore soft-deleted user | **live 2026-05-20** |
| `POST` | `/api/admin/super/tenants/:tenantId/users/:userId/totp/reset` | Super-admin force-reset of a user's two-factor (RW-45; see below) | **S10, 2026-10-15** |
| `DELETE` | `/api/admin/super/users/invitations/:invitationId` | Super-admin cancel pending invitation | **live 2026-05-20** |
| `PATCH` | `/api/admin/super/users/:userId` | Super-admin edit of a tenant user (name / role / email); identity-transfer guard on email | **live 2026-05-24** |
| `PATCH` | `/api/admin/super/tenants/:tenantId` | Super-admin rename a tenant's display name (`tenants.name`); slug unchanged | **branch `feat/platform-edit-company`, PR-pending** |

#### `PATCH /api/admin/super/tenants/:tenantId` (rename company)

Renames a tenant's display name (the `tenants.name` column) from the Platform page "Manage ▸ Edit company" modal. Display-only: the **slug is permanent** and is not touched here; no isolation/RLS/session/login impact.

**Auth:** `super_admin` + **fresh MFA** (401 `fresh totp` → MfaStepUp). **Body:** `{ name }` (1–200 chars, non-empty after trim). Mirrors the `suspendTenant` audited pattern — `withTenant(tenantId)` row-locks (`SELECT … FOR UPDATE`), `UPDATE tenants SET name`, and `auditInTx('tenant.renamed', before/after)` in one transaction. A name equal to the current one short-circuits to `noOp:true` (no write, no audit) — making a post-MFA retry idempotent.

**Response 200:** `{ tenantId, name, previousName, auditId, noOp }`. **400:** `MISSING_NAME` / `NAME_TOO_LONG`. **404:** tenant not found. New audit action `tenant.renamed` added to the `14-audit-log` catalog.

#### `PATCH /api/admin/tenant` (tenant admin renames own company)

Lets a **tenant admin** change their own company's display name (`tenants.name`) from `/admin/settings` ("Company name" card). Implemented in `apps/api/src/routes/admin-tenant-settings.ts` -> `renameTenant` (`modules/02-tenancy/src/service.ts`).

**Auth:** `authChain({ roles: ['admin'] })` — reviewer / candidate / `super_admin` get 403 (super-admins use `PATCH /api/admin/super/tenants/:tenantId`). No fresh-MFA requirement (display-only, audited). **The tenant is always `session.tenantId`** — a `tenantId`/`id`/`slug` in the body is ignored; there is no URL param. `assertTenantActive` runs first (suspended/archived -> 409 `TENANT_NOT_ACTIVE`).

**Body:** `{ name: string }`. Server normalises: collapse whitespace runs to one space, trim, reject control characters, 2-120 chars. `UPDATE tenants SET name` + exactly one `tenant.renamed` audit row commit in one `withTenant` tx (row locked `FOR UPDATE`); same name -> `noOp:true`, no write, no audit. Slug / id / status / login routing are never touched.

**Response 200:** `{ tenantId, name, previousName, auditId, noOp }`. **400:** `MISSING_NAME` / `INVALID_NAME_CHARS` / `INVALID_NAME_LENGTH`. **403:** wrong role. **409:** `TENANT_NOT_ACTIVE`.

`GET /api/auth/whoami` now also returns `tenant.name` (additive) so the admin shell header can show the company name; the SPA refreshes whoami after a successful rename. Audit note: `redact.ts` redacts `name` keys, so the audit payload records that a rename happened, not the old/new text.

#### `PATCH /api/admin/super/users/:userId` (Edit admin)

Edits a tenant user's profile from the Platform page "Manage ▸ Edit admin" inline modal. Targets the primary-contact admin shown on each row (`admin_user_id`).

**Auth:** `super_admin` + **fresh MFA** (`superAdminFreshMfa`, TOTP within 15 min). A stale TOTP returns `401` with a `fresh totp` message → the UI shows the MFA step-up sub-form and retries (same UX as create-company).

**Path params:** `userId` — the target user's UUID. The tenant is resolved server-side via `resolveUserTenant` (system-role read); all writes run under `withTenant(targetTenantId)`. `session.tenantId` (the platform tenant) is never used for the data operation.

**Body** (all fields optional; at least one effective change required):

| Field | Type | Notes |
|---|---|---|
| `name` | string | 1–200 chars. |
| `role` | `"admin"` | `reviewer` (removed 2026-10-03), `candidate` and `super_admin` are rejected (400 `INVALID_ROLE`). |
| `email` | string | The **login identity** (Google SSO resolves a user purely by Google-verified email). See semantics below. |
| `confirmEmailIdentityChange` | boolean | Required `true` when changing the email of a **non-pending** account (`active` or `disabled`). |
| `reason` | string | Optional, recorded in the audit row. |

**Email-change semantics (load-bearing — see `docs/04-auth-flows.md`):**
- **Pending** admin (invite not yet accepted): the old-address invitation is retired in-transaction and a fresh invite is re-issued to the new address post-commit (`reinvited:true`). A post-commit send failure still returns `200` with `reinvited:false` (the rename committed; recover via "Resend invite").
- **Active/disabled** admin: requires `confirmEmailIdentityChange:true`. Transfers the login identity — the user's sessions are swept (forced re-login) and the stale Google `oauth_identities` link is removed (`sessionsSwept:true`).
- A role change on a live user also sweeps sessions to drop stale role claims.

**Guards:** the old `409 LAST_ADMIN` guard (demote the only admin to reviewer) is gone with the demotion path (2026-10-03). New email colliding with an existing user in the same tenant → `409 USER_EMAIL_EXISTS`. Editing a `super_admin` user → `400 CANNOT_EDIT_SUPER_ADMIN`. Editing a soft-deleted user → `409 USER_DELETED`. Editing a target whose role is not `admin` (a `candidate`, or a legacy `reviewer` row) → `400 INVALID_ROLE` with `details.role` = the actual role (Y-4, 2026-10-16). Before Y-4, the row passed a false `admin` type through to the audit event and the response. Every change writes one `audit_log` row (`user.updated`, `kind:'super_profile_edit'`) in the same transaction.

**Response 200:** `{ userId, email, name, role, previousEmail, emailChanged, status, sessionsSwept, reinvited, auditId }`

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

#### `GET /api/admin/super/ai-generate-mode` (FU-D27, 2026-10-06)

Read-only. Returns `{ global_default: "omnibus" | "sharded" }` — the live value of `config.AI_GENERATE_MODE` (the platform default used when a tenant's `ai_generate_mode` override is `null`). Replaces the hardcoded `"omnibus"` string the admin UI previously showed. **Auth:** `super_admin` only, same gate as the PATCH above. No path/body params.
**Response 403:** `AUTHZ_FAILED` — caller is not `super_admin`.
**Response 404:** target tenant's `tenant_settings` row is absent.

**Audit:** Emits `tenant_settings.ai_generate_mode.updated` (ACTION_CATALOG in `modules/14-audit-log/src/types.ts`). The `UPDATE` and the `audit_log` INSERT share a single Postgres transaction — the UPDATE rolls back if the INSERT fails.

**Design ref:** `docs/design/2026-05-10-stage-3-promotion-rollout.md` §3.

**Source:** `apps/api/src/routes/admin-super.ts:41`, `modules/02-tenancy/src/service.ts` (`updateAiGenerateMode`).

#### `POST /api/admin/super/companies`

Provisions a new company tenant and sends a first-admin invitation email. Requires fresh TOTP (verified within 15 minutes).

**Auth:** `super_admin` + fresh MFA. Returns `401 AUTHN_FAILED` with message containing `"fresh totp"` if MFA is stale (triggers in-form step-up on the frontend, not a redirect).

**Body:**
```json
{ "name": "string", "slug": "string", "domain": "string (optional)", "adminEmail": "string", "adminName": "string (optional)" }
```

**Response 201:**
```json
{
  "tenantId": "uuid",
  "slug": "acme-corp",
  "name": "Acme Corp",
  "status": "active",
  "invitation": { "id": "uuid", "email": "admin@acme.com", "role": "admin", "expires_at": "2026-05-20T10:00:00Z" }
}
```
A `201` is only returned after the tenant is provisioned **and** activated, so `status` is always `"active"` here. If seeding or the invitation step fails the tenant is left at `provisioning` and the call returns an error (not a `201`). `invitation` may be `null` if the invitation row could not be created.

**Response 400:** `details.code` one of `MISSING_NAME` | `INVALID_SLUG` | `MISSING_ADMIN_EMAIL`.
**Response 401:** `code = "AUTHN_FAILED"`, message contains `"fresh totp"` — MFA freshness expired; frontend shows step-up prompt.
**Response 409:** `details.code = "TENANT_SLUG_CONFLICT"` — slug already taken.

**Source:** `apps/api/src/routes/admin-super.ts`.

#### `POST /api/admin/super/tenants/:tenantId/invitations/resend`

Re-issue a pending admin invitation for an existing tenant when the original magic link expired, was lost, or the recipient never received it. The route reuses the canonical `inviteUser()` re-invite path. The path deletes the existing pending invitation and mints a fresh token. It sends the invitation email again (same 7-day TTL). The new token *invalidates* the old one (same email = same pending row gets replaced).

**Why this exists, not `PATCH /companies`:** A super-admin who just provisioned a company must not need to run the entire `POST /companies` flow again to get a new invitation token. That flow would return 409 on the slug. This route is the surgical fix.

**Why it is idempotent (in effect):** If you call it twice in a row, it produces two emails, but only the second token is valid. The second call replaces the first pending invitation. The user cannot end up with two simultaneous live tokens for the same email.

**Auth:** `super_admin` + **fresh MFA** (15-minute window) — same gate as `POST /companies` because this is privilege-granting (the magic link grants admin role on accept). A stale-TOTP session cannot blast invite emails.

**Request body:** `{}` — no parameters. The tenant is identified by the URL `:tenantId`; the recipient email is read server-side from the tenant's first admin row (the earliest-created `role='admin'` user). Looking up the email from the DB rather than trusting the request body prevents a CSRF-style "resend to attacker email" abuse.

**Tenant scoping:** the email lookup is scoped by `WHERE u.tenant_id = $1` from the URL param, **never** from `session.tenantId`. The super-admin's session lives in the `platform` tenant; the lookup must use the target tenant.

**Response 200:**
```json
{
  "invitation": {
    "id": "uuid",
    "email": "admin@acme.com",
    "role": "admin",
    "expires_at": "2026-05-27T10:00:00Z"
  }
}
```

**Response 401:** `code = "AUTHN_FAILED"`, message contains `"fresh totp"` — MFA freshness expired; frontend shows step-up prompt (same pattern as `POST /companies`).
**Response 404:** `details.code = "NO_PENDING_ADMIN"` — the tenant has no admin user (`role='admin'`) to resend to. Possible causes: tenant predates the C4 super-admin onboarding contract; admin was hard-deleted.
**Response 409:** `details.code = "ADMIN_ALREADY_ACCEPTED"` — the admin's `users.status` is already `active`. The frontend should refetch the tenants list — the row stale.
**Response 409:** `details.code = "ADMIN_DISABLED_OR_DELETED"` — admin is disabled (`status='disabled'`) or soft-deleted (`deleted_at IS NOT NULL`). Operator must restore/enable before re-inviting (matches `inviteUser` semantics from addendum § 3).
**Response 403:** caller is not `super_admin`.

**Audit:** two rows are written for one successful call (intentional — different query surfaces):
- `user.invited` with `kind='reinvite'` — written inside `inviteUser` via `auditInTx`, scoped to the target tenant. Surfaces "who has been re-invited within tenant X".
- `admin.invitation.resent` — written by the route handler via `audit()` after `inviteUser` succeeds, scoped to the super-admin's `platform` tenant. Surfaces "what cross-tenant resend actions has super-admin Y taken".

**Source:** `apps/api/src/routes/admin-super.ts`. Catalog entry: `modules/14-audit-log/src/types.ts` `ACTION_CATALOG`.

#### `GET /api/admin/super/tenants`

Returns all provisioned tenants. Read-only, no pagination in v1.

**Auth:** `super_admin` only.

**Response 200:** each tenant also carries its **first admin** (earliest `users` row with `role='admin'` in that tenant — the person invited at company-creation). `admin_*` are `null` for tenants with no admin user (for example, the `platform` tenant, whose operator is `super_admin`). `admin_status` is `pending` until the admin accepts the invite, then `active`.

**2026-05-20 addition.** Each row also carries `admin_invitation_expires_at: string | null`, sourced from a second `LEFT JOIN LATERAL` against `user_invitations` scoped to `(tenant_id, lower(email), accepted_at IS NULL)` (matches the partial index in `021_user_invitations.sql`; cross-tenant safe). Non-null only while `admin_status === 'pending'`; the Platform UI uses it to render an "Invite pending · expires …" Chip and gate the new Resend-invite action.

**A2 extension:** each tenant object now also carries a `usage` summary field:

```ts
usage: {
  tier: "free" | "pro" | "enterprise" | "internal",
  included_credits: number | null,   // null = unlimited (internal tier)
  used: number,
  remaining: number | null,          // null when unlimited; negative = overage magnitude
  overage: number,
  status: "ok" | "warn" | "over" | "unlimited"
} | null
```

`usage` is `null` when the service could not compute the per-tenant billing aggregate. This is best-effort: the endpoint never fails the whole list because one tenant has no billing row.

```json
{ "tenants": [{
  "id": "uuid", "slug": "acme-corp", "name": "Acme Corp",
  "status": "active", "created_at": "2026-05-17T10:00:00Z",
  "admin_email": "admin@acme.com", "admin_name": "Acme Admin", "admin_status": "pending",
  "usage": { "tier": "free", "included_credits": 50, "used": 43, "remaining": 7, "overage": 0, "status": "warn" }
}] }
```

Implementation: `LEFT JOIN LATERAL` against `users` under `SET LOCAL ROLE assessiq_system` (BYPASSRLS — the established cross-tenant system-role pattern for this endpoint; no N+1). The `usage` aggregate is a second lateral join (or a subquery) against `tenant_plans` + `billing_events`, also under the system role.

**Source:** `apps/api/src/routes/admin-super.ts`.

#### Tenant lifecycle endpoints (Phase B)

Shipped in commit `2af9849` (2026-05-20). All four endpoints are gated by `superAdminFreshMfa` — `super_admin` role + TOTP verified within **15 minutes**. When MFA is stale the route layer rejects with `401 AUTHN_FAILED`; the response body `details.code = 'FRESH_MFA_REQUIRED'` tells the frontend to render a step-up prompt.

Body parsing (`parseLifecycleBody`) rejects reason strings that exceed 500 characters. It also rejects a reason that is non-string or empty when provided. It rejects a reason with ASCII control characters, including NUL `\x00` (valid in jsonb, but it crashes SIEM tooling). These all return `400 INVALID_REASON`.

The shared response type is `LifecycleResponse` (from `modules/10-admin-dashboard/src/api.ts`):

```ts
{
  tenantId: string;
  slug: string;
  status: 'active' | 'suspended' | 'archived';
  previousStatus: 'active' | 'suspended' | 'archived';
  noOp: boolean;
  auditId: string | null;                                    // null on noOp
  sessionsRevoked?: { count: number; affectedUsers: string[] }; // suspend + archive only
}
```


#### `POST /api/admin/super/tenants/:tenantId/suspend`

Transitions the target tenant from `active` to `suspended`. Suspending a tenant blocks all future logins for that tenant's users and immediately destroys all active sessions.

**Auth:** `super_admin` + fresh TOTP (verified within 15 minutes). `401 AUTHN_FAILED` with `details.code = 'FRESH_MFA_REQUIRED'` when MFA is stale.

**Path params:** `tenantId` — UUID of the target tenant.

**Body:** `{ reason?: string }` (max 500 chars; NUL + ASCII control chars rejected with `400 INVALID_REASON`).

**Response 200:**
```json
{
  "tenantId": "uuid",
  "slug": "acme-corp",
  "status": "suspended",
  "previousStatus": "active",
  "noOp": false,
  "auditId": "uuid",
  "sessionsRevoked": { "count": 3, "affectedUsers": ["uuid1", "uuid2", "uuid3"] }
}
```

**Idempotency:** Already-suspended tenant returns `200` with `noOp: true`, `auditId: null`, and no `sessionsRevoked` field. No audit row is written and no session sweep is performed on a no-op call.

**Side effects (non-noOp only):** Calls `sessions.destroyAllForTenant(tenantId)` after the DB commit. Audit row written inside the `withTenant` transaction via `auditInTx` (UPDATE + audit INSERT are atomic). `logLifecycleEvent` fires at INFO level.

**Allowed source states:** `active` only. Any other source state raises `409 INVALID_LIFECYCLE_TRANSITION`.

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `INVALID_LIFECYCLE_TRANSITION` | 409 | Source state is not `active` |
| `INVALID_REASON` | 400 | reason is wrong type, too long, or contains control chars |
| `FRESH_MFA_REQUIRED` | 401 | TOTP not verified within 15 minutes |
| `TENANT_NOT_FOUND` | 404 | `tenantId` does not exist |

**Audit action emitted:** `tenant.suspended` (scoped to the target tenant's audit log).

**Source:** `apps/api/src/routes/admin-super.ts:471`, `modules/02-tenancy/src/service.ts` (`suspendTenant`, allowed source: `["active"]`).


#### `POST /api/admin/super/tenants/:tenantId/resume`

Transitions the target tenant from `suspended` back to `active`. Does not destroy or create sessions — users must log in again normally after resume.

**Auth:** `super_admin` + fresh TOTP (verified within 15 minutes). `401 AUTHN_FAILED` with `details.code = 'FRESH_MFA_REQUIRED'` when MFA is stale.

**Path params:** `tenantId` — UUID of the target tenant.

**Body:** `{ reason?: string }` (max 500 chars; NUL + ASCII control chars rejected with `400 INVALID_REASON`).

**Response 200:**
```json
{
  "tenantId": "uuid",
  "slug": "acme-corp",
  "status": "active",
  "previousStatus": "suspended",
  "noOp": false,
  "auditId": "uuid"
}
```

**Idempotency:** Already-active tenant returns `200` with `noOp: true`, `auditId: null`. No audit row is written.

**Side effects (non-noOp only):** Audit row written inside `withTenant` transaction via `auditInTx`. `logLifecycleEvent` fires at INFO level. No session sweep — sessions are not destroyed on resume.

**Allowed source states:** `suspended` only. Any other source state raises `409 INVALID_LIFECYCLE_TRANSITION`.

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `INVALID_LIFECYCLE_TRANSITION` | 409 | Source state is not `suspended` |
| `INVALID_REASON` | 400 | reason is wrong type, too long, or contains control chars |
| `FRESH_MFA_REQUIRED` | 401 | TOTP not verified within 15 minutes |
| `TENANT_NOT_FOUND` | 404 | `tenantId` does not exist |

**Audit action emitted:** `tenant.resumed` (scoped to the target tenant's audit log).

**Source:** `apps/api/src/routes/admin-super.ts:513`, `modules/02-tenancy/src/service.ts` (`resumeTenant`, allowed source: `["suspended"]`).


#### `POST /api/admin/super/tenants/:tenantId/archive`

Transitions the target tenant from `active` or `suspended` to `archived`. Archiving hides the tenant from the default Platform UI list and immediately destroys all active sessions. All data (users, attempts, audit history) is retained.

**Auth:** `super_admin` + fresh TOTP (verified within 15 minutes). `401 AUTHN_FAILED` with `details.code = 'FRESH_MFA_REQUIRED'` when MFA is stale.

**Path params:** `tenantId` — UUID of the target tenant.

**Body:** `{ reason?: string }` (max 500 chars; NUL + ASCII control chars rejected with `400 INVALID_REASON`).

**Response 200:**
```json
{
  "tenantId": "uuid",
  "slug": "acme-corp",
  "status": "archived",
  "previousStatus": "active",
  "noOp": false,
  "auditId": "uuid",
  "sessionsRevoked": { "count": 1, "affectedUsers": ["uuid1"] }
}
```

**Idempotency:** Already-archived tenant returns `200` with `noOp: true`, `auditId: null`, and no `sessionsRevoked` field. No session sweep on no-op.

**Side effects (non-noOp only):** Calls `sessions.destroyAllForTenant(tenantId)` after DB commit. Audit row written inside `withTenant` transaction via `auditInTx`. `logLifecycleEvent` fires at WARN level.

**Allowed source states:** `active` or `suspended`. Any other source state raises `409 INVALID_LIFECYCLE_TRANSITION`.

**Visibility:** Archived tenants are excluded from `GET /api/admin/super/tenants` by default. Pass `?include_archived=true` to surface them.

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `INVALID_LIFECYCLE_TRANSITION` | 409 | Source state is not `active` or `suspended` |
| `INVALID_REASON` | 400 | reason is wrong type, too long, or contains control chars |
| `FRESH_MFA_REQUIRED` | 401 | TOTP not verified within 15 minutes |
| `TENANT_NOT_FOUND` | 404 | `tenantId` does not exist |

**Audit action emitted:** `tenant.archived` (scoped to the target tenant's audit log).

**Source:** `apps/api/src/routes/admin-super.ts:545`, `modules/02-tenancy/src/service.ts` (`archiveTenant`, allowed sources: `["active", "suspended"]`).


#### `POST /api/admin/super/tenants/:tenantId/unarchive`

Transitions the target tenant from `archived` back to `active`. Does not restore sessions.

**Auth:** `super_admin` + fresh TOTP (verified within 15 minutes). `401 AUTHN_FAILED` with `details.code = 'FRESH_MFA_REQUIRED'` when MFA is stale.

**Path params:** `tenantId` — UUID of the target tenant.

**Body:** `{ reason?: string }` (max 500 chars; NUL + ASCII control chars rejected with `400 INVALID_REASON`).

**Response 200:**
```json
{
  "tenantId": "uuid",
  "slug": "acme-corp",
  "status": "active",
  "previousStatus": "archived",
  "noOp": false,
  "auditId": "uuid"
}
```

**Idempotency:** Already-active tenant returns `200` with `noOp: true`, `auditId: null`. No audit row written.

**Side effects (non-noOp only):** Audit row written inside `withTenant` transaction via `auditInTx`. `logLifecycleEvent` fires at INFO level. No session sweep — no sessions exist for an archived tenant.

**Allowed source states:** `archived` only. Any other source state raises `409 INVALID_LIFECYCLE_TRANSITION`.

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `INVALID_LIFECYCLE_TRANSITION` | 409 | Source state is not `archived` |
| `INVALID_REASON` | 400 | reason is wrong type, too long, or contains control chars |
| `FRESH_MFA_REQUIRED` | 401 | TOTP not verified within 15 minutes |
| `TENANT_NOT_FOUND` | 404 | `tenantId` does not exist |

**Audit action emitted:** `tenant.unarchived` (scoped to the target tenant's audit log).

**Source:** `apps/api/src/routes/admin-super.ts:587`, `modules/02-tenancy/src/service.ts` (`unarchiveTenant`, allowed source: `["archived"]`).


#### User lifecycle endpoints (Phase C)

Shipped in commit `a888a43` (2026-05-20). Two parallel surfaces:

- **Tenant-admin endpoints** (`/api/admin/users/…`) — operate within the caller's own tenant; enforce the LAST_ADMIN invariant unconditionally. Gated by `adminOnly` (`admin` role + `totpVerified`).
- **Super-admin override endpoints** (`/api/admin/super/users/…`) — operate cross-tenant; can bypass LAST_ADMIN when `confirm_last_admin: true` is provided with a non-empty `reason`. Gated by `superAdminFreshMfa` (`super_admin` + TOTP within 15 min).

Both surfaces share the same `parseLifecycleBody` reason-validation logic (max 500 chars, no control chars, `400 INVALID_REASON` on violation).


#### `GET /api/admin/super/tenants/:tenantId/users`

Returns all users in the target tenant plus all pending (unaccepted) invitations. Runs under `assessiq_system` (BYPASSRLS) — no RLS context restriction, so disabled and soft-deleted users are included when requested.

**Auth:** `super_admin` only (session TOTP; no fresh-MFA requirement).

**Path params:** `tenantId` — UUID of the target tenant.

**Query params:**
| Param | Default | Meaning |
|---|---|---|
| `include_disabled` | `false` | Include `status='disabled'` users (`true` or `1`) |
| `include_deleted` | `false` | Include `deleted_at IS NOT NULL` users (`true` or `1`) |

**Response 200:**
```json
{
  "users": [
    { "id": "uuid", "email": "...", "name": "...", "role": "admin", "status": "active", "totp_enrolled": true, "deleted_at": null, "created_at": "...", "updated_at": "..." }
  ],
  "pending_invitations": [
    { "id": "uuid", "email": "...", "role": "admin", "expires_at": "...", "created_at": "..." }
  ]
}
```

Users are ordered `created_at DESC, id DESC`. Pending invitations are `accepted_at IS NULL`, ordered `created_at DESC`.

**`totp_enrolled` (RW-45, S10, 2026-10-15).** Each user item carries `totp_enrolled: boolean`. It is true when the user has a TOTP secret. The query LEFT JOINs `user_credentials` (`modules/03-users/src/repository.ts`). The Users page uses it to show "Reset two-factor" only for enrolled users.

**Source:** `apps/api/src/routes/admin-super.ts:974`.


#### `POST /api/admin/super/tenants/:tenantId/users/:userId/totp/reset` (RW-45, S10, 2026-10-15)

A super admin clears the two-factor setup of one user. Use it when the user lost the authenticator and has no recovery codes. Source: `apps/api/src/routes/admin-super/user-totp-reset.ts`.

**Auth:** `superAdminOnly` (super admin role, TOTP-verified session). It does not need fresh MFA.

**Path params:** `tenantId` and `userId`, both UUID. The route calls `assertTenantActive(tenantId)`.

**Body:** `{ "reason": "text" }`. The reason is required, 1 to 500 characters after trim.

**Response 204:** no body.

**Errors:**
- `400` bad params or body.
- `403` caller is not a super admin.
- `404` the user is not in that tenant.
- `409` `SELF_RESET_FORBIDDEN`. A super admin cannot reset their own two-factor here.

**Behaviour.** `adminResetTotp` clears the TOTP secret, deletes the recovery codes and deletes the Postgres session rows of the target. It then calls `sessions.destroyAllForUser` after the commit. The user must enrol again at the next login. Flow and audit details: [04-auth-flows.md](04-auth-flows.md) § "Self-service MFA".

**Update (RW-91, S10, 2026-10-16):** the route now sends the notice email `totp_reset_notice` to the target after the reset. The tenant-admin variant is `POST /api/admin/users/:userId/totp/reset`, above.

**Not included:** a recovery-code fallback.


#### Super-admin user lifecycle override endpoints (Phase C)

Gated by `superAdminFreshMfa` (`super_admin` + TOTP within **15 minutes**). These are the cross-tenant counterparts to the tenant-admin endpoints above. Key differences:

- **Cross-tenant:** the target user's `tenantId` is resolved via a `assessiq_system` (BYPASSRLS) query on `userId`, then the operation runs under `withTenant(targetTenantId)`. The super-admin's session `tenantId` (the `platform` tenant) is never used for the data operation.
- **LAST_ADMIN override:** when the action would normally raise `LAST_ADMIN`, passing `confirm_last_admin: true` **and** a non-empty `reason` bypasses the guard. Without both fields, `LAST_ADMIN` fires identically to the tenant-admin path. The audit row carries `is_override: true` in the `after` JSON. `logLifecycleEvent` fires at **WARN** level when `isOverride: true`.
- **No self-action guards:** super-admins do not live in any tenant, so `CANNOT_DISABLE_SELF` and `CANNOT_DELETE_SELF` never apply.

**Body shape for all super-admin lifecycle endpoints:** `{ reason?: string, confirm_last_admin?: boolean }`


##### `POST /api/admin/super/users/:userId/disable`

Cross-tenant disable. Sweeps Redis sessions for the target user after DB commit.

**Auth:** `super_admin` + fresh TOTP (15 min).

**Response 200:** `{ userId, status: "disabled", previousStatus, isOverride: boolean }`

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `LAST_ADMIN` | 409 | Last active admin; `confirm_last_admin: true` + non-empty `reason` required to override |
| `INVALID_REASON` | 400 | reason validation failure |
| `FRESH_MFA_REQUIRED` | 401 | TOTP stale |

**Audit action emitted:** `user.disabled`. `after.is_override: true` when override path fired.

**Source:** `apps/api/src/routes/admin-super.ts:1139`.


##### `POST /api/admin/super/users/:userId/reenable`

Cross-tenant reenable. Sets `status = 'active'`. No LAST_ADMIN check (enabling, not restricting). `confirm_last_admin` is accepted in the body but has no effect.

**Auth:** `super_admin` + fresh TOTP (15 min).

**Response 200:** `{ userId, status: "active", previousStatus }`

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `INVALID_REASON` | 400 | reason validation failure |
| `FRESH_MFA_REQUIRED` | 401 | TOTP stale |

**Audit action emitted:** `user.reenabled`.

**Source:** `apps/api/src/routes/admin-super.ts:1227`.


##### `DELETE /api/admin/super/users/:userId`

Cross-tenant soft-delete. Sets `deleted_at = now()`. Cascades to pending invitations for the user's email (same cascade as the tenant-admin path). Sweeps Redis sessions after commit.

**Auth:** `super_admin` + fresh TOTP (15 min).

**Response 200:** `{ userId, deleted: true, isOverride: boolean }`

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `LAST_ADMIN` | 409 | Last active admin; `confirm_last_admin: true` + non-empty `reason` required to override |
| `INVALID_REASON` | 400 | reason validation failure |
| `FRESH_MFA_REQUIRED` | 401 | TOTP stale |

**Audit action emitted:** `user.soft_deleted`. `after.is_override: true` when override path fired.

**Source:** `apps/api/src/routes/admin-super.ts:1354`.


##### `POST /api/admin/super/users/:userId/restore`

Cross-tenant restore. Clears `deleted_at`. Does not recreate invitations or sessions.

**Auth:** `super_admin` + fresh TOTP (15 min).

**Response 200:** `{ userId, status, previousDeletedAt }`

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `INVALID_REASON` | 400 | reason validation failure |
| `FRESH_MFA_REQUIRED` | 401 | TOTP stale |

**Audit action emitted:** `user.restored`.

**Source:** `apps/api/src/routes/admin-super.ts:1433`.


##### `DELETE /api/admin/super/users/invitations/:invitationId`

Cross-tenant invitation cancellation. Resolves the invitation's `tenantId` via `assessiq_system` BYPASSRLS lookup, then delegates to `cancelInvitation(targetTenantId, …)`. Returns the same response shape as the tenant-admin path.

**Auth:** `super_admin` + fresh TOTP (15 min).

**Path params:** `invitationId` — UUID of the invitation.

**Body:** `{ reason?: string }` (`confirm_last_admin` is not applicable here).

**Response 200:**
```json
{ "invitationId": "uuid", "email": "...", "cascadedPendingUser": true, "cancelledUserId": "uuid" }
```

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `INVITATION_NOT_FOUND` | 404 | No invitation row with this id |
| `INVITATION_ALREADY_ACCEPTED` | 409 | Invitation already used |
| `INVALID_REASON` | 400 | reason validation failure |
| `FRESH_MFA_REQUIRED` | 401 | TOTP stale |

**Audit action emitted:** `user.invitation_cancelled`.

**Note:** This route is registered **before** `DELETE /api/admin/super/users/:userId` so Fastify's static-segment-first matching resolves `invitations` correctly and never confuses it with a `userId`.

**Source:** `apps/api/src/routes/admin-super.ts:1282`.

### Candidate

All routes mounted under `/api/me/*`, gated by the candidate auth chain (`requireAuth({ roles: ['candidate'] })`). RLS scopes every read/write to the candidate's own tenant; service-layer ownership check denies cross-user reads with `AUTHZ_FAILED { code: AE_NOT_OWNED_BY_USER }`.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET`  | `/api/me/assessments`             | List active assessments the candidate is invited to | **live 2026-05-02; wire fixed 2026-10-06 (FU-C10)** |
| `POST` | `/api/me/assessments/:id/start`   | Begin attempt — creates `attempt`, freezes question set into `attempt_questions`, returns `201 Attempt` (idempotent — re-call returns existing). A NEW attempt requires a consent row on file: optional body `{consent:true}` records it, else `422 CONSENT_REQUIRED` (same invariant as `POST /take/start` Begin; resume and embed attempts exempt) | **live 2026-05-02** |
| `GET`  | `/api/me/attempts/:id`            | Server-authoritative attempt view — `{ attempt, questions[], answers[], remaining_seconds }`. Auto-submits the attempt if `ends_at` has passed. Each `questions[]` item carries `answer_guidance` (always a non-empty string — authored value or per-type default; instructional/candidate-safe, never a rubric/answer key) (0098). | **live 2026-05-02** |
| `GET`  | `/api/me/attempts/:id` (scenario `mcq` steps) | **Scenario `mcq` steps (2026-10-02, commit `ac531c5`):** in the candidate payload a scenario step of type `mcq` with an array `options` carries `id`, `type` and `options` (string items only) next to `prompt`. A step without that shape carries `prompt` only. `correct`, `trap` and `expected` never appear. The candidate saves the chosen option text as `{ stepIndex, response }` through `POST /api/me/attempts/:id/answer`. The mcq step is not auto-scored: scenario answers are evaluated from the string response. | **live 2026-10-02** |
| `POST` | `/api/me/attempts/:id/answer`     | Autosave one answer (last-write-wins, decision #7) — body `{ question_id, answer, client_revision?, edits_count?, time_spent_seconds? }`; returns `204` + `X-Client-Revision` header | **live 2026-05-02** |
| `POST` | `/api/me/attempts/:id/answer` (scenario shape) | **Scenario answer check (2026-10-03, commit `e6eb22d`):** for a question of type `scenario`, `answer` must be `{ steps: [{ stepIndex, response }] }` or `null`. Any other shape gives HTTP 400 `AE_INVALID_PARAM` with `param: "answer"`. Unknown keys are removed. The key is the question type, never the answer shape. Other types are stored as sent. The check runs after the lock, owner, status, timer and section checks. | **live 2026-10-03** |
| `POST` | `/api/me/attempts/:id/answer` (structured_case shape) | **Structured case answer check (2026-10-03, commit `885403b`):** for a question of type `structured_case`, `answer` must be `{ steps: { [stepId]: number[] } }` or `null`. The server checks it against the FROZEN question version content: every key is a known step id, every value is a unique array of in-range option indexes. A `select: "one"` step takes at most one pick (commit `e7d7d04`); a wrong count on a `many` step is scored, not rejected. A bad shape gives the same HTTP 400 `AE_INVALID_PARAM` with `param: "answer"` as the scenario check (message names the type). The key is the question type, never the answer shape. | **live 2026-10-03** |
| `POST` | `/api/me/attempts/:id/flag`       | Toggle flag on a question — body `{ question_id, flagged }`; returns `200 { flagged }` | **live 2026-05-02** |
| `POST` | `/api/me/attempts/:id/event`      | Push behavioral event (catalog: `modules/06-attempt-engine/EVENTS.md`) — body `{ event_type, question_id?, payload? }`; returns `201 AttemptEvent` or `204` if rate-cap dropped | **live 2026-05-02** |
| `POST` | `/api/me/attempts/:id/submit`     | Final submit (idempotent terminal) — returns `202 { attempt_id, status, estimated_grading_seconds, result_expectation, release_mode, email_masked, turnaround_text }` (`estimated_grading_seconds` is about 60 when the result shows on screen, else `null`) | **live 2026-05-02** |
| `GET`  | `/api/me/attempts/:id/result`     | View result — `200` with the complete, final result once the attempt is released; otherwise `202 { status: 'pending', result_expectation, release_mode, … }`. Candidates never see a partial or per-question score. | **live** |

> **Update 2026-10-01:** `submit` returns `result_expectation`, `release_mode`, `email_masked` and `turnaround_text`. `GET /api/me/results` lists released results. See § Scoring and result release at the end of this doc.

> **FU-C10 (2026-10-06): `GET /api/me/assessments` wire fixed.** The response shape was `{ items: [{ assessment_id, name, description, status, opens_at, closes_at, duration_minutes, invitation_status, invitation_expires_at }] }` — the client type `InvitedAssessmentWire` (`modules/11-candidate-ui/src/types.ts`) expects `{ id, name, duration_seconds, question_count, opens_at, closes_at }`. Nothing called this route yet (FR12 review, 2026-10-03), so this was a latent bug, not a live regression. Fixed: the route now returns the aligned field names. It also filters out assessments outside their `opens_at`/`closes_at` window and invitations past their own `expires_at`. Before the fix, the list had no window or expiry filter at all.

#### Candidate attempt payload: numeric and multi_select

**History:** added in the 2026-10-02 batch 3 notes.

- `numeric`: content sent to the candidate is `{ question, unit? }` (sanitiser allowlist; `answer`, `tolerance`, `rationale` are never sent). Answer saved: a JSON number or null.
- `multi_select`: `{ question, options }` in the student's shuffled order (shuffle covers up to 10 options); `correct`, `scoring`, `rationale` stripped. Answer saved: `{ "selected": [int] }` of displayed indexes, translated to original indexes at the save seam (all-or-nothing: one bad element leaves the answer untouched). Scoring and result shapes: see 02 and 05.

#### `POST /api/me/attempts/:id/finish-section` (candidate)

**History:** added in the 2026-10-02 batch 4 notes.

- **What.** Candidate-only. No body. Returns `{ section_index }` (the section just opened). Opens the next section now and re-pins `attempts.ends_at = now + the remaining sections' minutes`.
- **Errors.** 409 `AE_SECTION_NOT_FINISHABLE` on the last section (submit instead) or on an attempt without sections. Standard attempt ownership / state errors otherwise.
- **Candidate attempt payload `sections`.** `GET` of an in-progress sectioned attempt adds `sections: { current, total, name, calculator, ends_at, remaining_seconds }`. `questions` and `answers` are already limited to the running section; later sections are not sent. Finished attempts return everything as before. Plain tests have no `sections` key.
- **`AE_SECTION_LOCKED` (409).** `saveAnswer` / `toggleFlag` on a question whose section is not the running one (finished or not yet open).
- **Why.** Deadlines are server-authoritative; a locked section cannot be edited from a stale tab. Details in 02 (migration 0132) and `modules/06-attempt-engine/SKILL.md`.
- **Not included.** Per-section score breakdown in any response.

#### `CANDIDATE_ERASED` (409)

**History:** added in the 2026-10-02 batch 4 notes.

- **What.** The server refuses the request when the target candidate has `erased_at` set. The routes are: 05 invite and resend; 07 manual-score and override; 18 reissue and issue-on-release (issue-on-release treats an erased candidate as null, so no certificate); 20 data-rights export.
- **Why.** Hiding buttons in the UI is not a block; a stale tab or direct API call could still touch erased data.
- **Not included.** Release itself already refused erased candidates (older guard).

#### Candidate attempt view: `sections_summary`

**History:** added in the 2026-10-02 batch 5 notes.
- **What.** `GET /api/me/attempts/:id` (sectioned assessments only) adds `sections_summary: [{ index, name, question_count, answered_count, status: "done"|"current"|"upcoming" }]` over ALL sections. Counts only: no question ids, no content. "Answered" uses the take-page emptiness rule (null, empty string, empty array, all-empty object = unanswered).
- **Why.** The final submit dialog must total unanswered questions across all sections, but the view only carries the running section's questions.
- **Impact.** Absent for attempts without sections. Type in 11 `SectionSummaryWire`.

#### Candidate attempt payload: ordering

**History:** added in the 2026-10-02 batch 5 notes.

- Content sent to the candidate is `{ question, items }` only (sanitiser allowlist; `correct_order`, `scoring`, `explanation` are never sent). `items` are in the attempt's own shuffled order, which is never the correct order and does not change between reloads.
- Answer saved (`PUT` answer route): `{ "order": [int] }` of DISPLAYED item positions in the sequence the candidate chose. The server translates it to original item indexes before storing (all-or-nothing: one bad element leaves the answer untouched and it scores 0). The candidate's own reads translate it back to displayed positions. No new route; `answer` is untyped JSON as for the other types.
- Scoring and result shapes: see 02 and 05. Admin attempt detail shows the candidate order next to the correct order (admin only).

#### Candidate attempt payload: structured_case (2026-10-03)

**History:** added in the 2026-10-02 batch 5 notes.

- Content sent to the candidate is `{ title, context, log_excerpt?, steps: [{ id, prompt, select, options }] }` only. The sanitiser keeps an allowlist per step; `correct`, `scoring` and `explanation` are never sent. Options are in authored order (no shuffle for this type).
- Answer saved (`PUT` answer route): `{ "steps": { "<stepId>": [int] } }` with original option indexes. Check rule: see the answer-save row above. The candidate runner marks a question answered when at least one step has a pick.
- Scoring and result shapes: see 02 and 05. The admin attempt detail shows the key and the candidate picks per step (admin only).

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
| `GET`  | `/ready`         | Readiness (RW-9, no auth) — `{ status: "ready"\|"not_ready", checks: { db, redis, claude } }` booleans only; 200 if all pass, else 503; `db`/`redis` probes cached 5 s, `claude` probe cached 60 s |
| `GET`  | `/ready`         | Readiness — checks DB + Redis + queue |
| `GET`  | `/help/:key`     | Public help content fetch (anonymous, globals-only) — **live 2026-05-02** |
| `GET`  | `/api/help`      | Authenticated page-batch fetch (any role) — **live 2026-05-02** |
| `GET`  | `/api/help/:key` | Authenticated single-key fetch with locale fallback — **live 2026-05-02** |
| `GET`  | `/api/help/public?page=&locale=` | Anonymous, rate-limited, globals-only batch for the take flow. `page` must be exactly `candidate.take` or `candidate.attempt` (else 400); each returns only its own `<page>.%` keys. Audience fixed to candidate+all; no tenant rows. `Cache-Control: public, max-age=60`. Not registered unless a rate limiter is injected. |
| `POST` | `/api/help/track`| Telemetry (anonymous, deterministic 10% sample) — **live 2026-05-02** |
| `POST` | `/api/_log`       | Frontend log ingest. Body: `{ entries: [{level: "info"\|"warn"\|"error", msg: string (≤200 chars), ts: number, fields?: {…}}] }` (1–50 items). Returns `204`. No auth required. Rate-limited: 600 req/min/IP. (`apps/api/src/routes/_log.ts:80`) — **live** |
| `GET`  | `/verify/:credentialId`         | Public certificate verify HTML page (no auth, no tenant context). Returns 200 with green/red badge; 404 if credential not found or malformed; 429 if rate limit exceeded (60 req/IP/hour). Renders OG/Twitter meta tags in `<head>` pointing at `/og.png` so LinkedIn/Twitter previews render as rich cards. Fire-and-forget `verification_views` counter increment, deduped per (IP, credential) per hour. (`modules/18-certification/src/routes-public.ts`) — **live 2026-05-11** |
| `GET`  | `/verify/:credentialId/og.svg`  | OG/social-preview image as SVG (1200×630). Returns `image/svg+xml`, `Cache-Control: public, max-age=3600`. Used by Twitter, Facebook, Mastodon, Slack. 404 on missing/malformed credential. — **live 2026-05-11** |
| `GET`  | `/verify/:credentialId/og.png`  | OG/social-preview image as PNG (1200×630), rasterized from the SVG via `@resvg/resvg-js`. Returns `image/png`, `Cache-Control: public, max-age=3600`. Used by LinkedIn (which rejects SVG previews). 404 on missing/malformed credential. — **live 2026-05-13** |

#### `/try` is not an API route

**History:** added in the 2026-10-02 batch 4 notes.

`/try` and `/try/certificate` are static SPA pages (`apps/web/src/pages/try`): fixed content, client-side scoring, no network calls, no session. Nothing was added to this contract. The edge routes them to the SPA through the Caddy `@app` matcher (see 06 deployment).

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

## Worked examples

### Worked example — Admin creates an assessment and invites SOC L1 cohort

```http
# 1. Authenticate (browser does this; abbreviated)
GET /api/auth/whoami
→ 200 { "user": { "id":"u_...", "role":"admin" }, "tenant": { "id":"t_...","slug":"wipro-soc" }, "mfa_status":"verified" }

# 2. List published packs
GET /api/admin/packs?status=published
→ 200 { "items": [ { "id":"pack_soc_2026q2", "name":"SOC Skills 2026 Q2", "domain":"soc", "status":"published", "version":2, "question_count":24, "completed_count":137 } ], "page":1, "pageSize":20, "total":1 }

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

### Worked example — Candidate takes assessment

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
→ 202 { "attempt_id":"att_...", "status":"submitted", "estimated_grading_seconds": 60, "result_expectation":"soon", ... }

# 5. Poll for result
GET /api/me/attempts/att_.../result
→ 202 { "status":"pending", "result_expectation":"soon", ... }
... after the result is released ...
→ 200 { "status":"released", "score": { ... }, "released_at": "..." }   (complete score only; see § Scoring and result release)
```

> Note (2026-10-01): the `/submit` and `/result` bodies in steps 4 and 5 above are out of date. Current shapes: § Scoring and result release at the end of this doc.

### Worked example — Webhook payload (host integration)

When a host app has registered for `attempt.graded`:

```http
POST <host_endpoint>
Content-Type: application/json
X-AssessIQ-Event: attempt.graded
X-AssessIQ-Delivery: del_<uuid>
X-AssessIQ-Timestamp: 1790851200                                   (unix seconds since 2026-10-01; was ISO-8601)
X-AssessIQ-Signature-V2: sha256=<hmac of "<timestamp>.<body>" using webhook secret>
X-AssessIQ-Signature: sha256=<hmac of body using webhook secret>  (V1, legacy: no timestamp)

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
    "result": "https://assessiq.in/api/admin/attempts/att_..."
  }
}
```

**Host verification:**
```js
// V2 (2026-10-01): timestamp is unix seconds and is covered by the signature
if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) reject();  // replay window
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
if (receivedV2.length !== expected.length || !timingSafeEqual(Buffer.from(receivedV2), Buffer.from(expected))) reject();
```

**Retry and delivery rules:**
- **Retries:** 5 attempts, custom backoff, intended as 1m, 5m, 30m, 2h, 12h. A known off-by-one makes the first retry wait 5 m.
- **Refusals that are never retried:**
  - a 3xx answer: redirects are not followed;
  - a destination that resolves to a private or reserved address;
  - a 4xx answer, stored as `HTTP 4xx: <snippet>`.
- **Timeout:** 10 s.
- **After the final failure:** the delivery is marked `failed`, and an admin can replay it from the UI.
- **Details:** see § "2026-10-01 (later)" at the end of this file.

### Worked example — Embed JWT (host issuing)

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
  return `https://assessiq.in/embed?token=${encodeURIComponent(token)}`;
}
```

## Business events for webhooks (FU-B6, 2026-10-03)

**What.** Three events go to the registered webhook endpoints of a tenant. Code: `modules/13-notifications/src/business-events.ts`, function `emitAttemptEventAfterCommit` (commits `28ab66f`, `5b02fa1`).

| Event | Sent from |
|---|---|
| `attempt.submitted` | 06 candidate submit, and both timer auto-submit paths |
| `attempt.graded` | 09 `finalizeAttemptIfComplete` (the only writer of status `graded`) |
| `result.released` | 09 `releaseAttemptInTx`: manual release, bulk release and the auto-release sweep |

**Payload.** `{ event, tenant_id, attempt_id, assessment_id, candidate_id, occurred_at }`. The payload has no scores, no answers and no personal data. The host reads details with the API. The worked example below shows the older, richer `attempt.graded` shape.

**Timing.** The call runs after the database commit through `onCommit` (FU-B5). A rolled-back transaction sends nothing. If the code runs outside `withTenant`, the helper writes a warning log and sends nothing.

**Why.** A host needs a stable trigger. Ids only keep the payload safe when a result is not yet released.

**Considered and rejected.** Scores in the payload (leaks an unreleased result). A BullMQ job per event (not needed; the webhook worker already retries).

**Not included.** Other events. A per-event subscription filter in the UI. A plan-tier check (by owner decision, webhooks are for the Growth tier and up; there is no code gate yet).

**Impact.** Modules 06 and 09 now depend on `@assessiq/notifications`. Tests that mock that package must export `emitAttemptEventAfterCommit` (see `docs/RCA_LOG.md` 2026-10-03). `release.ts` may import only that helper (structure test, `74f1f46`).

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


### `GET /api/admin/assessments/:id/results.csv`

LIVE placement-cell export (reads live tables, NOT `attempt_summary_mv`). Roles: admin only (`adminOrReviewer` removed 2026-10-03). Assessment must belong to the session tenant (404 otherwise). One row per **invited** candidate (not started, in progress, submitted, graded, released, expired); latest attempt wins. Capped at 10,000 rows. UTF-8 with BOM; string cells starting `= + - @` are prefixed with `'`.

**Response 200:** `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<assessmentId>-results-YYYY-MM-DD.csv"`.

**Columns:** `name, email, status, started_at, submitted_at, score, max_score, percent, result, <Category name> (%)...` (categories alphabetical). `status` = attempt status, or `invited` / `expired` when no attempt exists. score/max/percent/per-category are blank unless the attempt is `graded`/`released`. score = sum of the latest grading per question (`graded_at DESC`, admin_override wins). percent has 1 decimal. `result` = Pass/Fail vs `levels.passing_score_pct`.

**Query (2026-10-01, `1a4f82d`):** `sort` = `name` (default; previous behaviour) | `rank` | `branch` (branch A→Z, then rank, then name; rows without a branch last). Any other value → 400.

**Columns since `1a4f82d`:** `name, email, roll_number, branch, status, started_at, submitted_at, score, max_score, percent, result, rank, tab_switches, paste_count, fullscreen_exits, <Category name> (%)...`
- `roll_number` / `branch` come from `users.metadata` (set by the CSV import, see 02).
- `rank` is competition ranking ("1,2,2,4") by percent DESC over rows with a visible score. It is blank for rows still awaiting evaluation, or not started.
- `tab_switches`, `paste_count` and `fullscreen_exits` count `tab_blur` / `paste` / `fullscreen_exit` events. They are integrity signals, not scores, so they show whatever the release state. They are 0 for an attempt with no events and blank when there is no attempt.
- **Why:** the university placement cell needs a ranked, branch-wise list.
- **Rejected:** a separate "rank list" endpoint. One CSV with a sort option keeps a single export path and one audit action.
- **Not included:** rank within branch as its own column. `sort=branch` orders by overall rank inside each branch.

**Audit:** `action: 'attempt.exported'`, `entityType: 'assessments'`, `entityId` = assessment id.


### `GET /api/admin/attempts/:id/integrity`

LIVE 2026-10-01 (`0d9999e`, `79a853a`). Module 06 (`routes.admin.ts`). Roles: admin. Tenant from the session; `attempt_events` RLS scopes the rows. Invalid UUID → 400; attempt in another tenant or absent → 404.

**Response 200:** `{ tab_switches, copy, paste, paste_blocked, fullscreen_exits, multi_tab_conflicts }`, all integers (counts of `attempt_events`; `paste_blocked` = paste events with payload `blocked: true`).
- **Why:** this feeds the `Integrity` card on the admin attempt page.
- **Release state:** counts are visible whatever the state, because they are not scores.
- **Not included:** event timelines and per-question breakdown. Counts only, for v1.

**Candidate side (same release):**
- `GET /api/me/attempts/:id` now also returns `integrity: { fullscreen: boolean, block_copy_paste: boolean }`, read from `assessments.settings.integrity` (default false/false).
- `POST /api/me/attempts/:id/events` accepts two new event types, `fullscreen_enter` and `fullscreen_exit` (payload `{}`).
- `copy` / `paste` payloads accept an optional `blocked: boolean`.
- Event catalog: `modules/06-attempt-engine/EVENTS.md`.


### `GET /api/admin/reports/exports/attempts.csv`

Streams all scored attempts as CSV (RFC 4180). Capped at `EXPORT_ROW_CAP = 10_000` rows.

**Query params (all optional):** `from` (ISO date), `to` (ISO date), `assessmentId` (UUID), `userId` (UUID)

**Response 200:** `Content-Type: text/csv`, `Content-Disposition: attachment; filename="attempts.csv"`, streaming body.

**Columns:** `attempt_id, assessment_name, user_id, submitted_at, total_earned, total_max, auto_pct, pending_review, archetype`

**Audit:** `action: 'attempt.exported'` written to audit log on each call.


### `GET /api/admin/reports/exports/attempts.jsonl`

Same data as attempts.csv but as JSON Lines (one JSON object per line, `\n` delimited).

**Query params:** same as `attempts.csv`.

**Response 200:** `Content-Type: application/x-ndjson`, streaming body.

**Audit:** `action: 'attempt.exported'` written to audit log.


### `GET /api/admin/reports/exports/topic-heatmap.csv`

Exports the topic heatmap report as CSV.

**Query params:** `packId` (required UUID), `from` (optional ISO date), `to` (optional ISO date)

**Response 200:** `Content-Type: text/csv`, streaming body.

**Columns:** `topic_id, topic_label, avg_pct, bucket, n`

**Response 400:** `packId` missing or malformed.


### `GET /api/admin/reports/cohort/:assessmentId/breakdown` (FU-C4, 2026-10-06)

Admin. Returns `{ data: { levelBreakdown: LevelBreakdown[], topicBreakdown: TopicBreakdownItem[] } }` from 15 `cohortReport` (shapes in `modules/15-analytics/src/types.ts`). Tenant-visible rule: the level rows come from `attempt_summary_mv` (released attempts only since 0122). The topic rows filter on released / evaluation-released attempts (FU-C3). A non-UUID id returns 400. **What changed:** the cohort page (`/admin/reports/cohort/:assessmentId`) now shows "By level", "By topic" and a "Topic heatmap" with a pack selector. The default is the pack of the assessment. The list comes from `GET /admin/packs?pageSize=100`. The heatmap comes from `GET /admin/reports/topic-heatmap?packId=`. **Why:** `cohortReport` had level and topic breakdowns since Phase 3 but no route and no screen (RS6 FR10). **Rejected:** merging into 09's `/reports/cohort/:assessmentId` (different module and MV source); a tab strip (no kit recipe). **Not included:** date filters on the breakdown; a per-candidate drill-down. **Downstream:** help keys `admin.reports.cohort.{by_level,by_topic,heatmap,pack}` (migration 0159).

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


### `POST /api/admin/analytics/refresh`

Triggers `REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv`. All analytics and cohort-report endpoints read this MV. After a large grading run or bulk import, use this endpoint. Then you do not wait for the nightly 02:00 UTC BullMQ job.

**Auth:** `super_admin` only (not tenant admin — the refresh acquires a non-exclusive table lock and is a platform-operator action).

**Body:** none.

**Response 200:** `{ ok: true, duration_ms: number }`

**Notes:** Auto-refresh on every attempt write is intentionally deferred; see `modules/15-analytics/SKILL.md` for rationale.

**Source:** `modules/15-analytics/src/routes.ts:339`.

## Admin — Activity (Phase 9, module 15-analytics)

All routes require admin session; tenant-scoped via `withTenant` (RLS). Served at `/api/admin/activity/*`. Each endpoint owns its full vertical slice under [`modules/15-analytics/src/activity/`](../modules/15-analytics/src/activity/) (one file per endpoint).

**Decision (locked `db020d1`):** backend returns raw `question_packs.domain` slugs (for example, `"soc"`, `"devops"`, `"cloud-architect"`). Frontend maps slugs → display names. No schema migration in v1.1.

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


### `GET /api/admin/activity/leaderboard`

Catalog-wide **question-pack** ranking by submission volume, with prior-period delta. One row per `question_packs.id` — a pack with multiple assessment cycles rolls up to a single leaderboard entry. (The Phase 9 review considered per-assessment grouping and rejected it. It produced duplicate-pack-name rows in the Phase 11 page when a pack had more than 1 assessment cycle.)

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

## Certificates (module 18-certification)

> **Status: live.** All endpoints below are implemented in `modules/18-certification/src/routes.ts`. They return `401` without a session. They return `404` for an unknown or foreign certificate and `403` for a wrong owner. They return `409` or `410` for revoked states and `422` for a malformed `credential_id`. The earlier `501 Not Implemented` stub status ended when the issuance engine and PDF generator shipped.

### Candidate-facing


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


#### `GET /api/certificates/:credentialId/pdf`

Download the PDF for a certificate. `credentialId` is matched case-insensitively (normalised to uppercase).

**Auth:** candidate session required; cert must belong to the calling user.

**Response 200:** `application/pdf` stream.
Headers: `Content-Disposition: attachment; filename="<credentialId>.pdf"`, `Cache-Control: no-cache, no-store, must-revalidate`.
Increments `pdf_downloads` counter.

**Response 404:** cert not found or not owned by caller.

**Response 410:** cert is revoked — do NOT serve PDFs for revoked certs.

**Source:** `modules/18-certification/src/routes.ts` — `GET /api/certificates/:credentialId/pdf`.


#### `POST /api/certificates/:credentialId/share-linkedin`

Increment the `linkedin_shares` counter. Fire-and-forget from the frontend before opening the LinkedIn share URL.

**Auth:** candidate session required.

**Body:** none.

**Response 204:** no content.

**Source:** `modules/18-certification/src/routes.ts` — `POST /api/certificates/:credentialId/share-linkedin`.


### Admin-facing

> All admin endpoints require tenant-context middleware (CLAUDE.md rule #4). Tenant scope is derived from the session — never passed in URL or body.


#### `GET /api/admin/certificates`

List all certificates for the calling tenant (paginated, filterable).

**Auth:** admin session + tenant-context middleware.

**Query params:** `candidate_id?` (UUID), `tier?` (completion|distinction|honors), `revoked?` (true|false), `limit` (default 20, max 100), `offset` (default 0), `sort?` (allowlist enum: `credential_id`|`user_email`|`tier`|`course_title`|`issued_at`|`status`), `dir?` (`asc`|`desc`). Default sort `issued_at desc`. `sort` maps through a fixed column allowlist server-side (ORDER BY cannot be parameterized); invalid values fall back to the default. **2026-05-21**

**Response 200:**
```json
{ "items": [ /* Certificate objects */ ], "total": 42 }
```

**Source:** `modules/18-certification/src/routes.ts` — `GET /api/admin/certificates`.


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


#### `POST /api/admin/certificates/:id/reissue`

Re-snapshot `display_name` from the current `users` record and recompute `signed_hash`. Does NOT rotate `credential_id` or `issued_at` — doing so would break shared LinkedIn URLs and invalidate previously verified HMAC signatures.

**Auth:** admin session + tenant-context middleware.

**Body:** none.

**Response 200:** updated Certificate object.

**Response 404:** cert not found in calling tenant.

## Admin — Billing (Phase A1, module 19-billing)

> **Status: LIVE — 2026-05-17 (commit `111dd77`).** Route in `modules/19-billing/src/routes.ts`. Auth via `authChain({ roles: ['admin'] })`. Tenant context via `withTenant` (RLS-scoped to session tenant).

### `GET /api/billing/usage`

Returns the calling tenant's credit tier, allowance, and current consumption. Soft-enforcement only — this endpoint reports usage and never blocks a request.

**Auth:** company tenant admin (`authChain({ roles: ['admin'] })`); own tenant only; read-only. `super_admin` satisfies the admin gate via the role hierarchy and resolves to the platform tenant's plan row (`internal` tier, `included_credits: null` — harmless).

**Request:** no query params, no body.

**Response 200** `application/json`:
```json
{
  "tier": "free",
  "included_credits": 50,
  "used": 43,
  "remaining": 7,
  "overage": 0,
  "status": "warn"
}
```

| Field | Type | Notes |
|---|---|---|
| `tier` | `"free" \| "pro" \| "enterprise" \| "internal"` | From `tenant_plans.tier` |
| `included_credits` | `number \| null` | `null` when unlimited (`internal` tier) |
| `used` | `number` | `COUNT(*)` from `billing_events WHERE tenant_id = ?` |
| `remaining` | `number \| null` | `included_credits - used`; `null` when unlimited; negative value signals overage magnitude |
| `cycle_window_start` | `string \| null` | **FU-A2 (2026-10-06).** ISO start of the current monthly window (`cycle_start` + whole months elapsed); `used` and `ai_answers_used` count events since this instant. `null` only when the tenant has no plan row. |
| `ai_answers_used` | `number` | **FU-A4 (2026-10-06).** AI-evaluated answers accepted this window (one per attempt + question; re-accepts not counted). |
| `ai_answers_included` | `number \| null` | **FU-A9.** From the tier table: Starter 20, Growth 500, Enterprise/internal `null` (no cap recorded). |
| `ai_answers_remaining` | `number \| null` | `ai_answers_included - ai_answers_used`; `null` when no cap. |
| `overage` | `number` | `max(0, used - included_credits)`; `0` when unlimited |
| `status` | `"ok" \| "warn" \| "over" \| "unlimited"` | `ok` = <80% used; `warn` = 80–<100%; `over` = ≥100%; `unlimited` = `included_credits` is null |

**Errors:**

- `401 AUTHN_FAILED` — no session or invalid session cookie. Verified live.
- No `404` for a planless tenant — fails safe to `{ tier: "free", included_credits: 0, used: <count>, status: "over" }` and logs a server-side warning. This is an operator-visible data-integrity signal (every tenant should have a plan row post-backfill by migration `0080`).

**Note:** RLS-scoped to the session tenant via `withTenant`. The credit count query is `COUNT(*) FROM billing_events WHERE tenant_id = $1` — no mutable counter, always self-consistent.

**Source:** `modules/19-billing/src/routes.ts` — `GET /api/billing/usage`.

## Admin — Super Billing (Phase A2, module 19-billing)

> **Status: LIVE — 2026-05-17 (commit `66ea0ff`).** Routes in `apps/api/src/routes/admin-super.ts`. Auth via `authChain({ roles: ['super_admin'] })` (`superAdminOnly` gate — same as all other super routes). No fresh-MFA requirement (fresh-MFA is reserved for tenant creation; config edits like plan changes do not require step-up).

> **FU-A2/FU-A4/FU-A9 (2026-10-06):** `GET /api/admin/super/tenants` usage rows and `GET /api/admin/super/tenants/:tenantId/billing` also return `ai_answers_used` and `ai_answers_included`; the detail adds `cycle_window_start`. `used` now counts the current monthly window, not lifetime (see `docs/02-data-model.md` § Migration 0160). `recent_events` lists graded events only.

### `GET /api/admin/super/tenants/:tenantId/billing`

Returns full billing detail for a single tenant. Intended for the platform operator billing drill-down view.

**Auth:** `super_admin` only (`superAdminOnly`). Tenant admins and reviewers receive `403 AUTHZ_FAILED`.

**Path params:** `tenantId` — UUID of the target tenant.

**Request:** no query params, no body.

**Response 200** `application/json` — `TenantBillingDetail`:
```json
{
  "tenant_id": "uuid",
  "tier": "free",
  "included_credits": 50,
  "status": "active",
  "cycle_start": "2026-01-01T00:00:00Z",
  "used": 43,
  "remaining": 7,
  "overage": 0,
  "usage_status": "warn",
  "recent_events": [
    { "id": "uuid", "attempt_id": "uuid", "event_type": "assessment_graded", "occurred_at": "2026-05-17T09:00:00Z" }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `tenant_id` | `string` (UUID) | Target tenant |
| `tier` | `"free" \| "pro" \| "enterprise" \| "internal"` | From `tenant_plans.tier` |
| `included_credits` | `number \| null` | `null` when unlimited (`internal` tier) |
| `status` | `"active" \| "suspended"` | From `tenant_plans.status` |
| `cycle_start` | ISO8601 string | Reserved; not cycle-windowed in A2 — usage is lifetime `COUNT(*)` |
| `used` | `number` | `COUNT(*)` from `billing_events WHERE tenant_id = ?` |
| `remaining` | `number \| null` | `included_credits - used`; `null` when unlimited; negative = overage magnitude |
| `overage` | `number` | `max(0, used - included_credits)`; `0` when unlimited |
| `usage_status` | `"ok" \| "warn" \| "over" \| "unlimited"` | `ok` = <80% used; `warn` = 80–<100%; `over` = ≥100%; `unlimited` = credits null |
| `recent_events` | `Array<{ id, attempt_id, event_type, occurred_at }>` | Last 50 billing events, newest first |

**Errors:**

- `404` `details.code = 'PLAN_NOT_FOUND'` — target tenant has no `tenant_plans` row (data-integrity signal; every tenant should have a row post-backfill by migration `0080`).
- `401 AUTHN_FAILED` — no session.
- `403 AUTHZ_FAILED` — caller is not `super_admin`.

**Source:** `apps/api/src/routes/admin-super.ts`, `modules/19-billing/src/service.ts`.


### `GET /api/admin/super/tenants/:tenantId/billing/export.csv`

Downloads all billing events for a tenant as an RFC4180 CSV file.

**Auth:** `super_admin` only.

**Path params:** `tenantId` — UUID of the target tenant.

**Request:** no query params, no body.

**Response 200** `text/csv; charset=utf-8`:

- `Content-Disposition: attachment; filename="billing-<tenantId>.csv"`
- RFC4180 body: header row `id,attempt_id,event_type,occurred_at`; one data row per `billing_events` record (all events for the tenant, newest first); every field double-quoted.

**Errors:**

- `401 AUTHN_FAILED` — no session.
- `403 AUTHZ_FAILED` — caller is not `super_admin`.

**Note:** No `404` for a tenant with zero events — returns a header-only CSV. A `404` for an unknown `tenantId` may be returned if tenant existence is validated before the query.

**Source:** `apps/api/src/routes/admin-super.ts`, `modules/19-billing/src/service.ts`.


### `PATCH /api/admin/super/tenants/:tenantId/plan`

Updates a tenant's billing tier and/or credit allowance. Both fields are optional — omitting a field keeps the previous value.

**Auth:** `super_admin` only (`superAdminOnly` — same gate as `PATCH .../ai-generate-mode`). No fresh-MFA required (fresh-MFA is reserved for tenant creation, not config edits).

**Path params:** `tenantId` — UUID of the target tenant.

**Body** (both fields optional):
```json
{ "tier": "pro", "includedCredits": 200 }
```

| Field | Type | Notes |
|---|---|---|
| `tier` | `"free" \| "pro" \| "enterprise" \| "internal"` (optional) | Omit to keep existing tier |
| `includedCredits` | `number \| null` (optional) | Omit to keep existing value; `tier:'internal'` with `includedCredits` omitted coerces credits to `null` (unlimited) |

**Response 200** `application/json`:
```json
{
  "tenant_id": "uuid",
  "tier": "pro",
  "included_credits": 200,
  "previous": { "tier": "free", "included_credits": 50 },
  "updatedAt": "2026-05-17T10:30:00Z",
  "auditId": "uuid"
}
```

- `previous` — tier and credits before this call (for undo / audit display).
- `auditId` — UUID of the `audit_log` row committed atomically with the `UPDATE`.

**Validation errors (400):**

| `details.code` | Condition |
|---|---|
| `INVALID_TIER` | `tier` not in `"free" \| "pro" \| "enterprise" \| "internal"` |
| `INVALID_CREDITS` | `includedCredits` is not `null` and not an integer ≥ 0 |
| `INTERNAL_REQUIRES_NULL_CREDITS` | `tier = "internal"` with explicit non-null `includedCredits` |
| `FINITE_TIER_REQUIRES_CREDITS` | `tier` is non-`internal` and `includedCredits` is explicitly `null` |

**Errors:**

- `404` `details.code = 'PLAN_NOT_FOUND'` — target tenant has no `tenant_plans` row.
- `401 AUTHN_FAILED` — no session.
- `403 AUTHZ_FAILED` — caller is not `super_admin`.

**Audit:** Emits `tenant.plan_updated` (`ACTION_CATALOG` in `modules/14-audit-log/src/types.ts`). The `UPDATE` on `tenant_plans` and the `audit_log` INSERT are in the same Postgres transaction (atomic — rollback reverts both). This is a **two-role transaction**. The `SELECT … FOR UPDATE` + `UPDATE` on `tenant_plans` runs under `assessiq_system` (BYPASSRLS; by design, no UPDATE RLS policy exists on `tenant_plans`). The `auditInTx` write to `audit_log` runs under `assessiq_app` with `set_config('app.current_tenant', tenantId, true)`. This satisfies the INSERT RLS policy of `audit_log` and the `modules/14-audit-log/src/audit.ts` contract. This mirrors the reviewed `updateAiGenerateMode` precedent in `@assessiq/tenancy`.

**Source:** `apps/api/src/routes/admin-super.ts`, `modules/19-billing/src/service.ts` (`updateTenantPlan`).

## Entitlements and publish-time enforcement

Phase B1 and B2 changed who may call the question-bank and generation routes. They also added the tenant entitlement routes and the publish-time check.

### Phase B1 — generation endpoints re-gated to super_admin

> **Status: LIVE — 2026-05-18 (commits `2ba822d` + `9f073a5`).** Follows Phase A2.

Previously `roles:['admin']`, now `roles:['super_admin']` for the following 7 paths. Tenant admins receive `403 AUTHZ_FAILED`. Nav links and SPA routes for these features are also restricted to super_admin as defence-in-depth — the backend auth gate is authoritative. The remaining question-bank **authoring** routes (pack/level/question CRUD, import, publish, archive, activate-questions, save-rubric, bulk-status) later moved to `super_admin` as well. See the next subsection (2026-05-21). `modules/07-ai-grading` grading routes (grade, accept, release, override, etc.) remain unchanged on `roles:['admin']`.

| Path | Previous auth | Phase B1 auth |
|---|---|---|
| `POST /api/admin/packs/:id/levels/:levelId/generate` | `roles:['admin']` | `roles:['super_admin']` |
| `POST /api/admin/questions/:id/generate-rubric` | `roles:['admin']` | `roles:['super_admin']` |
| `POST /api/admin/questions/:id/generate-answer-guidance` | — | `roles:['super_admin']` |
| `POST /api/admin/packs/:id/generate-missing-rubrics` | `roles:['admin']` | `roles:['super_admin']` |
| `GET /api/admin/generation-attempts` | `roles:['admin']` | `roles:['super_admin']` |
| `GET /api/admin/packs/:packId/levels/:levelId/generation-attempts` | `roles:['admin']` | `roles:['super_admin']` |
| `POST /api/admin/generation-attempts/:id/score` | `roles:['admin']` | `roles:['super_admin']` |

**Source:** `modules/04-question-bank/src/routes.ts` — `superAdminOnly` chain replaces `adminOnly` on the 6 generation/history routes. Per-route auth is documented inline in § Admin — Rubric generation & generation attempts above.

### Phase B1 (cont.) — question-bank authoring re-gated to super_admin

> **Status: LIVE — 2026-05-21 (backend `7500abb`, frontend `ef9d2d8`).** Completes the Phase B1 model on every QB mutation, not just generation.

The Phase B1 model — super_admin curates the shared question-pack library; tenant admins consume entitled packs read-only — is now enforced on **every** question-bank mutation. The 13 routes below moved `roles:['admin']` → `roles:['super_admin']`; tenant admins get `403 AUTHZ_FAILED`. All `GET` reads (list/get pack, list/get question, list versions) deliberately stay `roles:['admin']` so tenant admins keep a read-only view.

| Path | Previous | Now |
|---|---|---|
| `POST /api/admin/packs` | admin | super_admin |
| `PATCH /api/admin/packs/:id` | admin | super_admin |
| `POST /api/admin/packs/:id/publish` | admin | super_admin |
| `POST /api/admin/packs/:id/revise` | admin | super_admin |
| `POST /api/admin/packs/:id/archive` | admin | super_admin |
| `POST /api/admin/packs/:id/activate-questions` | admin | super_admin |
| `POST /api/admin/packs/:id/levels` | admin | super_admin |
| `PATCH /api/admin/levels/:id` | admin | super_admin |
| `POST /api/admin/questions` | admin | super_admin |
| `POST /api/admin/questions/import` | admin | super_admin |
| `PATCH /api/admin/questions/:id` | admin | super_admin |
| `POST /api/admin/questions/:id/restore` | admin | super_admin |
| `POST /api/admin/questions/:id/save-rubric` | admin | super_admin |
| `POST /api/admin/questions/bulk-update-status` | admin | super_admin |

**Re-gated later (2026-10-11, RW-56):** `POST /api/admin/domains` and `POST /api/admin/categories` first stayed `admin` here. They are now `super_admin` only (see "S9 notes" at the end of this file). **SPA gating (defence-in-depth; the backend is the authoritative gate):** the Question Bank list hides "+ New Pack" and the per-row archive from non-super_admin. Pack-detail hides Publish / Archive pack / Activate all / per-question Archive / bulk select+approve+archive, and it shows per-question **Edit → View**. The question editor is read-only for tenant admins (no approve/archive/generate/save; read-only rubric summary; create form blocked). Adversarial review (Sonnet takeover; codex companion was hung) returned VERDICT=accept — no cross-tenant leak, no authz gaps, const-only SQL interpolation, fail-closed counts.

**Source:** `modules/04-question-bank/src/routes.ts`.

### Phase B1 — tenant entitlement endpoints

> **Status: LIVE — 2026-05-18 (commits `2ba822d` + `9f073a5`).** Schema in `docs/02-data-model.md` § `tenant_entitlements`.

#### `GET /api/admin/super/tenants/:tenantId/entitlements`

Returns all entitlement rows for the named tenant, including revoked rows.

**Auth:** `super_admin` only. Returns `401 AUTHN_FAILED` / `403 AUTHZ_FAILED` otherwise.

**Path params:** `tenantId` — UUID of the target tenant.

**Response 200:**
```json
{
  "entitlements": [
    {
      "id": "uuid",
      "tenant_id": "uuid",
      "scope_type": "domain",
      "scope_id": "soc",
      "status": "active",
      "granted_at": "2026-05-18T00:00:00Z",
      "granted_by": "uuid-or-null"
    }
  ]
}
```

`granted_by` is `null` for backfill rows (migration `0082`). Both `active` and `revoked` rows are returned; use `status` to filter.

**Errors:** `401 AUTHN_FAILED` — no session. `403 AUTHZ_FAILED` — caller is not `super_admin`.

**Source:** `apps/api/src/routes/admin-super.ts`, `modules/19-billing/src/service.ts`.


#### `POST /api/admin/super/tenants/:tenantId/entitlements`

Grants a domain or pack-level entitlement to the named tenant. Idempotent — if the `(tenant, scope_type, scope_id)` already exists and is active, returns the existing row unchanged. If the row exists but is revoked, reactivates it (`ON CONFLICT DO UPDATE`).

**Auth:** `super_admin` only.

**Path params:** `tenantId` — UUID of the target tenant.

**Body:**
```json
{ "scopeType": "domain", "scopeId": "soc" }
```

| Field | Type | Notes |
|---|---|---|
| `scopeType` | `"domain" \| "pack"` | Required |
| `scopeId` | `string` | Required; 1–256 chars; domain label or pack UUID |

**Response 200:**
```json
{
  "tenant_id": "uuid",
  "scope_type": "domain",
  "scope_id": "soc",
  "status": "active",
  "auditId": "uuid"
}
```

**Errors:**
- `400` `details.code = 'INVALID_SCOPE'` — `scopeType` not `"domain"` or `"pack"`, or `scopeId` is empty or >256 chars.
- `401 AUTHN_FAILED` — no session.
- `403 AUTHZ_FAILED` — caller is not `super_admin`.

**Audit:** Emits `tenant.entitlement_granted` (appended to `ACTION_CATALOG` in `modules/14-audit-log/src/types.ts`). Two-role transaction: `assessiq_system` (BYPASSRLS) for the `INSERT … ON CONFLICT DO UPDATE` on `tenant_entitlements`; `assessiq_app` + `set_config('app.current_tenant', tenantId, true)` for the `auditInTx` write — same pattern as `updateTenantPlan`.

**Source:** `apps/api/src/routes/admin-super.ts`, `modules/19-billing/src/service.ts` (`grantTenantEntitlement`).


#### `DELETE /api/admin/super/tenants/:tenantId/entitlements`

Revokes an active entitlement by soft-delete (sets `status='revoked'`, records `revoked_by` and `revoked_at`). Never hard-deletes.

**Auth:** `super_admin` only.

**Path params:** `tenantId` — UUID of the target tenant.

**Body (JSON):**
```json
{ "scopeType": "domain", "scopeId": "soc" }
```

Note: this `DELETE` carries a JSON body — required because the scope identity is composite (`scope_type` + `scope_id`). Standard HTTP allows body on DELETE; the Fastify route explicitly enables content-type parsing for this verb.

**Response 200:**
```json
{
  "tenant_id": "uuid",
  "scope_type": "domain",
  "scope_id": "soc",
  "status": "revoked",
  "auditId": "uuid"
}
```

**Errors:**
- `404` `details.code = 'ENTITLEMENT_NOT_FOUND'` — no active entitlement matching `(tenantId, scopeType, scopeId)` was found. No audit row is written for the no-op.
- `400` `details.code = 'INVALID_SCOPE'` — `scopeType` / `scopeId` validation failure.
- `401 AUTHN_FAILED` — no session.
- `403 AUTHZ_FAILED` — caller is not `super_admin`.

**Audit:** Emits `tenant.entitlement_revoked` (`ACTION_CATALOG` in `modules/14-audit-log/src/types.ts`). Same two-role transaction pattern as grant.

**Clone archival (RW-47, S10, 2026-10-15).** The revoke runs in the same system-role transaction as the entitlement `UPDATE`. It also sets the cloned `question_packs` of the tenant for that scope to `status='archived'`.
- Pack scope: clones whose `source_pack_id` is the revoked pack. The `scopeId` can be the source id or a clone id.
- Domain scope: every clone whose source pack has the revoked domain slug.
- When at least one clone is archived, the transaction writes one `tenant.pack_clone_archived` audit row. It holds ids and counts only (`source_pack_ids`, `archived_clone_ids`, `archived_count`).
- The response shape does not change.
- The code never deletes content. Attempts in progress are not affected, because questions are snapshotted at attempt start.
- A later grant does NOT un-archive the clones. The admin must clone again.

**Source:** `apps/api/src/routes/admin-super.ts`, `modules/19-billing/src/service.ts` (`revokeTenantEntitlement`).


#### `GET /api/admin/super/tenants/:tenantId/content-scopes` (2026-05-24)

The endpoint returns the **grantable scopes** of the PLATFORM library for the named tenant. These are the domain slugs and published platform packs that a super-admin can grant through `POST /entitlements`, minus scopes that this tenant already has actively granted.

**Auth:** `super_admin` only.

**Path params:** `tenantId` — UUID of the target tenant.

**What it returns.** The response is built from two sources under `assessiq_system` (BYPASSRLS):
1. **Canonical domain slugs** — queried from the `domains` table (the platform's taxonomy, seeded by migration 0083). These are lowercase slugs like `"soc"`, `"devops"`, `"cloud-architect"`.
2. **Published platform packs** — `question_packs` rows where `tenant_id = platform_tenant_id` AND `status = 'published'`, represented as `scope_type='pack'` entries with `scope_id = pack.id`.

Scopes that already have an `active` row in `tenant_entitlements` for this tenant are **excluded**. The result is the delta that the super-admin can still grant, not a full catalog list.

**Why this endpoint replaced the old behavior.** The previous implementation read the **target tenant's own** `question_packs.domain` column values and returned those as grantable scopes. That produced non-canonical free-text domains (for example, `'SOC'`, mixed-case values from the old free-text Domain field). These never matched the lowercase platform slug `'soc'` during license-resolution at publish time (`assertPublishEntitled` matches entitlement `scope_id` against `question_packs.domain` by exact string). The fix takes scopes from the `domains` table of the platform instead. The granted `scope_id` therefore always matches the canonical lowercase slug written to `question_packs.domain` by the write-path enforcement (see migration `0090_normalize_domain_slugs.sql` in `docs/02-data-model.md`).

**Response 200:**
```json
{
  "grantable": [
    { "scope_type": "domain", "scope_id": "soc",        "label": "SOC Analyst" },
    { "scope_type": "domain", "scope_id": "devops",     "label": "DevOps" },
    { "scope_type": "pack",   "scope_id": "uuid-of-pack", "label": "SOC Analyst L1–L3", "domain": "soc" }
  ]
}
```

`label` is the human-readable name from the `domains` table (for domain scopes) or `question_packs.name` (for pack scopes). `domain` is present only on pack entries. Already-granted-active scopes are omitted. Empty `grantable` array when nothing remains to grant.

**Errors:** `401 AUTHN_FAILED` — no session. `403 AUTHZ_FAILED` — caller is not `super_admin`. `404` — `tenantId` not found.

**Source:** `apps/api/src/routes/admin-super.ts`, `modules/19-billing/src/service.ts` (`listGrantableScopesForTenant`).


#### Platform domain management (2026-05-25)

Super-admin management of the canonical domain taxonomy. These are **platform-wide** operations (no `:tenantId`): they read and write the `domains` of the platform master tenant. They **propagate** changes into every company tenant, so the whole fleet shares one consistent domain set. Provenance (`domains.source`, migration 0091) keeps propagation from ever touching a tenant-LOCAL domain. Cross-tenant writes run under `SET LOCAL ROLE assessiq_system`; each mutation writes one audit row in the same transaction.

**Why a new namespace (not the existing `POST /api/admin/domains`).** `POST /api/admin/domains` (module 04) was the **tenant-local** domain-create path. Since 2026-10-11 (RW-56) it is `superAdminOnly`: a tenant admin gets 403 and no longer adds domains. The `/api/admin/super/domains` namespace is for **platform** domains that mirror across tenants and needs `super_admin` + fresh MFA, like every other cross-tenant `/super` operation.

##### `GET /api/admin/super/domains`

Lists the domains of the platform master tenant, in **all statuses** (active + archived + legacy inactive). The UI can then show the full library and offer reactivate.

**Auth:** `super_admin` only (read-only; no fresh MFA).

**Response 200:**
```json
{ "domains": [
  { "id": "uuid", "slug": "soc", "name": "SOC", "description": null,
    "status": "active", "display_order": 1, "source": "platform" }
] }
```
Empty `domains` array when the platform tenant does not exist (fresh DB).

##### `POST /api/admin/super/domains`

Creates a platform domain and propagates it (`source='platform'`, `status='active'`) into every non-platform tenant. The propagation INSERT is `ON CONFLICT (tenant_id, slug) DO NOTHING`, so the INSERT skips a tenant that already has the slug and leaves it untouched. This includes a **tenant-local domain on the same slug**.

**Auth:** `super_admin` + **fresh MFA** (15-min) — platform-affecting cross-tenant write.

**Body (JSON):** `{ "name": "Network Security", "description": "optional" }` — `slug` is server-generated kebab-case(name).

**Response 201:**
```json
{ "id": "uuid", "slug": "network-security", "name": "Network Security",
  "description": null, "status": "active", "display_order": 10,
  "source": "platform", "propagatedTenants": 5 }
```
`propagatedTenants` = number of company tenants that received the new row (collisions skipped are not counted).

**Errors:** `400 MISSING_REQUIRED`/`INVALID_PARAM` — bad/empty name. `409 DOMAIN_SLUG_EXISTS` — the platform tenant already has this slug. `404 PLATFORM_TENANT_MISSING` — no platform tenant. `401`/`403` — auth/MFA.

**Audit:** `domain.created`.

##### `PATCH /api/admin/super/domains/:id`

Archives (`status='archived'`) or reactivates (`status='active'`) a platform domain and propagates the status to **every platform-origin copy** of that slug across all tenants (`UPDATE … WHERE slug=$ AND source='platform'`). Tenant-local domains sharing the slug are never touched.

**CATALOG-ONLY (decided 2026-05-25):** archiving removes the domain from all selection dropdowns (which filter `status='active'`) and makes it non-grantable from then on. It does **not** revoke existing `tenant_entitlements`. It does **not** untag existing packs/questions. Reversible via reactivate.

**Auth:** `super_admin` + **fresh MFA** (15-min).

**Path params:** `id` — UUID of the **platform** domain row. Passing a tenant-local domain id (or any non-platform row) returns `404`.

**Body (JSON):** `{ "status": "archived" }` or `{ "status": "active" }`.

**Response 200:**
```json
{ "id": "uuid", "slug": "network-security", "name": "Network Security",
  "description": null, "status": "archived", "display_order": 10,
  "source": "platform", "affectedRows": 6 }
```
`affectedRows` = number of platform-origin rows flipped (platform tenant + each company copy).

**Errors:** `400 INVALID_STATUS` — status not `active`/`archived`. `400 INVALID_PARAM` — id not a UUID. `404 DOMAIN_NOT_FOUND` — id is not a platform domain. `404 PLATFORM_TENANT_MISSING`. `401`/`403` — auth/MFA.

**Audit:** `domain.archived` | `domain.reactivated`.

**Source:** `apps/api/src/routes/admin-super.ts`, `modules/04-question-bank/src/platform-domains.ts`.


#### `GET /api/billing/entitlements`

Returns the calling tenant's own active entitlements. Read-only; drives the B2 publish-time scope picker (not yet built).

**Auth:** Company tenant admin (`companyAdmin` chain — `roles:['admin']` scoped to the session tenant). Super-admin can also call as a tenant by establishing a tenant session. `roles:['candidate']` receives `403`.

**Response 200:**
```json
{
  "entitlements": [
    {
      "id": "uuid",
      "tenant_id": "uuid",
      "scope_type": "domain",
      "scope_id": "soc",
      "status": "active",
      "granted_at": "2026-05-18T00:00:00Z",
      "granted_by": "uuid-or-null"
    }
  ]
}
```

Active rows only — revoked rows are excluded. RLS-scoped to the session tenant (no cross-tenant leakage possible).

**Errors:** `401 AUTHN_FAILED` — no session. `403 AUTHZ_FAILED` — caller is not a tenant admin.

**Source:** `modules/19-billing/src/routes.ts` — `GET /api/billing/entitlements`.

#### `GET /api/billing/available-sets`

**Step 2 (standing-license + clone-on-use).** Returns the published PLATFORM-library question sets that the calling tenant has a license for. A **domain** license shows ALL current AND future sets in that domain. A **pack** license shows one set. The response has metadata only (no question content). SQL applies the license filter, so the endpoint never returns an unlicensed set. Drives the company-admin "assess from a set" picker, which calls `POST /admin/assessments/from-set` (clone-on-use).

**Auth:** Company tenant admin (`companyAdmin` chain). Runs under `assessiq_system` to read the platform library while resolving the caller's own licenses + existing clones.

**Response 200:**
```json
{
  "sets": [
    {
      "source_pack_id": "uuid",
      "name": "SOC Analyst L1–L3",
      "domain": "soc",
      "source_version": 3,
      "question_count": 42,
      "level_count": 3,
      "cloned": true,
      "cloned_pack_id": "uuid-or-null",
      "update_available": false
    }
  ]
}
```
Empty `sets` when the tenant has no active licenses. `cloned`/`update_available` flag whether the set was already materialised into the tenant and whether a newer source version exists.

**Source:** `modules/19-billing/src/routes.ts` — `GET /api/billing/available-sets` → `listAvailableSetsForTenant`.

### Phase B2 — publish-time enforcement

> **Status: LIVE — 2026-05-18 (commit `5c80aaa`).** Follows Phase B1. Schema in `docs/02-data-model.md` § `tenant_entitlements` → Phase B2 note.

Every transition INTO `assessments.status='published'` now validates pack entitlement server-side **before** the status write and the `assessment.published` audit event. This applies to `POST /admin/assessments/:id/publish` (`draft → published`) and to `POST /admin/assessments/:id/reopen` (`closed → published`). The check runs inside the existing `withTenant` transaction in `modules/05-assessment-lifecycle/src/service.ts`; a failure rolls back the entire transition (no partial published row, no audit entry).

**Entitlement function:** `assertPublishEntitled(client, tenantId, packId)` exported from `@assessiq/billing`.

**Decision tree:**

1. `tenant_plans.tier = 'internal'` → **bypass** (always allowed).
2. No `tenant_plans` row for the tenant → **fail-closed** (enforce, not bypass).
3. `assessment.pack_id` has an active `tenant_entitlements` row with `scope_type='pack'` → **entitled**.
4. `question_packs.domain` of that pack has an active `tenant_entitlements` row with `scope_type='domain'` → **entitled**.
5. Neither → **403 `NOT_ENTITLED`**.

Reads (`tenant_plans`, `tenant_entitlements`, `question_packs`) run under the publishing tenant's own `withTenant` RLS — no system role; cross-tenant reads are structurally impossible.

**The picker in `assessment-detail.tsx` is convenience only** — it hints at entitlement when you select a pack at draft time. It fails open and is never authoritative. The server 403 is the gate.

**403 NOT_ENTITLED body:**

```json
{
  "error": {
    "code": "NOT_ENTITLED",
    "message": "The question pack is not entitled for this tenant's plan.",
    "details": {
      "code": "NOT_ENTITLED",
      "pack_id": "<uuid>",
      "domain": "<domain-label>"
    }
  }
}
```

A 403 rolls back the publish attempt — there is no partial published state and no `assessment.published` audit row.

## Scoring and result release (2026-10-01)

> **Status: LIVE.** Phase I (candidate result, release modes, result email; deploy `ecea951`) and Phase II (platform evaluation queue; merges `ee8a28f` backend and `1564489` frontend, fix `a7b4596`). Rules: a candidate sees only a **complete, final** result. Only the platform super admin runs AI evaluation. The company (tenant) reviews and publishes. **This section supersedes** the grade / accept / rerun / attempt-detail / release / override rows under "Admin — Grading & review" and the candidate `submit` / `result` rows. Data: `docs/02-data-model.md` § Scoring and result release. Flow and rationale: `docs/05-ai-pipeline.md` § Platform evaluation queue.

**Conventions.** Errors are `{ error: { code, message, details? } }`. A body that fails validation returns `400 VALIDATION_FAILED` (`details.code = AIG_INVALID_BODY`, `details.issues`). A value that a handler rejects uses the `error.code` shown below. Three codes are the exception: `TENANT_NOT_ACTIVE`, `TENANT_NOT_FOUND` and `INVALID_RESULT_RELEASE_MODE`. These are `error.details.code`, and the top-level code is `CONFLICT`, `NOT_FOUND`, `VALIDATION_FAILED`. The tenant is never in the URL or body. Company routes use the tenant of the session. Platform routes find the tenant of the attempt in the database. State a company sees: `awaiting_evaluation` → `ready_to_publish` → `published`.

### Candidate (`/api/me/*`, candidate session)

| Method + path | Behaviour |
|---|---|
| `POST /api/me/attempts/:id/submit` | `202 { attempt_id, status: 'submitted', estimated_grading_seconds: 60 \| null, result_expectation: 'soon' \| 'email', release_mode: 'manual' \| 'auto', email_masked, turnaround_text }`. `'soon'` only when the tenant is in `auto` (switched on) AND every question is MCQ AND the attempt is not an embed attempt; everything else is `'email'`. `email_masked` looks like `r***@example.com`. `turnaround_text` is config `EVALUATION_TURNAROUND_TEXT` (default "within 72 hours"). The lookup can never fail a submit (it falls back to `'email'`). Never a score. |
| `GET /api/me/attempts/:id/result` | Published: `200 { status: 'released', total_earned, total_max, percent (0-100, 1 dp), passed (score reaches the assessment pass mark, integer math, no rounding up), pass_mark_pct (1-100, snapshot from `attempt_scores.pass_mark_pct`, Z-16), assessment_name, released_at, certificate: { credential_id, verify_url } \| null }`. Otherwise `202 { status: 'pending', result_expectation, release_mode, email_masked, turnaround_text, tenant_name }`. 404 for an unknown attempt or someone else's. Never per-question data, bands, justifications or a partial score. |
| `GET /api/me/results` | `200 { items: [{ attempt_id, assessment_name, released_at, total_earned, total_max, percent, passed, certificate \| null, is_new }] }`: published results only, newest first (the portal "My results" page). |
| `POST /api/me/attempts/:id/seen` | Z-12. Candidate session; no body. Sets `attempts.seen_at` for the caller's own released attempt, once (idempotent). `200 { seen: true }`. 404 `AE_ATTEMPT_NOT_FOUND` for an unknown, non-uuid, unreleased or someone else's attempt, and across tenants. `is_new` in `GET /api/me/results` is true until this call. The shell banner counts `is_new` results; notification mark-read no longer clears it. |

Related: the candidate magic-link verify (`POST /api/auth/candidate/verify-link`) now redirects to `/candidate/results`. `GET /api/me/activity/stats` and `/leaderboard` count published results only. The `result_released` email links to `/candidate/login?tenant=<slug>`. The system sends it once, after publishing, and skips erased candidates and embed attempts. That page reads `?tenant=`. It shows an "Organisation code" field when the parameter is missing. The consent policy version recorded at Begin is now `2026-10-02` (the PreTest copy says written answers are evaluated by AssessIQ evaluators with AI assistance).

### Company (tenant) admin (`/api/admin/*`, admin session)

| Method + path | Auth | Behaviour |
|---|---|---|
| `GET /api/admin/tenant-settings` | admin | `200 { result_release_mode, result_release_auto_since, retention_days, company_name }`. |
| `PATCH /api/admin/tenant-settings/result-release-mode` | admin + **fresh MFA (15 min)** | Body `{ mode: 'manual' \| 'auto' }` → `200 { tenantId, result_release_mode, previous, result_release_auto_since, updatedAt, auditId \| null }` (`auditId` is null on a same-mode no-op). Switching never publishes anything by itself; only evaluations released AFTER switching to auto are published automatically (worker job `result.auto_release`, ~15 s). Errors: 400 `INVALID_RESULT_RELEASE_MODE`, 409 `TENANT_NOT_ACTIVE`, 401 stale MFA, 403 not admin. Audit `tenant.settings.updated`. |
| `POST /api/admin/attempts/:id/release` | admin | Publish one result (`graded` → `released`; certificate issued inside a SAVEPOINT; result email after commit). `200 { attempt: { id, status: 'released' } }`. Errors: 404 `AIG_ATTEMPT_NOT_FOUND`; 422 `AIG_ATTEMPT_NOT_RELEASABLE_ERASED`; 409 `RESULT_NOT_READY` (not `graded` (this used to be 422 `AIG_ATTEMPT_NOT_GRADEABLE`), evaluation not yet released to the company, or a grade still `review_needed`). |
| `POST /api/admin/assessments/:id/release-all` | admin | Publish every ready result of the assessment (graded, evaluation released, candidate not erased), one transaction each. `200 { released: [attemptId], skipped: [{ id, code }] }`. 404 unknown assessment; 400 non-UUID id. |
| `POST /api/admin/attempts/:id/send-back` | admin | Body `{ note: 1..500 chars }` (strict). Returns the evaluation to the platform queue: clears `evaluation_released_at/_by`, stores the note, status stays `graded` (no re-billing). `200 { attempt_id, evaluation_sent_back_at }`. Errors: 409 `EVALUATION_NOT_RELEASED`, 409 `RESULT_ALREADY_PUBLISHED`, 404. Audit `grading.sent_back` (the note is not in the audit row). |
| `POST /api/admin/gradings/:id/override` | admin + **fresh MFA (5 min)** | Changed: allowed only after the platform released the evaluation (409 `EVALUATION_NOT_RELEASED` before that; 409 `RESULT_ALREADY_PUBLISHED` once published). `score_earned` must be finite and within `0..score_max` (422 `AIG_INVALID_BODY`, `details.score_max`). The attempt rollup is recomputed in the same tx. Body and the INSERT-only D8 rule are unchanged. |
| `POST /api/admin/attempts/:id/{grade,accept,rerun}`, `POST …/questions/:questionId/manual-score`, `POST /api/admin/grading-jobs/:id/retry` | admin | **`403 AI_EVALUATION_BY_ASSESSIQ`** for everyone (anonymous callers still get 401). Kept only so a stale client gets a clear answer. |
| `GET /api/admin/attempts/:id` | admin | Now **read-only**: no `submitted → pending_admin_grading` claim and no `grading.claimed` audit row. Adds `evaluation_status`, `evaluation_released_at`, `evaluation_note`, `evaluation_sent_back_at` and `score` (`{ total_earned, total_max, auto_pct, pending_review }`). `ai_proposals` and `grading_started_at` are always `null` for companies. While `awaiting_evaluation`: `gradings: []` and `score: null`. |
| `GET /api/admin/attempts`, `GET /api/admin/dashboard/queue` | admin | Each row gains `evaluation_status`. |
| `GET /api/admin/attempts?status=` | admin | **RV58 (2026-10-03, commit `487707d`):** `status` accepts a comma-separated list. Each value must be one of `submitted`, `pending_admin_grading`, `graded`, `released`, `auto_submitted`; one bad value gives 400 `AIG_INVALID_BODY`. A single value works as before. The attempts page tab "Awaiting evaluation" sends `status=submitted,auto_submitted,pending_admin_grading` (the old "Pending grading" tab was always empty because `pending_admin_grading` is no longer written since `67ed5e2`). |
| `GET /api/admin/attempts?assessmentId=` | admin | **Z-22 (2026-10-17):** optional `assessmentId` (uuid; non-uuid gives 400 `AIG_INVALID_BODY`). Adds `a.assessment_id = $n::uuid` (parameterised); the tenant stays scoped by RLS, so an id from another tenant returns `{ items: [], total: 0 }`. Combines with `status`. The attempts page reads it from the URL and shows a clearable filter chip; the assessment page links here. |
| `GET /api/admin/assessments/:id/results.csv` | admin | A row still awaiting evaluation shows the result "Awaiting evaluation" and no score, percent or category columns. |

### Platform evaluation queue (`/api/admin/super/evaluations*`, `super_admin` only)

Chains are defined in `apps/api/src/routes/admin-super-evaluations.ts`; the route bodies are `modules/07-ai-grading/src/routes-super.ts`. **super** = `roles: ['super_admin']` (TOTP is always required for super admins); **super + fresh MFA** = the same plus TOTP within 15 minutes, used only by manual score and override. Every per-attempt route finds the tenant of the attempt in the database (read-only system-role lookup). It refuses a missing or suspended tenant (404 `TENANT_NOT_FOUND`, 409 `TENANT_NOT_ACTIVE`). Then it runs the handler inside the `withTenant` of that tenant with the super admin as actor. Audit rows therefore land in the log of the **tenant**. A non-UUID path param is `400 VALIDATION_FAILED`; an unknown attempt is `404 AIG_ATTEMPT_NOT_FOUND`. The platform never receives the candidate's name or email.

| Method + path | Auth | Body → success | Errors |
|---|---|---|---|
| `GET /api/admin/super/evaluations?tenant_id=` | super | → `200 { items: [{ attempt_id, tenant_id, tenant_name, assessment_id, assessment_name, level_label, submitted_at, age_hours (1 dp), written_count, kql_count, status, complete (status === 'graded'), grading_in_progress (an AI run started under 10 min ago), sent_back, sent_back_note, ai_paused (FU-A11: the company's `ai_grading_enabled` is false; grade / rerun answer 409, rows stay listed) }], counts: { pending, older_than_24h } }`. Oldest first, at most 500 rows (counts cover the whole queue). | 400 bad `tenant_id` |
| `GET …/:attemptId` | super | → `200 { tenant_id, tenant_name, attempt: { id, status, assessment_name, level_label, started_at, submitted_at }, answers, frozen_questions (with rubric), gradings, ai_proposals, grading_started_at, score, evaluation_released_at, evaluation_note, evaluation_sent_back_at }`. No side effects. | |
| `POST …/:attemptId/grade` | super | Optional `{ override_skill? }` → `200 { proposals }`. **The only AI trigger:** synchronous, single-flight, writes no `gradings` row until accepted (D8). | 409 `NOT_IN_EVALUATION_QUEUE`; 409 `AIG_TENANT_AI_PAUSED` (FU-A11, company flag off; RW-7: also returned AFTER the AI call if the pause landed during it, and the proposal is then discarded, not cached); 409 `AIG_HEARTBEAT_STALE` (session idle over 5 min); 409 `AIG_GRADING_IN_PROGRESS`; 422 `AIG_ATTEMPT_NOT_GRADEABLE`; 503 `AIG_*` runtime errors |
| `POST …/:attemptId/accept` | super | `{ proposals: [...] }` (same schema as the old tenant accept; every `proposal.attempt_id` must equal the URL id) → `200 { gradings, attempt: { id, status: 'graded' \| 'pending_admin_grading' } }`. Completing the attempt flips it to `graded` (billed once) but does **not** release it to the company. | 400 id mismatch or schema; 422 `AIG_INVALID_BODY` (`0 < score_max <= 1000`, `0 <= score_earned <= score_max`, question not in the attempt); 409 `RESULT_ALREADY_PUBLISHED`; 409 `AIG_TENANT_AI_PAUSED` (RW-7: accept is blocked while the company's AI is paused; nothing is written; manual-score and override stay allowed) |
| `POST …/:attemptId/rerun` | super | `{ forceEscalate?: boolean }` (strict; default false = normal automatic escalation) → fresh `proposals`. Also valid on a `graded` attempt the company sent back. | as `grade` (incl. 409 `AIG_TENANT_AI_PAUSED`, FU-A11; RW-7: also after the AI call, proposal discarded); 400 for any other body shape |
| `POST …/:attemptId/questions/:questionId/manual-score` | super + fresh MFA | `{ score_earned >= 0, reason 1..500 }` (strict) → `200 { grading, attempt: { id, status } }`. First human score for a question with no grade (KQL has no grader). No AI. | 409 `AIG_QUESTION_ALREADY_GRADED`; 409 `RESULT_ALREADY_PUBLISHED`; 422 `AIG_INVALID_BODY` (question not in the attempt, or outside `0..questions.points`); 422 `AIG_ATTEMPT_NOT_GRADEABLE` |
| `POST …/:attemptId/gradings/:gradingId/override` | super + fresh MFA | `{ score_earned, reasoning_band?, ai_justification?, error_class?, reason }` → `200 { grading }`. Part of the evaluation itself (no "released first" rule). | 404 `AIG_GRADING_NOT_FOUND` (also when the grading belongs to another attempt); 409 `RESULT_ALREADY_PUBLISHED`; 422 `AIG_INVALID_BODY` |
| `POST …/:attemptId/release-to-tenant` | super | → `200 { attempt_id, evaluation_released_at }`. Needs status `graded`, every question effectively graded, none `review_needed`, candidate not erased. Sets `evaluation_released_at/_by`, clears the send-back marker. Audit `grading.evaluation_released`. | 409 `EVALUATION_NOT_COMPLETE`, `EVALUATION_ALREADY_RELEASED`, `RESULT_ALREADY_PUBLISHED`; 422 `AIG_ATTEMPT_NOT_RELEASABLE_ERASED` |
| `POST /api/admin/super/evaluations/release-to-tenant` | super | `{ attempt_ids: uuid[1..200] }` (strict) → `200 { released: [ids], skipped: [{ id, code }] }`. One transaction per attempt; duplicates are processed once. | 400 |

`NOT_IN_EVALUATION_QUEUE` (`a7b4596`) guards `grade` and `rerun` only. The attempt must have a non-MCQ question and a non-erased candidate. It must be pre-graded or `graded`, and its evaluation must not be released yet. This is the same rule as the queue list. A direct call therefore cannot spend an AI run on an MCQ-only, released or published attempt.

**Considered and rejected.** Returning 404 for the old company grade routes (a stale client would not learn why; 403 with a stable code does). Showing a "provisional" score with a flag (owner rule P1 forbids any partial number). A new `attempts.status` value for "released to the company" (see `docs/02-data-model.md`).

**Not included.** Background or API-mode grading. Company-triggered AI: the owner has decided that companies may evaluate once an API budget exists, but this is not built, so these routes answer 403 in every mode. A per-assessment release mode. A "result updated" email (a published result is final). A company-facing ETA beyond the `turnaround_text` of the candidate.

**Release on the last accept (built, `809e807`, `23c9f0b`).** The accept, manual score or override that completes an attempt also releases the attempt to the company in the same transaction. `release-to-tenant` remains for sent-back attempts and recovery.

**Impact.** `modules/11-candidate-ui` wire types and the post-submit / My results pages. `modules/10-admin-dashboard` (tenant settings, review states, platform queue and evaluate pages). 15 results CSV and candidate activity. 13 `result_released` template. Rollback: deploy the previous image; the new columns are additive (data model doc).

### 2026-10-01 (later): invitations, webhooks, evaluation flow, option shuffle

**Invitations** (company admin; same auth chain as `/api/admin/invitations/:id`)

| Method + path | Success | Errors |
| --- | --- | --- |
| `POST /api/admin/invitations/:id/extra-attempt` | 200 `{ invitation, attempts_used, attempts_allowed }` (Z-39; body `{ reason }` required) | 404 `INVITATION_NOT_FOUND` · 409 `ASSESSMENT_NOT_ACTIVE`, `EXTRA_ATTEMPT_LIMIT` · 422 `INVALID_PARAM` |
| `POST /api/admin/invitations/:id/reopen` | 200 the invitation; a new link is emailed (Z-39, next attempt) | 404 `INVITATION_NOT_FOUND` · 409 `ATTEMPTS_EXHAUSTED`, `RETAKE_NOT_AVAILABLE`, `ASSESSMENT_NOT_ACTIVE`, `USER_INACTIVE` · 502 `INVITATION_EMAIL_FAILED` |
| `POST /api/admin/assessments/:id/invitations/resend` | 200 the invitation; a new link is emailed after commit, the old link stops working, valid 7 days | 404 `INVITATION_NOT_FOUND` · 409 `INVITATION_ALREADY_STARTED` / `ASSESSMENT_NOT_ACTIVE` / `USER_INACTIVE` · 502 `INVITATION_EMAIL_FAILED` (link rotated but email not queued: resend again) |
| `POST /api/admin/assessments/:id/invitations/resend` | 200 `{ resent, skipped: [{ id, code }], remaining }`: at most 200 per call, one transaction per row; skips revoked rows and rows re-issued in the last 10 minutes | 404 |

- **Invitation list:** `GET /api/admin/assessments/:id/invitations` rows gain `can_resend`, and the response gains `resendable` (the bulk count).
- **Re-invite:** `POST /api/admin/assessments/:id/invite` and the CSV import now re-activate a revoked or lapsed invitation (fresh link, email) instead of skipping it. A live or started one stays `INVITATION_EXISTS`.
- **Link lifetime:** candidate invitation links last 7 days (was 72 h).

**Webhooks**
- **Create:** `POST /api/admin/webhooks` rejects, with 400 `WEBHOOK_URL_NOT_ALLOWED` and `details.reason` ∈ `invalid_url | scheme_not_allowed | userinfo_not_allowed | localhost_not_allowed | blocked_address`:
  - non-https URLs (http is allowed only outside production);
  - userinfo;
  - `localhost`;
  - blocked IP literals.
- **Delivery:**
  - The hostname is resolved at connect time. The delivery is refused if ANY address is private, loopback, link-local, CGNAT, multicast or reserved (IPv4 and IPv6, including mapped and NAT64). A refusal is recorded `failed` (`blocked_address` / `blocked_url`) and never retried.
  - Redirects are not followed (3xx = permanent failure).
  - Timeout 10 s (was 30 s); at most 2 KB of the response is stored.
- **Headers:**
  - `X-AssessIQ-Timestamp` is now **unix seconds** (was ISO-8601; 0 endpoints existed in production at the change).
  - New `X-AssessIQ-Signature-V2: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
  - The V1 signature header is unchanged.
  - Receivers should verify V2 and reject timestamps more than 5 minutes old. The reference check is `verifySignatureV2` in `modules/13-notifications/src/webhooks/signature.ts`.

**Platform evaluation (super admin)**
- `accept`, `manual-score` and `override` under `/api/admin/super/evaluations/:attemptId/*` release the evaluation to the company in the same transaction when that call completes the attempt. They set `evaluation_released_at` and `evaluation_released_by`. This never happens for an erased candidate. It never happens for an already-graded (sent-back) attempt either. For those, use `release-to-tenant`.
- `rerun` on a graded (sent-back) attempt sets the grading marker and caches `ai_proposals` (poll like Grade all). Accepting those proposals writes new grading rows (the newest wins) and answers `attempt.status = "graded"`.
- `release-to-tenant` clears the `ai_proposals` cache.

**Candidate (option shuffle)**
- `GET /api/me/attempts/:id`: MCQ `content.options` come in this attempt's display order, and `answers[].answer.selected` is the displayed position.
- `POST /api/me/attempts/:id/answer` takes the displayed index; the server stores the original one.
- No new fields and no new errors.

## S13 additions (2026-10-16)

*Type: reference.* Session S13 changed the routes below. Each block says what changed, why, what we rejected, what is not included, and the impact.

### Audit export caps and archive (FR1, FU-B2)

**What changed.** Module `14-audit-log` (`modules/14-audit-log/src/routes.ts`).
- `GET /api/admin/audit/export.csv` and `GET /api/admin/audit/export.jsonl` accept `limit`: an integer from 1 to 100000. The default is 100000. A value outside the range returns 400 `VALIDATION_FAILED`.
- Both responses carry the header `X-Export-Truncated: true` or `false`. The value is `true` when more rows match than `limit`.
- A truncated JSONL stream ends with one note line: `{"_note":"truncated","limit":N,"hint":"Narrow the date range and export again."}`. A truncated CSV stream has no note line. Read the header.
- Each export call writes one audit row `audit.exported` before the stream starts. Its `after` is `{ format, filters, limit, truncated }`. It never holds audit row contents.
- New route `POST /api/admin/audit/archive`. Body: `{ from, to, format: 'jsonl' }`. `from` and `to` are ISO date-times with an offset. `to` must be after `from`. The span must be 366 days or less. Any other body returns 400 `VALIDATION_FAILED`.
- Success returns `200 { archive_id, row_count, truncated, export_url }`. `archive_id` is the id of the new `audit.archived` row. `export_url` is `/api/admin/audit/export.jsonl?from=..&to=..`. `row_count` never exceeds 100000.
- The archive route writes one `audit.archived` row. Its `after` is `{ from, to, row_count, format, export_path }`.
- The admin page then follows `export_url`. That download writes its own `audit.exported` row. One archive click therefore adds two audit rows.

**Why.** An unbounded export could stream millions of rows and hold a database cursor. The owner (decision FR1, 2026-10-03) wants an export cap, an audit of every export, and no deletion yet.

**Considered and rejected.**
- A hard error above the cap: the admin would get nothing. A marked partial file is more useful.
- A count query without a limit: it scans the whole range. The code counts at most `limit + 1` rows.
- One shared transaction for the export audit row: an export is read-only, so the row uses its own short `withTenant` transaction.
- Deleting rows on archive: the application role cannot delete `audit_log` rows, and the owner parked the S3 job.

**Not included.** Deletion of archived rows. The S3 archive job (`GET /api/admin/audit/archives` is still a placeholder). A CSV note line. A restore flow. The auth chain is unchanged (tenant admin).

**Downstream impact.**
- `ACTION_CATALOG` in `modules/14-audit-log/src/types.ts` has two new actions: `audit.exported` and `audit.archived`.
- Any client that reads the audit list now sees these rows for its own exports.
- Admin page: `docs/08-ui-system.md` § "Audit log page tails (S13)".

### Embed SDK file: `GET /embed/sdk.js` (RV44, FU-B13)

**What changed.** `apps/api/src/routes/auth/embed.ts`.
- The route serves the built bundle `apps/api/public/embed/sdk.js`. The code reads the file once at load.
- Success headers: `Content-Type: application/javascript; charset=utf-8`, `Cache-Control: public, max-age=3600`, `X-AssessIQ-SDK-Version: <version>` and `ETag` (a quoted SHA-1 of the body).
- A request with a matching `If-None-Match` header gets `304` with no body.
- If the file is missing, the route serves the old inline stub. It then sends no `ETag` and no version header. The server logs `embed.sdk.fallback_stub` once at start.
- The bundle sets `window.AssessIQ = { version, mount, buildUrl }`. `mount` takes two new options: `onBlocked()` and `readyTimeoutMs` (default 15000). `onBlocked` runs when the frame sends no `aiq.ready` in time.

**Why.** The route served a small stub, while the real SDK sat unused in `packages/embed-sdk`. Rule B check: the package is now the served artifact and the stub is superseded.

**Considered and rejected.**
- Build at image time: the API image never runs a build, so we commit the output.
- Delete the stub: Rule A keeps it as a fallback.

**Not included.**
- `verifyEmbedOrigin` has no caller. The SPA filters inbound messages with `window.__AIQ_EMBED_CONFIG__` (`apps/web/src/lib/embedBus.ts`). Nothing injects that value today. This is an open item.
- A production route to mint a test token. The dev-only `/embed/sdk-mint` is unchanged.
- The Caddy edge change for `frame-ancestors` is owner-gated and not done.

**Downstream impact.**
- `GET /embed` already sets the tenant CSP `frame-ancestors`, removes `X-Frame-Options` and fails closed with 401 on a bad token. S13 added a route test: `apps/api/src/__tests__/routes/embed-headers.test.ts`.
- The CSP is on the `/embed` 302 response. It is not on the final `/take/a/:id?embed=true` document that the frontend container serves. The iframe flow needs that page to carry the tenant CSP too. This is an open design item.
- Rebuild the bundle after any SDK change. A drift test (`packages/embed-sdk/src/__tests__/build.test.ts`) fails when the committed file is stale.
- The embed secret routes (`/api/admin/embed-secrets`) did not change. The admin page now uses them: `docs/08-ui-system.md` § "Embed page tails (S13)".

### Question and pack taxonomy routes (RW-61)

**What changed.** Module `04-question-bank` (`modules/04-question-bank/src/taxonomy-routes.ts`).

| Method and path | Auth | Behaviour |
| --- | --- | --- |
| `GET /api/admin/questions/:id/taxonomy` | admin | `200 { node_ids: string[], nodes: [{ id, parent_id, kind, code, label }] }`. 404 when the question is not visible. |
| `PUT /api/admin/questions/:id/taxonomy` | super admin | Body `{ node_ids: uuid[] }`, at most 50. The server removes duplicates and replaces all links. `200 { node_ids }`. 404 for a foreign question. 400 for a node that is not visible (`details.code = INVALID_PARAM`, `param = node_ids`). |
| `GET /api/admin/packs/:id/taxonomy?node_id=<uuid>` | admin | `200 { items: [{ question_id, node_id }] }` for the question set. With `node_id`, only links under that node or any descendant (recursive query). |

- The `PUT` route runs `DELETE` then `INSERT` on `question_taxonomy` in one transaction. It checks node visibility first because foreign-key checks skip row-level security.
- The `PUT` route writes one audit row: action `question.updated`, `before` and `after` = `{ kind: 'taxonomy', node_ids }`.
- `GET /api/admin/domains` rows gain `node_id` (`null` when the domain has no link).

**Why.** Questions had framework links only through import and clone. Admins could not read or edit them. The question editor, set filter, wizard and blueprint builder now need the links.

**Considered and rejected.**
- A new audit action `question.taxonomy.updated`: it needs a catalog change. We reuse `question.updated` with `kind: 'taxonomy'`, like `save_rubric`.
- Tenant admin writes: tenants never author taxonomy (owner decision, see the taxonomy section above).
- A filter that runs in the browser: the recursive query keeps descendants correct.

**Not included.** Node authoring by tenants. Bulk link edits. Links per level. A new generation parameter.

**Downstream impact.** Clients that parse the domain list must accept the extra `node_id` field. UI use: `docs/08-ui-system.md` § "Framework tree picker (RW-61, S13)".

### Candidate notifications (Z-3)

**What changed.** Module `13-notifications` (`modules/13-notifications/src/routes.ts`). The routes exist only when `apps/api/src/server.ts` passes `candidateOnly` (the candidate auth chain). Without it the routes are not registered.

| Method and path | Behaviour |
| --- | --- |
| `GET /api/me/notifications?unread=&since=&limit=` | `unread` is `0`, `1`, `true` or `false`. `since` is an ISO date-time. `limit` is 1 to 100 (default 50). Returns `200 { items, cursor, unread_count }`. `unread_count` counts unread `result.released` rows of this user only. `items` can also hold role and all-user rows for the candidate role. A bad query returns 400 `VALIDATION_FAILED`. |
| `POST /api/me/notifications/mark-read` | Body `{ ids?: uuid[] (max 100), kind?: string }`. Other keys return 400. Returns `200 { updated }`. The update touches only rows with `audience = 'user'` and `user_id` = the caller. |

- Producer: `notifyCandidateResultReleasedAfterCommit(client, tenantId, attemptId)`. `releaseAttemptInTx` (`modules/09-scoring/src/release.ts`) calls it after `emitAttemptEventAfterCommit`. It reads `attempts.user_id` in the open transaction. After commit it calls `notifyInApp` with audience `user`, kind `result.released`, message "A new result is published." and link `/candidate/results`.
- The producer never throws. It logs `in-app.result_released.failed` or `in-app.result_released.skipped_no_user` (see `docs/11-observability.md` § 38).

**Why.** A candidate had no sign in the portal that a result was published. Only the email told them.

**Considered and rejected.**
- Polling: one fetch after sign-in is enough for this notice.
- Reuse of `POST /api/admin/notifications/:id/mark-read`: it can mark role and all-user rows. A candidate must not clear admin notices.
- Count by list length: the count has its own query, so a limit does not change it.

**Not included.** A bell for candidates. Email changes. Notices for other events.

**Downstream impact.** The admin list route gained an internal `unreadOnly` filter (no API change). UI: `docs/08-ui-system.md` § "Candidate new-result banner (Z-3, S13)". Module notes: `modules/13-notifications/SKILL.md`.

### Webhooks (FU-B7)

Page-only change. No API change. The Replay button calls `POST /api/admin/webhooks/deliveries/:id/replay`, which already existed. See `docs/08-ui-system.md` § "Webhooks page tails (S13)".

## S14 additions (2026-10-16)

*Type: reference.* Session S14 changed the routes below. Each block says what changed, why, what we rejected, what is not included, and the impact.

### Per-organisation limits on heavy admin routes (S7/N5, FU gate tail)

**What changed.** A new helper `tenantRateLimit({ name, max, windowSeconds })` in `apps/api/src/middleware/tenant-rate-limit.ts` limits calls for each organisation (tenant) in a fixed window.

| Route | Limit name | Limit |
| --- | --- | --- |
| `GET /api/admin/audit/export.csv`, `GET /api/admin/audit/export.jsonl`, `POST /api/admin/audit/archive` | `audit-export` | 5 requests per 10 minutes, shared by the three routes |
| `POST /api/admin/assessments/:id/invitations/resend` | `invitations-bulk-resend` | 3 requests per 10 minutes |

- Over the limit, the response is 429 with error code `RATE_LIMITED`, `details.scope = "tenant-op"`, `details.retryAfterSeconds` and the header `Retry-After`.
- The Redis key is `aiq:rl:tenant-op:<name>:<tenantId>`. For the audit routes it is `aiq:rl:tenant-op:audit-export:<tenantId>`.
- `registerAuditRoutes(app, { adminOnly, heavyOpGuard })` receives the guard as an option. Module `14-audit-log` must not import `@assessiq/auth` (import cycle).

**Why.** One audit export streams up to 100000 rows. A script could hold many database cursors at once. A bulk resend sends one email for each invitation.

**Not included.** A limit for each user. A limit on the single-invitation Resend button. A change to the per-IP buckets: [04-auth-flows.md](04-auth-flows.md) § "Campus-scale rate limits and DB pool (task R2)".

**Downstream impact.** A client that loops over exports must read `Retry-After`. Log and metric names: `docs/11-observability.md`.

### Invitations bulk resend (S7/N5)

- `POST /api/admin/assessments/:id/invitations/resend` skips a candidate who got a bulk resend in the last 24 hours. The constant is `BULK_RESEND_RECENT_MINUTES = 1440` (it was 10). The single-invitation Resend button is not affected.
- Each call writes one audit row `assessment.invitations.bulk_resent`. Its `after` is `{ resent, skipped, remaining }`. The row is written also when `resent` is 0.
- The response shape is unchanged.
- Why: a 10-minute window let an admin send the same reminder several times in one day. The audit row lets support count what the button did.

### Candidate request-link bucket (S2/N2)

`POST /api/auth/candidate/request-link` now uses the candidate-entry per-IP bucket, and the service adds a per-IP send cap of 200 per hour. The response is always 204. Details and numbers: [04-auth-flows.md](04-auth-flows.md) § "Campus-scale rate limits and DB pool (task R2)".

### Question import formats and QTI export (RW-59)

| Method and path | Auth | Behaviour |
| --- | --- | --- |
| `POST /api/admin/super/question-imports` | super admin | `format` accepts `csv`, `xlsx`, `gift`, `aiken` and `qti`. `gift` and `aiken` are text files in UTF-8 and hold MCQ questions only. `qti` is a QTI 2.1, 2.2 or 3.0 content package (`.zip`) or one `assessmentItem` `.xml` file. An item that the importer cannot map becomes a row error. Limits: 4 MB, 2000 rows. The row limit also applies to each unzipped entry. The unzipped total is at most 16 MB |
| `GET /api/admin/super/question-imports/templates/:type` | super admin | `type` is `csv` or `xlsx` only |
| `GET /api/admin/super/packs/:id/export?format=qti3` | super admin | Returns a QTI 3.0 zip (`imsmanifest.xml` and `items/<id>.xml`) of the non-archived questions of the question set. The answer key is included. Another `format` returns 400. A set that the caller cannot see returns 404. Headers: `Content-Type: application/zip` and `Content-Disposition: attachment; filename="<slug>.qti3.zip"`. Audit action `pack.exported` with `{ format, question_count }` |

- The CSV and XLSX templates gain an optional common column `negative_marks` (0 to 1000, blank means "use the default"). See "Negative marking" below.
- Adapter code and the interaction mapping: `modules/04-question-bank/SKILL.md` § "Import adapters and QTI export (RW-59, S14, 2026-10-16)".
- Not included: QTI tests and sections, numeric tolerance or unit in QTI, HTML or media in prompts, feedback blocks.

### Tenant logo (Logo L1 to L4)

Table and rules: [02-data-model.md](02-data-model.md) § "Table `tenant_logos` (migration 0183, owner 02-tenancy)".

| Method and path | Auth | Behaviour |
| --- | --- | --- |
| `PUT /api/admin/tenant-settings/logo` | admin, MFA step-up within 15 minutes | Body: multipart field `file`, or JSON `{ content_base64 }`. `200 { logo: { mime, width, height, byte_size, sha256, updated_at, url } }`. Errors: 400 `LOGO_BAD_FORMAT`, 400 `LOGO_BAD_DIMENSIONS`, 400 `LOGO_FILE_REQUIRED`, 413 `LOGO_TOO_LARGE` |
| `DELETE /api/admin/tenant-settings/logo` | admin, MFA step-up | `204`. The answer is also 204 when no logo exists |
| `PUT /api/admin/super/tenants/:tenantId/logo`, `DELETE /api/admin/super/tenants/:tenantId/logo` | super admin | Same behaviour for the named organisation |
| `GET /api/public/tenant-logo/:tenantId?v=` | none | Returns the image bytes. Headers: `X-Content-Type-Options: nosniff`, CSP `default-src 'none'; sandbox`, `ETag: "<sha256>"`. `Cache-Control` is `immutable` for one year when `v` matches the stored hash, else one hour. A matching `If-None-Match` returns 304. No logo or a `tenantId` that is not a UUID returns 404 |

- Only PNG and JPEG are accepted (at most 512 KB, 32 to 2048 pixels on each side). SVG, GIF and WebP return `LOGO_BAD_FORMAT`.
- `GET /api/admin/tenant-settings` gains `logo` (`{ meta, url }` or `null`).
- `GET /api/auth/whoami` gains `tenant.logo_url` (`null` for API keys).
- `POST /api/take/start` (preview and start): `assessment.company_logo_url` (`string | null`).
- `GET /api/me/attempts/:id`: top-level `company_name` and `company_logo_url`.
- `GET /api/me/attempts/:id/result` (200 and 202): `company_logo_url`. The released payload also carries `tenant_name`.
- `url` is `<ASSESSIQ_BASE_URL>/api/public/tenant-logo/<id>?v=<sha12>`. The public route needs no cookie, so the mail proxy of an email client can fetch it.
- Audit actions: `tenant.logo.updated` and `tenant.logo.removed` (metadata only).
- Not included: SVG, logo history, server-side resize. Code: `modules/02-tenancy/src/logo.ts`, `apps/api/src/routes/_logo-upload.ts`, `apps/api/src/routes/public-tenant-logo.ts`.

### Negative marking (EX-1)

Rule and scoring: [05-ai-pipeline.md](05-ai-pipeline.md) § "Negative marking (EX-1)". Columns: [02-data-model.md](02-data-model.md) § "S14 additions (2026-10-16)".

- `POST /api/admin/questions`: optional `negative_marks` (number of 0 or more, or `null`).
- `PATCH /api/admin/questions/:id`: `negative_marks` (`null` clears it). This is a metadata change and it does not create a new version. An invalid value returns 422 `NEGATIVE_MARKS_INVALID`.
- The question list and the question detail include `negative_marks`.
- `PATCH /api/admin/assessments/:id` accepts `settings.scoring.negative_marks_default` (0 to 1000) while the assessment is a draft.
- `GET /api/me/attempts/:id/result` and each item of `GET /api/me/results` gain `negative_marking: { enabled, penalty_total }`. `enabled` is true when any frozen `negative_marks` is above 0. `penalty_total` is the sum of the negative effective gradings, as a positive number.
- Z-44: `GET /api/me/attempts/:id/result` (released, 200) gains `feedback_level`: `'none' | 'right_wrong' | 'with_expected_answer' | 'with_ai_justification'`. It is read from `tenant_settings.result_feedback_level` at request time (the only source; no copy is stored on the attempt). The Submitted page and the result list show the plain sentence from `feedbackSentence` (`@assessiq/core/feedback-copy`), the same function the result email uses for a fail. `none` shows no sentence. The pending (202) body is unchanged. Not included: new per-question data; the sentence never carries answers.
- `total_earned` in those payloads is signed. `percent` may be negative.
- The admin attempt review `frozen_questions[]` gains `negative_marks`.
- Why: a wrong guess should cost marks in exams that use this rule. The value is frozen per attempt so that a later edit cannot change a result.
- Not included: a penalty for AI-graded types, and a validation of `settings.scoring` on write (module 06 sanitises it on read).

### `structured_case` candidate view (EX-3)

`GET /api/me/attempts/:id` returns each step with `points` and `negative_marks` when the author set them. These values are not secret. `correct`, `scoring` and `explanation` stay on the server. Scoring rule: [05-ai-pipeline.md](05-ai-pipeline.md) § "Passage sets (EX-3)".

### Plan tier gates (PT1 and PT-4)

**What changed.** The env flag `PLAN_TIERS_ENFORCED` (`modules/00-core`, default `false`) turns the gates on. While it is `false`, every gate and limit below is a no-op.

- Error responses are 403. The `details.code` is `TIER_NOT_INCLUDED`, `TIER_LIMIT_REACHED` or `CREDITS_HARD_CAP`. `details` also holds `tier` and, when it applies, `feature`, `limit` and `current`.
- Gated routes:
  - Certificate admin routes (module 18, composed in `apps/api/src/server.ts`).
  - `/api/admin/webhook*` (module 13, option `webhooksGuard`).
  - Audit routes (module 14, the `adminOnly` array).
  - The cohort breakdown (module 15, option `fullReportGuard`, feature `cohort_analytics_full`, `pro` and above).
  - `GET` and `POST` of `/api/admin/api-keys`. `DELETE` stays open so a downgraded organisation can revoke a key.
  - The embed admin routes and `/api/admin/embed-secrets`.
  - Entitlement grant (cap on licensed packs; a new grant of an active scope is not counted).
  - Bulk invitation import, and a single invite with `assessment_id` (credit hard cap first, then the per-drive candidate cap; the count includes revoked invitations).
- The free tier limits are in `TIER_LIMITS` (module 19): 2 licensed packs, 200 candidates for each drive, and a hard cap at 120 percent of the credits. Other tiers have `null`.
- `GET /api/billing/usage` (`getUsage`) gains `tier_limits` and `tiers_enforced`. The AI answers included are `tenant_plans.ai_answers_included_override ?? TIER_AI_ANSWERS_INCLUDED[tier]`.
- `PATCH /api/admin/super/tenants/:id/plan` accepts `aiAnswersIncludedOverride` (integer of 0 or more, or `null`). A bad value returns 400 `INVALID_AI_ANSWERS_OVERRIDE`.

**Not included.** `getAllTenantUsage` (the super list) still shows the tier default. A UI notice shows "Plan limits are shown for information and are not enforced yet." while the flag is off.

**Owner gate.** Turn the flag on only after you confirm that no current organisation is blocked. Check free-tier organisations for packs, webhooks, API keys and embed secrets first. The handoff in `docs/SESSION_STATE.md` has the SQL.

### AI grading scope and grading tiers (P4)

Rules and the tier table: [05-ai-pipeline.md](05-ai-pipeline.md) § "Least-AI tier order (P4)".

| Method and path | Auth | Behaviour |
| --- | --- | --- |
| `GET /api/admin/super/tenants/:tenantId/ai-grading-scope` | super admin | Returns the current scope |
| `PATCH /api/admin/super/tenants/:tenantId/ai-grading-scope` | super admin | Body `{ scope }`, where `scope` is `written` or `none`. `200 { tenantId, ai_grading_scope, previous, updatedAt, auditId }`. 400 `INVALID_SCOPE` for any other value. Audit action `tenant_settings.ai_grading_scope.updated` |

- `POST /api/admin/super/evaluations/:attemptId/grade` gains `tiers: Record<'answer_key' | 'reuse' | 'rule' | 'ai' | 'human', number>` in the response.
- The tenant attempt `GET` and the super evaluation `GET` also return `tiers`.
- A tenant admin cannot change the scope. The setting is a platform decision.

### New audit actions in S14

`tenant.logo.updated`, `tenant.logo.removed`, `user.purged`, `pack.exported`, `assessment.invitations.bulk_resent`, `tenant_settings.ai_grading_scope.updated`.

## S15 additions

*Type: reference.* Session S15 (2026-10-17) added the route below.

### GET /api/me/progress (RW-84)

**What changed.** A new candidate route returns the history, score trend and per-subject strengths of the signed-in candidate. Code: `modules/06-attempt-engine/src/routes.candidate.ts` calls `getCandidateProgress(tenantId, userId)` in `modules/06-attempt-engine/src/progress.ts`, inside `withTenant`.

**Why.** The candidate portal had results and certificates but no view across tests. RW-84 asks for a history list, a trend and strengths.

- Auth: candidate session (`candidateOnly`). The route reads tenant and user from the session.
- Path: `GET /api/me/progress`. No query parameters. No body.
- Errors: 401 without a candidate session. There are no other error codes.
- Release rule: only released attempts count (`a.status = 'released'`, the `RELEASED_AT_SQL` rule of `/api/me/results`, certificates not revoked). An unreleased attempt shows nowhere: not in the list, not in the trend, not in the subjects.
- `score_pct` comes from `resultPercent(total_earned, total_max)`. This is the same rule as `/api/me/results`. `passed` is `score_pct >= passing_score_pct` (the level setting).
- `trend` lists `score_pct` from the oldest to the newest attempt.
- `subjects` use the newest `gradings` row for each attempt and question. Rows with `review_needed` do not count. A question counts as correct when its status is `correct` or it has full marks (same rule as module 15). The subject is the taxonomy node itself, its parent or its grandparent, whichever has kind `subject`. A question with no subject goes to the group "Other". The list is sorted by `rate_pct` (lowest first), then by label.

Response shape:

```json
{
  "attempts": [{
    "attempt_id": "uuid", "assessment_id": "uuid", "assessment_name": "string",
    "released_at": "ISO date", "total_earned": 7, "total_max": 10,
    "score_pct": 70, "passing_score_pct": 60, "passed": true,
    "certificate": { "credential_id": "string", "verify_url": "string" }
  }],
  "trend": [70],
  "subjects": [{ "node_id": "uuid", "label": "Networking", "questions": 4, "correct": 3, "rate_pct": 75 }]
}
```

`certificate` is `null` when none exists. `score_pct`, `passing_score_pct` and `passed` can be `null`.

**Considered and rejected.**
- A `/me/*` web route family. The portal uses `/candidate/*`.
- `auto_pct` as the percent. It differs from the results page.

**Not included.** No per-framework split (a question that maps to subjects in two frameworks counts once in each). No unit-level strengths. No filters or paging.

**Impact.** No schema change. Help ids `candidate.progress*` are in `modules/16-help-system/content/en/candidate.yml`. UI: [08-ui-system.md](08-ui-system.md) § "Candidate progress page (RW-84, S15)". Tests: `modules/06-attempt-engine/src/__tests__/candidate-progress.test.ts`, `apps/api/src/__tests__/routes/me-progress.test.ts`.

### GET /api/admin/super/questions/:id/stats (RW-60)

**What changed.** A new super-admin route returns the Phase C statistics of one question. Code: `modules/15-analytics/src/routes.ts` calls `getQuestionStats(questionId)` in `modules/15-analytics/src/question-stats.ts`. Data comes from the view `question_stats_mv` (see [02-data-model.md](02-data-model.md)).

**Why.** The difficulty spec (§ 6) asks for per-item success rate, level gradient, discrimination and a `miscalibrated` flag. FU-C14 and RW-60 asked for a super-admin view.

- Auth: super admin only (`superAdminOnly`). The session carries the platform tenant. The route does not use it.
- Path: `GET /api/admin/super/questions/:id/stats`. `:id` is a UUID. No query parameters. No body.
- Errors: 400 `VALIDATION_FAILED` for a bad id. 401 without a session. 403 for a user who is not a super admin. 404 `QUESTION_NOT_FOUND` when the question does not exist.
- Scope `tenant`: the question has no clones. The service reads one tenant (the tenant of the question pack) with `withTenant`.
- Scope `rollup`: the question has clones (`questions.source_question_id`, migration `0084`). The service reads rows with `question_id = :id OR source_question_id = :id` across all tenants with `withSystemRole` (read-only). It sums attempts, correct counts and `exposure_count`. `mean_band` and `point_biserial` are attempts-weighted means (an approximation of the pooled item-rest correlation). `last_used_at` is the maximum. The gradient covers the source pack and the packs with `source_pack_id` equal to the source pack, grouped by `levels.position`.
- `clone_count` is the number of clone questions (copies), not the number of organisations.
- `stats` is `null` when the question has no row in the view or no graded attempt.

Response shape:

```json
{
  "question": { "id": "uuid", "type": "mcq", "level_position": 2, "level_label": "Intermediate",
                "cognitive_level": "apply", "difficulty_params": {} },
  "stats": { "attempts": 36, "exposure_count": 40, "correct_rate": 0.5556,
             "mean_band": null, "point_biserial": 0.31, "discrimination_ok": true,
             "last_used_at": "ISO date", "computed_at": "ISO date" },
  "gradient": [{ "level_position": 1, "label": "Beginner", "mean_success": 0.8, "attempts": 120 }],
  "miscalibrated": { "flag": false, "reason": null, "min_attempts": 30 },
  "scope": "tenant",
  "clone_count": 0
}
```

`stats.discrimination_ok` is `null` when `point_biserial` is `null`. The exact type is `QuestionStatsResult` in `question-stats.ts`.

**The `miscalibrated` rule is a default.** The spec § 6 gives no threshold. The code uses these values (constants in `question-stats.ts`):
- Needs 30 or more attempts (`MIN_PHASE_C_ATTEMPTS`). Under 30, `flag` is false.
- Success is `mean_band`, or `correct_rate` when there is no band.
- Flag when the item is on the top level with success 0.90 or more.
- Flag when the item is on the lowest level with success 0.25 or less.
- Flag when the gradient at the level of the item is inverted against an adjacent level by more than 0.15.
- `discrimination_ok` is true when `point_biserial` is 0.2 or more.

**Considered and rejected.** A tenant-admin route (the roll-up crosses tenants, and the statistics are a platform tool). A numeric threshold written as a spec claim (the values above are marked as defaults).

**Not included.** A roll-up by distinct organisation. A review queue of miscalibrated items. Tenant-admin visibility. Incremental refresh. Paging (one question for each call).

**Impact.** No change to existing routes. UI: [08-ui-system.md](08-ui-system.md) § "Item statistics card on the question editor (RW-60, S15)". Help ids `admin.question.editor.stats*`. Tests: `modules/15-analytics/src/__tests__/question-stats.test.ts`.

### Start a test (RW-83): no new routes

**What changed.** The admin page `/admin/start-test` adds no API route. It calls these existing routes in this order. A step runs only if the one before it worked.

1. `GET /api/billing/available-sets` (load the question sets).
2. `GET /api/admin/users?role=candidate&pageSize=100&search=` (load active candidates).
3. `POST /api/admin/assessments/from-set` with `{ source_pack_id, level_position, name, question_count, opens_at, closes_at }`.
4. `POST /api/admin/assessments/:id/publish`.
5. `POST /api/admin/assessments/:id/invite` with `{ user_ids }`. This step runs only if the admin ticked candidates.
6. `POST /api/admin/users/import` with `{ csv: "name,email
...", assessment_id }`. This step runs only if the admin pasted emails. It creates unknown emails as candidates and invites them.

**Why.** RW-83 asks for one screen for the common case. The six-screen path stays for advanced use.

**Considered and rejected.** A new "start test" endpoint that does all steps in one transaction. The existing routes already hold the rules (licence checks, plan limits, invitation emails). A new endpoint would copy them.

**Not included.** Duration edits (the duration comes from the set level). A retry after a partial failure: the page names the failed step and links to the assessment.

**Impact.** A failure after step 3 leaves a draft or published assessment. The admin sees it in the assessments list. UI: [08-ui-system.md](08-ui-system.md) § "Start a test screen (RW-83, S15)".

### PATCH /api/admin/tenant-settings/result-feedback-level (RW-80)

**What changed.** A new admin route sets how much per-question detail candidates see on a released result. Code: `apps/api/src/routes/admin-tenant-settings.ts` calls `updateResultFeedbackLevel` in `modules/02-tenancy/src/service.ts`. The Zod schema `resultFeedbackLevelBody` is in `apps/api/src/routes/_schemas.ts`.

**Why.** The owner decides what students may see. The setting lets each organisation choose, and the default stays closed.

- Auth: tenant admin with fresh MFA (`adminFreshMfa`). Tenant and actor come from the session. The tenant must be active (`assertTenantActive`).
- Body: `{ "level": "none" | "right_wrong" | "with_expected_answer" | "with_ai_justification" }`.
- 200: `{ tenantId, result_feedback_level, previous, updatedAt, auditId }`. `auditId` is `null` when the level did not change.
- Errors: 400 `INVALID_RESULT_FEEDBACK_LEVEL` (bad or missing level). 401 for a stale TOTP or no session. 403 for a role that is not admin. 409 `TENANT_NOT_ACTIVE`.
- Same value as today: no write and no audit row. A change writes one `tenant.settings.updated` row (`before` and `after` = `{ result_feedback_level }`).
- `GET /api/admin/tenant-settings` now also returns `result_feedback_level`.

### PATCH /api/admin/tenant-settings/certificate-show-distinction (Z-50)

**What changed.** A new admin route switches the word "Distinction" on or off for the certificates of the caller's organisation. Code: `apps/api/src/routes/admin-tenant-settings.ts` calls `updateCertificateShowDistinction` in `modules/02-tenancy/src/service.ts`. The Zod schema `certificateShowDistinctionBody` is in `apps/api/src/routes/_schemas.ts`.

**Why.** The owner decided that every candidate who passes gets a certificate, and that the organisation decides if a score of 90 percent or more is written as Distinction. Default is off.

- Auth: tenant admin with fresh MFA (`adminFreshMfa`). The handler checks `session.role === 'admin'` again and throws `AuthzError` (403) otherwise. Tenant and actor come from the session. The tenant must be active (`assertTenantActive`).
- Body: `{ "enabled": true | false }`. Other types are rejected.
- 200: `{ tenantId, certificate_show_distinction, previous, updatedAt, auditId }`. `auditId` is `null` when the value did not change.
- Errors: 400 `INVALID_CERTIFICATE_SHOW_DISTINCTION`. 401 for a stale TOTP or no session. 403 for a role that is not admin. 409 `TENANT_NOT_ACTIVE`.
- Same value as today: no write and no audit row. A change writes one `tenant.settings.updated` row (`before` and `after` = `{ certificate_show_distinction }`).
- `GET /api/admin/tenant-settings` now also returns `certificate_show_distinction`.
- Effect on other responses: `GET /api/certificates` (candidate list) returns `tier: "completion"` for a stored distinction while the switch is off. `GET /api/admin/certificates` always returns the stored tier. The PDF, the public verify page (`/verify/:id`, its JSON-LD and Open Graph text) and the preview images (`og.svg`, `og.png`) follow the switch. Public preview images are cached for one hour, so a change can take up to an hour to show there.
- Not included: a per-assessment switch, an honors tier, a tier upgrade, a rewrite of issued certificates.

### GET /api/me/attempts/:id/feedback (RW-80)

**What changed.** A new candidate route returns per-question feedback for one released attempt. Code: `modules/06-attempt-engine/src/routes.candidate.ts` (`candidateOnly`) calls `getCandidateFeedback(tenantId, userId, attemptId)` in `modules/06-attempt-engine/src/feedback.ts`, inside `withTenant`.

**Why.** Candidates asked to see which answers were wrong and what to study. The route follows the result-release rules: no feedback before the result is published.

- Errors: 404 `ATTEMPT_NOT_FOUND` when the attempt is not the caller's. 409 `RESULT_NOT_READY` unless `attempts.status = 'released'` and an `attempt_scores` row exists. We chose 409, not 202, because the portal asks only for attempts that `/api/me/results` already lists as released.
- Level `none`: returns `{ level: "none", items: [] }` before any question is read. The 404 and 409 checks still run first.
- Items come from `attempt_questions` joined to the frozen `question_versions` content. Each question uses its newest `gradings` row (`graded_at DESC`). Rows with `status = 'review_needed'` or an `error_class` that starts with `AIG_` are dropped, so a pending question is omitted, not shown as pending.

Response shape:

```json
{
  "level": "with_ai_justification",
  "items": [{
    "question_id": "uuid", "position": 1, "type": "mcq",
    "prompt": "text", "your_answer": "text or null",
    "outcome": "correct | incorrect | partial",
    "score_earned": 1, "score_max": 1,
    "expected_answer": "text or null", "explanation": "text or null",
    "study": { "unit": "text or null", "subject": "text or null", "topic": "text" }
  }]
}
```

| Field | none | right_wrong | with_expected_answer | with_ai_justification |
| --- | --- | --- | --- | --- |
| `items` | empty | yes | yes | yes |
| `your_answer`, `outcome`, scores, `study` | no | yes | yes | yes |
| `expected_answer` | no | no | deterministic types only | deterministic types only |
| `explanation` | no | no | no | AI-graded types only |

- `prompt`: the registry `candidateView` text (`question`, else `title`, else `intro`), capped at 500 characters.
- `your_answer`: a text form of the answer for each of the 9 question types. It is `null` for an unknown shape and is never raw JSON.
- `outcome`: from the grading status. For an overridden row, the marks decide: full marks is `correct`, more than 0 is `partial`, else `incorrect`.
- `expected_answer`: only when the level is `with_expected_answer` or higher AND the registry says `scoring: 'deterministic'` (mcq, multi_select, numeric, ordering, structured_case).
- `explanation`: only at `with_ai_justification` AND registry `scoring: 'ai'`. It is `plainWords(ai_justification, reasoning_band, error_class)`. Rules: [05-ai-pipeline.md](05-ai-pipeline.md) § "Candidate feedback levels (RW-80, S15)".
- `study`: the unit node from `question_taxonomy` and `taxonomy_nodes`, with its subject parent. `topic` is `questions.topic` and is the fallback.
- Never sent: `stage_inputs`, `anchor_hits`, rubric text and raw AI text. Tests assert this.

### GET /api/me/results: new field `feedback_level` (RW-80)

`GET /api/me/results` now returns `{ items, feedback_level }`. `feedback_level` is the tenant setting, read in the same tenant transaction. The portal needs no extra call to know whether to show "Review your answers".

**Considered and rejected.** Per-question data on the post-submit page `apps/web/src/pages/take/Submitted.tsx` (its rule P1 allows none). A per-assessment override. An AI rewrite of the justification.

**NOT included.** Feedback for pending questions. Rubric anchors. A per-assessment override. A candidate-facing explanation for deterministic types beyond the expected answer.

**Downstream impact.** The migration `0190` adds the column ([02-data-model.md](02-data-model.md)). The candidate UI reads both routes ([08-ui-system.md](08-ui-system.md)). Client types: `modules/11-candidate-ui/src/types.ts`. Owner gate: the production default stays `none` until the owner chooses.

## OpenAPI spec

A formal OpenAPI 3.1 spec lives at `infra/openapi.yaml`, kept in sync with this doc. Generated from Fastify route schemas via `fastify-swagger`. Tenants can pull it from `/api/openapi.yaml` (auth required).

### Exam blueprints and "Start a full mock" (EXP-6, 2026-10-17)

| Method and path | Who | Result |
| --- | --- | --- |
| `GET /api/admin/blueprints` | any admin | `{ items: ExamBlueprint[] }` (platform data, the same for every tenant) |
| `GET /api/admin/blueprints/:id` | any admin | `ExamBlueprint`; 404 when unknown |
| `POST /api/admin/blueprints` | super admin | 201 `ExamBlueprint` |
| `PUT /api/admin/blueprints/:id` | super admin | full replace of the head and the sections; 200 |
| `DELETE /api/admin/blueprints/:id` | super admin | `{ deleted: true }`; 404 when unknown |
| `POST /api/admin/blueprints/:id/mock` | any admin | 201 `{ assessment, warnings }`. Body: `pack_id`, `level_id`, `opens_at` (required), `closes_at?`, `name?` |

- **ExamBlueprint.** `id, stage_node_id, edition, name, total_minutes, qualifying, verification_status, source_note, total_questions, total_marks` (both derived) and `sections[]` (`position, name, subject_node_id, question_count, marks_per_question, negative_marks_per_question, minutes, sectional_timing, qualifying, cutoff_marks, calculator_allowed, allowed_types`).
- **Validation (400).** 1 to 10 sections; `question_count >= 1`; marks `>= 0`; `0 <= negative <= marks`; optional `total_questions` must equal the section sum; `cutoff_marks` needs `qualifying` and must not exceed the section marks; `sectional_timing` is all or none, needs `minutes`, and the minutes must add up to `total_minutes`; stage and subject ids must be platform nodes of kind `stage` and `subject`; one blueprint per (stage, edition). Unknown body keys are rejected.
- **Audit.** `exam_blueprint.created`, `.updated`, `.deleted` (module 14), written in the same transaction under the super admin's tenant.
- **Mock.** Goes through `createAssessment`, so every existing guard applies (pack published, level in pack, `opens_at`, tenant scope). It writes a `draft` with `question_count` = the section sum, `settings.sections[]` (`name, question_count, minutes, calculator?, qualifying?, cutoff_marks?`), `settings.scoring.negative_marks_default` and `settings.exam_blueprint` (`id, edition, verification_status`). 400 when the sections have different negative marks. `warnings` tells the admin that sections are timed one by one: a blueprint without sectional timing gets an even split of `total_minutes`. **The draw does not use `subject_node_id` today**: a section takes `question_count` questions from the pack and level pool in order, so the pool must hold the exam's questions. Marks per question come from each question's `points`, not from the blueprint.
- **Result payload.** `GET /api/me/attempts/:id/result` (released) adds `sections[]` (`index, name, earned, max` and, for a qualifying section with `cutoff_marks`, `cutoff_marks` and `passed_cutoff`) only when the assessment has sections. `passed` and `pass_mark_pct` are unchanged. Admin attempt detail (module 07) carries the same optional keys in `section_scores`.

### Whole-test timer and marks per question (Z-42, 2026-10-18)

This section supersedes the "even split", "400 when the sections have different negative marks" and `scoring.negative_marks_default` statements in the EXP-6 section above.

- **Settings.** `settings.whole_test_minutes` (integer 1 to 600). With it, `settings.sections[].minutes` must be absent; without it every section needs `minutes`. 400 `INVALID_PARAM` (`param: settings.sections` or `settings.whole_test_minutes`) on a mix, on no timer at all, or on a bad value. `settings.sections[].marks_per_question` and `negative_marks_per_question` are optional numbers 0 to 1000.
- **Mock.** `POST /api/admin/blueprints/:id/mock` copies the blueprint: sectional blueprint gives `minutes` per section; a blueprint without sectional timing gives `whole_test_minutes = total_minutes` and no section minutes. Every section carries its own `marks_per_question` and `negative_marks_per_question`, so sections may have different penalties (no 400 any more). `warnings` only reports an unverified blueprint.
- **Take flow.** `POST /api/me/attempts/start` returns `duration_seconds` = `whole_test_minutes * 60`. `GET /api/me/attempts/:id` returns all questions and no `sections` key in whole-test mode, plus `section_names: string[]` (indexed by each question's `section_index`, used to group the navigator). `section_names` is absent for per-section and unsectioned assessments. `finish-section` answers 409 `SECTION_NOT_FINISHABLE`. `AE_SECTION_LOCKED` is never returned. A save after `ends_at` answers 409 `TIMER_EXPIRED` (server clock). Per-section assessments are unchanged.
- **Result.** `GET /api/me/attempts/:id/result` is unchanged; `sections[]` now totals the scaled marks. The candidate result page shows a "Marks by section" table with the qualifying result.

### Attempts list: attempt number (Z-39 tails, 2026-10-18)

- **What.** Each item of the admin attempts list (`GET /api/admin/attempts`, handler `admin-attempts-list.ts`) adds two integers: `attempt_number` (this attempt's number for the candidate on the assessment) and `attempts_total` (how many attempts the candidate has on it). The admin page shows an "Attempt n of m" chip when `attempts_total` is above 1.
- **Why.** The list keeps every attempt, so an admin needs to tell the attempts of one candidate apart. Cohort reports and dashboard counts show the candidate once instead (module 15 SKILL.md).
- **Not included.** No filter by attempt number. No change to the request. The fields are additive; old clients ignore them.

### S32 additions: Free-plan limits (all no-ops while `PLAN_TIERS_ENFORCED=false`)

- **New behaviour.** When the flag is on, `POST /api/admin/users` (role candidate), `POST /api/admin/users/import` and `PATCH /api/admin/users/:id` (role change) answer `403` with `details.code` `TIER_LIMIT_REACHED` once a Free organisation would hold more than 5 candidates in total. On a capped tier a candidate cannot change role. `POST /api/admin/super/evaluations/:attemptId/grade` and `/rerun` answer `403` `TIER_LIMIT_REACHED` after 5 AI-graded attempts, or `403` `AI_GRADING_DISABLED` when `FREE_PLAN_AI_DISABLED=true`. Paid tiers are never blocked.
- **Why.** The approved Free plan (docs/design/2026-10-18-free-plan-pack.md). **Not included:** a DB-level guard against concurrent requests (Z-71), a changed response shape. Detail: `docs/design/2026-10-20-free-tier-limits.md`.

## Import: passage columns (EXP-8, 2026-10-19)

No route changed. The v2 import template has two more columns, after `pyq_shift`: `passage_ref` and `passage_text`.

- Rows with the same `passage_ref` in one file share one passage. The text comes from `passage_text`, on any row of the group (usually the first).
- A `passage_ref` with no `passage_text` on any row, or with two different texts, gives a row error `passage_text` on every row of the group. `passage_text` without `passage_ref` is a row error.
- Commit writes one `passages` row for each ref (tenant of the import) and sets `questions.passage_id` and `passage_position` (1, 2, 3 in file order among the committed rows).
- The candidate attempt view (`GET` attempt payload, `questions[]`) gets an optional `passage: { id, title, body }` on each question that has one.

## Credit ledger endpoints (Z-93, Z-79)

*Type: reference*

### `POST /api/admin/super/tenants/:tenantId/credits`

- Gate: super admin (`superAdminOnly`). Tenant must be active.
- Body: `{ credits: int 1..1000000, source: 'purchase' | 'bonus' | 'pilot', invoiceRef?: string (200), note?: string (500), expiresInMonths?: int 1..120 (default 12) }`.
- 200: `{ id, expires_at, auditId }`. The grant and the audit row `billing.credits_granted` are written in one transaction.
- 400: bad input (`INVALID_CREDITS`, `INVALID_SOURCE`, `INVALID_EXPIRY`). 403: not a super admin. 404: the tenant has no plan row.

### `GET /api/admin/super/tenants/:tenantId/credits`

- Gate: super admin.
- 200: `{ grants: CreditGrantView[], burns: { mock, real, real_camera } }`. Grants include expired ones, newest first.

### `GET /api/billing/usage` (extended)

- New field `credits` (additive; no existing field changes): `{ unlimited, has_grants, balance, next_expiry, grants[], burn_by_type: { mock, real, real_camera }, ai_answers }`.
- `balance` sums `remaining` of unexpired grants. `unlimited` is true when the plan has `included_credits` NULL.
- With `PLAN_TIERS_ENFORCED` on, a Free tenant that has any grant is stopped with `CREDITS_HARD_CAP` when the balance is 0 or less. Other tiers keep the old meter.

## Z-87 / Z-89 / Z-91 - test type, desktop-only, readiness (2026-10-20)

- `assessments.delivery_mode` and `assessment_invitations.delivery_mode`: `"real"` (default) or `"mock"`. Assessment create (`POST /api/admin/assessments`, `/from-set`) and update (`PATCH`, draft only) accept optional `delivery_mode`; any other value is `400 INVALID_PARAM`. Assessment detail, assessment list and invitation list return it.
- `POST /api/admin/assessments/:id/invite` accepts optional `delivery_mode` (see the admin table). The audit row `assessment.invite` and `assessment.update` include `delivery_mode`.
- `POST /take/start`: preview/Begin return `assessment.delivery_mode`. New errors `403 DEVICE_NOT_ALLOWED` and `422 READINESS_FAILED` (details under "POST /take/start modes").
- Candidate result (`GET /api/me/attempts/:id/result`) and `GET /api/me/results` items add `delivery_mode`. The UI shows a Mock label. A mock result never has a `certificate`.
- Reports: the cohort report, results CSV, attempts export, dashboard "attempts this week", topic heatmap, question statistics and Activity stats count REAL attempts only (`countingAttemptSql`, migration `0219`, and `delivery_mode = 'real'` filters).
- Attempts allowance (Z-39): only attempts of the same `delivery_mode` as the invitation count, so a mock does not use up a real allowance.

## Public self-serve sign-up (Z-71, Z-81, 2026-10-20)

*Type: reference.* Three PUBLIC routes (`config: { skipAuth: true }`, no session, no tenant context). Code: `apps/api/src/routes/public-signup.ts`. Flow, safety argument and key spaces: `docs/04-auth-flows.md` § "Self-serve organisation sign-up". All answers carry `Cache-Control: no-store`. The routes sit behind the public credential chain (anonymous IP bucket and the 20 a minute credential bucket) in addition to the limits below.

**Gate.** The routes answer `404 NOT_FOUND` unless `PLAN_TIERS_ENFORCED=true`, `SIGNUP_ENABLED=true`, both Turnstile keys are set and Redis answers. Checked on every request.

### `GET /api/public/signup/config`

Always `200 { open: boolean, turnstileSiteKey: string | null, dpaVersion: "1.0" }`. `turnstileSiteKey` is `null` while `open` is false. The Turnstile widget must use the action `signup-request`.

### `POST /api/public/signup/request`

Body (strict, unknown fields are refused): `{ orgName, adminName, email, turnstileToken, dpaAccepted, dpaVersion, termsAccepted, termsVersion }`.

| Field | Rule |
| --- | --- |
| `orgName` | 3-80 characters after trim and whitespace collapse; letters, digits, space and `. - & '` only |
| `adminName` | 2-80 characters, no control characters or angle brackets |
| `email` | valid address, up to 254 characters, lower-cased |
| `turnstileToken` | 1-2048 characters |
| `dpaAccepted` | literally `true` |
| `dpaVersion` | must equal the server constant `DPA_VERSION` (`"1.0"`) |
| `termsAccepted` | literally `true` (the form has its own Terms of Service checkbox) |
| `termsVersion` | must equal the server constant `TERMS_VERSION` (`"1.0"`); stored with the code and written to the acceptance row at verify |

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ ok: true }` | Every case after the checks: new address, existing account, super-admin or blocked address, daily cap reached. Same body and the same 800 ms minimum time. |
| 400 | `VALIDATION_FAILED`, `details.code` one of `INVALID_ORG_NAME`, `INVALID_ADMIN_NAME`, `INVALID_EMAIL`, `MISSING_TURNSTILE`, `DPA_NOT_ACCEPTED`, `DPA_VERSION_MISMATCH`, `TERMS_NOT_ACCEPTED`, `TERMS_VERSION_MISMATCH` | body rule failed |
| 403 | `TURNSTILE_FAILED` | siteverify failed, timed out (3 s), wrong action or hostname, or token already used |
| 404 | `NOT_FOUND` | gate closed |
| 429 | `RATE_LIMITED`, `details.scope` `signup_ip` (5 a day for each source; a request with no determinable IP is refused with this scope) or `signup_email` (3 a day for each folded address; both mails count), `Retry-After` set | limit reached |

Order of checks: gate, body, Turnstile, IP limit, address limit, super-admin address and block list, daily cap, then the mail.

### `POST /api/public/signup/verify`

Body: `{ email, code, dpaVersion? }` (`code` is 6 digits). On success: `200 { ok: true, redirect: "/admin" }` (or `"/admin/mfa"` when `MFA_REQUIRED=true`) and a `Set-Cookie` for the new admin session. Every failure is `400 { error: { code: "SIGNUP_INVALID", message: "The code is not valid. Request a new one." } }` after the same 800 ms minimum: wrong, expired or burnt code, a malformed body, a claim conflict, an address that already has a user, a different `dpaVersion` than the stored one, the daily cap (no audit row at verify), a create step that fails before commit (logged), a client IP that cannot be determined. If the organisation committed but the session could not be created, the answer is `200 { ok: true, redirect: "/admin/login" }` with no cookie (sign in with the emailed admin code). `404` when the gate is closed.

**Not included.** A resend route (the page calls `request` again; the address limit applies). An endpoint that tells if an address is free (it would allow enumeration).
## Mock results endpoints (Z-90, 2026-10-20)

Read-only, admin role, tenant-scoped. All five read live tables where `attempts.delivery_mode = 'mock'` and the status is submitted, auto_submitted, pending_admin_grading, graded or released. They never read `attempt_summary_mv` or `question_stats_mv` (real-only since migration 0219). No export. Response shape `{ data: ... }`. A bad UUID returns 400.

- `GET /api/admin/mock/summary?assessmentId=` returns `{ mock_attempts, students, completed_pct, avg_score_pct, by_assessment: [{ assessment_id, name, attempts, avg_score_pct, last_taken_at }] }`. `completed_pct` is the share of mock invitations with status `submitted`.
- `GET /api/admin/mock/topics?assessmentId=` returns `{ topics, strongest, weakest }`, each topic `{ topic, attempts_graded, correct_pct }`. Topic is `questions.topic`, else the section name, else `General`. Correct means full marks on the newest grading (an admin override wins a tie). Rows with status `review_needed` are not counted. strongest and weakest hold five rows each.
- `GET /api/admin/mock/students?assessmentId=` returns `[{ user_id, name, mock_attempts, avg_score_pct, last_score_pct, last_taken_at }]`, best average first.
- `GET /api/admin/mock/trend?userId=&assessmentId=` returns `[{ date, score_pct, attempts }]`, average score per UTC day, for one student or the whole cohort.
- `GET /api/admin/mock/not-taken?assessmentId=` (required) returns `[{ user_id, name, email, invited_at }]` for candidates invited with `delivery_mode = 'mock'` who have no mock attempt.

Related fix: the admin and candidate Activity readers (leaderboard, stats, heatmap, feed) now count real attempts only.
