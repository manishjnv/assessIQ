# 01-auth — Identity, sessions, MFA, embed JWT, API keys

> See `docs/04-auth-flows.md` for full sequence diagrams. This skill is the implementation orientation for that doc.

## Purpose
Authenticate every request: humans via Google SSO + TOTP, host applications via embed JWT, server-to-server via API keys.

## Scope
- **In:** OIDC client for Google (extensible to Microsoft/Okta/generic), TOTP enroll + verify + recovery codes, magic-link issuance + redemption, session creation/destruction, embed JWT verification, API key validation, rate limiting on auth routes, account lockout.
- **Out:** user CRUD (lives in 03-users), tenant settings UI (10-admin-dashboard), audit writes (delegated to 14-audit-log via emitted events).

## Dependencies
- `00-core` — config, errors, context, IDs
- `02-tenancy` — to resolve `tenant_id` and read `tenant_settings.auth_methods`
- `03-users` — to find/create user records on SSO callback
- `13-notifications` — to send magic-link emails
- `14-audit-log` — to emit `auth.*` events

## Public surface
Fastify plugins registered as:
```ts
fastify.register(authPlugin, { prefix: "/api/auth" });
fastify.register(embedAuthPlugin, { prefix: "/embed" });
fastify.register(magicLinkPlugin, { prefix: "/take" });

// Decorators available on every request after sessionLoader
req.session?: { id, userId, tenantId, totpVerified, expiresAt }
req.requireAuth(roles?: Role[], opts?: { freshMfa?: boolean })
req.apiKey?: { id, tenantId, scopes }
```

## Data model touchpoints
Owns: `sessions`, `oauth_identities`, `user_credentials`, `totp_recovery_codes`, `api_keys`, `embed_secrets`, `user_invitations` (auth-related portion).

Reads: `users` (existence check), `tenants`, `tenant_settings`.

## Key flows (recap)
- **Admin login:** `/api/auth/google/start` → Google → `/api/auth/google/cb` → pre-MFA session → `/admin/mfa` → `/api/auth/totp/verify` → fully-authenticated session
- **TOTP enroll:** server generates secret + QR; user confirms; recovery codes shown once
- **Embed:** `/embed?token=<JWT>` → verify HS256 with tenant secret → mint session → SPA in embed mode
- **API key:** `Authorization: Bearer aiq_live_*` → sha256 lookup → tenant context set

## Help/tooltip surface
- `admin.auth.totp.enroll` — explains TOTP enrollment, app recommendations, recovery codes
- `admin.auth.recovery.use` — when/how to use a recovery code
- `admin.settings.auth-methods.totp_required` — toggle implications
- `admin.settings.embed-secrets.rotate` — rotation grace period explained
- `admin.api-keys.scopes` — scope catalog with examples
- `candidate.auth.magic-link` — what to do if magic link expired

## Status

**Implemented — 2026-05-01 (Phase 0 G0.C-4 / Window 4 + Phase 0 closure).** Workspace package `@assessiq/auth` live on `origin/main` at commit `d9cfeb4`. Fastify HTTP route layer wrapping the library shipped in commits `58eba33` (route layer + assessiq-api Dockerfile) + `335d055` (dev-auth shim swap to real `@assessiq/auth` chain across `apps/api` + `apps/web`) + `0789e4f` (deploy-day Dockerfile fix + `getTenantBySlug` system-role implementation). Container `assessiq-api` live on `assessiq-vps` behind Caddy split-route `/api/* /embed*` → host 9092. Live drill verification: `/embed` HS256 + replay defense PASSED on production; `/api/auth/google/start` route + tenant resolution PASSED with the curl 302 drill DEFERRED on missing Google OAuth credentials in `/srv/assessiq/.env`.

- **Migrations applied to `assessiq-postgres` on the VPS** (via `psql -f`, additive against the W2 + W5 baseline): `010_oauth_identities.sql`, `011_sessions.sql`, `012_totp.sql` (`user_credentials`), `013_recovery_codes.sql`, `014_embed_secrets.sql`, `015_api_keys.sql`. RLS-policy linter passes (11 migrations / 9 tenant-bearing tables matched). Live RLS isolation drill confirmed (Phase E step 2): `assessiq_app` role with `app.current_tenant` set sees only tenant-scoped rows; cross-tenant SELECT returns zero.
- **Public surface (per `index.ts`):** `sessions.{create,get,refresh,markTotpVerified,destroy,destroyAllForUser}`, `totp.{enrollStart,enrollConfirm,verify,consumeRecovery,regenerateRecoveryCodes}`, `apiKeys.{create,revoke,list,authenticate,requireScope}`, `mintEmbedToken/verifyEmbedToken/createEmbedSecret/rotateEmbedSecret`, `startGoogleSso/handleGoogleCallback/normalizeEmail`, `mintCandidateSession`, full middleware barrel (`requestId/rateLimit/cookieParser/sessionLoader/apiKeyAuth/requireAuth/requireRole/requireFreshMfa/requireScope/extendOnPass`), and test escape hatches `setRedisForTesting/closeRedis` (mirror of `02-tenancy.setPoolForTesting`). All match the addendum-pinned contract above.
- **Tests:** 99/100 vitest cases pass against `postgres:16-alpine` + `redis:7-alpine` testcontainers. The 1 known flake is the constant-time microbenchmark (5ms threshold; ~22ms observed under noisy local Docker — RCA log has the full analysis: real invariant is `crypto.timingSafeEqual`, not wallclock variance; CI runs cleaner).
- **Cross-module integration verified.** 03-users `acceptInvitation` swapped from its mock seam to the real `@assessiq/auth.sessions` import in commit `be96623`. Carry-forwards from the 03-users addendum (§ 7 SADD per-user index in `sessions.create`, § 10 `normalizeEmail` in Google SSO callback) are present in code at `sessions.ts:133-134` and `google-sso.ts:331`.
- **Adversarial review verdict — accepted (opus-direct, codex:rescue takeover for W4; opus-direct fallback for the route layer because codex:rescue hit a usage limit during Phase 0 closure).** Phase-1 follow-ups now tracked across W4 + closure:
  1. ~~`requireAuth({ roles })` silently waved API keys through~~ — **patched in W4** (`require-auth.ts:66-77` now throws `AuthzError` on role/freshMfa gates with API-key-backed requests).
  2. `api-keys.ts` fire-and-forget `last_used_at` UPDATE silently no-ops under RLS without tenant context — wrap in `withTenant` or system role.
  3. `totp.ts` `recordFailure` post-crash TTL drift — INCR may run without subsequent EXPIRE, persisting `FAIL_KEY` indefinitely on restart.
  4. **Closure follow-up — `mapLockout` regex `/locked/` brittle string-match.** The route layer at `apps/api/src/routes/auth/totp.ts` maps `AuthnError("account locked")` → 423 ACCOUNT_LOCKED via `/locked/` regex. Tests pin the literal but a library `error.code === 'TOTP_LOCKED'` sentinel field would be cleaner. Requires touching the @assessiq/auth error class shape.
  5. **Closure follow-up — route-layer `extractClientIp` consolidation.** Route handlers extract `ip` for audit via `cf-connecting-ip ?? req.ip` instead of using the library's `extractClientIp` helper. Same posture but inconsistent surface.
  6. ~~**Closure follow-up — `GET /api/admin/embed-secrets` deferred.**~~ — **resolved 2026-05-01.** `listEmbedSecrets({tenantId}) → EmbedSecretRecord[]` shipped in `embed-jwt.ts` (envelope NEVER decrypted; SELECT excludes `secret_enc`); exported from `index.ts` (value + `EmbedSecretRecord` type); GET endpoint wired in `apps/api/src/routes/auth/embed-secrets.ts` mirroring the api-keys list pattern (`authChain({ roles: ['admin'] })`, no fresh-MFA — read-only metadata). Two new integration tests in `embed-jwt.test.ts` cover order/status/no-secret_enc-leak and RLS isolation.
  7. ~~**Closure follow-up — migration `0002_rls_helpers.sql` missing `GRANT assessiq_system TO assessiq_app`.**~~ — **resolved 2026-05-01.** GRANT appended at end of `modules/02-tenancy/migrations/0002_rls_helpers.sql` so fresh-VPS bootstrap reproduces the production grant set. `GRANT … TO ROLE` is idempotent in PG; safe re-apply on prod. NOINHERIT on `assessiq_app` keeps the elevation explicit (must `SET ROLE assessiq_system` to use BYPASSRLS). RCA prevention #1 closed.


- Passkeys (WebAuthn) priority vs SAML — decide after first 3 enterprise inquiries
- Whether to enforce TOTP for *all* admin sessions or just elevated actions (currently: all admin sessions, step-up for sensitive actions)

---

## Decisions captured (2026-05-01)

This addendum pre-flights Window 4 (G0.C Session 4) by freezing every implementation ambiguity surfaced in the Phase 0 plan plus the deep-read of `docs/04-auth-flows.md`, `docs/03-api-contract.md`, and `docs/02-data-model.md`. Each entry: **Decision · Source · Rationale**. Source shorthand: `PLAN` = `docs/plans/PHASE_0_KICKOFF.md`, `04-AUTH` = `docs/04-auth-flows.md`, `02-DATA` = `docs/02-data-model.md`, `03-API` = `docs/03-api-contract.md`.

### 1. Redis session schema

**Decision.** Redis key `aiq:sess:<sha256(token)>` (sha256 of the cookie value, hex-encoded). Value is a JSON document with this exact shape (lowerCamelCase, ISO-8601 timestamps):

```json
{
  "id": "<session uuid v7>",
  "userId": "<user uuid v7>",
  "tenantId": "<tenant uuid v7>",
  "role": "admin | reviewer | candidate",
  "totpVerified": false,
  "createdAt": "<ISO 8601 UTC>",
  "expiresAt": "<ISO 8601 UTC>",
  "lastSeenAt": "<ISO 8601 UTC>",
  "lastTotpAt": null,
  "ip": "<inet>",
  "ua": "<user-agent>"
}
```

Postgres mirror (`sessions` table, `02-DATA:145–157`) holds the same fields in snake_case; Redis is the fast-path read, Postgres is the durable record. Both are written transactionally on session create; expiry sweeper (Phase 3) keeps them in sync.

**Sliding-refresh trigger.** Every authenticated request that *passes* `requireAuth` extends `expiresAt` by 8h and updates `lastSeenAt`. Health checks, `/api/auth/whoami` pre-MFA, and unauthenticated public endpoints do **not** refresh. Idle eviction at 30 min: if `now - lastSeenAt > 30 min`, sessionLoader treats the session as expired even when `expiresAt > now`.

**Source.** `PLAN` decision #5; `04-AUTH:84–89` (cookie spec, 8h sliding, 30min idle); `04-AUTH:91–97` (middleware order — sessionLoader runs before tenantContext).

**Rationale.** lowerCamelCase + ISO timestamps mean the JSON parses directly into the TypeScript `Session` type with no field-name mapping layer. Idle-eviction-distinct-from-hard-expiry is the standard banking-app pattern: protects against an attacker who steals a cookie when the legitimate user has been idle but hasn't yet hit hard expiry. Refreshing only on `requireAuth` (not health checks) prevents an attacker's curl-keepalive from extending the lifetime indefinitely without ever touching business endpoints — which would also generate audit signal.

### 2. Recovery codes

**Decision.** 8-character Crockford base32 codes (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — excludes `I`, `L`, `O`, `U`); 10 codes per user; argon2id with `m=65536, t=3, p=4`. Storage: **one row per code** in `totp_recovery_codes` (`02-DATA:125–131`) with `code_hash TEXT NOT NULL` holding the argon2id digest and `used_at TIMESTAMPTZ NULL` marking consumption. Single-use enforced via atomic `UPDATE totp_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`. Regenerate flow: admin endpoint deletes all rows for the user and inserts 10 new — the plaintext set is shown **once** in the response and never returned again.

**Source.** `PLAN` decision #3; `04-AUTH:116–119`; `02-DATA:125–131`.

**Rationale.** One-row-per-code beats a JSON column because (a) the `(user_id, used_at IS NULL)` partial index makes "live codes for user X" a fast lookup; (b) DELETE-and-INSERT regenerate semantics map cleanly to the user-visible "your old codes no longer work" guarantee; (c) consume-via-`UPDATE … RETURNING` is atomic at row level, no need for a separate transaction. Crockford base32 excluding I/L/O/U eliminates the print-and-photograph readability traps users hit with O/0 and I/1/L. Argon2id parameters track OWASP's 2024 minimum recommendation for password-equivalent secrets.

### 3. TOTP

**Decision.**
- **Secret length: 20 bytes (160 bits).** **Overrides** `PLAN` decision #3 which said "32-byte" without justification. RFC 4226 §4 recommends 160 bits; Google Authenticator, Authy, 1Password, Microsoft Authenticator all default to SHA-1 with 20-byte secrets. The plan's 32-byte number conflicts with `04-AUTH:102` ("Server generates random 20-byte secret") — `04-AUTH` is correct and authoritative.
- **Algorithm:** HMAC-SHA1, period 30s, 6 digits.
- **Issuer string:** literal `"AssessIQ"` in the otpauth URI: `otpauth://totp/AssessIQ:<email>?secret=<base32>&issuer=AssessIQ&period=30&digits=6&algorithm=SHA1`.
- **Drift window:** ±1 step (one 30s window before/after current step) on verify. If verification fails inside drift, the user's backup channel is the recovery code via `POST /api/auth/totp/recovery` (`03-API:25`).
- **Storage:** AES-256-GCM with `ASSESSIQ_MASTER_KEY` envelope; `user_credentials.totp_secret_enc` (`BYTEA`).
- **Comparison:** `crypto.timingSafeEqual(Buffer, Buffer)` only — never `===` or string-compare.

**Source.** RFC 4226 §4 (160-bit secret recommendation); RFC 6238 §3 (drift); `04-AUTH:102–104`; `02-DATA:116–123`.

**Rationale.** SHA-1 + 20 bytes is the format every consumer authenticator app speaks fluently; SHA-256 + 32 bytes works in theory but causes "code never matches" enrollment failures with apps that ignore the `algorithm` parameter or default to SHA-1. The cost of the larger secret is nil since rate-limit + lockout already cap the brute-force horizon. Drift ±1 covers normal phone-clock skew without expanding the attacker's window meaningfully (3 × 10^6 codes per attempt window is still well above the lockout threshold).

### 4. Account lockout

**Decision.**
- **Trigger:** 5 failed TOTP verify attempts within 15 min per `userId`.
- **Counter key:** `aiq:auth:totpfail:<userId>` — integer, `INCR` + `EXPIRE NX 900`. On reaching 5, set `aiq:auth:lockedout:<userId>` = `1` with `TTL 900`.
- **Block check:** sessionLoader and `/api/auth/totp/verify` short-circuit with `423 Locked` if `aiq:auth:lockedout:<userId>` exists. The cheap `EXISTS` check happens **before** argon2 / TOTP compute — fail-fast under attack.
- **Auto-unlock:** TTL expiry — no admin action required.
- **Manual unlock:** existing endpoint `POST /api/admin/users/:id/totp/reset` (`03-API:49`) deletes both Redis keys atomically as a side-effect, in addition to its existing TOTP re-enrollment behavior.
- **Audit rows:** `auth.lockout.triggered` (`actor_kind=system`, `entity_id=user.id`, payload `{attemptCount: 5}`); `auth.lockout.cleared` with `payload.via ∈ {"auto","admin"}`. Audit writes are emitted via 14-audit-log events (currently a stub; lands in Phase 3).

**Source.** `04-AUTH:286` (5 fails / 15 min); `03-API:49` (admin reset endpoint already exists).

**Rationale.** Two-key design (counter + lockedout flag) lets the verify path do one cheap `EXISTS` on the lockout key before computing argon2 — fail-fast under credential-stuffing. TTL-based auto-unlock keeps the dataset bounded under attack. Side-effecting the existing reset endpoint avoids inventing a second endpoint just for unlock.

### 5. Embed JWT

**Decision.**
- **Algorithm whitelist: `["HS256"]`. Hard.** Always call `jwt.verify(token, secret, { algorithms: ["HS256"] })` — never `jwt.verify(token, secret)` without the option. Reject `alg: none`, `alg: HS384`, `alg: HS512`, `alg: RS256`, every other value. Algorithm-confusion is *the* canonical embed-JWT vuln (`04-AUTH:201`).
- **Replay cache:** Redis `SET aiq:embed:jti:<jti> 1 EX <floor(exp - now)> NX`. NX returns nil → reject as replay. TTL exactly equals `exp - now` so the cache evicts the moment the token would have expired anyway.
- **Required claims** (reject if any missing): `iss` (host app name, free-text), `aud` (must equal `"assessiq"`), `sub` (host's user ID, free-text), `tenant_id` (UUID), `email`, `name`, `assessment_id` (UUID), `iat`, `exp`, `jti` (UUID). `exp - iat <= 600s` enforced (10-minute max lifetime per `04-AUTH:192`).
- **Tenant secret resolution:** look up active `embed_secrets.secret_enc WHERE tenant_id = <claim> AND status = 'active'`, decrypt via `ASSESSIQ_MASTER_KEY`. During 90-day rotation grace, try active first; if signature fails, try the most-recent rotated secret (status = `'rotated'`). **Never try more than two keys** (avoid a verification oracle).

**Source.** `04-AUTH:181–211`; `04-AUTH:274–275` (embed_secrets storage).

**Rationale.** Hard-coding `["HS256"]` (not "any HS variant") is the only correct posture — `alg: HS512` against an HS256 secret is rare but viable. Two-key rotation grace beats N-key because each additional accepted key is a free brute-force surface. JTI replay cache TTL = `exp - now` ensures the cache is bounded by the same horizon as the token itself.

### 6. API key

**Decision.**
- **Format:** `aiq_live_<base62>` where the random portion is `crypto.randomBytes(32)` re-encoded as base62 (`[0-9A-Za-z]`) → 43-character random string. Total displayed length: `9 + 43 = 52` chars. `aiq_test_<...>` is reserved for future test-mode (not in Phase 0).
- **Storage:** `key_prefix` = first 12 chars (`aiq_live_xyz`), `key_hash` = `sha256(full_key).hex`, `UNIQUE (key_hash)`.
- **Lookup:** middleware reads `Authorization: Bearer <key>`, computes sha256, queries `api_keys WHERE key_hash = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())`. Updates `last_used_at` async (fire-and-forget pg query, never blocks the request).
- **Rotation:** admin creates a new key; both old and new are `active` during a configurable grace period (default 30 days); admin revokes old via `DELETE /admin/api-keys/:id` (`03-API:108`).
- **Scope enforcement:** `requireScope(scope: string)` Fastify preHandler reads `req.apiKey.scopes` and throws `AuthzError` if `scope` is not in the array. The literal `"admin:*"` matches every scope.

**Source.** `04-AUTH:222–245`; `02-DATA:159–171`.

**Rationale.** Base62 over hex/base32 keeps the key copy-pasteable everywhere (no `=` padding, no special chars, fits in URL params if absolutely necessary). 32 bytes of entropy = 256 bits, well above any brute-force horizon. The 12-char prefix is enough to identify a key in admin UI without leaking entropy. Async `last_used_at` write avoids serializing every API call on a synchronous DB UPDATE — the eventual-consistency window is acceptable for an audit field.

### 7. Rate limits

**Decision.**
- **Topology:** three independent token-bucket counters per request, all checked in parallel; request rejected if **any** limit is exceeded:
  - `aiq:rl:auth:ip:<ip>` — 10 tokens / 60s, applies to `/api/auth/*` only.
  - `aiq:rl:user:<userId>` — 60 tokens / 60s, applies to all authenticated routes.
  - `aiq:rl:tenant:<tenantId>` — 600 tokens / 60s, applies to all authenticated routes.
- **Algorithm:** sliding-window token bucket via Redis Lua script (atomic): `EVAL "<lua>" 1 <key> <max-tokens> <window-seconds> <now-ms>`. Lua returns `{remaining, retryAfterMs}`. Reject when `remaining < 0` after decrement.
- **IP source:** `req.headers['cf-connecting-ip']` — Caddy already populates this from Cloudflare's trusted_proxies (per `PLAN` deploy-reality block + `docs/06-deployment.md`). **Never** raw `X-Forwarded-For` (spoofable upstream of Cloudflare) and **never** `req.ip` (would be the Caddy bridge gateway IP, lumping the entire internet into one bucket).
- **Response headers** (set on every auth route, success or fail):
  - `X-RateLimit-Limit: <max-tokens>`
  - `X-RateLimit-Remaining: <remaining>`
  - `Retry-After: <ceil(retryAfterMs / 1000)>` (only on `429`).
- **HTTP status on reject:** `429 Too Many Requests` with body `{"error":{"code":"rate_limit","message":"...","details":{"retryAfterMs":...,"scope":"ip|user|tenant"}}}`.

**Source.** `PLAN` decision #6 (limits + Caddy IP-source caveat); `04-AUTH:285`.

**Rationale.** Lua atomicity matters because the read-modify-write sequence happens outside a single Redis command otherwise — race conditions during a flood let the limit be exceeded by ~N concurrent connections. Three independent counters (IP for unauth-burst, user for individual abuse, tenant for noisy-neighbor) each catch a different attack class and combine without scope-creep. CF-Connecting-IP is the only correct source on this VPS topology because Caddy terminates Cloudflare's L7 hop; the raw client IP is never available to AssessIQ.

### 8. Magic link

**Decision.**
- **Token generation:** `crypto.randomBytes(32).toString('base64url')` → 43-character URL-safe string.
- **Storage:** `user_invitations.token_hash = sha256(token).hex`. Plaintext token is never persisted.
- **TTL:** 72 hours from creation (`expires_at = now() + interval '72 hours'`). Configurable per-tenant in Phase 2; hardcoded for Phase 0.
- **Single-use semantics:** the token is **link-bound**, not session-bound. The candidate may re-click the link as many times as needed *until* the underlying attempt's `status` moves past `in_progress` (i.e. submit). After that, `GET /take/<token>` returns `410 already_submitted` with a hint to contact the admin.
- **Candidate session shape:** session is minted via `01-auth.sessions.create()` with `totpVerified=true`, `role='candidate'` (candidates do not enroll TOTP in Phase 0; the magic link itself is the auth factor). Cookie name is `aiq_sess` — same cookie as admin, role-discriminated server-side.

**Source.** `04-AUTH:144–166`.

**Rationale.** Re-click-until-submitted is the correct UX for candidates whose browsers crash mid-attempt — the alternative (single-redemption) traps users behind admin re-issue and ruins the candidate experience. The hard cutoff is "attempt past `in_progress`" because that's the moment grading kicks off; replay after grading would re-fire grading jobs against an immutable submission. `totpVerified=true` for the candidate session is a flag-state convenience (so `requireAuth` doesn't bounce), not a security claim — `requireAuth(roles=['admin'])` blocks candidates regardless of TOTP state.

### 9. Tenant-context handoff (01-auth → 02-tenancy)

**Decision.** `01-auth.sessionLoader` Fastify preHandler decorates the request with this exact shape, declared in `01-auth/src/types.d.ts`:

```ts
declare module 'fastify' {
  interface FastifyRequest {
    session?: {
      id: string;          // session uuid v7
      userId: string;      // user uuid v7
      tenantId: string;    // tenant uuid v7  ← consumed by 02-tenancy.tenantContextMiddleware
      role: 'admin' | 'reviewer' | 'candidate';
      totpVerified: boolean;
      expiresAt: string;   // ISO 8601 UTC
      lastTotpAt: string | null;
    };
    apiKey?: {
      id: string;
      tenantId: string;
      scopes: string[];
    };
  }
}
```

The contract field name is `tenantId` (lowerCamelCase). `02-tenancy.tenantContextMiddleware` reads `req.session?.tenantId ?? req.apiKey?.tenantId`. **01-auth does not call into 02-tenancy and 02-tenancy does not call into 01-auth** — they communicate exclusively through the request-decoration field names. This keeps the dependency graph DAG-shaped (both depend on 00-core only).

For development-only tenant override (when 01-auth is not yet wired in a test scaffold), 02-tenancy's middleware accepts `x-aiq-test-tenant` header **only when `NODE_ENV !== 'production'`**, per `modules/02-tenancy/SKILL.md` § Status. Production NODE_ENV guard is enforced.

**Source.** `04-AUTH:91–97` (middleware order); `modules/02-tenancy/SKILL.md` Status section.

**Rationale.** A single shared field name beats decorator coupling — if either module changes its representation, the type-check fails at every call site, not silently. No cross-module imports between 01 and 02 keeps the dependency graph a strict DAG.

### 10. Cross-module boundary with 03-users

**Decision.** `03-users.acceptInvitation(token)` is the only Phase-0 cross-module write coupling. **03-users orchestrates; 01-auth provides the `sessions.create` primitive.** Implementation contract:

```ts
// modules/03-users/src/invitations.ts
import { sessions } from '@assessiq/auth';   // 01-auth public surface

export async function acceptInvitation(token: string): Promise<{ user: User; sessionToken: string }> {
  // 1. Validate token: sha256 lookup in user_invitations, status='pending', expires_at > now()
  // 2. UPDATE user_invitations SET accepted_at = now(), status = 'accepted'
  // 3. UPDATE users SET status = 'active' WHERE id = invitation.user_id
  // 4. Mint session via 01-auth — there is NO higher-level helper:
  const { token: sessionToken } = await sessions.create({
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role,
    totpVerified: false,    // admin must still enroll TOTP on first login
    ip: getRequestContext().ip,
    ua: getRequestContext().ua,
  });
  return { user, sessionToken };
}
```

The `01-auth` public export `sessions.create` has this exact signature:

```ts
export const sessions = {
  create(input: {
    userId: string;
    tenantId: string;
    role: 'admin' | 'reviewer' | 'candidate';
    totpVerified: boolean;
    ip: string;
    ua: string;
  }): Promise<{ id: string; token: string; expiresAt: string }>;
  // ...other methods (destroy, refresh, get) sketched in src/sessions.ts
};
```

**No `01-auth.acceptInvitation()` helper.** The orchestrator is 03-users.

**Source.** `modules/03-users/SKILL.md:32` (`acceptInvitation(token): Promise<{ user, sessionToken }>`); `PLAN` G0.C-5 line 283 (`acceptInvitation` integrates with 01-auth).

**Rationale.** 03-users-orchestrates means 03-users owns the user-status transition (which is its domain) and consumes 01-auth as a single-purpose primitive provider. The alternative (01-auth.acceptInvitation) would force 01-auth to depend on 03-users for the user-status update, which inverts the dependency graph (01 should not depend on 03; both depend on 00).

### Schema deviations from `02-DATA` requested in same PR

Three auth-owned tables in `02-DATA:105–131` lack a direct `tenant_id` column and rely on transitive isolation via `users.tenant_id`. CLAUDE.md hard rule #4 ("Add a domain table without `tenant_id` and an RLS policy → bounce") and the `tools/lint-rls-policies.ts` linter both favor a direct, denormalized `tenant_id`. This PR adds `tenant_id UUID NOT NULL REFERENCES tenants(id)` to:

- `oauth_identities`
- `user_credentials`
- `totp_recovery_codes`

…and adds the standard two-policy template (`tenant_isolation` + `tenant_isolation_insert`) to each. `oauth_identities.UNIQUE (provider, subject)` remains globally unique — a single Google account maps to one user in one tenant only, by product decision (cross-tenant contractors need separate Google accounts). Window 4 implements this in migrations `010_oauth_identities.sql` / `012_totp.sql` / `013_recovery_codes.sql`. See `modules/01-auth/migrations/README.md` for sketches.

**Considered and rejected.** RLS-via-JOIN-subquery (`USING (user_id IN (SELECT id FROM users WHERE tenant_id = current_setting(...)::uuid))`). Rejected because (a) the linter does not catch the missing direct policy; (b) every read pays a subquery cost; (c) the JOIN form silently breaks if the `users.tenant_id` ever changes (foreign-key-on-update-cascade not enabled on the existing schema).

**Not included.** `sessions` already has `tenant_id` (`02-DATA:148`). `embed_secrets` and `api_keys` already have `tenant_id` (`02-DATA:175, 161`). No edits there.

**Downstream impact.** None on application code (RLS is transparent to the ORM/repository layer). `tools/lint-rls-policies.ts` will validate the new policies in CI. Window 4's migrations are the only production touchpoint.
