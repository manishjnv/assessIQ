# 04 — Auth Flows

> Phase 1 ships **Google SSO + TOTP**. All other methods are designed in but admin-toggled per tenant in Phase 2. The architecture below assumes them all from day one so we don't refactor the session and identity model later.

## Identity model summary

| Concept | Where it lives |
|---|---|
| **Who you are** | `users` (per tenant) — one row per (tenant, email) |
| **How you proved it** | `oauth_identities`, `user_credentials` |
| **Active sessions** | `sessions` (Redis-mirrored for fast lookup) |
| **Service-to-service** | `api_keys` |
| **Embed access** | `embed_secrets` (per tenant; signs JWT) |
| **Audit** | `audit_log` (every login, MFA, override) |

A `users` row exists *before* the first login. Admins create users (or import via CSV/SCIM in v2); SSO links the Google identity to that pre-existing row on first login. **No self-registration in v1** — protects against tenant pollution.

---

## Roles and capabilities

Four roles exist in the `Role` union. The `requireAuth` gate uses **exact set membership** (`opts.roles.includes(sess.role)`) — passing `roles: ['admin']` does NOT admit a `super_admin` session. Each route lists every accepted role explicitly. (`modules/01-auth/src/sessions.ts:23`, `modules/01-auth/src/middleware/require-auth.ts:26`)

| Role | Scope | Auth method | TOTP enforced | Typical access |
|---|---|---|---|---|
| `candidate` | Per-tenant | Magic link or Google SSO | Optional (tenant-configurable) | `/take/*`, `/api/me/*` |
| `reviewer` | Per-tenant | Google SSO | Yes (when `MFA_REQUIRED=true`) | Read-only admin routes |
| `admin` | Per-tenant | Google SSO | Yes (when `MFA_REQUIRED=true`) | Full `/api/admin/*` for their tenant |
| `super_admin` | Cross-tenant | Google SSO | Yes (when `MFA_REQUIRED=true`) | Routes explicitly gated to `['super_admin']` only |

**super_admin detail (commit d59ade4):** authenticates via the same Google SSO → TOTP path as admin. Session still carries a `tenant_id` (the tenant the operator authenticated against); cross-tenant writes are enabled in specific service functions (e.g. `updateAiGenerateMode` accepts a target `tenantId` as an explicit argument). Shipped endpoints gated to `roles: ['super_admin']`:

| Endpoint | Purpose |
|---|---|
| `PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode` | Flip AI generation mode for any tenant (atomic audit via `auditInTx`) |
| `POST /api/admin/analytics/refresh` | Manual materialized-view refresh (cross-tenant) |

(`apps/api/src/routes/admin-super.ts:25,41`, `apps/api/src/server.ts:225,229`)

> **DB caveat — migration pending:** `modules/01-auth/migrations/011_sessions.sql:23` has `CHECK (role IN ('admin','reviewer','candidate'))` — `'super_admin'` is absent. `sessions.create()` writes Postgres **first**; the CHECK violation throws before Redis is touched, so the session creation fails entirely (no dangling Redis entry, but no session either — the user gets a 500 at the TOTP-verify step). The prerequisite `ALTER TABLE` migration is tracked in `docs/design/2026-05-10-stage-3-promotion-rollout.md §3`. Do not promote a user to `super_admin` in production until that migration runs. (`modules/01-auth/src/sessions.ts:22`)

---

## Flow 1 — Admin login (Google SSO + TOTP)

> **Status (2026-05-01, Phase 0 closure — route layer + first API deploy live end-to-end):** library + DB layer + Fastify route layer + container deploy ALL LIVE on `origin/main`. Commits `d9cfeb4` (W4 library + migrations 010-015), `58eba33` (assessiq-api Dockerfile + auth route layer), `335d055` (dev-auth shim swap → real `@assessiq/auth` chain across `apps/api` and `apps/web`), `0789e4f` (Dockerfile build-strategy fix + `getTenantBySlug` system-role implementation). Routes serving Flow 1: `GET /api/auth/google/start?tenant=<slug>` (302 to Google, sets `aiq_oauth_state` + `aiq_oauth_nonce`), `GET /api/auth/google/cb` (mints pre-MFA `aiq_sess`, redirects to `/admin/mfa`), `POST /api/auth/totp/enroll/start` + `POST /api/auth/totp/enroll/confirm` (returns 10 plaintext recovery codes ONCE), `POST /api/auth/totp/verify` (promotes to `totp_verified`), `POST /api/auth/totp/recovery`, `POST /api/auth/logout`, `GET /api/auth/whoami`. Container live behind Caddy split-route on `https://assessiq.automateedge.cloud/api/*`; verified by direct curl on the deployed surface. **Drill B (curl `/api/auth/google/start` 302) is DEFERRED** — route + tenant resolution PASS but `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are empty in `/srv/assessiq/.env`, so the route returns 401 `"Google SSO is not configured"` cleanly (rate-limit headers populated, no leak, no stack trace). To clear: provision OAuth client in Google Cloud Console with redirect URI `https://assessiq.automateedge.cloud/api/auth/google/cb`, add credentials to `.env`, restart `assessiq-api`. **Drill 1 (full-stack browser SSO+MFA flow) is DEFERRED** — `assessiq-frontend` Dockerfile is a Phase 1+ deliverable, so the `/admin/login` HTML route currently serves the Caddy default placeholder, not the SPA. The dev-auth `FIXME(post-01-auth)` markers are now ZERO across the repo (`apps/api/src/middleware/dev-auth.ts` deleted; `apps/web` SPA edits in commit `335d055`).

The strict path. Every admin must clear both factors.

> **Post-login redirect contract (updated 2026-05-04, commit `473fef1`):** The canonical post-authentication landing is always `/admin` (the dashboard). Previously `MFA_REQUIRED=false` redirected to `/admin/users` and post-TOTP `nav()` calls in `apps/web/src/pages/admin/mfa.tsx` also targeted `/admin/users`. Both are now `/admin`. The `MFA_REQUIRED=false` path is an unusual dev/test mode; in production `MFA_REQUIRED=true` always so the path is: Google callback → `/admin/mfa` → TOTP verify → `/admin`.

```
┌──────────┐                ┌────────────┐                  ┌────────────┐
│ Browser  │                │ AssessIQ   │                  │  Google    │
└────┬─────┘                └─────┬──────┘                  └─────┬──────┘
     │                            │                               │
     │ GET /admin                 │                               │
     ├───────────────────────────▶│                               │
     │  302 → /api/auth/google/start                              │
     │◀───────────────────────────┤                               │
     │                            │                               │
     │ GET /api/auth/google/start                                 │
     ├───────────────────────────▶│                               │
     │  Build OIDC AuthN request: client_id, redirect_uri,        │
     │  state (signed), nonce, scope=openid email profile,        │
     │  hd=<tenant.domain> (if domain restriction enabled)        │
     │  302 → accounts.google.com/o/oauth2/v2/auth?...            │
     │◀───────────────────────────┤                               │
     │                            │                               │
     │     GET accounts.google.com/...                            │
     ├──────────────────────────────────────────────────────────▶ │
     │     User authenticates with Google                         │
     │◀────────────────────────────────────────────────────────── │
     │     302 → assessiq.automateedge.cloud/api/auth/google/cb?code&state │
     │                            │                               │
     │ GET /api/auth/google/cb    │                               │
     ├───────────────────────────▶│                               │
     │                            │ POST oauth2/token (code)      │
     │                            ├──────────────────────────────▶│
     │                            │ id_token + access_token       │
     │                            │◀──────────────────────────────┤
     │                            │ Verify id_token sig + claims  │
     │                            │ (iss=accounts.google.com,     │
     │                            │  aud=client_id, exp, nonce)   │
     │                            │ Resolve user:                 │
     │                            │  - find oauth_identities by   │
     │                            │    (provider='google',sub)    │
     │                            │  - else find users by         │
     │                            │    (tenant_id,email)+link     │
     │                            │  - else 403 (no self-reg)     │
     │                            │ Check tenant.domain allow-list│
     │                            │ Create pre-MFA session        │
     │                            │ (totp_verified=false)         │
     │  Set-Cookie: aiq_sess (httpOnly,Secure,SameSite=Lax)       │
     │  302 → /admin/mfa          │                               │
     │◀───────────────────────────┤                               │
     │                            │                               │
     │ GET /admin/mfa             │                               │
     ├───────────────────────────▶│                               │
     │  If totp_enrolled_at IS NULL: enroll flow (next section)   │
     │  Else: prompt for 6-digit code                             │
     │                            │                               │
     │ POST /api/auth/totp/verify {code}                          │
     ├───────────────────────────▶│                               │
     │  Decrypt totp_secret_enc, verify TOTP (RFC 6238, ±1 step)  │
     │  Update sessions.totp_verified=true                        │
     │  audit_log: 'auth.login.totp_success'                      │
     │  302 → /admin                                              │
     │◀───────────────────────────┤                               │
```

**Session cookie spec:**
- Name: `aiq_sess`
- Value: 32-byte random; only the `sha256` hash is stored
- Flags: `HttpOnly; Secure; SameSite=Lax; Path=/`
- Lifetime: 8 hours sliding (idle 30 min)
- On every request: middleware reads cookie → looks up Redis → checks `totp_verified` → loads tenant context

**Security middleware order (Fastify) — updated 2026-05-04:**
1. `requestId` (correlation)
2. `cookieParser` (`@fastify/cookie`, registered globally at app startup — runs as `onRequest` before any `preHandler`)
3. `sessionLoader` (sets `req.session` from Redis — **runs before rateLimit** so the bypass decision can read it; short-circuits in <1 ms when no `aiq_sess` cookie is present)
4. `rateLimit` (per-IP, per-user, per-tenant; IP bucket skipped on opt-in endpoints for verified admins/reviewers — see § Admin/reviewer IP rate-limit bypass below)
5. `tenantContext` (sets `app.current_tenant` for the DB connection)
6. `requireAuth(roles, mfaRequired=true)` — applied per route

> **Chain reorder note (2026-05-04):** The original order was `requestId → rateLimit → cookieParser → sessionLoader → ...`. sessionLoader was moved before rateLimit so the bypass logic can inspect `req.session`. This is safe: `@fastify/cookie` runs as an `onRequest` hook (before all `preHandlers`), so `req.cookies` is always populated when `sessionLoader` runs. Anonymous requests (no `aiq_sess` cookie) incur zero extra overhead — sessionLoader short-circuits on missing cookie without touching Redis.

## Flow 1a — TOTP enrollment (first admin login)

```
1. Server generates random 20-byte secret, base32-encodes for QR
2. Encrypts with AES-256-GCM using MASTER_KEY env var, stores in user_credentials.totp_secret_enc
3. Generates `otpauth://totp/AssessIQ:user@x.com?secret=...&issuer=AssessIQ&period=30&digits=6&algorithm=SHA1` (SHA-1 explicit — Google Authenticator / Authy / 1Password default but ambiguous if omitted)
4. Renders QR code + manual entry code
5. User scans with Authy / Google Authenticator / 1Password
6. User enters first 6-digit code → server verifies with ±1 time step tolerance
7. On success:
   - generates 10 single-use recovery codes (cryptographically random, 8 chars each)
   - hashes each with argon2id, stores in totp_recovery_codes
   - shows codes to user ONCE with prominent download/print prompt
   - sets totp_enrolled_at = now()
   - audit_log: 'auth.totp.enrolled'
```

**Recovery codes:**
- One-time use, marked `used_at` on consumption
- User can regenerate (admin can force regenerate); old codes invalidated
- Used at the same `/admin/mfa` prompt with a "Use recovery code instead" link

## Flow 1b — Step-up MFA for sensitive actions

Some admin actions require fresh MFA even within an active session:
- Override an AI grading score
- Delete an assessment with submitted attempts
- Rotate API keys or embed secrets
- Change tenant auth methods

Implementation: routes annotated `requireFreshMfa(maxAgeMinutes=15)`. If `sessions.last_totp_at < now() - 15min`, return `403 mfa_required` with a re-auth challenge. Frontend shows the TOTP modal, then retries the original action.

---

## Flow 2 — Candidate login

Two modes per assessment, set by admin:

### Mode A: SSO (default, internal)

Same Google SSO flow as admin, but:
- `requireAuth(role: 'candidate', mfaRequired: tenant.totp_required_for_candidates)` — TOTP optional for candidates by default; enforced if tenant requires it
- No admin UI access, candidate routes only
- Redirect target after auth: the assessment they were invited to (`/take/<invitation-token>`)

### Mode B: Magic link (cross-org, external candidates)

```
1. Admin invites candidate by email
   → POST /api/admin/invitations { email, assessment_id }
   → token = randomBytes(32).toString('base64url')
   → store token_hash (sha256), expires_at = now + 72h
   → email candidate: https://assessiq.automateedge.cloud/take/<token>

2. Candidate clicks link
   → GET /take/<token>
   → verify token_hash exists, not expired, status='pending'
   → mark status='viewed'
   → render landing page; CTA "Begin assessment"

3. Candidate clicks "Begin"
   → POST /api/take/start { token }
   → mark invitation status='started'
   → create attempt, create session bound to user_id, totp_verified=true (TOTP not required for magic link mode)
   → return session cookie
```

**Magic links are single-attempt:** once `attempt.status` moves past `in_progress`, the token is dead. If the candidate's browser crashes mid-attempt, they re-use the same link until the attempt is `submitted`. After that, the link returns "already submitted, contact your admin."

---

## Flow 3 — Embed (host application iframes AssessIQ)

> **Status: LIVE 2026-05-03 (Phase 4 commit `b20858b`).** All implementation gaps in the spec-drift note below have been resolved. The `/embed` handler is fully implemented in `apps/api/src/routes/auth/embed.ts`. Migrations 0070–0073 have been applied to production. The `aiq_embed_sess` ↔ `aiq_sess` cookie bridge is live in `apps/api/src/server.ts`.

Used when AssessIQ is dropped inside another app (Wipro internal portal, client product, etc.). The host app already authenticated the user; AssessIQ trusts the host's assertion via signed JWT.

### Setup (one-time per tenant)
1. Tenant admin creates an embed secret in AssessIQ admin UI
   → `POST /api/admin/embed-secrets { name }`
   → server returns the secret value ONCE (then stores only encrypted form)
2. Host app stores the secret in its own backend env var

### Per-request flow

```
Host app backend builds JWT:
{
  "iss": "host-app-name",
  "aud": "assessiq",
  "sub": "<host-user-id>",
  "tenant_id": "<aiq-tenant-uuid>",
  "email": "candidate@host-domain.com",
  "name": "Jane Doe",
  "assessment_id": "<aiq-assessment-uuid>",
  "exp": <now + 600 seconds>,
  "iat": <now>,
  "jti": "<random uuid>"        // for replay protection
}
Sign with HS256 using tenant's embed secret.

Host renders: <iframe src="https://assessiq.automateedge.cloud/embed?token=<JWT>">

AssessIQ /embed handler (Phase 4 implementation — LIVE):
1. Decode JWT header → reject if alg != 'HS256' (D5: alg=none and RS256 rejected)
2. Look up tenant by 'tenant_id' claim
3. Fetch tenant's embed_secrets (try active, then rotated within grace period)
4. Verify signature
5. Validate claims: aud='assessiq', exp>now, iat<=now, exp-iat ≤ 600s (D5 max window), jti not in replay cache (Redis SET with TTL=exp)
6. Resolve/create JIT user via `resolveJitUser()`:
   - find users by (tenant_id, email)
   - if not found: create guest user with role='candidate' (JIT provisioning, always enabled in v1)
7. Build per-tenant CSP: `frame-ancestors <tenant.embed_origins.join(' ')>` — removes `X-Frame-Options` header (D8)
8. Mint embed session via `mintEmbedSession()`: creates `sessions` row with `session_type='embed'` (D6)
9. Set `aiq_embed_sess` cookie: `HttpOnly; Secure; SameSite=None; Path=/` (D7). The server's `onRequest` hook bridges this cookie to `aiq_sess` for downstream middleware.
10. Call `startAttempt({ embedOrigin: true })` → sets `attempts.embed_origin = TRUE`
11. `reply.redirect('/take/a/<attemptId>?embed=true', 302)` — SPA detects `?embed=true` and renders `<EmbedLayout>`
```

**Host-host trust boundary:** AssessIQ trusts whatever the JWT says about identity. If the host signs a token claiming to be `ceo@wipro.com`, AssessIQ believes them. This is the correct model — but means embed secrets are valuable. Rotate every 90 days; revoke immediately on suspected compromise.

**postMessage protocol** (for iframe ↔ parent communication):
- AssessIQ → host: `{ type: 'aiq.attempt.started', attemptId }`, `{ type: 'aiq.attempt.submitted', attemptId, summary }`, `{ type: 'aiq.height', px }` (auto-resize), `{ type: 'aiq.ready', tenantId, assessmentId }` (initial handshake), `{ type: 'aiq.error', code, message }`, `{ type: 'aiq.close-blocked', reason }` (response to close-request when attempt in progress)
- Host → AssessIQ: `{ type: 'aiq.theme', tokens: {...} }` (runtime theming), `{ type: 'aiq.locale', locale: 'en-IN' }`, `{ type: 'aiq.close-request' }` (host wants to close iframe)
- Origin pinned via `tenant.embed_origins` allowlist (see spec-drift note below)
- Full TypeScript type definitions for all message types: `modules/12-embed-sdk/SKILL.md` § D3

> **Phase 4 spec drift — RESOLVED (2026-05-03 commit `b20858b`).**
>
> Two gaps that existed as "spec drift" before Phase 4 have been resolved:
>
> 1. **`tenants.embed_origins` column** — Migration `0070_embed_origins.sql` adds `embed_origins TEXT[] NOT NULL DEFAULT '{}'` to `tenants` with a GIN index. The `/embed` handler reads this column via `getEmbedOrigins()` and builds a per-tenant `frame-ancestors` CSP.
>
> 2. **`frame-ancestors 'none'` override** — The Fastify `/embed` handler sets `reply.header('Content-Security-Policy', 'frame-ancestors ' + origins.join(' '))` and removes `X-Frame-Options`. Caddy in reverse-proxy mode does not overwrite upstream response headers, so the per-tenant header reaches the browser intact. Production smoke test confirmed: `curl -sI '/embed/health'` returns `content-security-policy` from Fastify, not Caddy's `frame-ancestors 'none'` fallback.
>
> 3. **Cookie bridging** — `aiq_embed_sess` (SameSite=None) and `aiq_sess` (SameSite=Lax) are distinct cookies. An `onRequest` hook in `apps/api/src/server.ts` copies the embed cookie value to the standard cookie name so all existing auth-chain middleware works unmodified on embed requests.

### Embed JWT — claim contract

All claims are required. The verifier rejects any token with a missing or wrong-type field before touching the DB. (`modules/01-auth/src/embed-jwt.ts:25-36,188-199`)

| Claim | Type | Constraint |
|---|---|---|
| `iss` | string | Host-app name; free-text label; not verified by AssessIQ |
| `aud` | `"assessiq"` | Hard literal; any other value → rejected immediately |
| `sub` | string | Host's internal user ID |
| `tenant_id` | UUID string | AssessIQ tenant UUID; used to look up the embed secret |
| `email` | string | Candidate email for JIT user lookup/create |
| `name` | string | Display name for JIT user create |
| `assessment_id` | UUID string | AssessIQ assessment UUID |
| `iat` | unix seconds | Must be ≤ now + 5 s (5-second clock-skew allowance) |
| `exp` | unix seconds | Must be > now; `exp − iat` must not exceed 600 s |
| `jti` | UUID string | Replay guard; cached in Redis for `exp − now` seconds |

### Embed secret rotation

`rotateEmbedSecret()` is a two-step atomic operation within a single `withTenant` transaction:

1. Mark the current `status='active'` row as `status='rotated'` (sets `rotated_at = now()`).
2. Insert a new `status='active'` row.

The verification path tries the active key first. On **signature mismatch only**, it falls back to the single most-recent rotated row (`ORDER BY rotated_at DESC LIMIT 1`). Any other failure (`alg` confusion, expired `exp`, wrong `aud`, malformed payload) does NOT trigger the fallback — it rejects immediately. No TTL is enforced on rotated rows in the DB; the 90-day rotation cadence is a convention, not a code constraint. (`modules/01-auth/src/embed-jwt.ts:244-265`, `modules/01-auth/migrations/014_embed_secrets.sql:7-10`)

### Embed JWT — request sequence

```
Host app backend           Browser (iframe)           AssessIQ /embed handler
──────────────────────────────────────────────────────────────────────────────
Build JWT:
  { tenant_id, email, name,
    assessment_id, sub,
    aud:'assessiq',
    exp:now+600, jti:uuid }
Sign HS256 + embed_secret
Set iframe src="…/embed?token=<JWT>"
                           Load iframe
                           GET /embed?token=<JWT>
                           ──────────────────────────────────────────────────▶
                                                  [1] Decode header; alg must be HS256
                                                  [2] Decode + validate all required claims
                                                  [3] Reject if exp-iat > 600s or iat > now+5s
                                                  [4] withTenant(tenant_id):
                                                        load active embed_secret
                                                        jwtVerify(HS256)
                                                        (sig fail only → try rotated once)
                                                  [5] Redis SET NX: aiq:embed:jti:<tid>:<jti>
                                                        → 401 if jti already used (replay)
                                                  [6] resolveJitUser: find or create candidate
                                                  [7] Build per-tenant frame-ancestors CSP
                                                  [8] mintEmbedSession → sessions row (type='embed')
                                                  [9] startAttempt(embedOrigin=true)
                                                  Set-Cookie: aiq_embed_sess
                                                    (SameSite=None; Secure; HttpOnly; Path=/)
                                                  302 → /take/a/<attemptId>?embed=true
                           ◀──────────────────────────────────────────────────
                           (subsequent calls: server bridges aiq_embed_sess → aiq_sess slot)
```

Consumer-facing integration guide: `docs/09-integration-guide.md`.

---

## Flow 4 — API key (back-end integration)

For host applications that don't iframe but call the REST API server-to-server.

```
Authorization: Bearer aiq_live_<32-char-random>
```

- Keys are tenant-scoped, with `scopes` array (e.g. `['attempts:read','results:read','assessments:write']`)
- Server stores `key_hash` (sha256); the full key shown to user only at creation
- Display prefix: first 8 chars (`aiq_live_abc12345…`) for identification in admin UI
- Rate limits: per-key (configurable, default 1000 req/hour) and per-tenant aggregate
- `last_used_at` updated async (don't block requests)
- Rotation: admin creates new key, has 30-day grace period to migrate, then revokes old

**Scope catalog (v1):**
- `assessments:read`, `assessments:write`
- `users:read`, `users:write`
- `attempts:read`, `attempts:write`
- `results:read`
- `webhooks:manage`
- `admin:*` (rare, for full automation)

---

## Flow 4b — Public credential verify (auth-bypass surface)

> **Status: LIVE 2026-05-11 (commit 7208008).** Phase 5 Session 3.

Recruiters and external verifiers check a certificate's authenticity at `GET /verify/:credentialId` — no account, session cookie, API key, or tenant context required.

### Why this is safe without authentication

The route accesses `certificates` via a **GUC-based RLS policy** (`public_verify_lookup`) rather than the standard `withTenant()` + `app.current_tenant` path. The policy covers SELECT only; UPDATE/INSERT/DELETE are never permitted through it. (`modules/18-certification/migrations/0074_public_verify_policy.sql`)

```sql
CREATE POLICY public_verify_lookup
  ON certificates FOR SELECT
  USING (current_setting('app.public_verify', true) = 'true');
```

`withPublicVerifyContext()` opens a transaction, sets the GUC transaction-local (`is_local=true`), runs the callback, and commits. The GUC reverts on COMMIT/ROLLBACK and cannot leak across pool connections. `credential_id` is globally unique across all tenants — no `tenant_id` predicate is needed or added. (`modules/18-certification/src/repository.ts:193-210`)

```
BEGIN
SET LOCAL ROLE assessiq_app                               -- re-engages RLS (dev safety)
SELECT set_config('app.public_verify', 'true', true)     -- transaction-local; auto-reverts
SELECT ... FROM certificates WHERE credential_id = $1    -- public_verify_lookup allows this
COMMIT                                                    -- GUC reverts here
```

### HMAC guard (app-layer)

Every render calls `verifyCertificateSignature()` using `crypto.timingSafeEqual`. Three outcomes, all HTTP 200 when the credential exists:

- **green badge** — HMAC valid, `revoked_at IS NULL`
- **red "Revoked" badge** — `revoked_at IS NOT NULL`; revocation reason is shown
- **red "Invalid Signature" badge** — HMAC mismatch (data tampered post-issuance)

404 is returned only when `credential_id` is unknown. A recruiter who sees "Revoked" knows the credential existed but was invalidated — they do not mistake it for a forgery. (`modules/18-certification/src/routes-public.ts:327-368`)

### Rate limiting and view dedup

- Per-IP: 60 req/hour, fixed-window, in-memory, 10 000-bucket cap. (`routes-public.ts:54-56`)
- Per-(IP, credentialId) view dedup: 1 h window, 50 000-entry cap. (`routes-public.ts:96-97`)
- `verification_views` counter: fire-and-forget via a **separate** `withTenant()` transaction; the main request path uses `withPublicVerifyContext` and never sets `app.current_tenant`. (`routes-public.ts:355-361`)

### Request sequence

```
Recruiter / LinkedIn crawler     apps/api (no authChain, no tenant middleware)
────────────────────────────────────────────────────────────────────────────────
GET /verify/<credential_id>
────────────────────────────────────────────────────────────────────────────────▶
                                 [1] CREDENTIAL_ID_REGEX validation → 404 HTML on fail
                                 [2] Per-IP rate limit → 429 JSON on exceed
                                 [3] withPublicVerifyContext():
                                       BEGIN
                                       SET LOCAL ROLE assessiq_app
                                       set_config('app.public_verify','true',true)
                                       SELECT by credential_id (no tenant_id predicate)
                                       COMMIT
                                 [4] null → 404 HTML
                                 [5] revoked_at IS NOT NULL → 200 HTML (red revoked badge)
                                 [6] verifyCertificateSignature (timingSafeEqual)
                                       mismatch → 200 HTML (red invalid badge)
                                       match   → 200 HTML (green verified badge)
                                 [fire-and-forget] withTenant(cert.tenant_id) → views++
◀────────────────────────────────────────────────────────────────────────────────
No session cookie set or consumed. No auth header. No app.current_tenant in main path.
```

Routes are registered by `registerVerifyRoutes(app)` at `apps/api/src/server.ts:239-241` with no `authChain` argument. The global `tenantContextMiddleware` auto-skips when `req.session?.tenantId` is `undefined` (`modules/02-tenancy/src/middleware.ts:84-86`).

Also ships: `GET /verify/:credentialId/og.svg` — 1200×630 SVG for LinkedIn link previews; `Cache-Control: public, max-age=3600`. Same RLS path, same HMAC check. (`routes-public.ts:374-424`)

---

## Flow 5 — Future auth methods (designed in)

Tenant admin opens *Settings → Authentication* and toggles:

| Method | Phase | Notes |
|---|---|---|
| Google SSO | 1 (default) | OIDC; domain restrict via `hd` param |
| TOTP MFA | 1 (default for admin) | RFC 6238; recovery codes; admin can require for candidates too |
| Magic link | 2 | Single-use email link, 72h TTL |
| Microsoft Entra ID | 2 | OIDC; for Wipro internal deployment |
| Generic OIDC | 2 | Bring-your-own provider config |
| SAML 2.0 | 3 | For enterprise clients with legacy IdPs |
| Password (email + pwd) | 3 | Argon2id, min 12 chars, breach-list check (HIBP API), only enabled if SSO not viable |
| Passkeys / WebAuthn | 4 | Replaces TOTP for users who opt in |

Each method is a Fastify plugin under `01-auth/providers/`. The `tenant_settings.auth_methods` JSONB tells the login page which buttons to show. Adding a new method is: add a provider plugin + add to the toggle UI + add to tenant settings JSON schema.

---

## Token & secret storage standards

| Secret | Storage | Reveal policy |
|---|---|---|
| Session cookie value | sha256 hashed in `sessions.token_hash` | Never revealed after issuance |
| TOTP secret | AES-256-GCM in `user_credentials.totp_secret_enc` | Never revealed after enrollment (QR shown once) |
| Recovery codes | argon2id hashed | Plaintext shown once at generation |
| API keys | sha256 hashed | Plaintext shown once at creation |
| Embed secrets | AES-256-GCM | Plaintext shown once at creation |
| Passwords (if used) | argon2id (m=64MB, t=3, p=4) | Never revealed |
| Webhook signing secrets | AES-256-GCM | Plaintext shown once |

Master encryption key: 32-byte random, in env var `ASSESSIQ_MASTER_KEY` (base64). For v1, plain env file with strict perms (0600, owned by service user). For v2, integrate Doppler / Vault.

## Security must-do checklist

- [ ] Verify every JWT signature (no `alg: none` ever)
- [ ] CSRF protection on state-changing routes (double-submit cookie)
- [ ] Rate limit `/api/auth/*` aggressively (10/min per IP)
- [x] **Admin/reviewer IP bypass on selected opt-in endpoints** (2026-05-04) — see § below
- [ ] Account lockout after 5 failed TOTP attempts in 15 min

## Admin/reviewer IP rate-limit bypass

> **Status: LIVE 2026-05-04** (see `modules/01-auth/src/middleware/rate-limit.ts` + `apps/api/src/middleware/auth-chain.ts`).

### What changed

The per-IP rate-limit bucket (`aiq:rl:auth:ip:<ip>`, 10/min) is bypassed for verified admin/reviewer sessions on explicitly opted-in endpoints. The per-user (60/min) and per-tenant (600/min) buckets still apply even when the IP bucket is skipped.

### Why

Admins and reviewers re-click "Sign in with Google" during testing and normal login work. The 10/min per-IP limit is designed to stop anonymous brute-force attackers, not verified staff. Before this change, an admin in an office NAT (shared IP) could exhaust the limit within seconds, causing 429 errors and disrupting their own workflow.

### Bypass conditions (all three must be true simultaneously)

1. **Session loaded:** the request carries a valid `aiq_sess` cookie that `sessionLoader` resolved to a live Redis session.
2. **Role is admin or reviewer:** `session.role IN ('admin', 'reviewer')` — explicit allowlist, NOT a denylist. Candidates are never bypassed.
3. **TOTP verified:** `session.totpVerified === true` (strict boolean equality — not truthy coercion). Pre-MFA sessions (`totpVerified=false`) are not bypassed.

If any condition is false, the standard 10/min/IP limit applies.

### Opt-in flag is code-only

The bypass is controlled by an `allowVerifiedAdminBypass: boolean` flag set **in the route definition** (in `authChain({ allowVerifiedAdminBypass: true })`). It is **never** read from `req.headers`, `req.query`, `req.body`, or `req.params`. A reviewer cannot smuggle a flag into the request to bypass the IP limiter.

### Opt-in whitelist (these three endpoints are opted in)

| Endpoint | Reason |
|---|---|
| `GET /api/auth/google/start` | Admin re-clicking SSO during testing/normal work |
| `POST /api/auth/logout` | Admin aborting a session (should never be throttled) |
| `GET /api/auth/whoami` | Admin SPA polls this frequently to check session state |

### Always-strict blacklist (these are NEVER opted in)

| Endpoint | Reason |
|---|---|
| `POST /api/auth/totp/verify` | TOTP brute-force class — must remain unconditionally strict |
| `POST /api/auth/totp/recovery` | Recovery-code brute-force class |
| `POST /api/auth/totp/enroll/confirm` | Enrollment confirm is also brute-forceable |
| `GET /api/auth/google/cb` | OAuth callback — no session exists yet at callback time |
| `POST /api/take/start` | Magic-link redemption — no session exists yet |

### Response headers when bypass fires

When the IP bucket is bypassed, the response includes:

```
X-RateLimit-Bypass: admin          (or "reviewer")
X-RateLimit-Limit-User: 60
X-RateLimit-Remaining-User: <n>
X-RateLimit-Limit-Tenant: 600
X-RateLimit-Remaining-Tenant: <n>
```

The standard `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers are NOT emitted when bypass fires (they would be misleading — the IP bucket was not checked). The user and tenant headers provide the effective quota the request was counted against.

### What was considered and rejected

- **Option 2 (inline Redis lookup inside rateLimit):** rateLimit reads the session cookie and does its own Redis lookup before the IP check. Rejected — more complex, duplicates session-loading logic, increases Redis calls vs. the simple chain reorder.
- **Bypass for candidate role:** rejected — candidates don't legitimately re-click `/api/auth/google/start`; adding bypass for them adds attack surface for no UX benefit.
- **Bypassing user + tenant buckets in addition to IP:** rejected — IP is the attacker-class bucket (anonymous brute force). User and tenant buckets protect against individual abuse and noisy-neighbor, which still apply to verified staff.
- **Per-environment bypass (e.g., production=strict, dev=permissive):** rejected as out of scope. A separate task can tune bucket sizes per NODE_ENV if needed.

### What is NOT included

- New bypass-eligible endpoints beyond the three listed above.
- Changing the per-user (60/min) or per-tenant (600/min) thresholds.
- A UI for admins to view their own rate-limit status.
- Audit log entry when bypass fires (bypass is a rate-limit decision, not an admin action; debug log is emitted instead with `rate_limit_bypass: true`).

### Downstream impact

- `apps/api/src/middleware/auth-chain.ts`: chain reorder + `allowVerifiedAdminBypass` option added to `AuthChainOpts`.
- `modules/01-auth/src/middleware/rate-limit.ts`: `allowVerifiedAdminBypass` option + `shouldBypassIpBucket()` helper + new response headers.
- `modules/01-auth/src/__tests__/middleware.test.ts`: 9 bypass test cases (B1–B9) added.
- `modules/01-auth/SKILL.md`: addendum decision #7 refinement sub-bullet.
- [ ] Log every authentication outcome to `audit_log`
- [ ] Periodic session sweeper (purge expired from Redis + Postgres)
- [ ] Force re-auth on email change, role change, password reset
- [ ] HSTS header at edge with preload-eligible config
- [ ] CSP header tight enough to prevent inline-script execution in admin UI

---

## Auth-bypass route inventory

The canonical trust-boundary table. Every route that runs without a `requireAuth` session gate is listed here with the alternative trust model that makes it safe. Security reviews start here.

(`apps/api/src/server.ts` — see registration order for context)

| Route(s) | Alternative auth model | Security rationale |
|---|---|---|
| `GET /health` | None | Liveness probe; no user data, no side effects |
| `GET /api/auth/google/start` | None (per-IP rate-limited) | Auth-establishing; no session exists yet |
| `GET /api/auth/google/cb` | OIDC `state` + `nonce` (PKCE-equivalent) | OAuth callback; state param is the CSRF guard |
| `POST /api/auth/totp/verify` | Pre-MFA session (`totp_verified=false`) | Completes the second factor; not auth-bypassing |
| `POST /api/auth/totp/recovery` | Pre-MFA session | Recovery-code path; same session gate as totp/verify |
| `POST /api/auth/logout` | Optional session | Idempotent; no-session logout is a safe no-op |
| `GET /api/auth/whoami` | Optional session | Returns 401 when no session; read-only |
| `/take/:token` | Magic-link token (sha256-hashed in DB) | Token IS the credential; session created after hash validation |
| `GET /embed?token=<JWT>` | Embed JWT (HS256, per-tenant secret) | JWT replaces session cookie in cross-origin iframe context |
| `GET /embed/sdk.js` | None | Static JS bundle; no user data |
| `GET /embed/health` | None | Liveness probe |
| `GET /verify/:credentialId` | GUC-based RLS (`public_verify_lookup`) | credential_id is globally unique; policy restricts visible rows to SELECT |
| `GET /verify/:credentialId/og.svg` | GUC-based RLS (`public_verify_lookup`) | Same scoping as verify page; SVG only |
| `GET /help/...` (public routes) | None | Public help content; no user data |
| `POST /help/track` | None | Anonymous help-view analytics |

> Routes using `publicChain: authChain({ requireSession: false })` (e.g. `/take/*`) still pass through the session-loader hook — a valid session is loaded if present, but its absence is not an error. This is auth-**optional**, not auth-bypassed.

> Routes in `/api/auth/*` are auth-**establishing** — they CREATE or complete sessions. They are listed here because they accept unauthenticated callers, not because they skip authorization logic.
