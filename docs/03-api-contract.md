# 03 — API Contract

> Base URL: `https://assessiq.in/api`
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
| `POST` | `/take/start`          | Two modes (R4, 2026-10-01): `{ token, preview: true }` returns the landing summary and creates NOTHING; `{ token, consent: true }` (the Begin click) mints the session, records consent, creates the `attempt` and starts the clock |

#### `POST /take/start` modes (R4)

The attempt timer (`attempts.started_at` / `ends_at`) starts when the candidate clicks **Begin assessment** after the pre-test screen, never when the link is opened.

- **Preview** - body `{ "token": "...", "preview": true }`. Read-only: no attempt row, no session cookie, no timer. Marks the invitation `viewed` only.
  `200 { attempt_id: string | null, resumed: boolean, candidate: { name }, assessment: { id, name, duration_seconds, question_count, company_name } }`. `attempt_id` is non-null only when the candidate already began (resume).
- **Begin** - body `{ "token": "...", "consent": true }`. First call: appends a `consent_events` row (`purpose='data_processing'`, `lawful_basis='consent'`, policy version, ip, UA), then creates the attempt (`started_at = now`, `ends_at = started_at + level duration`) and sets the `aiq_sess` cookie. `201` with the same shape as preview plus `attempt_id`.
  Without `consent: true` and with no existing attempt: `422 CONSENT_REQUIRED` (no attempt, no cookie).
  Resume (attempt already exists): `consent` not required, `201` returns the SAME attempt with its ORIGINAL `ends_at`; calling Begin twice never resets the clock.
- Errors unchanged: generic `404 INVITATION_NOT_FOUND`; `410 ALREADY_SUBMITTED`. A non-`active` assessment with no existing attempt also returns the generic 404 (in preview too).
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
| `400` | `{ "error": { "code": "VALIDATION_FAILED", "message": "...", "details": { "validation": [...] } } }` | Fastify schema validation failure (e.g. field over maxLength) |
| `403` | `{ "error": { "code": "TURNSTILE_FAILED", "message": "..." } }` | Turnstile token missing/invalid (fail-closed) |
| `429` | rate-limit headers | Per-IP credential bucket exceeded |
| `429` | `{ "error": { "code": "RATE_LIMITED", "message": "..." } }` | Global 20/hour submission budget exceeded |
| `502` | `{ "error": { "code": "SEND_FAILED", "message": "Could not send your message. Please email connect@assessiq.in directly." } }` | SMTP transport threw (Brevo down, auth error, etc.) |

**Email delivery:** `from: config.EMAIL_FROM`, `to: connect@assessiq.in`, `replyTo: <submitter email>`. Plain-text + HTML multipart. `name` has CR/LF stripped before use in the `Subject` header (email-header-injection defense). All user-supplied fields are HTML-escaped in the HTML body.

---

### Admin — Tenants & users

> **Status (2026-05-01, Phase 0 closure — auth route layer + first API deploy live):** `assessiq-api` container is live behind Caddy split-route at `https://assessiq.automateedge.cloud/api/*` + `/embed*`. The Fastify route layer wrapping `@assessiq/auth` shipped in commits `58eba33` (route layer + Dockerfile) + `335d055` (dev-auth shim swap). All `Auth` table endpoints below are LIVE in code; the `Admin api-keys`, `Admin embed-secrets`, and `/embed` endpoints are LIVE in code. Live drill verification: `/embed` HS256 + replay defense PASSED (Drill C alg=none → 401, Drill D replay → 200 then 401 with Redis cache populated); `/api/auth/google/start` route + tenant resolution PASSED but Drill B (curl 302) is DEFERRED until `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` are added to `/srv/assessiq/.env` (currently returns 401 `"Google SSO is not configured"` cleanly). The `/admin/users/*` slice and `/admin/invitations` POST also live; `acceptInvitation` mints real sessions via `@assessiq/auth.sessions.create`. The `import` route remains a 501 stub returning `details.code = 'BULK_IMPORT_PHASE_1'`. `/admin/tenant` is 02-tenancy Phase 1 work. `GET /api/admin/embed-secrets` intentionally NOT shipped (library lacks `listEmbedSecrets`; Phase 1 follow-up). `assessiq-frontend` Dockerfile + Drill 1 (browser full-stack) deferred to Phase 1+.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `GET`  | `/admin/tenant`        | Current tenant settings + branding | Phase 1 |
| `PATCH`| `/admin/tenant`        | Update tenant name, branding, settings | Phase 1 |
| `GET`  | `/admin/users`         | List users (filter by role, status, search; pageSize cap 100 — stricter than the global 200 cap per `03-users` SKILL § 9) | live |
| `POST` | `/admin/users`         | Create user record (no email sent). **Status is role-derived:** `role:'candidate'` → `active` immediately (candidates have no invite/login flow — they authenticate only via per-assessment magic links); `admin` → `pending` (must accept an emailed invite, see `inviteUser`). `role:'reviewer'` is rejected with 400 `INVALID_ROLE` (role removed 2026-10-03). No `status` field is accepted, so an active admin cannot be minted here. Optional candidate `designation` rides in `metadata.designation` (free-text, no schema column). | live |
| `GET`  | `/admin/users/:id`     | Get user detail | live |
| `PATCH`| `/admin/users/:id`     | Update role, status, name, metadata; enforces last-admin invariant (HTTP 409 `LAST_ADMIN`) and status-state-machine (HTTP 422 `INVALID_STATUS_TRANSITION`); sweeps Redis sessions on disable | live |
| `DELETE` | `/admin/users/:id`   | Soft delete; cascades to pending invitations for the user's email; sweeps Redis sessions; enforces last-admin invariant | live |
| `POST` | `/admin/users/:id/restore` | Restore a soft-deleted user (clears `deleted_at`); does NOT recreate invitations or sessions | live |
| `POST` | `/admin/users/import`  | **Bulk candidate CSV import (live 2026-10-01).** Admin only; authChain rate limit. JSON body `{ csv: string, assessment_id?: string }`. CSV: UTF-8 (BOM stripped), header row required with `name`,`email` (case-insensitive; extra columns ignored), max 1000 data rows, max 512 KB; values trimmed, emails lowercased + shape-validated, in-file duplicates deduped (first wins), blank lines ignored. Each valid row creates a `candidate` (status `active`) in the admin's tenant; an email already in this tenant as a candidate is reused (`existing`); a non-candidate email is skipped (`EXISTING_USER_NOT_CANDIDATE`). One bad row never aborts the rest. With `assessment_id` (must be `published`/`active`, checked BEFORE any user is created → 409 `INVALID_STATE_TRANSITION`, 404 cross-tenant), all created+existing candidates go through the existing `inviteUsers` (same skip reasons e.g. `INVITATION_EXISTS`, `USER_INACTIVE`; same queued emails). Response 200: `{ created, existing, invited, skipped: [{ row, email, reason }], warning? }` — `row` is the spreadsheet row (header = 1); skip reasons: `INVALID_EMAIL`, `MISSING_NAME`, `NAME_TOO_LONG`, `DUPLICATE_IN_FILE`, `EXISTING_USER_NOT_CANDIDATE`, `INSERT_FAILED`, plus invite reasons. `warning` ("Email plan sends ~300/day shared; some invites may be delayed") is present when `invited` > 150. Errors (400 `ValidationError`): `INVALID_PARAM` (csv not a string / bad assessment_id), `CSV_MISSING_COLUMNS`, `CSV_TOO_MANY_ROWS`, `CSV_TOO_LARGE`, `CSV_MALFORMED` (unterminated quote). Audit: exactly ONE `audit_log` row per request (`user.created`, `after = { kind:'bulk_import', rows_total, created, existing, skipped }` — counts only, no names/emails) written in the same tx as the user inserts; invites additionally write their normal per-invitation `assessment.invite` rows. Replaces the former 501 stub (no longer returns `BULK_IMPORT_PHASE_1`). |
| `POST` | `/admin/invitations`   | Issue admin invitation (role enum `admin | candidate`; `reviewer` → 400 `INVALID_ROLE` since 2026-10-03; candidate role → 501 `CANDIDATE_INVITATION_PHASE_1`); response carries the invitation row ID + email + role + expires_at but **never** the plaintext token (per `03-users` SKILL § 2) | live |
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
| `CANDIDATE_INVITATION_PHASE_1` | 501 | `POST /admin/invitations` with `role: 'candidate'` |
| `ASSESSMENT_INVITATION_PHASE_1` | 501 | `POST /admin/invitations` with non-empty `assessmentIds` |
| `VALIDATION_FAILED` | 400 | Schema validation (Fastify `validation` array surfaced under `details.validation`) |

`AUTHN_FAILED` (401) and `AUTHZ_FAILED` (403) come from the dev-auth shim today (`x-aiq-test-tenant` / `x-aiq-test-user-id` / `x-aiq-test-user-role` headers; production hard-fails until 01-auth Window 4 lands).

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
| `GET`  | `/admin/questions`                   | List questions (filter by `pack_id`, `level_id`, `type`, `status`, `tag`, `search`) |
| `POST` | `/admin/questions`                   | Create question (returns 201). Optional `answer_guidance` (string ≤280; candidate-facing hint; omit/blank → per-type default) (0098) **`type` enum (2026-10-03):** `mcq`, `subjective`, `kql`, `scenario`, `log_analysis`, `numeric`, `multi_select`, `ordering`, `structured_case`. `structured_case` content is checked by `StructuredCaseContentSchema` (shape: see 02). |
| `GET`  | `/admin/questions/:id`               | Get question (latest version). Response includes `answer_guidance` (string or null) (0098) |
| `PATCH`| `/admin/questions/:id`               | Update — `content`/`rubric` create a new version (snapshot-before-update); `topic`/`points`/`answer_guidance` are metadata-only (NO version bump). `answer_guidance: null` clears it to the per-type default (0098) |
| `GET`  | `/admin/questions/:id/versions`      | List version snapshots (most-recent first) |
| `POST` | `/admin/questions/:id/restore`       | Restore from a prior version (body: `{ version: number }`); snapshots current then bumps |
| `POST` | `/admin/questions/import`            | Bulk import from JSON (Phase 1) — CSV deferred to Phase 2 |
| `POST` | `/admin/packs/:id/levels/:levelId/generate` | **AI question generation** — generates SOC-grounded `ai_draft` questions for the given level. Body: `{ count?: number (1–10, default 5), topic_focus?: string }`. Returns `{ questionIds: string[], generated: number, skillSha: string }`. Requires `AI_PIPELINE_MODE=claude-code-vps`. Single-flight: 409 `GRADING_IN_PROGRESS` if generation already in flight for this pack/level. Questions land as `status='ai_draft'` with `knowledge_base_sources` provenance. **live 2026-05-08** — **⚠ Phase B1: re-gated to `super_admin`; tenant admins receive 403.** **`topic_focus` (2026-10-03, RV62):** at most 200 characters after trim, no control characters; otherwise 400 `INVALID_PARAM`. The value reaches the generation skill input as `topic_focus` (it was always null before). The generate wizard has no field for it yet; the server skills must read it. |
| `POST` | `/admin/questions/bulk-update-status` | Bulk-flip a batch of questions to `active` or `archived` (admin grid action). Body: `{ ids: string[] (1–200 UUIDs), status: 'active' \| 'archived' }`. Returns `{ updated: string[], notFound: string[] }`. Service filters source statuses (`active` only accepts `ai_draft`; `archived` accepts `ai_draft` \| `draft` \| `active`); ids in disallowed source states OR cross-tenant ids land in `notFound`. Always writes a single `bulk_status` summary audit row (G3.D). 400 `INVALID_BULK_SIZE` for empty / >200 ids; 400 `VALIDATION_ERROR` for non-UUID id or bad status. **live 2026-05-11** |

### Admin — Rubric generation & generation attempts

> **Status: live.** Routes registered in `modules/04-question-bank/src/routes.ts` via `registerQuestionBankRoutes(app, { adminOnly: authChain({roles:['admin']}) })`. All routes were admin-only; tenant scope enforced via RLS + `withTenant`.
>
> **⚠ Phase B1 (2026-05-18, commits `2ba822d` + `9f073a5`) — generation endpoints re-gated to `super_admin`.** The 6 AI generation and generation-history routes below now require `roles:['super_admin']`. Tenant admins receive `403 AUTHZ_FAILED`. Nav and SPA routes are also super-admin-only as defence-in-depth (backend is authoritative). `save-rubric` and all CRUD/import/publish/assemble/status routes remain on `roles:['admin']` unchanged. See § Phase B1 — generation endpoints re-gated to super_admin below for the full listing.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/admin/questions/:id/generate-rubric` | Generate a rubric proposal for a question. **Does NOT persist** — call `save-rubric` to commit. Returns a rubric object. Requires `AI_PIPELINE_MODE=claude-code-vps`. **⚠ Phase B1: `super_admin` only.** |
| `POST` | `/admin/questions/:id/generate-answer-guidance` | Generate a candidate-facing answer-format hint proposal (feature #4, all 5 types). **Does NOT persist** — returns `{ proposal: string, skillSha, promptSha, model }`; the admin reviews it and PATCHes `{ answer_guidance }` to save. The generator receives an answer-key-FREE stem (never the correct option / expected findings / sample solution / step answers). Requires `AI_PIPELINE_MODE=claude-code-vps`. **`super_admin` only.** (0098/Phase B) |
| `POST` | `/admin/questions/:id/save-rubric` | Persist a rubric for a question. Body: `{ rubric: <rubric object> }` (required — 400 `INVALID_PARAM` if absent). Validates that all anchor weights sum to 100 (server-side). Saves as a new rubric version. Returns the updated rubric. |
| `POST` | `/admin/packs/:id/generate-missing-rubrics` | Find the first question in the pack with `rubric IS NULL` and `type IN ('subjective', 'scenario')`, generate a proposal, and return it with a pagination cursor. **Does NOT auto-save.** Response: `{ proposal: <rubric>, cursor: { currentQuestionId, nextQuestionId, remainingCount } }`. Call repeatedly until `cursor.nextQuestionId` is null. **⚠ Phase B1: `super_admin` only.** |
| `GET`  | `/admin/generation-attempts` | Cross-pack AI question-generation history. Query params (all optional): `status` (`success`\|`partial`\|`failed`\|`running`), `model` (substring match, ILIKE), `pack_id` (UUID), `level_id` (UUID), `since` (ISO-8601, filters `started_at ≥ since`), `limit` (1–100, default 50), `offset` (default 0), `sort` (allowlist: `started_at`\|`status`\|`duration_ms`\|`model`), `dir` (`asc`\|`desc`; default `started_at desc`; `sort` maps through a fixed column allowlist server-side, invalid → default). Response: `{ items: GenerationAttempt[], total, limit, offset }`. Each item: `id, status, count_requested, count_inserted, error_code, error_message, stderr_tail, skill_sha, model, chunks_planned, chunks_failed, dedupe_dropped, citation_dropped, difficulty_dropped, duration_ms, started_at, finished_at, pack_id, level_id, level_label, user_id`. **2026-05-30 (`31261c2`):** `level_label` resolves the difficulty level (`L1`/`L2`/`L3`) via a correlated subselect `(SELECT label FROM levels WHERE levels.id = generation_attempts.level_id)` — a subselect not a JOIN, because `levels` also has a `pack_id` column which would make `pack_id`/`status` in the WHERE clause ambiguous (`null` if the level row was deleted). `citation_dropped` + `difficulty_dropped` complete the post-generation drop-reason trio (with the already-present `dedupe_dropped`) so the history Details panel can explain any `count_inserted < count_requested` gap. Columns pre-date this change (migrations `0043`, `0087`); only the projection + admin UI were widened. **Not** added to the per-level endpoint below (keeps its narrower projection); no schema change so `02-data-model.md` is unaffected. **⚠ Phase B1: `super_admin` only.** |
| `GET`  | `/admin/packs/:packId/levels/:levelId/generation-attempts` | Most recent 5 generation attempts for a specific pack + level. Useful for diagnosing why a "Generate" click produced 0 rows without SSH access. Response: `Array<{ id, status, count_requested, count_inserted, error_code, error_message, stderr_tail, model, duration_ms, started_at, finished_at }>`. **⚠ Phase B1: `super_admin` only.** |
| `POST` | `/admin/generation-attempts/:id/score` | Server-side structural + runtime eval scoring for a single generation attempt. **Read-only — no writes to any table.** Resolves attempt via RLS (404 if absent or cross-tenant), loads inserted questions, runs `scoreQuestion` per question, compares per-type pass rates against `eval/baseline.json` regression thresholds. Response: `{ structural: <per-type breakdown>, runtime: <metrics>, verdict: "pass" \| "regression" \| "warning" \| "n/a" }`. **⚠ Phase B1: `super_admin` only.** |

### Admin — Assessments & invitations

> **Status: live as of 2026-05-02 (Phase 1 G1.B Session 3).** All 11 routes below registered into `apps/api/src/server.ts` via `registerAssessmentLifecycleRoutes(app, { adminOnly: authChain({roles:['admin']}) })`. Smoke verified live: `GET /api/admin/assessments` returns 401 AUTHN_FAILED without session, full lifecycle + cross-tenant RLS exercised by 69 testcontainer integration tests in `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts`. The `GET /:id`, `POST /:id/reopen`, `GET /:id/preview`, `GET /:id/invitations`, and `DELETE /admin/invitations/:id` rows are Phase 1 service-method extensions added in the same PR — same admin-only auth gate. `GET /admin/assessments/:id/attempts` belongs to module 06-attempt-engine and is NOT shipped here; it stays in the table as the canonical contract line for Group G1.C.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/admin/assessments`              | List assessments (paginated; filter by `status`, `pack_id`). **2026-05-30:** each item now includes two optional display fields: `level_label` (string, from `levels.label` via LEFT JOIN, e.g. "L1") and `domain` (string, the bound pack's domain as a **human name** — `domains.name` resolved server-side from `question_packs.domain` via a correlated subselect, e.g. "SOC", "Application Security", with COALESCE-fallback to the raw slug when no `domains` row matches). Both are `null` only if level/pack FK is dangling. Used by the admin list page's Level + Domain columns. Additive — existing callers unaffected. Domain is sourced from the bound pack (uniform for blueprint and non-blueprint) rather than `settings.blueprint.domain_id`; resolved server-side (not via the FE static `DOMAIN_LABELS` map) so it tracks super-admin domain renames. **2026-05-30b:** `cancelled` assessments are now EXCLUDED by default (no `status` filter → `status <> 'cancelled'`); they remain reachable via explicit `?status=cancelled`. |
| `POST` | `/admin/assessments`              | Create draft assessment (returns 201). **Blueprint restriction:** if the request body carries `settings.blueprint`, the caller must be `super_admin`; a tenant admin receives `403 AuthzError` ("Blueprint assessments are restricted to super_admin"). See § Blueprint authoring restriction below. |
| `POST` | `/admin/assessments/from-set`     | **Step 2:** create a draft assessment from a licensed PLATFORM-library set. Body: `{ source_pack_id, level_position, name, question_count, opens_at, closes_at?, randomize?, description?, settings? }`. License-checked (`403 NOT_LICENSED`), cloned-on-use into the tenant (idempotent), then created from the clone (returns 201). **Defense-in-depth:** any `settings.blueprint` field in the request body is stripped before delegating (even though this route is `adminOnly` — see § Blueprint authoring restriction). |
| `GET`  | `/admin/assessments/:id`          | Get assessment by id. **2026-05-29:** response now includes two optional fields joined from related tables: `level_label` (string, from `levels.label` — the human-readable level code, e.g. "L1") and `pack_name` (string, from `question_packs.name`). Both are `null` if the JOIN misses (should not happen on well-formed data). Used by the admin detail page header. All other callers of this endpoint are unaffected — the fields are additive. |
| `PATCH`| `/admin/assessments/:id`          | Update — only allowed in `draft` status. **Blueprint restriction:** if the request body carries `settings.blueprint`, the caller must be `super_admin`; a tenant admin receives `403 AuthzError` ("Blueprint assessments are restricted to super_admin"). |
| `POST` | `/admin/assessments/:id/publish`  | `draft → published` — runs pool-size pre-flight (count active questions ≥ `question_count` else 422 `POOL_TOO_SMALL`). **B2: 403 `NOT_ENTITLED` if pack is not entitled for the tenant's plan.** |
| `POST` | `/admin/assessments/:id/close`    | `active → closed` — illegal on `draft` (state-machine reject) |
| `POST` | `/admin/assessments/:id/reopen`   | `closed → published` if `now < closes_at`; else 422 `REOPEN_PAST_CLOSES_AT` (extension). **B2: 403 `NOT_ENTITLED` if pack is not entitled for the tenant's plan.** |
| `POST` | `/admin/assessments/:id/cancel`   | **2026-05-30 (extension).** Soft-retire → terminal `cancelled` state. Legal from `draft`/`published`/`active`/`closed` (state machine extended so a running/finished assessment can be cancelled); `cancelled → *` rejected with 422 `INVALID_STATE_TRANSITION`. Preserves attempts + invitations + audit; the row just drops out of the default list. Returns the updated assessment. Audited as `assessment.cancelled`. |
| `DELETE`| `/admin/assessments/:id`         | **2026-05-30 (extension).** Hard-delete the assessment (returns 204). Allowed ONLY when the assessment has **zero attempts**; otherwise 422 `ASSESSMENT_HAS_ATTEMPTS` (caller should cancel instead). `assessment_invitations` + `assessment_frozen_pool` cascade away (`ON DELETE CASCADE`); `attempts` FK is `RESTRICT` (the DB backstop, also catches a count→delete TOCTOU race → mapped to the same 422). `audit_log` is append-only and retained. RLS confines the delete to the caller's tenant. Audited as `assessment.deleted` (before-payload `{status,pack_id,level_id}`). |
| `GET`  | `/admin/assessments/:id/preview`  | Admin sample of the question pool — does NOT create attempt or snapshot (extension). **RV63 (2026-10-03, `afc5069`):** for a published, closed or reopened assessment with rows in `assessment_frozen_pool`, the counts and the sample come from the frozen pool (what candidates draw), and the response carries `frozen: true`. Draft, and assessments frozen before migration 0096, keep the live pool (`frozen` false or absent). Question text in the sample is the live row; ids and counts are the frozen set. |
| `GET`  | `/admin/assessments/:id/invitations` | List invitations for an assessment (paginated; filter by `status`). **2026-05-29:** each invitation row now includes additional optional fields from LEFT JOINs: `user_name` (string\|null), `user_email` (string\|null), `attempt_id` (UUID\|null), `attempt_status` (string\|null), `started_at` (ISO timestamp\|null), `submitted_at` (ISO timestamp\|null), `total_earned` (number\|null), `total_max` (number\|null), `auto_pct` (number\|null), `pending_review` (boolean\|null). All additive — single-row reads (findById, findByToken, findByAssessmentAndUser) are unaffected and do not return these fields. |
| `POST` | `/admin/assessments/:id/invite`   | Bulk invite users (body: `{ user_ids: string[] }`); per-user skip reasons returned in `skipped[]` (returns 201) |
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

**Why:** Blueprint mode lets an assessment author compose the tenant's domain question pool by per-criterion quota — this is a platform-operator capability, not a company-admin capability. Blueprints define cross-tenant pool structure and allowing a tenant admin to set `settings.blueprint` could produce quota arrangements that conflict with platform licensing invariants.

**`POST /admin/assessments/from-set` defense-in-depth:** this route is `adminOnly` (not `super_admin`) and is the correct entry point for tenant admins building assessments from licensed sets. As an additional safeguard it strips any `settings.blueprint` from the delegated body before creating the assessment — so even if a client crafts a request with `settings.blueprint`, the clone-and-create path never writes it.

**Downstream:** the admin-dashboard hides the "Blueprint" mode button on the New Assessment form for non-super-admin sessions (FE defense-in-depth; the backend gate is authoritative).

---

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

**Behavior:** diffs master↔clone by `questions.source_question_id` — **adds** new master questions (version=2 + `qv{v1}`, taxonomy-remapped by slug, skip-unresolvable), **version-bumps** changed content/rubric (new `question_versions` snapshot at the clone question's current version → future attempts resolve the new content via `MAX(qv.version)`; in-flight attempts stay frozen), **applies metadata-only** changes (level/domain/category/points/topic/type) without a version bump, **archives** questions removed upstream; then bumps the clone `question_packs.version` and records `source_version`. Idempotent: if the clone is already at/above the master version it returns `updated:false` and writes nothing. Runs under `assessiq_system` with a per-`(tenant,source)` advisory lock; one `tenant.pack_resynced` audit row in the same tx (only when something changed).

**Response 200:**
```json
{ "updated": true, "from_version": 1, "to_version": 2, "added": 3, "changed": 5, "archived": 1, "skipped": 0 }
```

**Errors:** `403 NOT_LICENSED`; `404` `CLONE_NOT_FOUND` (no clone of this set in the tenant) / `SOURCE_PACK_NOT_FOUND`; `400 INVALID_PARAM`; `401 AUTHN_FAILED`.

**Caveat (decided 2026-05-25):** future attempts — even on an existing PUBLISHED assessment using this clone — draw the refreshed content, because the attempt engine serves the latest active snapshot at attempt-start and does NOT per-assessment version-pin. In-flight/started attempts are never disrupted (their `attempt_questions` snapshot is frozen). This matches how editing a pack's questions already behaves.

**Source:** `modules/05-assessment-lifecycle/src/routes.ts`, `modules/05-assessment-lifecycle/src/service.ts` (`resyncLicensedSet`), `modules/04-question-bank/src/clone.ts` (`resyncSetForTenant` / `resyncClonedPack`).

### Admin — Grading & review

> **Status (2026-05-03, Phase 2 G2.A Session 1.b — LIVE in commit `5aec6ad`):** All 10 admin endpoints below registered into `apps/api/src/server.ts` via `registerGradingRoutes(app, { adminOnly: authChain({roles:['admin']}), adminFreshMfa: authChain({roles:['admin'], freshMfaWithinMinutes: 5}) })`. Smoke verified live: 11/11 Haiku checks PASS (every endpoint returns 401 AUTHN_FAILED without session — none 404). Service handlers under `modules/07-ai-grading/src/handlers/admin-*.ts`, registrar at `routes.ts`. Grading runtime at `runtimes/claude-code-vps.ts` spawns `claude -p` per D1-D8 in `docs/05-ai-pipeline.md`. Override never replaces — INSERTs new `gradings` row with `grader='admin_override'`, `override_of` FK, `override_reason`. Multi-tenancy guard: `/accept` validates every `proposal.attempt_id === URL attemptId` AND every `proposal.question_id ∈ attempt_questions` for the attempt. D7 single-flight is in-process `Map<attemptId>`; same-attempt OR other-attempt 409. Skill SHAs at deploy time: `anchors=1f04c875`, `band=15c14f96`, `escalate=f3588256` (claude CLI v2.1.119 on the VPS).

> **Superseded 2026-10-01 (platform evaluation queue):** for company admins `grade`, `accept`, `rerun` and `grading-jobs/:id/retry` below now answer `403 AI_EVALUATION_BY_ASSESSIQ` (AI evaluation runs from `/api/admin/super/evaluations*`); `GET /admin/attempts/:id` is read-only; `release` and `override` need the evaluation released to the company first. The heartbeat window in the rows below is 5 minutes in code (not 60 s). Current contract: § Scoring and result release at the end of this doc.

| Method | Path | Purpose | Status |
|---|---|---|---|
| `POST` | `/admin/attempts/:id/grade`           | Trigger sync AI grading. D1 mode + D7 heartbeat + D7 single-flight. Returns `{ proposals: GradingProposal[] }` — does NOT write `gradings` rows (D8 accept-before-commit). **2026-10-01:** also runs deterministic MCQ scoring first; for an attempt with only MCQ questions the click finalises it (graded + billed, no AI) and returns `{ proposals: [], attempt: { id, status: "graded" } }` (`attempt` is absent otherwise). `auto_submitted` attempts are now gradeable. 409 `AIG_HEARTBEAT_STALE` if session idle > 60s. 409 `AIG_GRADING_IN_PROGRESS` on single-flight reject. 503 `AIG_RUNTIME_FAILURE` on `claude` subprocess error. **Phase 2 cache (2026-05-29, commit `96b71a6`):** ALSO sets `attempts.grading_started_at = NOW()` on entry, writes `attempts.ai_proposals = proposals_jsonb` + nulls the marker at batch completion. On any thrown error a catch best-effort nulls the marker (so the FE banner doesn't stick on a failed run). Recovery path for "client got CF/proxy 504/524 on the 4-minute synchronous response" — proposals are persisted server-side regardless of whether the response reached the browser. Cache is review-state only — admin Accept click is still required to write `gradings` rows. | **live 2026-05-29** |
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
| `GET`  | `/admin/reports/individual/:userId`   | All scored attempts for a user across assessments. Response: `IndividualScore[]` (each row: `attempt_id, assessment_id, auto_pct, archetype, computed_at`). RLS-scoped to tenant. | **live 2026-05-01** |
| `GET`  | `/admin/reports/leaderboard/:assessmentId?topN=10&anonymize=false` | Top-N attempts ordered by `auto_pct DESC`. `topN` range: 1–200 (default 10). `anonymize=true` redacts `candidate_name` and `candidate_email` to null. **Admin-only.** No public cross-tenant view (P2.D13). Response: `LeaderboardRow[]` (each: `rank, attempt_id, candidate_name, candidate_email, auto_pct, archetype, computed_at`). | **live 2026-05-01** |
| `GET`  | `/admin/dashboard/summary`            | Headline KPIs for current tenant | **planned** |
| `GET`  | `/admin/reports/topic-heatmap`        | Strong/weak topics across team | **live 2026-05-xx (15-analytics), no admin UI caller — see FU-C5 note below** |
| `GET`  | `/admin/reports/export.csv`           | CSV export of attempts (with filters) | **live as `/admin/reports/exports/attempts.{csv,jsonl}` (15-analytics), no admin UI caller** |

> **FU-C5 (2026-10-06): which report routes have a UI, which are parked.** The three rows above were stale ("planned") — `modules/15-analytics/src/routes.ts` has shipped `topic-heatmap`, `archetype-distribution/:assessmentId`, `cost-by-month`, `exports/attempts.csv`, `exports/attempts.jsonl` and `exports/topic-heatmap.csv` since Phase 3 G3.C. None of the six has an `modules/10-admin-dashboard` caller today (checked 2026-10-06: no match for any of these paths under `modules/10-admin-dashboard/src`) — they are reachable only by a direct API call. `cost-by-month` is additionally empty-shape in `claude-code-vps` mode (D2, see `docs/05-ai-pipeline.md`). The cohort/individual routes just above (live, UI-backed) are a *separate*, independent implementation in 09-scoring — see `modules/15-analytics/SKILL.md` D4.

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
| `GET`    | `/admin/notifications`                     | Short-poll in-app notifications (`?since=<ISO cursor>&limit=<n>`) — admin only (the any-role option `anyRoleAuth` was removed 2026-10-03) — **live 2026-05-03** |
| `POST`   | `/admin/notifications/:id/mark-read`       | Mark notification read — admin only (since 2026-10-03) — **live 2026-05-03** |

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
| `GET` | `/api/admin/super/tenants/:tenantId/users` | List users + pending invitations for a tenant (Phase C) | **live 2026-05-20** |
| `POST` | `/api/admin/super/users/:userId/disable` | Super-admin user disable; LAST_ADMIN override path | **live 2026-05-20** |
| `POST` | `/api/admin/super/users/:userId/reenable` | Super-admin user reenable | **live 2026-05-20** |
| `DELETE` | `/api/admin/super/users/:userId` | Super-admin soft-delete; LAST_ADMIN override path | **live 2026-05-20** |
| `POST` | `/api/admin/super/users/:userId/restore` | Super-admin restore soft-deleted user | **live 2026-05-20** |
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

**Guards:** the old `409 LAST_ADMIN` guard (demote the only admin to reviewer) is gone with the demotion path (2026-10-03). New email colliding with an existing user in the same tenant → `409 USER_EMAIL_EXISTS`. Editing a `super_admin` user → `400 CANNOT_EDIT_SUPER_ADMIN`. Editing a soft-deleted user → `409 USER_DELETED`. Every change writes one `audit_log` row (`user.updated`, `kind:'super_profile_edit'`) in the same transaction.

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

Re-issue a pending admin invitation for an existing tenant when the original magic link expired, was lost, or the recipient never received it. Reuses the canonical `inviteUser()` re-invite path — the existing pending invitation is deleted, a fresh token is minted, and the invitation email is resent (same 7-day TTL). The new token *invalidates* the old one (same email = same pending row gets replaced).

**Why this exists, not `PATCH /companies`:** A super-admin who just provisioned a company should not have to re-run the entire `POST /companies` flow (which would 409 on the slug) to get a new invitation token. This route is the surgical fix.

**Why it's idempotent (in effect):** Calling it twice in a row produces two emails but only the second token is valid — the second call replaces the first pending invitation. The user cannot end up with two simultaneous live tokens for the same email.

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

**Response 200:** each tenant also carries its **first admin** (earliest `users` row with `role='admin'` in that tenant — the person invited at company-creation). `admin_*` are `null` for tenants with no admin user (e.g. the `platform` tenant, whose operator is `super_admin`). `admin_status` is `pending` until the admin accepts the invite, then `active`.

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

`usage` is `null` when the per-tenant billing aggregate could not be computed (best-effort — the endpoint never fails the whole list because of a billing row absence for one tenant).

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

Body parsing (`parseLifecycleBody`) rejects reason strings that: exceed 500 characters, are non-string/empty if provided, or contain ASCII control characters (including NUL `\x00` — valid in jsonb but crash SIEM tooling). These all return `400 INVALID_REASON`.

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

---

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

---

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

---

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

---

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

---

#### User lifecycle endpoints (Phase C)

Shipped in commit `a888a43` (2026-05-20). Two parallel surfaces:

- **Tenant-admin endpoints** (`/api/admin/users/…`) — operate within the caller's own tenant; enforce the LAST_ADMIN invariant unconditionally. Gated by `adminOnly` (`admin` role + `totpVerified`).
- **Super-admin override endpoints** (`/api/admin/super/users/…`) — operate cross-tenant; can bypass LAST_ADMIN when `confirm_last_admin: true` is provided with a non-empty `reason`. Gated by `superAdminFreshMfa` (`super_admin` + TOTP within 15 min).

Both surfaces share the same `parseLifecycleBody` reason-validation logic (max 500 chars, no control chars, `400 INVALID_REASON` on violation).

---

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
    { "id": "uuid", "email": "...", "name": "...", "role": "admin", "status": "active", "deleted_at": null, "created_at": "...", "updated_at": "..." }
  ],
  "pending_invitations": [
    { "id": "uuid", "email": "...", "role": "admin", "expires_at": "...", "created_at": "..." }
  ]
}
```

Users are ordered `created_at DESC, id DESC`. Pending invitations are `accepted_at IS NULL`, ordered `created_at DESC`.

**Source:** `apps/api/src/routes/admin-super.ts:974`.

---

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

---

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

---

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

**Audit actions emitted:** `user.deleted` in `audit_log` (via `auditInTx` in the service-layer transaction) plus `user.soft_deleted` in the lifecycle operational JSONL log (via `logLifecycleEvent` in the route handler). The two action names are catalogued as equivalent — see [`modules/14-audit-log/src/types.ts:157`](modules/14-audit-log/src/types.ts#L157).

**Source:** `apps/api/src/routes/admin-users.ts:304`, `modules/03-users/src/service.ts` (`softDelete`).

---

##### `POST /api/admin/users/:userId/restore`

Restores a soft-deleted user by clearing `deleted_at`. Does NOT recreate invitations or sessions — the user must be re-invited or log in again.

**Auth:** `admin` role + `totpVerified`.

**Body:** `{ reason?: string }`

**Response 200:** `{ userId, status }` — `status` reflects the user's current `users.status` (e.g. `"active"` or `"disabled"` — whatever it was before soft-delete).

**Error codes:**
| `details.code` | HTTP | Meaning |
|---|---|---|
| `INVALID_REASON` | 400 | reason is wrong type, too long, or contains control chars |

**Audit action emitted:** `user.restored`.

**Source:** `apps/api/src/routes/admin-users.ts:242`, `modules/03-users/src/service.ts` (`restore`).

---

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

---

#### DPDP data-rights endpoints (Module 20, 2026-05-29)

Admin-mediated data-subject rights for **candidates** (who never log in — they are reached only via single-purpose magic links, so there is no candidate-facing portal). Both endpoints are gated `admin` role: under the DPDP the tenant is the **data fiduciary** for its own candidates, and Postgres RLS confines every statement to the caller's tenant, so a cross-tenant `userId` resolves to `USER_NOT_FOUND`. (This deliberately widens the originally-planned `super_admin`-only erase gate; see `modules/20-data-rights/SKILL.md` D-route note.)

##### `GET /api/admin/users/:userId/data-export`

Right of access / portability. Returns a JSON bundle of everything the platform holds for the candidate, assembled synchronously (no S3, no worker — the narrow candidate PII surface does not warrant async generation). The admin's browser downloads it as `assessiq-data-export-<userId>.json`; nothing is stored server-side.

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

---

#### Super-admin user lifecycle override endpoints (Phase C)

Gated by `superAdminFreshMfa` (`super_admin` + TOTP within **15 minutes**). These are the cross-tenant counterparts to the tenant-admin endpoints above. Key differences:

- **Cross-tenant:** the target user's `tenantId` is resolved via a `assessiq_system` (BYPASSRLS) query on `userId`, then the operation runs under `withTenant(targetTenantId)`. The super-admin's session `tenantId` (the `platform` tenant) is never used for the data operation.
- **LAST_ADMIN override:** when the action would normally raise `LAST_ADMIN`, passing `confirm_last_admin: true` **and** a non-empty `reason` bypasses the guard. Without both fields, `LAST_ADMIN` fires identically to the tenant-admin path. The audit row carries `is_override: true` in the `after` JSON. `logLifecycleEvent` fires at **WARN** level when `isOverride: true`.
- **No self-action guards:** super-admins do not live in any tenant, so `CANNOT_DISABLE_SELF` and `CANNOT_DELETE_SELF` never apply.

**Body shape for all super-admin lifecycle endpoints:** `{ reason?: string, confirm_last_admin?: boolean }`

---

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

---

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

---

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

---

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

---

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
| `GET`  | `/api/me/assessments`             | List active assessments the candidate is invited to | **live 2026-05-02** |
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
→ 202 { "attempt_id":"att_...", "status":"submitted", "estimated_grading_seconds": 60, "result_expectation":"soon", ... }

# 5. Poll for result
GET /api/me/attempts/att_.../result
→ 202 { "status":"pending", "result_expectation":"soon", ... }
... after the result is released ...
→ 200 { "status":"released", "score": { ... }, "released_at": "..." }   (complete score only; see § Scoring and result release)
```

> Note (2026-10-01): the `/submit` and `/result` bodies in steps 4 and 5 above are out of date. Current shapes: § Scoring and result release at the end of this doc.

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

**Not included.** Other events, a per-event subscription filter in the UI, a plan-tier check (webhooks are Growth and up by owner decision; no code gate yet).

**Impact.** Modules 06 and 09 now depend on `@assessiq/notifications`. Tests that mock that package must export `emitAttemptEventAfterCommit` (see `docs/RCA_LOG.md` 2026-10-03). `release.ts` may import only that helper (structure test, `74f1f46`).

## Worked example — Webhook payload (host integration)

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
  return `https://assessiq.in/embed?token=${encodeURIComponent(token)}`;
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

### `GET /api/admin/assessments/:id/results.csv`

LIVE placement-cell export (reads live tables, NOT `attempt_summary_mv`). Roles: admin only (`adminOrReviewer` removed 2026-10-03). Assessment must belong to the session tenant (404 otherwise). One row per **invited** candidate (not started, in progress, submitted, graded, released, expired); latest attempt wins. Capped at 10,000 rows. UTF-8 with BOM; string cells starting `= + - @` are prefixed with `'`.

**Response 200:** `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<assessmentId>-results-YYYY-MM-DD.csv"`.

**Columns:** `name, email, status, started_at, submitted_at, score, max_score, percent, result, <Category name> (%)...` (categories alphabetical). `status` = attempt status, or `invited` / `expired` when no attempt exists. score/max/percent/per-category are blank unless the attempt is `graded`/`released`; score = sum of the latest grading per question (`graded_at DESC`, admin_override wins); percent has 1 decimal; `result` = Pass/Fail vs `levels.passing_score_pct`.

**Query (2026-10-01, `1a4f82d`):** `sort` = `name` (default; previous behaviour) | `rank` | `branch` (branch A→Z, then rank, then name; rows without a branch last). Any other value → 400.

**Columns since `1a4f82d`:** `name, email, roll_number, branch, status, started_at, submitted_at, score, max_score, percent, result, rank, tab_switches, paste_count, fullscreen_exits, <Category name> (%)...`
- `roll_number` / `branch` come from `users.metadata` (set by the CSV import, see 02).
- `rank` is competition ranking ("1,2,2,4") by percent DESC over rows with a visible score. It is blank for rows still awaiting evaluation, or not started.
- `tab_switches`, `paste_count` and `fullscreen_exits` count `tab_blur` / `paste` / `fullscreen_exit` events. They are integrity signals, not scores, so they show whatever the release state. They are 0 for an attempt with no events and blank when there's no attempt.
- **Why:** the university placement cell needs a ranked, branch-wise list.
- **Rejected:** a separate "rank list" endpoint. One CSV with a sort option keeps a single export path and one audit action.
- **Not included:** rank within branch as its own column. `sort=branch` orders by overall rank inside each branch.

**Audit:** `action: 'attempt.exported'`, `entityType: 'assessments'`, `entityId` = assessment id.

---

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


> **Status: live.** All endpoints below are implemented in `modules/18-certification/src/routes.ts`. They return `401` without a session, `404` for an unknown or foreign certificate, `403` for a wrong owner, `409` or `410` for revoked states, and `422` for a malformed `credential_id`. The earlier `501 Not Implemented` stub status ended when the issuance engine and PDF generator shipped.

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

**Query params:** `candidate_id?` (UUID), `tier?` (completion|distinction|honors), `revoked?` (true|false), `limit` (default 20, max 100), `offset` (default 0), `sort?` (allowlist enum: `credential_id`|`user_email`|`tier`|`course_title`|`issued_at`|`status`), `dir?` (`asc`|`desc`). Default sort `issued_at desc`. `sort` maps through a fixed column allowlist server-side (ORDER BY can't be parameterized); invalid values fall back to the default. **2026-05-21**

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

---

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
| `overage` | `number` | `max(0, used - included_credits)`; `0` when unlimited |
| `status` | `"ok" \| "warn" \| "over" \| "unlimited"` | `ok` = <80% used; `warn` = 80–<100%; `over` = ≥100%; `unlimited` = `included_credits` is null |

**Errors:**

- `401 AUTHN_FAILED` — no session or invalid session cookie. Verified live.
- No `404` for a planless tenant — fails safe to `{ tier: "free", included_credits: 0, used: <count>, status: "over" }` and logs a server-side warning. This is an operator-visible data-integrity signal (every tenant should have a plan row post-backfill by migration `0080`).

**Note:** RLS-scoped to the session tenant via `withTenant`. The credit count query is `COUNT(*) FROM billing_events WHERE tenant_id = $1` — no mutable counter, always self-consistent.

**Source:** `modules/19-billing/src/routes.ts` — `GET /api/billing/usage`.

---

## Admin — Super Billing (Phase A2, module 19-billing)

> **Status: LIVE — 2026-05-17 (commit `66ea0ff`).** Routes in `apps/api/src/routes/admin-super.ts`. Auth via `authChain({ roles: ['super_admin'] })` (`superAdminOnly` gate — same as all other super routes). No fresh-MFA requirement (fresh-MFA is reserved for tenant creation; config edits like plan changes do not require step-up).

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

---

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

---

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

**Audit:** Emits `tenant.plan_updated` (`ACTION_CATALOG` in `modules/14-audit-log/src/types.ts`). The `UPDATE` on `tenant_plans` and the `audit_log` INSERT are in the same Postgres transaction (atomic — rollback reverts both). This is a **two-role transaction**: the `SELECT … FOR UPDATE` + `UPDATE` on `tenant_plans` runs under `assessiq_system` (BYPASSRLS — no UPDATE RLS policy exists on `tenant_plans` by design); the `auditInTx` write to `audit_log` runs under `assessiq_app` with `set_config('app.current_tenant', tenantId, true)`, satisfying `audit_log`'s INSERT RLS policy and the `modules/14-audit-log/src/audit.ts` contract. This mirrors the reviewed `updateAiGenerateMode` precedent in `@assessiq/tenancy`.

**Source:** `apps/api/src/routes/admin-super.ts`, `modules/19-billing/src/service.ts` (`updateTenantPlan`).

---

## Phase B1 — generation endpoints re-gated to super_admin

> **Status: LIVE — 2026-05-18 (commits `2ba822d` + `9f073a5`).** Follows Phase A2.

Previously `roles:['admin']`, now `roles:['super_admin']` for the following 7 paths. Tenant admins receive `403 AUTHZ_FAILED`. Nav links and SPA routes for these features are also restricted to super_admin as defence-in-depth — the backend auth gate is authoritative. The remaining question-bank **authoring** routes (pack/level/question CRUD, import, publish, archive, activate-questions, save-rubric, bulk-status) were subsequently re-gated to `super_admin` as well — see the next subsection (2026-05-21). `modules/07-ai-grading` grading routes (grade, accept, release, override, etc.) remain unchanged on `roles:['admin']`.

| Path | Previous auth | Phase B1 auth |
|---|---|---|
| `POST /api/admin/packs/:id/levels/:levelId/generate` | `roles:['admin']` | `roles:['super_admin']` |
| `POST /api/admin/questions/:id/generate-rubric` | `roles:['admin']` | `roles:['super_admin']` |
| `POST /api/admin/questions/:id/generate-answer-guidance` | — | `roles:['super_admin']` |
| `POST /api/admin/packs/:id/generate-missing-rubrics` | `roles:['admin']` | `roles:['super_admin']` |
| `GET /api/admin/generation-attempts` | `roles:['admin']` | `roles:['super_admin']` |
| `GET /api/admin/packs/:packId/levels/:levelId/generation-attempts` | `roles:['admin']` | `roles:['super_admin']` |
| `POST /api/admin/generation-attempts/:id/score` | `roles:['admin']` | `roles:['super_admin']` |

**Source:** `modules/04-question-bank/src/routes.ts` — `superAdminOnly` chain swapped in for `adminOnly` on the 6 generation/history routes; per-route auth documented inline in § Admin — Rubric generation & generation attempts above.

---

## Phase B1 (cont.) — question-bank authoring re-gated to super_admin

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

**Not re-gated (deliberately):** `POST /api/admin/domains` and `POST /api/admin/categories` stay `admin` — they are per-tenant generation taxonomy, not shared-library content. **SPA gating (defence-in-depth, authoritative gate is the backend):** the Question Bank list hides "+ New Pack" and the per-row archive from non-super_admin; pack-detail hides Publish / Archive pack / Activate all / per-question Archive / bulk select+approve+archive and renders per-question **Edit → View**; the question editor is read-only for tenant admins (no approve/archive/generate/save; read-only rubric summary; create form blocked). Adversarial review (Sonnet takeover; codex companion was hung) returned VERDICT=accept — no cross-tenant leak, no authz gaps, const-only SQL interpolation, fail-closed counts.

**Source:** `modules/04-question-bank/src/routes.ts`.

---

## Phase B1 — tenant entitlement endpoints

> **Status: LIVE — 2026-05-18 (commits `2ba822d` + `9f073a5`).** Schema in `docs/02-data-model.md` § `tenant_entitlements`.

### `GET /api/admin/super/tenants/:tenantId/entitlements`

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

---

### `POST /api/admin/super/tenants/:tenantId/entitlements`

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

---

### `DELETE /api/admin/super/tenants/:tenantId/entitlements`

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

**Source:** `apps/api/src/routes/admin-super.ts`, `modules/19-billing/src/service.ts` (`revokeTenantEntitlement`).

---

### `GET /api/admin/super/tenants/:tenantId/content-scopes` (2026-05-24)

Returns the PLATFORM library's **grantable scopes** for the named tenant — the set of domain slugs and published platform packs that a super-admin can grant via `POST /entitlements`, minus scopes that are already actively granted to this tenant.

**Auth:** `super_admin` only.

**Path params:** `tenantId` — UUID of the target tenant.

**What it returns.** The response is built from two sources under `assessiq_system` (BYPASSRLS):
1. **Canonical domain slugs** — queried from the `domains` table (the platform's taxonomy, seeded by migration 0083). These are lowercase slugs like `"soc"`, `"devops"`, `"cloud-architect"`.
2. **Published platform packs** — `question_packs` rows where `tenant_id = platform_tenant_id` AND `status = 'published'`, represented as `scope_type='pack'` entries with `scope_id = pack.id`.

Scopes that already have an `active` row in `tenant_entitlements` for this tenant are **excluded** — the result is the delta the super-admin can still grant, not a full catalog re-listing.

**Why this endpoint replaced the old behavior.** The previous implementation read the **target tenant's own** `question_packs.domain` column values and returned those as grantable scopes. That produced non-canonical free-text domains (e.g. `'SOC'`, mixed-case values entered via the old free-text Domain field) that never matched the lowercase platform slug `'soc'` during license-resolution at publish time (`assertPublishEntitled` matches entitlement `scope_id` against `question_packs.domain` by exact string). The fix sources scopes from the platform's `domains` table instead, ensuring the granted `scope_id` always matches the canonical lowercase slug written to `question_packs.domain` by the write-path enforcement (see migration `0090_normalize_domain_slugs.sql` in `docs/02-data-model.md`).

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

---

### Platform domain management (2026-05-25)

Super-admin management of the canonical domain taxonomy. These are **platform-wide** operations (no `:tenantId`): they read/write the platform master tenant's `domains` and **propagate** changes into every company tenant so the whole fleet shares one consistent domain set. Provenance (`domains.source`, migration 0091) keeps propagation from ever touching a tenant-LOCAL domain. Cross-tenant writes run under `SET LOCAL ROLE assessiq_system`; each mutation writes one audit row in the same transaction.

**Why a new namespace (not the existing `POST /api/admin/domains`).** `POST /api/admin/domains` (module 04, `adminOnly`) remains the **tenant-local** domain-create path — a tenant admin adds a domain only for their own tenant (`source='tenant'`). The `/api/admin/super/domains` namespace is for **platform** domains that mirror across tenants and is gated by `super_admin` + fresh MFA, consistent with every other cross-tenant `/super` operation.

#### `GET /api/admin/super/domains`

Lists the platform master tenant's domains — **all statuses** (active + archived + legacy inactive) so the UI can show the full library and offer reactivate.

**Auth:** `super_admin` only (read-only; no fresh MFA).

**Response 200:**
```json
{ "domains": [
  { "id": "uuid", "slug": "soc", "name": "SOC", "description": null,
    "status": "active", "display_order": 1, "source": "platform" }
] }
```
Empty `domains` array when the platform tenant does not exist (fresh DB).

#### `POST /api/admin/super/domains`

Creates a platform domain and propagates it (`source='platform'`, `status='active'`) into every non-platform tenant. The propagation INSERT is `ON CONFLICT (tenant_id, slug) DO NOTHING`, so a tenant that already has the slug — **including a tenant-local domain on the same slug** — is skipped and left untouched.

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

#### `PATCH /api/admin/super/domains/:id`

Archives (`status='archived'`) or reactivates (`status='active'`) a platform domain and propagates the status to **every platform-origin copy** of that slug across all tenants (`UPDATE … WHERE slug=$ AND source='platform'`). Tenant-local domains sharing the slug are never touched.

**CATALOG-ONLY (decided 2026-05-25):** archiving removes the domain from all selection dropdowns (which filter `status='active'`) and makes it non-grantable going forward, but does **not** revoke existing `tenant_entitlements` and does **not** untag existing packs/questions. Reversible via reactivate.

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

---

### `GET /api/billing/entitlements`

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

### `GET /api/billing/available-sets`

**Step 2 (standing-license + clone-on-use).** Returns the published PLATFORM-library question sets the calling tenant is licensed for — a **domain** license surfaces ALL current AND future sets in that domain; a **pack** license surfaces one set. Metadata only (no question content); license filter is applied in SQL so an unlicensed set is never returned. Drives the company-admin "assess from a set" picker, which calls `POST /admin/assessments/from-set` (clone-on-use).

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

---

## Phase B2 — publish-time enforcement

> **Status: LIVE — 2026-05-18 (commit `5c80aaa`).** Follows Phase B1. Schema in `docs/02-data-model.md` § `tenant_entitlements` → Phase B2 note.

Every transition INTO `assessments.status='published'` — whether via `POST /admin/assessments/:id/publish` (`draft → published`) or `POST /admin/assessments/:id/reopen` (`closed → published`) — now validates pack entitlement server-side **before** the status write and the `assessment.published` audit event. The check runs inside the existing `withTenant` transaction in `modules/05-assessment-lifecycle/src/service.ts`; a failure rolls back the entire transition (no partial published row, no audit entry).

**Entitlement function:** `assertPublishEntitled(client, tenantId, packId)` exported from `@assessiq/billing`.

**Decision tree:**

1. `tenant_plans.tier = 'internal'` → **bypass** (always allowed).
2. No `tenant_plans` row for the tenant → **fail-closed** (enforce, not bypass).
3. `assessment.pack_id` has an active `tenant_entitlements` row with `scope_type='pack'` → **entitled**.
4. `question_packs.domain` of that pack has an active `tenant_entitlements` row with `scope_type='domain'` → **entitled**.
5. Neither → **403 `NOT_ENTITLED`**.

Reads (`tenant_plans`, `tenant_entitlements`, `question_packs`) run under the publishing tenant's own `withTenant` RLS — no system role; cross-tenant reads are structurally impossible.

**The picker in `assessment-detail.tsx` is convenience only** — it hints at entitlement when selecting a pack at draft time, but it fails open and is never authoritative. The server 403 is the gate.

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

---

## Scoring and result release (2026-10-01)

> **Status: LIVE.** Phase I (candidate result, release modes, result email; deploy `ecea951`) and Phase II (platform evaluation queue; merges `ee8a28f` backend and `1564489` frontend, fix `a7b4596`). Rules: a candidate sees only a **complete, final** result; AI evaluation is run only by the platform super admin; the company (tenant) reviews and publishes. **This section supersedes** the grade / accept / rerun / attempt-detail / release / override rows under "Admin — Grading & review" and the candidate `submit` / `result` rows. Data: `docs/02-data-model.md` § Scoring and result release. Flow and rationale: `docs/05-ai-pipeline.md` § Platform evaluation queue.

**Conventions.** Errors are `{ error: { code, message, details? } }`. A body that fails validation is `400 VALIDATION_FAILED` (`details.code = AIG_INVALID_BODY`, `details.issues`); a value rejected inside a handler uses the `error.code` shown below, except `TENANT_NOT_ACTIVE`, `TENANT_NOT_FOUND` and `INVALID_RESULT_RELEASE_MODE`, which are `error.details.code` (the top-level code is `CONFLICT`, `NOT_FOUND`, `VALIDATION_FAILED`). Tenant is never in the URL or body: company routes use the session's tenant, and the platform routes look the attempt's tenant up in the database. State a company sees: `awaiting_evaluation` → `ready_to_publish` → `published`.

### Candidate (`/api/me/*`, candidate session)

| Method + path | Behaviour |
|---|---|
| `POST /api/me/attempts/:id/submit` | `202 { attempt_id, status: 'submitted', estimated_grading_seconds: 60 \| null, result_expectation: 'soon' \| 'email', release_mode: 'manual' \| 'auto', email_masked, turnaround_text }`. `'soon'` only when the tenant is in `auto` (switched on) AND every question is MCQ AND the attempt is not an embed attempt; everything else is `'email'`. `email_masked` looks like `r***@example.com`. `turnaround_text` is config `EVALUATION_TURNAROUND_TEXT` (default "within 72 hours"). The lookup can never fail a submit (it falls back to `'email'`). Never a score. |
| `GET /api/me/attempts/:id/result` | Published: `200 { status: 'released', total_earned, total_max, percent (0-100, 1 dp), passed (percent >= the level's passing_score_pct), assessment_name, released_at, certificate: { credential_id, verify_url } \| null }`. Otherwise `202 { status: 'pending', result_expectation, release_mode, email_masked, turnaround_text, tenant_name }`. 404 for an unknown attempt or someone else's. Never per-question data, bands, justifications or a partial score. |
| `GET /api/me/results` | `200 { items: [{ attempt_id, assessment_name, released_at, total_earned, total_max, percent, passed, certificate \| null }] }`: published results only, newest first (the portal "My results" page). |

Related: the candidate magic-link verify (`POST /api/auth/candidate/verify-link`) now redirects to `/candidate/results`. `GET /api/me/activity/stats` and `/leaderboard` count published results only. The `result_released` email (sent once, after publishing; skipped for erased candidates and embed attempts) links to `/candidate/login?tenant=<slug>`; that page reads `?tenant=` and shows an "Organisation code" field when it is missing. The consent policy version recorded at Begin is now `2026-10-02` (the PreTest copy says written answers are evaluated by AssessIQ evaluators with AI assistance).

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
| `GET /api/admin/assessments/:id/results.csv` | admin | A row still awaiting evaluation shows the result "Awaiting evaluation" and no score, percent or category columns. |

### Platform evaluation queue (`/api/admin/super/evaluations*`, `super_admin` only)

Chains are defined in `apps/api/src/routes/admin-super-evaluations.ts`; the route bodies are `modules/07-ai-grading/src/routes-super.ts`. **super** = `roles: ['super_admin']` (TOTP is always required for super admins); **super + fresh MFA** = the same plus TOTP within 15 minutes, used only by manual score and override. Every per-attempt route resolves the attempt's tenant from the database (read-only system-role lookup), refuses a missing or suspended tenant (404 `TENANT_NOT_FOUND`, 409 `TENANT_NOT_ACTIVE`), then runs the handler inside that tenant's `withTenant` with the super admin as actor, so audit rows land in the **tenant's** log. A non-UUID path param is `400 VALIDATION_FAILED`; an unknown attempt is `404 AIG_ATTEMPT_NOT_FOUND`. The platform never receives the candidate's name or email.

| Method + path | Auth | Body → success | Errors |
|---|---|---|---|
| `GET /api/admin/super/evaluations?tenant_id=` | super | → `200 { items: [{ attempt_id, tenant_id, tenant_name, assessment_id, assessment_name, level_label, submitted_at, age_hours (1 dp), written_count, kql_count, status, complete (status === 'graded'), grading_in_progress (an AI run started under 10 min ago), sent_back, sent_back_note }], counts: { pending, older_than_24h } }`. Oldest first, at most 500 rows (counts cover the whole queue). | 400 bad `tenant_id` |
| `GET …/:attemptId` | super | → `200 { tenant_id, tenant_name, attempt: { id, status, assessment_name, level_label, started_at, submitted_at }, answers, frozen_questions (with rubric), gradings, ai_proposals, grading_started_at, score, evaluation_released_at, evaluation_note, evaluation_sent_back_at }`. No side effects. | |
| `POST …/:attemptId/grade` | super | Optional `{ override_skill? }` → `200 { proposals }`. **The only AI trigger:** synchronous, single-flight, writes no `gradings` row until accepted (D8). | 409 `NOT_IN_EVALUATION_QUEUE`; 409 `AIG_HEARTBEAT_STALE` (session idle over 5 min); 409 `AIG_GRADING_IN_PROGRESS`; 422 `AIG_ATTEMPT_NOT_GRADEABLE`; 503 `AIG_*` runtime errors |
| `POST …/:attemptId/accept` | super | `{ proposals: [...] }` (same schema as the old tenant accept; every `proposal.attempt_id` must equal the URL id) → `200 { gradings, attempt: { id, status: 'graded' \| 'pending_admin_grading' } }`. Completing the attempt flips it to `graded` (billed once) but does **not** release it to the company. | 400 id mismatch or schema; 422 `AIG_INVALID_BODY` (`0 < score_max <= 1000`, `0 <= score_earned <= score_max`, question not in the attempt); 409 `RESULT_ALREADY_PUBLISHED` |
| `POST …/:attemptId/rerun` | super | `{ forceEscalate?: boolean }` (strict; default false = normal automatic escalation) → fresh `proposals`. Also valid on a `graded` attempt the company sent back. | as `grade`; 400 for any other body shape |
| `POST …/:attemptId/questions/:questionId/manual-score` | super + fresh MFA | `{ score_earned >= 0, reason 1..500 }` (strict) → `200 { grading, attempt: { id, status } }`. First human score for a question with no grade (KQL has no grader). No AI. | 409 `AIG_QUESTION_ALREADY_GRADED`; 409 `RESULT_ALREADY_PUBLISHED`; 422 `AIG_INVALID_BODY` (question not in the attempt, or outside `0..questions.points`); 422 `AIG_ATTEMPT_NOT_GRADEABLE` |
| `POST …/:attemptId/gradings/:gradingId/override` | super + fresh MFA | `{ score_earned, reasoning_band?, ai_justification?, error_class?, reason }` → `200 { grading }`. Part of the evaluation itself (no "released first" rule). | 404 `AIG_GRADING_NOT_FOUND` (also when the grading belongs to another attempt); 409 `RESULT_ALREADY_PUBLISHED`; 422 `AIG_INVALID_BODY` |
| `POST …/:attemptId/release-to-tenant` | super | → `200 { attempt_id, evaluation_released_at }`. Needs status `graded`, every question effectively graded, none `review_needed`, candidate not erased. Sets `evaluation_released_at/_by`, clears the send-back marker. Audit `grading.evaluation_released`. | 409 `EVALUATION_NOT_COMPLETE`, `EVALUATION_ALREADY_RELEASED`, `RESULT_ALREADY_PUBLISHED`; 422 `AIG_ATTEMPT_NOT_RELEASABLE_ERASED` |
| `POST /api/admin/super/evaluations/release-to-tenant` | super | `{ attempt_ids: uuid[1..200] }` (strict) → `200 { released: [ids], skipped: [{ id, code }] }`. One transaction per attempt; duplicates are processed once. | 400 |

`NOT_IN_EVALUATION_QUEUE` (`a7b4596`) guards `grade` and `rerun` only. The attempt must have a non-MCQ question, a non-erased candidate, and be pre-graded or `graded` with the evaluation not yet released: the same rule as the queue list. A direct call therefore cannot spend an AI run on an MCQ-only, released or published attempt.

**Considered and rejected.** Returning 404 for the old company grade routes (a stale client would not learn why; 403 with a stable code does). Showing a "provisional" score with a flag (owner rule P1 forbids any partial number). A new `attempts.status` value for "released to the company" (see `docs/02-data-model.md`).

**Not included.** Background or API-mode grading, company-triggered AI (the owner has decided companies may evaluate once an API budget exists; not built, so these routes answer 403 in every mode), a per-assessment release mode, a "result updated" email (a published result is final), and a company-facing ETA beyond the candidate's `turnaround_text`.

**Release on the last accept (built, `809e807`, `23c9f0b`).** The accept, manual score or override that completes an attempt also releases it to the company in the same transaction. `release-to-tenant` remains for sent-back attempts and recovery.

**Impact.** `modules/11-candidate-ui` wire types and the post-submit / My results pages, `modules/10-admin-dashboard` (tenant settings, review states, platform queue and evaluate pages), 15 results CSV and candidate activity, 13 `result_released` template. Rollback: deploy the previous image; the new columns are additive (data model doc).

---

## 2026-10-01 (later): invitations, webhooks, evaluation flow, option shuffle

**Invitations** (company admin; same auth chain as `/api/admin/invitations/:id`)

| Method + path | Success | Errors |
| --- | --- | --- |
| `POST /api/admin/invitations/:id/resend` | 200 the invitation; a new link is emailed after commit, the old link stops working, valid 7 days | 404 `INVITATION_NOT_FOUND` · 409 `INVITATION_ALREADY_STARTED` / `ASSESSMENT_NOT_ACTIVE` / `USER_INACTIVE` · 502 `INVITATION_EMAIL_FAILED` (link rotated but email not queued: resend again) |
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
- `accept`, `manual-score` and `override` under `/api/admin/super/evaluations/:attemptId/*` release the evaluation to the company in the same transaction when that call completes the attempt, setting `evaluation_released_at` and `evaluation_released_by`. This never happens for an erased candidate, and never for an already-graded (sent-back) attempt: use `release-to-tenant` for those.
- `rerun` on a graded (sent-back) attempt sets the grading marker and caches `ai_proposals` (poll like Grade all). Accepting those proposals writes new grading rows (the newest wins) and answers `attempt.status = "graded"`.
- `release-to-tenant` clears the `ai_proposals` cache.

**Candidate (option shuffle)**
- `GET /api/me/attempts/:id`: MCQ `content.options` come in this attempt's display order, and `answers[].answer.selected` is the displayed position.
- `POST /api/me/attempts/:id/answer` takes the displayed index; the server stores the original one.
- No new fields and no new errors.


## Batch 3 API changes (2026-10-02)

### `PATCH /api/admin/assessments/:id/integrity`

- Auth: admin session (`adminOnly`), tenant-scoped. Body, strict (unknown keys rejected): `{ "fullscreen": boolean, "block_copy_paste": boolean }`; both required. Bad body: 400 `VALIDATION_ERROR`, `details.code = INVALID_PARAM`, `param = body`. Unknown id: 404 `ASSESSMENT_NOT_FOUND`.
- Effect: merges only `settings.integrity` (`jsonb_set`, one UPDATE); blueprint and other settings keys are untouched. Allowed in ANY status, including published: the candidate view reads settings live, so it applies to attempts started afterwards and a student mid-test picks it up on next page load. Audit: `assessment.updated` with `before/after { integrity }`. Returns the updated assessment.
- Why: switches could be set only on the create form. Rejected: a general PATCH of settings (wider surface, would let a published blueprint change). Not included: the tab-leave warning is not switchable.

### `GET /api/admin/assessments/:id/invitations` paging

`page` (1-based) and `pageSize` (cap 100) were already accepted; the admin UI now uses them: 100 per page, "Showing x-y of N", Previous/Next, page clamped to the last real page when rows shrink. The picker and has-attempts guard use ids gathered across all pages. No API shape change; `total` in the response is the paging source.

### Candidate attempt payload: numeric and multi_select

- `numeric`: content sent to the candidate is `{ question, unit? }` (sanitiser allowlist; `answer`, `tolerance`, `rationale` are never sent). Answer saved: a JSON number or null.
- `multi_select`: `{ question, options }` in the student's shuffled order (shuffle covers up to 10 options); `correct`, `scoring`, `rationale` stripped. Answer saved: `{ "selected": [int] }` of displayed indexes, translated to original indexes at the save seam (all-or-nothing: one bad element leaves the answer untouched). Scoring and result shapes: see 02 and 05.

### Auth note: session-status cache

Every authenticated request now consults a 30 s positive-only Redis cache for the user/tenant active check. Suspend, disable, delete, erase take effect at once on the normal path; worst case 30 s. Details in 04 "Session-status cache". Responses are unchanged.



## Batch 4 notes (2026-10-02)

### `POST /api/me/attempts/:id/finish-section` (candidate)

- **What.** Candidate-only. No body. Returns `{ section_index }` (the section just opened). Opens the next section now and re-pins `attempts.ends_at = now + the remaining sections' minutes`.
- **Errors.** 409 `AE_SECTION_NOT_FINISHABLE` on the last section (submit instead) or on an attempt without sections. Standard attempt ownership / state errors otherwise.
- **Candidate attempt payload `sections`.** `GET` of an in-progress sectioned attempt adds `sections: { current, total, name, calculator, ends_at, remaining_seconds }`. `questions` and `answers` are already limited to the running section; later sections are not sent. Finished attempts return everything as before. Plain tests have no `sections` key.
- **`AE_SECTION_LOCKED` (409).** `saveAnswer` / `toggleFlag` on a question whose section is not the running one (finished or not yet open).
- **Why.** Deadlines are server-authoritative; a locked section cannot be edited from a stale tab. Details in 02 (migration 0132) and `modules/06-attempt-engine/SKILL.md`.
- **Not included.** Per-section score breakdown in any response.

### `PATCH /api/admin/assessments/:id/reminders` (admin)

- **What.** Body `{ enabled: boolean, hours_before?: int 1..168 }`, strict. Allowed in any assessment status. Merged into `settings.reminders` server-side; audited as `assessment.updated`; returns the assessment. 400 `INVALID_PARAM` (param `body`) on a bad body.
- **Why a dedicated route.** Works on a published assessment without re-sending the whole settings object (same pattern as `/integrity`).
- `GET /api/admin/assessments/:id/invitations` rows gain `reminded_at` (nullable).

### `POST /api/invitations/accept`: 429 behaviour

- **What.** A per-IP brake that counts FAILED redemptions only (unknown, expired or used token): 30 per 60 s per client IP (`INVITE_FAIL_MAX`). A valid accept is never blocked or counted. Only a failure past the cap returns 429 `scope=ip` with `Retry-After: 60`, instead of the specific error (so it is not an oracle).
- **Why.** Replaces the old FIXME. Tokens are 256-bit so guessing is infeasible; the brake bounds DB lookups and log noise from scanners. The first version checked the limit before redeeming, which let one scanner lock a whole campus NAT out of valid accepts (codex revise); it now redeems first.
- **Not included.** No per-token or per-email limit; the route-level limiters are unchanged.

### `CANDIDATE_ERASED` (409)

- **What.** Server-side refusal when the target candidate has `erased_at` set, on: 05 invite and resend; 07 manual-score and override; 18 reissue and issue-on-release (the latter treats an erased candidate as null, no certificate); 20 data-rights export.
- **Why.** Hiding buttons in the UI is not a block; a stale tab or direct API call could still touch erased data.
- **Not included.** Release itself already refused erased candidates (older guard).

### `/try` is not an API route

`/try` and `/try/certificate` are static SPA pages (`apps/web/src/pages/try`): fixed content, client-side scoring, no network calls, no session. Nothing was added to this contract. The edge routes them to the SPA through the Caddy `@app` matcher (see 06 deployment).


## Batch 5 notes (2026-10-02)

### `PATCH /api/admin/assessments/:id/grading` (05, admin)
- **What.** Body `{ "high_stakes": boolean }`, strict (extra keys give 400). Works in any assessment status. Merges only `settings.high_stakes`. Audited as `assessment.updated`. Returns the full assessment.
- **Errors.** 400 `INVALID_PARAM` (param `body`) on a bad body; 404 `ASSESSMENT_NOT_FOUND` (also for another tenant's id).
- **Why.** Same pattern as `/integrity` and `/reminders`: one setting key, any status, no sections-lock side effects.
- **Not included.** Per-question flag; tenant default.
- **Impact.** Takes effect for AI grading runs started afterwards (07 reads it live). `settings.high_stakes` is also accepted at create/update.

### `PATCH /api/admin/assessments/:id` and create: `SECTIONS_LOCKED` (409)
- **What.** If `settings.sections` would change and any attempt exists: `409 { error: { details: { code: "SECTIONS_LOCKED" } } }`, message "Sections can't be changed after students have started this test."
- **Not included.** Other settings keys are not affected.

### `AIG_EVAL_GATE` (409, 07)
- **What.** Returned by grade-all and re-run (including super-admin evaluations) before any AI call, only when `AI_EVAL_GATE=enforce` (or an unknown value) and the current grading skill shas match no blessed baseline. `details.current = { anchors, band, escalate }`. In `warn` (default) it is only logged as `grading.eval_gate.unapproved`.
- **Not included.** Question generation is never gated.

### `AIG_ESCALATION_FAILURE` on high-stakes grading (07)
- **What.** Not a new route. For a high-stakes assessment, a failed Stage 3 now returns this code on the proposal, so status derives to `review_needed` and the FE keeps it out of "Accept all".

### `GET /api/admin/super/eval-gate` (07, super admin)
- **Response.** `{ mode: "off"|"warn"|"enforce", approved: boolean, current: {anchors, band, escalate}, baseline_date: string|null }`. Read-only. `baseline_date` is the file name (date) of the approving baseline.

### `GET /api/admin/super/grading-quality?days=90` (07, super admin)
- **Query.** `days` integer 1..730, default 90. Bad query gives 400.
- **Response.** `{ days, items: [{ prompt_version_sha, ai_grades, overrides, override_rate, mean_abs_band_delta, mean_abs_score_delta_pct }] }`. `override_rate` is null with no AI rows. Cross-tenant aggregate, no candidate data, read-only transaction.

### Generation batches (04, super admin)
All three use the same guard as the other generate routes. `id` must be a uuid (else 400 `INVALID_PARAM`).
- `GET /api/admin/generation-batches/active` returns `{ batch: Batch | null }`, the caller's newest `active` batch.
- `PUT /api/admin/generation-batches/:id`, body `{ domainId?: uuid|null, level?: string<=10|null, categories: object[] (max 50), completedCategoryIds?: uuid[] (max 50) }`. Upsert. `completed_category_ids` is unioned with the stored value. Returns `{ batch }`. 409 if the id belongs to another user or tenant (never says which).
- `PATCH /api/admin/generation-batches/:id`, body `{ status: "done"|"dismissed" }`. Returns `{ ok: true }`. 404 if not found for this user.
- `Batch` = `{ id, domainId, level, categories, completedCategoryIds, status, updatedAt }`.
- **Why.** Durable wizard plan, see 02 migration 0142.
- **Not included.** No list-all, no delete.

### Candidate attempt view: `sections_summary`
- **What.** `GET /api/me/attempts/:id` (sectioned assessments only) adds `sections_summary: [{ index, name, question_count, answered_count, status: "done"|"current"|"upcoming" }]` over ALL sections. Counts only: no question ids, no content. "Answered" uses the take-page emptiness rule (null, empty string, empty array, all-empty object = unanswered).
- **Why.** The final submit dialog must total unanswered questions across all sections, but the view only carries the running section's questions.
- **Impact.** Absent for attempts without sections. Type in 11 `SectionSummaryWire`.

### Admin attempt detail: `section_scores`
- **What.** `GET /api/admin/attempts/:id` adds `section_scores: [{ index, name, earned, max }]`, from 09 `getSectionScoresForAttempt`. Empty array when the assessment has no sections or the score is not visible (not released to the tenant).
- **Impact.** The attempt page shows a "Section scores" table (score and %).

### `GET /api/admin/assessments/:id/results.csv`: section columns
- **What.** After the existing columns, one column per section named `Section: <name> (%)` (names from `settings.sections`). Blank when the row's score is not visible. Sort and other params unchanged.
- **Not included.** No per-section rank or earned/max columns.

### Candidate attempt payload: ordering

- Content sent to the candidate is `{ question, items }` only (sanitiser allowlist; `correct_order`, `scoring`, `explanation` are never sent). `items` are in the attempt's own shuffled order, which is never the correct order and does not change between reloads.
- Answer saved (`PUT` answer route): `{ "order": [int] }` of DISPLAYED item positions in the sequence the candidate chose. The server translates it to original item indexes before storing (all-or-nothing: one bad element leaves the answer untouched and it scores 0). The candidate's own reads translate it back to displayed positions. No new route; `answer` is untyped JSON as for the other types.
- Scoring and result shapes: see 02 and 05. Admin attempt detail shows the candidate order next to the correct order (admin only).


### Candidate attempt payload: structured_case (2026-10-03)

- Content sent to the candidate is `{ title, context, log_excerpt?, steps: [{ id, prompt, select, options }] }` only. The sanitiser keeps an allowlist per step; `correct`, `scoring` and `explanation` are never sent. Options are in authored order (no shuffle for this type).
- Answer saved (`PUT` answer route): `{ "steps": { "<stepId>": [int] } }` with original option indexes. Check rule: see the answer-save row above. The candidate runner marks a question answered when at least one step has a pick.
- Scoring and result shapes: see 02 and 05. The admin attempt detail shows the key and the candidate picks per step (admin only).

> **Reviewer role removed (2026-10-03, RV60).** Invites, user create/update and super-admin edit-admin return 400 `INVALID_ROLE` for `reviewer`. Notifications and the results CSV are admin only. See `docs/04-auth-flows.md` § "Reviewer role removed". The dev minter section still names `reviewer` in its body type, for legacy rows only.
