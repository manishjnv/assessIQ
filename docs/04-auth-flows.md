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

## Flow 1 — Admin login (Google SSO + TOTP)

> **Status (2026-05-01, Phase 0 closure — route layer + first API deploy live end-to-end):** library + DB layer + Fastify route layer + container deploy ALL LIVE on `origin/main`. Commits `d9cfeb4` (W4 library + migrations 010-015), `58eba33` (assessiq-api Dockerfile + auth route layer), `335d055` (dev-auth shim swap → real `@assessiq/auth` chain across `apps/api` and `apps/web`), `0789e4f` (Dockerfile build-strategy fix + `getTenantBySlug` system-role implementation). Routes serving Flow 1: `GET /api/auth/google/start?tenant=<slug>` (302 to Google, sets `aiq_oauth_state` + `aiq_oauth_nonce`), `GET /api/auth/google/cb` (mints pre-MFA `aiq_sess`, redirects to `/admin/mfa`), `POST /api/auth/totp/enroll/start` + `POST /api/auth/totp/enroll/confirm` (returns 10 plaintext recovery codes ONCE), `POST /api/auth/totp/verify` (promotes to `totp_verified`), `POST /api/auth/totp/recovery`, `POST /api/auth/logout`, `GET /api/auth/whoami`. Container live behind Caddy split-route on `https://assessiq.automateedge.cloud/api/*`; verified by direct curl on the deployed surface. **Drill B (curl `/api/auth/google/start` 302) is DEFERRED** — route + tenant resolution PASS but `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are empty in `/srv/assessiq/.env`, so the route returns 401 `"Google SSO is not configured"` cleanly (rate-limit headers populated, no leak, no stack trace). To clear: provision OAuth client in Google Cloud Console with redirect URI `https://assessiq.automateedge.cloud/api/auth/google/cb`, add credentials to `.env`, restart `assessiq-api`. **Drill 1 (full-stack browser SSO+MFA flow) is DEFERRED** — `assessiq-frontend` Dockerfile is a Phase 1+ deliverable, so the `/admin/login` HTML route currently serves the Caddy default placeholder, not the SPA. The dev-auth `FIXME(post-01-auth)` markers are now ZERO across the repo (`apps/api/src/middleware/dev-auth.ts` deleted; `apps/web` SPA edits in commit `335d055`).

The strict path. Every admin must clear both factors.

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

**Security middleware order (Fastify):**
1. `requestId` (correlation)
2. `rateLimit` (per IP, tighter on `/api/auth/*`)
3. `cookieParser`
4. `sessionLoader` (sets `req.session` from Redis)
5. `tenantContext` (sets `app.current_tenant` for the DB connection)
6. `requireAuth(roles, mfaRequired=true)` — applied per route

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

AssessIQ /embed handler:
1. Decode JWT header → reject if alg != 'HS256'
2. Look up tenant by 'tenant_id' claim
3. Fetch tenant's embed_secrets (try active, then rotated within grace period)
4. Verify signature
5. Validate claims: aud='assessiq', exp>now, iat<=now, jti not in replay cache (Redis SET with TTL=exp)
6. Resolve user:
   - find users by (tenant_id, email)
   - if not found AND tenant_settings.allow_jit_user=true: create user with role='candidate'
   - else 403
7. Mint AssessIQ session bound to user, totp_verified=true (host vouched), set Cookie
8. Render SPA in embed mode (?embed=true)
```

**Host-host trust boundary:** AssessIQ trusts whatever the JWT says about identity. If the host signs a token claiming to be `ceo@wipro.com`, AssessIQ believes them. This is the correct model — but means embed secrets are valuable. Rotate every 90 days; revoke immediately on suspected compromise.

**postMessage protocol** (for iframe ↔ parent communication):
- AssessIQ → host: `{ type: 'aiq.attempt.started', attemptId }`, `{ type: 'aiq.attempt.submitted', attemptId, summary }`, `{ type: 'aiq.height', px }` (auto-resize)
- Host → AssessIQ: `{ type: 'aiq.theme', tokens: {...} }` (runtime theming), `{ type: 'aiq.locale', locale: 'en-IN' }`
- Origin pinned via tenant.embed_origins allowlist

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
- [ ] Account lockout after 5 failed TOTP attempts in 15 min
- [ ] Log every authentication outcome to `audit_log`
- [ ] Periodic session sweeper (purge expired from Redis + Postgres)
- [ ] Force re-auth on email change, role change, password reset
- [ ] HSTS header at edge with preload-eligible config
- [ ] CSP header tight enough to prevent inline-script execution in admin UI
