# Phase 0 — Closure Plan

> **Generated:** 2026-05-01 by Opus 4.7 via `claude-mem:make-plan`.
> **Parent:** `docs/plans/PHASE_0_KICKOFF.md` § Final phase (steps 1, 3, 4, 5 partial — closes the verification drills the kickoff plan deferred).
> **Predecessor commits on `origin/main`:** `d9cfeb4` (W4 — `@assessiq/auth` library + DB), `be96623` (W5 mock-seam swap → real `@assessiq/auth.sessions`), `32e5e85` (handoff docs). Working tree clean at plan-write time.
> **What this plan does:** stands up the API container + Fastify auth route layer that wraps the W4 library, swaps out the dev-auth shim across the apps/api + apps/web surface, deploys the API to the shared VPS additively, and runs the four live drills SESSION_STATE deferred (full-stack browser, alg=none, replay, plus Google SSO start curl).
> **What this plan does NOT do:** rewrite `tools/migrate.ts` (separate session per Open Question carryover); patch the api-keys `last_used_at` RLS no-op or TOTP `recordFailure` TTL drift (Phase-1 follow-ups #2 and #3 from W4 handoff — deferred unless one blocks a drill); ship the `assessiq-frontend` Dockerfile (out of scope per user pin); ship `assessiq-worker` or `assessiq-redis` Dockerfiles (out of scope per user pin — Redis runs from the upstream `redis:7-alpine` image directly via compose, no custom Dockerfile needed; worker is a Phase-1+ deliverable when BullMQ work appears).

---

## Phase 0 — Documentation Discovery (consolidated)

This section consolidates the facts subsequent phases must honor. Every entry cites a specific source; no API or path is invented. Subsequent phases reference back to this section by anchor name.

### Frozen contracts (must-not-renegotiate)

The route layer (Section 2) WRAPS the public surface — never renegotiates it. Source pins:

| # | Pin | Source |
|---|---|---|
| §1 | Cookie name `aiq_sess`, `httpOnly; Secure; SameSite=Lax; Path=/`, 8h sliding TTL, 30min idle eviction | `modules/01-auth/SKILL.md` § Decisions captured §1; [`docs/04-auth-flows.md:84-90`](../04-auth-flows.md#L84-L90) |
| §2 | Recovery codes: 8-char Crockford base32, 10 codes/user, argon2id `m=65536,t=3,p=4`, single-use via atomic `UPDATE … RETURNING` | `modules/01-auth/SKILL.md` § Decisions captured §2 |
| §3 | TOTP: 20-byte SHA-1 secret, period 30s, 6 digits, drift ±1, issuer literal `"AssessIQ"`, AES-256-GCM envelope, `crypto.timingSafeEqual` only, `keyDecoder` round-trip per RCA | `modules/01-auth/SKILL.md` § Decisions captured §3; [`docs/RCA_LOG.md` 2026-05-01 TOTP HMAC](../RCA_LOG.md) |
| §4 | Account lockout: 5 fails / 15min via `aiq:auth:totpfail:<userId>` + `aiq:auth:lockedout:<userId>`; `EXISTS` cheap check before argon2; `423 Locked` short-circuit | `modules/01-auth/SKILL.md` § Decisions captured §4 |
| §5 | Embed JWT: `algorithms:["HS256"]` HARD; required claims `iss/aud/sub/tenant_id/email/name/assessment_id/iat/exp/jti`; `aud === "assessiq"`; `exp - iat ≤ 600s`; replay cache `SET aiq:embed:jti:<jti> 1 EX <floor(exp - now)> NX`; two-key rotation grace (active + most-recent rotated only) | `modules/01-auth/SKILL.md` § Decisions captured §5; [`docs/04-auth-flows.md:181-216`](../04-auth-flows.md#L181-L216) |
| §6 | API key: `aiq_live_<43-char-base62>`; sha256 storage; `key_prefix` = first 12 chars; `Authorization: Bearer` lookup; system-role `last_used_at` UPDATE (Phase-1 follow-up #2 — out of scope this plan) | `modules/01-auth/SKILL.md` § Decisions captured §6 |
| §7 | Rate limits: three independent token-bucket counters in parallel — `aiq:rl:auth:ip:<ip>` 10/60s on `/api/auth/*`, `aiq:rl:user:<userId>` 60/60s, `aiq:rl:tenant:<tenantId>` 600/60s; **CF-Connecting-IP fail-closed in production** (NEVER raw `X-Forwarded-For`, NEVER `req.ip`) | `modules/01-auth/SKILL.md` § Decisions captured §7 |
| §8 | Magic link: `crypto.randomBytes(32).toString('base64url')`; sha256 storage; 72h TTL; link-bound (re-click until `attempt.status` past `in_progress`); candidate session minted with `totpVerified=true`, `role='candidate'` | `modules/01-auth/SKILL.md` § Decisions captured §8 |
| §9 | Middleware order: `requestId → rateLimit → cookieParser → sessionLoader → apiKeyAuth → tenantContext → requireAuth*`; `extendOnPass` runs last on session-backed pass | [`modules/01-auth/src/middleware/index.ts:1-13`](../../modules/01-auth/src/middleware/index.ts#L1-L13); `modules/01-auth/SKILL.md` § Decisions captured §9 |
| §10 | `acceptInvitation` is orchestrated by `03-users` — NO `01-auth.acceptInvitation()` helper. 03-users imports `sessions.create` from `@assessiq/auth` | `modules/01-auth/SKILL.md` § Decisions captured §10; [`modules/03-users/src/invitations.ts`](../../modules/03-users/src/invitations.ts) |

### Allowed APIs (cite-only)

The library public surface this plan binds against. Verified by direct read of [`modules/01-auth/src/index.ts:1-56`](../../modules/01-auth/src/index.ts#L1-L56) and [`modules/01-auth/src/middleware/index.ts:1-27`](../../modules/01-auth/src/middleware/index.ts#L1-L27):

```ts
// from @assessiq/auth
sessions.{create, get, refresh, markTotpVerified, destroy, destroyAllForUser}
totp.{enrollStart, enrollConfirm, verify, consumeRecovery, regenerateRecoveryCodes}
apiKeys.{create, list, revoke, authenticate, requireScope}
mintEmbedToken / verifyEmbedToken / createEmbedSecret / rotateEmbedSecret
startGoogleSso / handleGoogleCallback / normalizeEmail
mintCandidateSession

// middleware
requestIdMiddleware, cookieParserMiddleware, parseCookieHeader,
rateLimitMiddleware, extractClientIp,
sessionLoaderMiddleware, apiKeyAuthMiddleware,
requireAuth, requireRole, requireFreshMfa, requireScope,
extendOnPassMiddleware

// types
AuthRequest, AuthReply, AuthHook
Session, CreateSessionInput, CreateSessionOutput, Role
EnrollStartOutput, ApiKeyRecord, ApiKeyScope,
EmbedTokenPayload, VerifiedEmbedToken,
OidcStartOutput, OidcCallbackOutput, CookieOpts
```

Endpoint contracts come from [`docs/03-api-contract.md`](../03-api-contract.md) § Auth and [`docs/04-auth-flows.md`](../04-auth-flows.md) Flows 1, 1a, 1b, 3, 4. Error codes come from `docs/03-api-contract.md` § Error contracts.

### Anti-patterns to refuse

Sourced from `docs/RCA_LOG.md` and the addendum:

- **`jwt.verify(token, secret)` without `algorithms:["HS256"]`** — addendum §5; canonical embed-JWT vuln. The library's `verifyEmbedToken` already enforces this; route handlers MUST pass through to the library and never re-implement.
- **TOTP comparison via `===` or string-compare** — addendum §3; `crypto.timingSafeEqual` only.
- **HMAC the base32 string directly** — `docs/RCA_LOG.md` 2026-05-01 TOTP. Always route through `keyDecoder(secretBase32, opts.encoding)` first.
- **Logging session tokens / JWTs / recovery codes / API keys** — only sha256 prefixes (first 8 chars) for tracing.
- **Skipping rate-limit middleware in dev "for convenience"** — addendum §7.
- **`SameSite=None` on `aiq_sess`** — `Lax` per addendum §1.
- **Reading raw `X-Forwarded-For` for client IP** — addendum §7; `extractClientIp` from the library is the only correct source on the Caddy + Cloudflare topology.
- **Caddyfile mutation via `mv`** — `docs/RCA_LOG.md` 2026-04-30 502 incident. Bind-mount inode preservation requires `cat new > Caddyfile` (truncate-write).
- **Cloudflare Origin Cert paste without `sed` cleanup** — `docs/RCA_LOG.md` 2026-04-30 paste artifact. Not in scope this plan (no cert rotation), but any unplanned cert touch must `sed -i 's/\r$//; s/^[[:space:]]*//'` before `openssl` verify.
- **`if (domain === "soc")`** — `CLAUDE.md` rule #4. Not directly relevant here, but Phase-3 critique still bounces.
- **Importing `@anthropic-ai/claude-agent-sdk` outside `modules/07-ai-grading/runtimes/anthropic-api.ts`** — `CLAUDE.md` AssessIQ-specific rule #2. Phase 0 is grading-free.

### Pattern files to copy from

These are the EXISTING templates the new code mirrors. Section 2 frames the auth routes as COPY-from these patterns, not invent-from-spec:

- [`apps/api/src/routes/admin-users.ts:1-139`](../../apps/api/src/routes/admin-users.ts#L1-L139) — Fastify route plugin with `preHandler` array, `req.session!.tenantId` extraction, AppError throws, conditional spread for `exactOptionalPropertyTypes`. Pattern for the admin-facing auth routes (api-keys, embed-secrets).
- [`apps/api/src/routes/invitations.ts:1-109`](../../apps/api/src/routes/invitations.ts#L1-L109) — schema-validated POST with JSON Schema body, `config: { skipAuth: true }` for the pre-auth route, `reply.setCookie` for `aiq_sess`. Pattern for `/api/auth/google/cb`, `/api/auth/totp/verify`, `/api/invitations/accept`-style cookie-mint endpoints.
- [`apps/api/src/server.ts:1-135`](../../apps/api/src/server.ts#L1-L135) — Fastify bootstrap with `@assessiq/core` ALS, `tenantContextMiddleware` skip-on-no-session, `setErrorHandler` mapping `AppError` + Fastify validation, `request.log` mixin. Pattern for the new middleware registration order in §9.
- [`modules/03-users/src/invitations.ts`](../../modules/03-users/src/invitations.ts) — orchestrator pattern for `sessions.create` consumption (Section 2's `/api/auth/google/cb` mints sessions the same way).
- [`apps/api/src/routes/health.ts:1-6`](../../apps/api/src/routes/health.ts#L1-L6) — `config: { skipAuth: true }` minimal-route pattern. Pattern for `/api/auth/google/start` (pre-auth) and `/embed` (pre-auth, special — no `/api` prefix).

### Discovery artefacts that DEVIATE from inputs (must reconcile in plan)

Three reconciliations the user prompt did not pre-flag — surfaced here so subsequent sections can encode them:

1. **Dockerfile path mismatch.** User prompt says `infra/docker/assessiq-api/Dockerfile`. Compose at [`infra/docker-compose.yml:69`](../../infra/docker-compose.yml#L69) declares `dockerfile: ./infra/docker/api.Dockerfile`. Section 1 picks the user's namespaced-subdir path (`infra/docker/assessiq-api/Dockerfile`) — clearer convention now that frontend + worker Dockerfiles will eventually exist as siblings — and updates the compose `dockerfile:` line accordingly. Same edit semantically; clearer file tree.
2. **No build step in apps/api.** [`apps/api/package.json:7-12`](../../apps/api/package.json#L7-L12) has no `build` script; `start` is `tsx src/server.ts`. Compose healthcheck assumes `node dist/server.js` — `wget … /api/health` doesn't actually invoke it, but the worker command on line 96 is hardcoded to `node dist/worker.js`. Section 1 picks **tsx in production runtime** (smallest blast radius — no new build pipeline, no `tsc` config drift, no `dist/` artifact to lint) and notes the worker-command mismatch as out-of-scope for this plan (worker Dockerfile is out anyway; the line stays a Phase-1+ TODO).
3. **Additional dev-auth.ts consumers.** Section 3 of the original TOC listed 6 web sites + dev-auth.ts file deletion. Discovery found that [`apps/api/src/routes/admin-users.ts:11`](../../apps/api/src/routes/admin-users.ts#L11) and [`apps/api/src/routes/invitations.ts:4`](../../apps/api/src/routes/invitations.ts#L4) also import `requireRole` from `../middleware/dev-auth.js`. The dev-auth file deletion breaks both unless rewired to import from `@assessiq/auth` first. Section 3 expanded to enumerate these.
4. **`apps/web/src/lib/session.ts` shim.** Discovery found [`apps/web/src/pages/admin/login.tsx:21-26`](../../apps/web/src/pages/admin/login.tsx#L21-L26), [`mfa.tsx:35`](../../apps/web/src/pages/admin/mfa.tsx#L35), [`invite-accept.tsx:40-45`](../../apps/web/src/pages/invite-accept.tsx#L40-L45) all call `saveSession(...)` from `'../../lib/session'` and [`api.ts:32`](../../apps/web/src/lib/api.ts#L32) reads `aiq:dev-auth` from `sessionStorage`. The session shim itself (file `apps/web/src/lib/session.ts`) is a load-bearing peer of dev-auth.ts on the frontend. Section 3 adds it to the swap-site list with Phase 5 acceptance test "browser DevTools shows no `aiq:dev-auth` key in sessionStorage after `/admin/login` → MFA → /admin/users round-trip."

---

## Section 1 — API Dockerfile

> **Routing:** Opus self-execute. Small file (~30-50 lines), security-adjacent (build provenance), all references already in hot read cache. Sonnet cold-start would be slower than direct write.
> **Phase 3 Opus diff review:** mandatory (load-bearing `infra/**` per `CLAUDE.md`).
> **codex:rescue gate:** not required for this section in isolation (no auth code; build-config only). Bundles into the Section 4 deploy commit's codex:rescue pass since the deploy is the security-adjacent action.

### What changes

- **Create** `infra/docker/assessiq-api/Dockerfile` — multi-stage:
  - Stage 1 `deps`: `node:22-alpine` base, install pnpm via `corepack enable`, COPY `package.json`, `pnpm-lock.yaml`, all `apps/api/`, `modules/00-core/`, `modules/01-auth/`, `modules/02-tenancy/`, `modules/03-users/`, `modules/13-notifications/` `package.json` files (pnpm workspace metadata), then `pnpm install --frozen-lockfile --filter @assessiq/api... --filter @assessiq/api^...` (transitive workspace dependencies only — drops `apps/web`, `apps/storybook`, AccessIQ_UI_Template).
  - Stage 2 `runtime`: `node:22-alpine`, COPY `--from=deps` the resolved `node_modules/` + workspace source, set `WORKDIR /app/apps/api`, expose 3000, healthcheck via `wget --spider http://127.0.0.1:3000/api/health`, `CMD ["pnpm", "exec", "tsx", "src/server.ts"]` (matches `apps/api/package.json` `start` script).
  - Non-root user: `USER node` after the COPY.
  - `ENV NODE_ENV=production` set in runtime stage.
  - **No build step** — runtime executes TypeScript via tsx (per Discovery reconciliation #2). `tsx` is already in `apps/api` devDependencies; the runtime install includes it.
- **Create** `.dockerignore` at repo root (verify absence first via `Glob`) — exclude `node_modules`, `.git`, `dist`, `coverage`, `.turbo`, `.env*`, `apps/storybook`, `apps/web/dist`, `modules/17-ui-system/AccessIQ_UI_Template`, `**/__tests__`, `**/*.test.ts`. Reduces build context by ~80%.
- **Edit** `infra/docker-compose.yml:69` — change `dockerfile: ./infra/docker/api.Dockerfile` to `dockerfile: ./infra/docker/assessiq-api/Dockerfile` (Discovery reconciliation #1). No other compose edits.

### Why

- Closes Open Question #1 from W4 SESSION_STATE handoff: container-side deploy of `assessiq-api` blocked on missing Dockerfile.
- First-time API deploy in Section 4 builds against this Dockerfile; closure drills in Section 5 require a running API container.
- Multi-stage with workspace-aware install keeps the runtime image small (~150 MB target vs ~400 MB if full repo + dev deps shipped).

### Documentation references

- [`docs/06-deployment.md` § docker-compose.yml](../06-deployment.md#L168-L278) — compose service definition that consumes the Dockerfile.
- [`apps/api/package.json:7-12`](../../apps/api/package.json#L7-L12) — `start` script and dependency list.
- [`package.json:6-10`](../../package.json#L6-L10) — Node 22 + pnpm 9.15 engine constraints.

### Acceptance test

- `docker build -f infra/docker/assessiq-api/Dockerfile -t assessiq-api:phase-0-closure .` succeeds locally on Windows + Docker Desktop.
- `docker run --rm -e DATABASE_URL=postgres://x:x@localhost/x -e REDIS_URL=redis://localhost:6379 -e ASSESSIQ_MASTER_KEY=$(openssl rand -base64 32) -e SESSION_SECRET=$(openssl rand -base64 32) -p 3000:3000 assessiq-api:phase-0-closure` boots and responds `200 {"status":"ok"}` on `curl http://localhost:3000/api/health` within 10s. (Will Zod-error on Postgres reach but `/api/health` has `skipAuth: true` and no DB query — should succeed.)
- `docker compose -f infra/docker-compose.yml config` validates without error after the dockerfile path change.
- Image size `< 200 MB` (`docker images assessiq-api:phase-0-closure`).
- `pnpm-lock.yaml` integrity preserved — running `pnpm install` against the same lockfile inside the build matches the lockfile hash.

### Anti-pattern guards

- Don't run `pnpm install` (without `--frozen-lockfile`) — silently bumps versions.
- Don't `COPY . .` from repo root — lets `apps/web/dist` and `AccessIQ_UI_Template/` into the image; `.dockerignore` is the gate.
- Don't `apk add` build tools (gcc, make) for argon2 — `argon2` ships prebuilt binaries for `node:22-alpine`. If install fails complaining about node-gyp, that's the symptom of using `node:22-slim` (Debian glibc) vs `node:22-alpine` (musl) — match the runtime image arch.
- Don't bake `.env` or secrets into the image — env comes from `docker compose --env-file ../.env` at run time.
- Don't `RUN pnpm typecheck` in the build — typecheck is CI's job, not the build's; failures should fail CI not the deploy.

### Rollback note

Image is purely additive — `docker rm assessiq-api && docker rmi assessiq-api:phase-0-closure` leaves no residue on the VPS. Compose dockerfile path edit is a one-line revert. `.dockerignore` removal is harmless (worst case: bigger build context).

### DoD (per `CLAUDE.md` rule #9)

1. **Commit** `feat(infra): assessiq-api Dockerfile + multi-stage pnpm workspace build`. Noreply env-var pattern (per global `CLAUDE.md` § Git push).
2. **Deploy** — defer to Section 4. This commit ships the Dockerfile but no container build/run.
3. **Document** — append to [`docs/06-deployment.md`](../06-deployment.md) § docker-compose.yml a build-context table entry for `assessiq-api` (image tag policy, NODE_ENV default, healthcheck behavior). Cross-reference the Dockerfile path so future readers find it.
4. **Handoff** — SESSION_STATE entry references this commit + the Section 4 deploy commit it enables.

---

## Section 2 — API server + auth routes

> **Routing:** Opus self-execute scaffolding (12 endpoints, each a thin wrapper + Zod schema; addendum-pinned contract; hot read cache from Phase 0). **Optional Sonnet sub-agent in parallel** for test sketches if user wants TDD-shaped acceptance — fire one sub-agent per route file with the contract excerpt + `apps/api/src/routes/admin-users.ts` pattern to copy from, expect 6 small test files back.
> **Phase 3 Opus diff review:** mandatory (load-bearing `modules/01-auth/**` consumer; addendum-pinned contract).
> **codex:rescue gate:** mandatory before push (security/auth diff per global `CLAUDE.md` and AssessIQ project overlay; user explicitly confirmed NOT opus-takeover for this session).

### What changes

#### 2a. Server middleware chain rewire — [`apps/api/src/server.ts`](../../apps/api/src/server.ts)

Current state (verified in Discovery):
- Lines 36-45: ALS context onRequest hook ✅ (keep)
- Line 49: `app.addHook('preHandler', devAuthHook)` — REMOVE
- Lines 54-66: `tenantContextMiddleware` preHandler/onResponse ✅ (keep — runs after sessionLoader populates `req.session?.tenantId`)
- Lines 68-101: `setErrorHandler` ✅ (keep)
- Lines 105-118: `request.log` mixin onResponse ✅ (keep)
- Lines 120-123: route registrations ✅ (keep, append `registerAuthRoutes`)

Edits:

1. **Replace** `import { devAuthHook } from './middleware/dev-auth.js';` with imports from `@assessiq/auth`:
   ```ts
   import {
     requestIdMiddleware,
     cookieParserMiddleware,
     rateLimitMiddleware,
     sessionLoaderMiddleware,
     apiKeyAuthMiddleware,
     extendOnPassMiddleware,
   } from '@assessiq/auth';
   ```
   Note: `@fastify/cookie` registration on line 27 stays — the library's `cookieParserMiddleware` reads `req.cookies` populated by `@fastify/cookie`. (Verify: read [`modules/01-auth/src/middleware/cookie-parser.ts`](../../modules/01-auth/src/middleware/cookie-parser.ts) before commit — if it parses raw `Cookie` header itself rather than reading `req.cookies`, the `@fastify/cookie` registration becomes redundant; keep both during the transition since redundant parse is idempotent.)
2. **Add `@assessiq/auth: workspace:*`** to [`apps/api/package.json:13-20`](../../apps/api/package.json#L13-L20) dependencies. (Mirrors how `@assessiq/users`, `@assessiq/notifications` are already listed.)
3. **Replace** the dev-auth `preHandler` registration (line 49) with the addendum §9 chain, ordered:
   ```ts
   app.addHook('preHandler', requestIdMiddleware);     // §9.1 (idempotent if Fastify genReqId set above)
   app.addHook('preHandler', rateLimitMiddleware);     // §9.2 (skipAuth-aware via routeOptions config)
   app.addHook('preHandler', cookieParserMiddleware);  // §9.3 (or rely on @fastify/cookie — pick one in implementation)
   app.addHook('preHandler', sessionLoaderMiddleware); // §9.4 (sets req.session if cookie present)
   app.addHook('preHandler', apiKeyAuthMiddleware);    // §9.5 (sets req.apiKey if Bearer present and no session)
   // tenantContextMiddleware stays at lines 54-66 — runs after sessionLoader/apiKeyAuth populate tenantId
   app.addHook('onResponse', extendOnPassMiddleware);  // §9.7 (sliding-refresh; runs onResponse not preHandler)
   ```
4. **Sync `req.assessiqCtx`** after sessionLoader runs so logging mixin sees `tenantId`/`userId`:
   ```ts
   app.addHook('preHandler', async (req) => {
     if (req.session) {
       req.assessiqCtx.tenantId = req.session.tenantId;
       req.assessiqCtx.userId = req.session.userId;
     } else if (req.apiKey) {
       req.assessiqCtx.tenantId = req.apiKey.tenantId;
     }
   });
   ```
5. **Append** `await registerAuthRoutes(app);` after line 123 (auth routes register after admin/invitations so the dev path "open API in dev tools, hit /api/auth/google/start" works alongside existing endpoints). Order doesn't strictly matter — Fastify's prefix-routing handles collision safely.

#### 2b. Type augmentation — [`apps/api/src/types.d.ts`](../../apps/api/src/types.d.ts)

Replace lines 13-19 (existing thin `req.session` shape) with an import-and-re-export from `@assessiq/auth`:

```ts
import 'fastify';
import type { PoolClient } from 'pg';
import type { Session } from '@assessiq/auth';
import type { ApiKeyRecord } from '@assessiq/auth';

declare module 'fastify' {
  interface FastifyRequest {
    assessiqCtx: {
      requestId: string;
      tenantId?: string;
      userId?: string;
      ip?: string;
      ua?: string;
    };
    session?: Pick<Session, 'id' | 'userId' | 'tenantId' | 'role' | 'totpVerified' | 'expiresAt' | 'lastTotpAt'>;
    apiKey?: Pick<ApiKeyRecord, 'id' | 'tenantId' | 'scopes'>;
    tenant?: { id: string };
    db?: PoolClient;
  }
}
```

The `Pick<>` narrows to the fields addendum §9 pins as the cross-module contract; if `@assessiq/auth`'s `Session` type has additional fields (e.g. `ip`, `ua`, `createdAt`, `lastSeenAt`), they're library-internal and not part of the route-layer surface.

#### 2c. Route plugin scaffold — `apps/api/src/routes/auth/index.ts`

```ts
import type { FastifyInstance } from 'fastify';
import { registerGoogleSsoRoutes } from './google.js';
import { registerTotpRoutes } from './totp.js';
import { registerEmbedRoutes } from './embed.js';
import { registerApiKeysRoutes } from './api-keys.js';
import { registerEmbedSecretsRoutes } from './embed-secrets.js';
import { registerWhoamiRoutes } from './whoami.js';
import { registerLogoutRoutes } from './logout.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  await registerGoogleSsoRoutes(app);
  await registerTotpRoutes(app);
  await registerEmbedRoutes(app);          // /embed (no /api prefix — special)
  await registerApiKeysRoutes(app);        // /api/admin/api-keys
  await registerEmbedSecretsRoutes(app);   // /api/admin/embed-secrets
  await registerWhoamiRoutes(app);         // /api/auth/whoami
  await registerLogoutRoutes(app);         // /api/auth/logout
}
```

#### 2d. Endpoint enumeration

Six route files. Each row: HTTP verb + path + library binding + auth requirement + response shape + error catalog. **All routes match `docs/03-api-contract.md` paths verbatim** unless flagged "deviation."

##### `apps/api/src/routes/auth/google.ts`

| Verb | Path | Library binding | Auth | Notes |
|---|---|---|---|---|
| `GET` | `/api/auth/google/start` | `startGoogleSso({tenantSlug, returnTo})` | `skipAuth: true` | Returns 302 to `accounts.google.com/o/oauth2/v2/auth`; sets `aiq_state` + `aiq_nonce` cookies (5min TTL) for CSRF binding. Library returns `OidcStartOutput { redirectUrl, stateCookie, nonceCookie }` — handler pipes into `reply.setCookie` + `reply.redirect`. |
| `GET` | `/api/auth/google/cb?code=&state=` | `handleGoogleCallback({code, state, stateCookie, nonceCookie})` | `skipAuth: true` | Library verifies RS256 JWKS, validates state+nonce via `constantTimeEqual`, normalizes email, JIT-links via `oauth_identities`, mints pre-MFA session via `sessions.create({totpVerified: false})`. Handler `setCookie(SESSION_COOKIE_NAME, result.sessionToken, {httpOnly,secure,sameSite:'lax',path:'/',maxAge:8*3600})` + `reply.redirect('/admin/mfa')`. Errors map: `INVALID_STATE` → 400, `EMAIL_NOT_PROVISIONED` → 403, `USER_DELETED` → 403, `JWKS_VERIFY_FAILED` → 401. |

##### `apps/api/src/routes/auth/totp.ts`

| Verb | Path | Library binding | Auth | Notes |
|---|---|---|---|---|
| `POST` | `/api/auth/totp/enroll/start` | `totp.enrollStart({userId})` | session required, `totpVerified: false` allowed (this IS the enroll path) | Returns `{otpauthUri, qrPngBase64?}`. Handler: `req.session!.userId`. Body empty. Response shape per `EnrollStartOutput`. |
| `POST` | `/api/auth/totp/enroll/confirm` | `totp.enrollConfirm({userId, code})` | session required, `totpVerified: false` | Body `{code: string (6 digits)}`. On success returns `{recoveryCodes: string[]}` (10 plaintext codes, shown ONCE). Handler: after success, `sessions.markTotpVerified(req.session!.id)` + extend cookie TTL. Errors: `INVALID_CODE` → 401, `ALREADY_ENROLLED` → 409. |
| `POST` | `/api/auth/totp/verify` | `totp.verify({userId, code})` | session required (any `totpVerified` state — verifies pre-MFA session OR step-up MFA per Flow 1b) | Body `{code: string}`. On success: `sessions.markTotpVerified(req.session!.id)`, return 204. Errors: `INVALID_CODE` → 401, `RATE_LIMITED` → 423 with `Retry-After` per addendum §4 (lockout). |
| `POST` | `/api/auth/totp/recovery` | `totp.consumeRecovery({userId, code})` | session required, `totpVerified: false` | Body `{code: string (8 chars Crockford b32)}`. Success same as `/verify`; consumed code marked `used_at`. |

##### `apps/api/src/routes/auth/embed.ts`

| Verb | Path | Library binding | Auth | Notes |
|---|---|---|---|---|
| `GET` | `/embed?token=<JWT>` | `verifyEmbedToken(token)` | `skipAuth: true` (this IS the auth — token is the credential) | Library validates HS256, claims, replay cache. On success, library returns `VerifiedEmbedToken { tenantId, userId, assessmentId, claims }` and the handler MAY mint an embed session via `sessions.create({totpVerified: true, role: 'candidate'})` then `reply.redirect(`/embed-app?assessment=${assessmentId}`)`. **Phase 0 minimum:** redirect to a frontend-served `/embed-app` route that the SPA renders in embed mode (apps/web/src/pages/embed.tsx — out of scope this plan unless the frontend already has such a page; if not, the route returns `200 {accepted: true, assessmentId, sessionMinted: true}` JSON until the embed SPA ships in Phase 4). Errors: `INVALID_TOKEN` (alg≠HS256, sig fail, claim missing) → 401; `JTI_REPLAY` → 401; `TENANT_NOT_FOUND` → 401 (don't leak whether tenant exists). |

**Deviation note:** `docs/03-api-contract.md:165` lists `/embed?token=<JWT>` (no `/api` prefix). This is intentional — the embed surface is a public landing for iframes, not the JSON API. Section 4's Caddyfile MUST split `/embed*` into the API container path the same way `/api/*` does, OR `/embed` lives on the frontend container which proxies to `/api/embed/verify` internally. **Pick the simpler option:** Caddyfile `handle /embed* { reverse_proxy 172.17.0.1:9092 }` alongside `handle /api/* { reverse_proxy 172.17.0.1:9092 }`. Section 4 to encode.

##### `apps/api/src/routes/auth/api-keys.ts`

| Verb | Path | Library binding | Auth | Notes |
|---|---|---|---|---|
| `GET` | `/api/admin/api-keys` | `apiKeys.list({tenantId})` | `requireAuth({roles: ['admin']})` | Returns `{items: ApiKeyRecord[]}` — no plaintext key, only `id`, `keyPrefix`, `name`, `scopes`, `status`, `createdAt`, `lastUsedAt`. |
| `POST` | `/api/admin/api-keys` | `apiKeys.create({tenantId, name, scopes})` | `requireAuth({roles: ['admin'], freshMfa: true})` | Body validated against scope catalog (addendum §6 + 04-auth-flows.md:240). Returns plaintext `aiq_live_<43-char-base62>` ONCE. Errors: `INVALID_SCOPE` → 400. |
| `DELETE` | `/api/admin/api-keys/:id` | `apiKeys.revoke({tenantId, keyId})` | `requireAuth({roles: ['admin'], freshMfa: true})` | Returns 204. |

##### `apps/api/src/routes/auth/embed-secrets.ts`

| Verb | Path | Library binding | Auth | Notes |
|---|---|---|---|---|
| `GET` | `/api/admin/embed-secrets` | **MISSING in library — see Open Question** | `requireAuth({roles: ['admin']})` | `modules/01-auth/src/index.ts` exports `createEmbedSecret`, `rotateEmbedSecret` but NO `listEmbedSecrets`. Either (a) add the helper to the library in this commit (Phase 3 Opus review applies) or (b) defer the GET endpoint to a follow-on. Recommend (a) — single-query helper, ~10 LOC. |
| `POST` | `/api/admin/embed-secrets` | `createEmbedSecret({tenantId, name})` | `requireAuth({roles: ['admin'], freshMfa: true})` | Body `{name: string}`. Returns `{id, name, secret: string}` — plaintext shown ONCE. |
| `POST` | `/api/admin/embed-secrets/:id/rotate` | `rotateEmbedSecret({tenantId, secretId})` | `requireAuth({roles: ['admin'], freshMfa: true})` | Returns `{id, name, secret: string}`. Two-key rotation grace per addendum §5. |

##### `apps/api/src/routes/auth/whoami.ts`

| Verb | Path | Library binding | Auth | Notes |
|---|---|---|---|---|
| `GET` | `/api/auth/whoami` | (no library call — returns from req.session + a `getUser` lookup via `@assessiq/users`) | `requireAuth()` (any role) | Response shape per `docs/03-api-contract.md:27`: `{user: {id, email, name, role}, tenant: {id, slug}, mfaStatus: 'verified' \| 'pending'}`. Use `req.session.totpVerified` for `mfaStatus`. |

##### `apps/api/src/routes/auth/logout.ts`

| Verb | Path | Library binding | Auth | Notes |
|---|---|---|---|---|
| `POST` | `/api/auth/logout` | `sessions.destroy({sessionId: req.session!.id})` | `requireAuth()` (any role) | Clears Redis + Postgres mirror. `reply.clearCookie(SESSION_COOKIE_NAME, {path:'/'})`. Returns 204. |

#### 2e. Tests — `apps/api/src/__tests__/routes/auth/`

Mirror the existing [`apps/api/src/__tests__/server.test.ts`](../../apps/api/src/__tests__/server.test.ts) pattern (Fastify `inject`, supertest-style assertions). One test file per route file. Critical cases (each is a hard requirement, not a "nice to have"):

- **alg=none rejection** (`embed.test.ts`) — craft `eyJhbGciOiJub25lIn0.<payload>.` and `inject({method:'GET', url:'/embed?token=...'})` → expect 401, `error.code === 'INVALID_TOKEN'`. **Inline test, not deferred to Section 5 Drill C.**
- **Replay cache rejection** (`embed.test.ts`) — `mintEmbedToken` valid, inject once → 200, inject again with same token → 401, `error.code === 'JTI_REPLAY'`.
- **Middleware order assertion** (`server.test.ts` extension) — register a probe `preHandler` that records hook firing order; assert order matches addendum §9.
- **Rate-limit fail-closed** (`google.test.ts`) — set `NODE_ENV=production` env, inject without `cf-connecting-ip` header, expect 503 (rate-limit middleware should fail-closed when it can't extract IP per addendum §7).
- **TOTP timing-safe** (`totp.test.ts`) — already covered in `modules/01-auth/src/__tests__/totp.test.ts` at the library level; route layer test asserts the route doesn't introduce new timing leakage (inject 100 valid + 100 invalid codes, assert wall-clock variance ≤ 5ms threshold; same calibration as the library test per RCA).
- **Cookie sets `aiq_sess`** (`google.test.ts` callback test) — mock the Google JWKS fetch + token exchange, inject the callback path with synthetic `code`/`state`, assert `Set-Cookie: aiq_sess=...; HttpOnly; Secure; SameSite=Lax; Path=/`.
- **`requireRole(['admin'])` blocks reviewer** (`api-keys.test.ts`) — inject `POST /api/admin/api-keys` with reviewer-role session → 403, `error.code === 'AUTHZ_FAILED'`.
- **`freshMfa` re-challenge** (`api-keys.test.ts`) — inject with admin session where `lastTotpAt` is 16min old → 403, `error.code === 'MFA_REQUIRED'`. (Addendum §4 step-up MFA.)

### Why

- Closes Open Question #2 from W4 SESSION_STATE handoff (route layer wrapping `@assessiq/auth`).
- Inline alg=none + replay tests mean Section 5's Drill C and Drill D have a green-from-CI baseline — the live drill becomes "did the deployment break what CI proved?" rather than first-time validation.

### Documentation references

- Phase 0 § Frozen contracts (above) for the addendum pins.
- Phase 0 § Allowed APIs (above) for the library surface.
- Phase 0 § Pattern files to copy from (above) for the route-plugin shape.
- [`docs/04-auth-flows.md`](../04-auth-flows.md) Flow 1, 1a, 1b, 3, 4 — sequence diagrams.
- [`docs/03-api-contract.md`](../03-api-contract.md) § Auth, § Embed, § Admin api-keys, § Admin embed-secrets — endpoint shapes + error catalog.

### Acceptance test

- `pnpm --filter @assessiq/api typecheck` clean.
- `pnpm --filter @assessiq/api test` green for all auth route handlers (each test in §2e green).
- `pnpm --filter @assessiq/api test` includes the alg=none + replay tests; both green inline.
- Workspace-wide `pnpm -r typecheck` clean (regression check on cross-module types).
- Workspace-wide `pnpm test` green (regression check on tenancy + users + auth library tests).
- Secrets scan + RLS lint + ambient-AI grep clean (Phase 2 deterministic gates per global `CLAUDE.md` Phase 2).
- Phase 3 Opus diff review: numbered revision list ≤ 0 must-fix-before-push items (looped Phase 4 if any) — same procedure as W4.
- **codex:rescue verdict:** accepted, or revised + must-fix patched in same commit.

### Anti-pattern guards

- See Phase 0 § Anti-patterns to refuse (above) — every item applies.
- Don't re-implement `requireRole` / `requireFreshMfa` in the route file — import from `@assessiq/auth.requireAuth({roles, freshMfa})`.
- Don't pass `secretBase32` directly to TOTP comparison — the library handles `keyDecoder` round-trip; route just calls `totp.verify(...)`.
- Don't add `addHook('preHandler', ...)` registrations after `registerAuthRoutes` — Fastify hooks added after route registration apply only to subsequent routes; addendum §9 chain MUST run before any auth route fires.

### Rollback note

Route plugin is purely additive: `registerAuthRoutes` registration is one line in `server.ts`; revert that line + delete `apps/api/src/routes/auth/` and the API returns to W5 state. The middleware chain replacement is the riskier revert — keeps a `dev-auth-fallback` branch in working tree during the deploy window means rollback is `git revert <SHA>` cleanly.

### DoD

1. **Commit** `feat(api): auth route layer wrapping @assessiq/auth`. Noreply env-var pattern.
2. **Deploy** — defer to Section 4. This commit ships the route layer; deploy is Section 4.
3. **Document** — flip [`docs/03-api-contract.md`](../03-api-contract.md) § Auth status from "Window 5 / W4 library shipped, route layer pending" → "live end-to-end including route layer" with the live SHA. Same for [`docs/04-auth-flows.md`](../04-auth-flows.md) Flow 1 status. Update [`modules/01-auth/SKILL.md`](../../modules/01-auth/SKILL.md) Status section to note route layer SHA.
4. **Handoff** — SESSION_STATE entry references this commit + the Section 4 deploy commit. **codex:rescue verdict line in the agent-utilization footer is mandatory.**

---

## Section 3 — Dev-auth shim swap-out

> **Routing:** Opus self-execute. 9 small targeted edits against the addendum-pinned contract; cache stays warm from Section 2's reads.
> **Phase 3 Opus diff review:** mandatory (touches `apps/api` route imports + `apps/web` auth UX).
> **codex:rescue gate:** rolls into Section 2's codex:rescue pass IF same commit; separate codex:rescue pass IF trailing commit. See Open Question on "Dev-auth deletion timing."

### What changes — full enumeration

#### API-side sites (3)

1. **Delete** [`apps/api/src/middleware/dev-auth.ts`](../../apps/api/src/middleware/dev-auth.ts) — file removal; `devAuthHook` and module-level `requireRole` go away.
2. **Edit** [`apps/api/src/routes/admin-users.ts:11`](../../apps/api/src/routes/admin-users.ts#L11) — change `import { requireRole } from '../middleware/dev-auth.js';` to `import { requireAuth } from '@assessiq/auth';` and rewrite `const adminOnly = requireRole(['admin']);` (line 13) to `const adminOnly = requireAuth({ roles: ['admin'] });`. The library's `requireAuth` is a higher-level helper covering the dev-auth `requireRole` semantics + freshMfa option; admin-users routes that don't need freshMfa just pass `roles` only.
3. **Edit** [`apps/api/src/routes/invitations.ts:4`](../../apps/api/src/routes/invitations.ts#L4) — same swap as admin-users (`requireRole` → `requireAuth({roles: ['admin']})`).

#### Web-side sites (6)

4. **Edit** [`apps/web/src/lib/api.ts:29-32`](../../apps/web/src/lib/api.ts#L29-L32) and [`:47-60`](../../apps/web/src/lib/api.ts#L47-L60) — remove the `...devAuthHeaders()` spread on line 32 AND delete the `devAuthHeaders()` function (lines 47-60). `credentials: 'include'` on line 24 stays — that's the cookie path. After the edit, `api()` is pure cookie-based.
5. **Edit** [`apps/web/src/pages/admin/login.tsx:17-28`](../../apps/web/src/pages/admin/login.tsx#L17-L28) — rewrite `startGoogleSso` to do `window.location.href = '/api/auth/google/start'` (the comment on line 18 already shows the target). Delete the `saveSession({...})` mock + the `nav('/admin/mfa')` line — the server-side redirect after callback handles MFA routing. Keep the rest of the JSX untouched.
6. **Edit** [`apps/web/src/pages/admin/mfa.tsx:14-25`](../../apps/web/src/pages/admin/mfa.tsx#L14-L25) — rewrite the `useEffect` to fetch `POST /api/auth/totp/enroll/start` (returns `EnrollStartOutput { otpauthUri }`), use the returned URI for QR generation. The placeholder `JBSWY3DPEHPK3PXP` literal goes away.
7. **Edit** [`apps/web/src/pages/admin/mfa.tsx:27-37`](../../apps/web/src/pages/admin/mfa.tsx#L27-L37) — rewrite `verify` to `POST /api/auth/totp/verify` with `{code}`. On success (204), `nav('/admin/users')`. Delete the `saveSession({...})` mock. On 401 with `error.code === 'INVALID_CODE'`, set local error state to "Invalid code, try again." On 423, surface "Too many attempts; locked for 15 minutes."
8. **Edit** [`apps/web/src/pages/invite-accept.tsx:7-14`](../../apps/web/src/pages/invite-accept.tsx#L7-L14) — `AcceptResponse` interface narrows to `{user: {id, tenantId, role}, expiresAt: string}` matching the actual server response (`apps/api/src/routes/invitations.ts:103-106`). The mock fields `userId`, `tenantId`, `role` at the top level go away.
9. **Edit** [`apps/web/src/pages/invite-accept.tsx:37-46`](../../apps/web/src/pages/invite-accept.tsx#L37-L46) — replace `saveSession({userId, tenantId, role, totpVerified: false})` with cookie-trust pattern: just `nav('/admin/mfa', { replace: true })`. The server already set `aiq_sess` via the `/api/invitations/accept` Set-Cookie path (verified at `apps/api/src/routes/invitations.ts:95-101`).

#### Web-side session-shim cleanup (1 file, depends on usage scan)

10. **Audit** `apps/web/src/lib/session.ts` (path inferred from imports — verify path with `Glob`) — if it exists and only powers the dev-auth flow, delete it. If it has any non-mock helpers (e.g. `getSession()` that reads a server endpoint), keep those and remove only `saveSession` + the `aiq:dev-auth` sessionStorage key. **Acceptance test:** browser DevTools shows no `aiq:dev-auth` key in sessionStorage after a full `/admin/login → MFA → /admin/users` round-trip.

### Why

- Closes the FIXME(post-01-auth) markers from W4 handoff. The 7 markers grep'd in Phase 0 warm-start cover items 4-9 above; items 1-3 (API-side dev-auth.ts consumers) and item 10 (session.ts shim) are Discovery-found additional sites the Phase 0 reads surfaced.
- Removes the dev-auth backdoor entirely. The dev-auth.ts:23-29 hard-fail on `NODE_ENV === 'production'` was a transitional safety; once the real chain ships, the safety becomes dead code. Removing it eliminates the "what if NODE_ENV is misconfigured" footgun.

### Documentation references

- Phase 0 § Frozen contracts §9 (middleware order) — defines the chain that replaces `devAuthHook`.
- [`apps/api/src/routes/invitations.ts:91-101`](../../apps/api/src/routes/invitations.ts#L91-L101) — established cookie-mint pattern that proves the swap target works (codex:rescue HIGH on the same file's earlier draft pinned this — body never carries the bearer).
- [`docs/04-auth-flows.md`](../04-auth-flows.md) Flow 1 — sequence the web pages now drive against real endpoints.

### Acceptance test

- `pnpm --filter @assessiq/web typecheck` clean.
- `pnpm --filter @assessiq/web test` green (any existing tests; new tests for cookie-trust flows are nice-to-have, not blocking — manual smoke is Section 5 Drill A).
- `pnpm --filter @assessiq/api typecheck` clean after dev-auth.ts deletion (the `requireRole` rewires must take effect first or imports break).
- `Grep` for `FIXME(post-01-auth)` returns ZERO hits across the repo.
- `Grep` for `'aiq:dev-auth'` returns ZERO hits.
- `Grep` for `x-aiq-test-tenant` returns ZERO hits except possibly tests (audit + remove if found in production paths).
- Workspace-wide `pnpm -r typecheck` clean.

### Anti-pattern guards

- Don't leave `devAuthHook` import in `server.ts` after deleting the file — typecheck catches but only after a fresh install; verify locally.
- Don't replace `saveSession` with a new client-side session store — the cookie IS the session; client-side mirror is a freshness-bug factory.
- Don't keep the `'aiq:dev-auth'` sessionStorage key as a "feature flag" — it's a backdoor by another name. Delete it.
- Don't simplify `apps/api/src/routes/invitations.ts:91-101` cookie-set into a body bearer "for the SPA" — codex:rescue HIGH on this file's earlier draft already rejected that path; the comment on line 91-94 explains why.

### Rollback note

Section 3's edits are coupled with Section 2's deployment: rolling back Section 3 alone (re-add dev-auth.ts) leaves the new auth route layer running but the SPA still using mock saveSession + dev-auth headers — broken end-to-end. Rollback if needed = revert Sections 2 + 3 together.

### DoD

1. **Commit** options:
   - **Same-commit option:** `feat(api,web): swap dev-auth shim for real sessionLoader after 01-auth route layer` — bundles Sections 2 + 3. Cleanest history, biggest single diff (~700 LOC est.).
   - **Trailing-commit option:** `fix(web,api): swap dev-auth shim after 01-auth route layer` — separates concerns, lets Section 2 ship and bake before the swap. Risk: brief window where api/web disagree on auth model.
   - **Decision:** see Open Question #4. Recommendation: **same-commit** because the swap is a hard cutover (no graceful coexistence) — separating commits buys nothing operationally and risks the brief-disagreement window. If user picks trailing-commit, codex:rescue gate fires on BOTH commits.
2. **Deploy** — defer to Section 4. Bundles with Section 2's container build.
3. **Document** — FIXME marker count drop is self-documenting; no doc edit needed beyond the SESSION_STATE handoff.
4. **Handoff** — SESSION_STATE entry references this commit (or notes it bundled into Section 2's commit).

---

## Section 4 — VPS deploy (additive)

> **Routing:** Haiku subagent for the enumeration sweep (returns checkmark table — single SSH call, single bash transcript). Opus for the Caddyfile edit + `docs/06-deployment.md` rewrite (security-adjacent shared-infra; addendum-pinned bind-mount inode rule).
> **Phase 3 Opus diff review:** mandatory (Caddyfile is shared infra; `infra/**` is load-bearing).
> **codex:rescue gate:** mandatory before Caddyfile reload (deploy is the security-adjacent action even though no code changes; codex:rescue verdict on the deploy steps themselves catches the "did we miss enumeration?" trap).

### Pre-deploy enumeration (Haiku subagent)

Single SSH session to `assessiq-vps`. Subagent prompt: "ssh assessiq-vps and run these 6 commands; return a markdown checkmark table with command + key facts + pass/fail per `CLAUDE.md` rule #8 (additive only):

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
systemctl list-units --state=running --no-pager --type=service
ss -tlnp | awk 'NR==1 || /:909[12]/'
cat /opt/ti-platform/caddy/Caddyfile
ls -la /srv/assessiq/
test -f /srv/assessiq/.env && echo '.env present' || echo '.env missing'
```

Pass criteria: (a) no non-`assessiq-*` container/unit will be touched; (b) port 9091 + 9092 status is known (free, bound by `assessiq-*`, or bound by something else → STOP); (c) Caddyfile diff target is identifiable (the placeholder block from RCA 2026-04-30); (d) `/srv/assessiq/` exists and `.env` is present (per docs/06-deployment.md first-boot bootstrap)."

Subagent returns checkmark table. Opus reviews for any non-additive surprise (e.g. 9092 already bound by another app → STOP and surface as Open Question resolution).

### Build + deploy

Run from local checkout (push image to registry NOT used in Phase 0; build on VPS directly):

```bash
ssh assessiq-vps
cd /srv/assessiq
git pull origin main
docker compose -f infra/docker-compose.yml build assessiq-api
docker compose -f infra/docker-compose.yml up -d assessiq-api
docker compose -f infra/docker-compose.yml ps assessiq-api  # expect healthy within 30s
docker compose -f infra/docker-compose.yml logs --tail=50 assessiq-api  # expect 'assessiq-api listening' line
```

**Add host port 9092 to `assessiq-api`.** Discovery confirmed [`infra/docker-compose.yml:86`](../../infra/docker-compose.yml#L86) declares `expose: ["3000"]` (internal only). For the split-route topology (load-bearing decision #8), API needs a host port. **Edit compose:**

```yaml
  assessiq-api:
    # ... existing ...
    ports:
      - "9092:3000"   # NEW — additive deviation from docs/06-deployment.md:282-285
    expose: ["3000"]
```

This compose edit IS a load-bearing infra/** change → codex:rescue gate. Same commit as Caddyfile.

### Caddyfile edit

Current state (verified in Phase 0 warm-start, [`docs/06-deployment.md:135-153`](../06-deployment.md#L135-L153)):

```caddy
assessiq.automateedge.cloud {
    tls /etc/caddy/ssl/assessiq.automateedge.cloud.pem /etc/caddy/ssl/assessiq.automateedge.cloud.key
    import security-headers
    encode zstd gzip
    header Content-Type "text/html; charset=utf-8"
    header Cache-Control "no-store"
    respond 200 { body "<!DOCTYPE html>...<h1>AssessIQ</h1>..."; close }
}
```

Target state:

```caddy
assessiq.automateedge.cloud {
    tls /etc/caddy/ssl/assessiq.automateedge.cloud.pem /etc/caddy/ssl/assessiq.automateedge.cloud.key
    import security-headers
    encode zstd gzip

    # API + embed routes → assessiq-api on 9092
    @api path /api/* /embed*
    handle @api {
        reverse_proxy 172.17.0.1:9092 {
            header_up X-Forwarded-Proto https
        }
    }

    # Default → assessiq-frontend on 9091 (still placeholder for now; see Open Question on frontend container)
    handle {
        # IF assessiq-frontend not yet shipped: keep the placeholder body for / paths.
        # IF assessiq-frontend shipped: reverse_proxy 172.17.0.1:9091 { header_up X-Forwarded-Proto https }
        header Content-Type "text/html; charset=utf-8"
        header Cache-Control "no-store"
        respond 200 { body "<!DOCTYPE html>...<h1>AssessIQ</h1><p>API live at /api. Frontend coming soon.</p>..."; close }
    }

    log {
        output file /var/log/caddy/assessiq.log
        format json
    }
}
```

**Apply procedure** (load-bearing — addendum bind-mount inode rule):

```bash
# 1. Backup
sudo cp /opt/ti-platform/caddy/Caddyfile /opt/ti-platform/caddy/Caddyfile.bak.$(date -u +%Y%m%d-%H%M%S)

# 2. Edit IN PLACE — truncate-write only, NEVER mv (RCA 2026-04-30 inode trap)
sudo cat > /opt/ti-platform/caddy/Caddyfile <<'EOF'
... (full Caddyfile, AssessIQ block updated, ALL OTHER BLOCKS BYTE-FOR-BYTE PRESERVED) ...
EOF

# 3. Validate before reload
docker exec ti-platform-caddy-1 caddy validate --config /etc/caddy/Caddyfile

# 4. Graceful reload
docker exec ti-platform-caddy-1 caddy reload --config /etc/caddy/Caddyfile

# 5. Smoke
curl -sS -D - https://assessiq.automateedge.cloud/api/health | head
# expect: HTTP/2 200, content-type: application/json, body: {"status":"ok"}
```

**Truncate-write requires the WHOLE Caddyfile to be re-emitted** — a `>>` append plus a manual surgery on the AssessIQ block would re-invite the inode trap. Procedure: read current Caddyfile (`docker exec ti-platform-caddy-1 cat /etc/caddy/Caddyfile`), splice the new AssessIQ block, emit the full file via `cat <<'EOF' > /opt/ti-platform/caddy/Caddyfile`. Phase 3 review verifies `diff Caddyfile.bak Caddyfile` is exactly +1 modified block, all other bytes identical.

### Migrations

Per project rule #6 (load-bearing), `tools/migrate.ts` is OUT of scope this session. Section 2 + 3 don't add migrations (the route layer wraps existing W4 tables; dev-auth removal touches no tables). **Net-new migrations expected: 0.** If Section 2's discovery surfaces the need (e.g. `embed-secrets` list helper requires a new index), apply via `psql -f` direct, matching the W2/W4/W5 pattern.

### Acceptance test

- Pre-deploy enumeration table green (no non-additive surprises).
- `docker ps` shows `assessiq-api` healthy, container name `assessiq-api`, image `assessiq/api:latest` (or the IMAGE_TAG specified), port mapping `0.0.0.0:9092->3000/tcp`.
- `ss -tlnp` confirms 9092 bound by docker-proxy.
- `curl -I https://assessiq.automateedge.cloud/api/health` returns `200` with `{"status":"ok"}` body — proves Caddy split-route lands on the API container, not the placeholder.
- `curl -I https://assessiq.automateedge.cloud/` returns `200` with the placeholder body — proves the default route still works for non-API paths.
- `diff /opt/ti-platform/caddy/Caddyfile.bak.<UTC-ts> /opt/ti-platform/caddy/Caddyfile` shows exactly the AssessIQ block changed; no other apps' blocks touched.
- `docker compose logs assessiq-api` shows `'assessiq-api listening', port: 3000` and zero ERROR-level lines in the first 60s.

### Rollback note

```bash
# Caddyfile rollback
sudo cp /opt/ti-platform/caddy/Caddyfile.bak.<UTC-ts> /opt/ti-platform/caddy/Caddyfile  # cp not mv — preserve bak
docker exec ti-platform-caddy-1 caddy validate --config /etc/caddy/Caddyfile
docker exec ti-platform-caddy-1 caddy reload --config /etc/caddy/Caddyfile

# Container rollback
docker compose -f /srv/assessiq/infra/docker-compose.yml stop assessiq-api
docker compose -f /srv/assessiq/infra/docker-compose.yml rm -f assessiq-api
```

After rollback, the Caddyfile placeholder is restored and `/api/*` returns the placeholder body (graceful degradation — no 502).

### Anti-pattern guards

- `cp` for backup, **`cat … > Caddyfile` for the edit** (NEVER `mv`, `cp src dst` from a prepared file, or any operation that detaches the bind-mount inode).
- Don't `docker system prune -a` to reclaim space — `CLAUDE.md` rule #8 hard ban.
- Don't restart `ti-platform-caddy-1` to apply changes — `caddy reload` is graceful and doesn't drop in-flight connections; restart drops them.
- Don't add a `/healthz` ALSO if `/api/health` is the chosen path — pick one; both is API-surface debt.
- Don't push an `assessiq/api` image to a public registry — Phase 0 builds on the VPS, no registry involvement.

### DoD

1. **Commit** `feat(deploy): assessiq-api container + Caddyfile split-route /api/* /embed → 9092` — covers compose `ports:` addition + Caddyfile rewrite encoding (since the live Caddyfile is on the VPS, the commit captures the procedure + the target block, not the live edit). The Caddyfile target block lives in [`docs/06-deployment.md`](../06-deployment.md) so future restores reproduce it from the doc, per the existing DR pattern.
2. **Deploy** — this section IS the deploy. Ordered:
   1. Pre-deploy enumeration (Haiku).
   2. `git pull origin main` on VPS (fetches Sections 1+2+3 commits).
   3. `docker compose build assessiq-api`.
   4. Edit compose `ports:` and `git stash`/`commit` on VPS-only checkout (pick: stash if VPS is read-only ref to main, OR the compose edit lands in the local commit pre-deploy and is pulled; recommendation: land it in the same commit as Caddyfile docs).
   5. `docker compose up -d assessiq-api` → wait for healthy.
   6. Caddyfile backup + edit + validate + reload.
   7. Smoke (`curl /api/health`).
3. **Document** — overhaul [`docs/06-deployment.md`](../06-deployment.md) § Current live state — Phase 0 placeholder. Replace the all-placeholder narrative with split-route narrative: "API live on 9092 via Caddy `/api/*` + `/embed*` handle; placeholder retained for `/`." Add the target Caddyfile block. Cross-reference the inode rule (still load-bearing for any future swap-back of the placeholder when frontend ships). Record live SHA + UTC deploy timestamp.
4. **Handoff** — SESSION_STATE entry includes the VPS additive-deploy audit (Haiku enumeration table summary + Caddyfile diff scope confirmation). codex:rescue verdict line in the agent-utilization footer is mandatory.

---

## Section 5 — Closure drills (live)

> **Routing:** Opus drives drills A-D (each is a security pass/fail judgment per result). Haiku for the doc-drift textual scan (returns table of files needing edits).
> **Phase 3 Opus diff review:** N/A — drills produce evidence captures, not code.
> **codex:rescue gate:** N/A — drills are verification of already-shipped code.

### Drill A — Full-stack browser smoke

**Procedure:**
1. Open fresh incognito Chrome (no extensions, no cookies).
2. Navigate to `https://assessiq.automateedge.cloud/admin/login`.
3. Click "Continue with Google".
4. Authenticate with the bootstrap admin Google account (provisioned per `docs/plans/PHASE_0_KICKOFF.md` Decision #1).
5. Expect redirect to `/admin/mfa`. Cookie `aiq_sess` should be set with `HttpOnly; Secure; SameSite=Lax`.
6. If first login: scan QR with Google Authenticator → enter 6-digit code → expect 10 recovery codes shown ONCE.
   If returning: enter 6-digit code from authenticator app.
7. Expect redirect to `/admin/users`.
8. Page renders user list (just the bootstrap admin row).

**Evidence captures:**
- Screenshot of `/admin/users` rendered with the user row visible.
- DevTools → Application → Cookies snapshot showing `aiq_sess` with the right flags.
- DevTools → Application → Local/Session Storage snapshot showing NO `aiq:dev-auth` key (acceptance test for Section 3 item 10).
- `psql -h <vps> -U assessiq -d assessiq -c "SELECT id, user_id, totp_verified FROM sessions WHERE user_id = '<bootstrap-admin-uuid>' ORDER BY created_at DESC LIMIT 1;"` — confirms session row with `totp_verified=true`.

**Pass criteria:** all evidence captures present and correct. Any failure → Drill A FAIL → bounce to either Section 2 (route layer bug) or Section 3 (web SPA bug) or Section 4 (deploy bug).

**Phase-1 follow-up gating:** if Drill A reveals lockout-after-success (TOTP `recordFailure` TTL drift per W4 follow-up #3), this drill becomes a blocker and TTL drift fix moves into scope. Same for api-keys `last_used_at` (W4 follow-up #2) — only if Drill A reveals it (it shouldn't; admin login doesn't touch API keys).

### Drill B — Google SSO start curl

**Procedure:**
```bash
curl -sS -D - -o /dev/null https://assessiq.automateedge.cloud/api/auth/google/start
```

**Pass criteria:**
- HTTP `302`.
- `Location:` header points at `https://accounts.google.com/o/oauth2/v2/auth?...` with query params `client_id=<GOOGLE_CLIENT_ID>`, `redirect_uri=https://assessiq.automateedge.cloud/api/auth/google/cb`, `state=<random>`, `nonce=<random>`, `scope=openid+email+profile`.
- `Set-Cookie:` headers for `aiq_state` and `aiq_nonce` (5-minute TTL, `HttpOnly; Secure; SameSite=Lax`).
- `Cache-Control: no-store` (security pin — never cache the redirect URL).

**Evidence:** full `curl -v` transcript saved.

### Drill C — alg=none embed JWT

**Procedure:**
```bash
# Header: {"alg":"none","typ":"JWT"} → eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0
# Payload: {"iss":"attacker","aud":"assessiq","sub":"x","tenant_id":"<any-uuid>","email":"x@x.com","name":"x","assessment_id":"<any-uuid>","iat":1700000000,"exp":9999999999,"jti":"<uuid>"}
TOKEN="eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJpc3MiOiJhdHRhY2tlciIsImF1ZCI6ImFzc2Vzc2lxIiwic3ViIjoieCIsInRlbmFudF9pZCI6IjAxOTU1NjAwLTAwMDAtN2YwMC04MDAwLTAwMDAwMDAwMDAwMSIsImVtYWlsIjoieEB4LmNvbSIsIm5hbWUiOiJ4IiwiYXNzZXNzbWVudF9pZCI6IjAxOTU1NjAwLTAwMDAtN2YwMC04MDAwLTAwMDAwMDAwMDAwMiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjo5OTk5OTk5OTk5LCJqdGkiOiIwMTk1NTYwMC0wMDAwLTdmMDAtODAwMC0wMDAwMDAwMDAwMDMifQ."
curl -sS -D - "https://assessiq.automateedge.cloud/embed?token=${TOKEN}"
```

**Pass criteria:**
- HTTP `401`.
- Body `{"error":{"code":"INVALID_TOKEN","message":"..."}}` per the addendum §5 + 03-api-contract.md error envelope.
- NO `Set-Cookie: aiq_sess` (token rejected before session mint).

**Evidence:** full `curl -v` transcript saved.

### Drill D — Replay valid embed JWT

**Procedure:**
```bash
# 1. Mint a valid token via @assessiq/auth.mintEmbedToken — use a Node REPL on VPS or a unit-test helper.
#    Or via direct DB: insert a known active embed_secret, then sign locally with the secret.
TOKEN=$(node -e "...")  # actual procedure documented in apps/api/src/__tests__/routes/auth/embed.test.ts

# 2. First request — expect 200 (or 302 if the route redirects to /embed-app)
curl -sS -D - -o /tmp/embed-1.body "https://assessiq.automateedge.cloud/embed?token=${TOKEN}"

# 3. Second request — expect 401 jti_replay
curl -sS -D - -o /tmp/embed-2.body "https://assessiq.automateedge.cloud/embed?token=${TOKEN}"
```

**Pass criteria:**
- First request: `200` (or `302` if redirect to `/embed-app`); `Set-Cookie: aiq_sess` present (session minted with `role='candidate'`, `totpVerified=true`).
- Second request: `401`; body `{"error":{"code":"jti_replay" /* or 'INVALID_TOKEN' with details.code='jti_replay' */, ...}}`. Recommended: distinct error code so monitoring can distinguish replay-attempt from invalid-token.
- Redis: `EXISTS aiq:embed:jti:<jti>` returns `1` between the two curls (cache populated).

**Evidence:** paired `curl -v` transcripts. `redis-cli -h <vps>` `EXISTS aiq:embed:jti:<jti>` output confirming the cache write.

### Doc-drift sweep (Haiku)

Subagent prompt: "Grep across `docs/`, `modules/01-auth/SKILL.md`, `modules/03-users/SKILL.md`, `PROJECT_BRAIN.md` for any of these phrases: 'pending', 'deferred', 'next deliverable', 'route layer', 'route-layer', 'Phase 1 follow-up', 'FIXME(post-01-auth)', '01-auth Window 4', 'mock seam'. Return a markdown table: file path · line number · matched phrase · suggested update (live SHA, status flip, or removal). Do NOT edit anything — just report the table."

Opus reviews the table. Each row: either flip the doc to "live" with the deploy SHA, or remove the phrase entirely (if it referred to W4 work that's now shipped). Bulk-edit applied as a single doc-drift commit.

### Phase 0 § Final phase verification mapping

| Kickoff Final phase step | Drill | Status |
|---|---|---|
| 1. Manual full-stack smoke | Drill A | covered |
| 2. Tenant isolation drill | (already drilled in W4 session per its handoff — confirmed in Phase 0 reads) | covered earlier |
| 3. Token whitelist drill (alg=none) | Drill C | covered |
| 4. Replay drill | Drill D | covered |
| 5. VPS additive-deploy audit | Section 4 enumeration + diff check | covered |
| 6. Doc drift sweep | Doc-drift sweep above | covered |
| 7. codex:rescue final pass on merged Phase 0 surface | Section 2's codex:rescue gate before push | covered |

### Pass criteria for Phase 0 closure

- Drills A, B, C, D all pass.
- Doc-drift sweep: 0 stale "pending"/"deferred"/"FIXME" markers remain.
- VPS additive-deploy audit table green (Section 4).
- All Section 1, 2, 3, 4 commits on `origin/main`.
- SESSION_STATE handoff written + agent-utilization footer present.
- PROJECT_BRAIN.md decision log gets one row referencing this plan + the Phase 0 closure SHA range.

### Failure handling

If any drill FAILS:
1. Append to [`docs/RCA_LOG.md`](../RCA_LOG.md) per the project format (symptom / cause / fix / prevention).
2. Open one bounce-back fix. Routing per scope: a bug in the library → 01-auth fix session; bug in route layer → Section 2 fix; bug in SPA → Section 3 fix; bug in deploy → Section 4 fix. Each bounce is its own commit + DoD pass.
3. Re-run only the failed drill. Don't re-drill A-D wholesale unless the fix touches >1 surface.

### DoD

1. **Commit** — drills produce no commits. Doc-drift sweep produces ONE commit `docs(phase-0): close out W4 + route-layer references` after drills pass.
2. **Deploy** — N/A.
3. **Document** — append the drill outcomes table (with timestamps + evidence file paths) to SESSION_STATE handoff. If any drill FAIL: also append RCA entry. **Add Phase 0 closure entry to [`PROJECT_BRAIN.md`](../../PROJECT_BRAIN.md) decision log** with the live SHA range and date.
4. **Handoff** — SESSION_STATE entry. Phase 0 closes here.

---

## Final Phase — Verification

This is the orchestrator-only gate AFTER all five sections land. Self-contained: a fresh chat session reading this section can verify Phase 0 is closed without re-deriving anything.

### Exit criteria checklist

- [ ] Section 1 commit on `origin/main`. `Glob` `infra/docker/assessiq-api/Dockerfile` returns hit. `infra/docker-compose.yml` line 69 reads `dockerfile: ./infra/docker/assessiq-api/Dockerfile`.
- [ ] Section 2 commit on `origin/main`. `apps/api/src/routes/auth/index.ts` exists + 6 sibling files. `pnpm --filter @assessiq/api test` green.
- [ ] Section 3 commit (or merged into Section 2 commit). `Glob` `apps/api/src/middleware/dev-auth.ts` returns ZERO hits. `Grep` `FIXME(post-01-auth)` returns ZERO hits. `Grep` `'aiq:dev-auth'` returns ZERO hits.
- [ ] Section 4 commit on `origin/main`. VPS: `docker ps` shows `assessiq-api healthy`. Caddyfile has split-route block. `curl https://assessiq.automateedge.cloud/api/health` → 200.
- [ ] Section 5 drill outcomes recorded in SESSION_STATE handoff. All drills pass OR RCA entry appended for each fail.
- [ ] Doc-drift sweep commit on `origin/main`. `Grep` for "pending route layer" / "01-auth Window 4 must ship" returns ZERO hits across `docs/`.
- [ ] PROJECT_BRAIN.md decision log has the Phase 0 closure row.
- [ ] Workspace-wide `pnpm -r typecheck` clean.
- [ ] Workspace-wide `pnpm -r test` clean (or known-flaky line documented in SESSION_STATE).
- [ ] codex:rescue verdict captured in SESSION_STATE agent-utilization footer (line item per affected commit).

### Anti-pattern grep gate (one-shot)

```bash
# FIXME markers
grep -rn 'FIXME(post-01-auth)' apps/ modules/ infra/ docs/ tools/

# Dev-auth backdoor strings
grep -rn 'x-aiq-test-tenant\|x-aiq-test-user-id\|x-aiq-test-user-role\|aiq:dev-auth' apps/ modules/

# Ambient AI calls (always — global rule)
grep -rn 'claude\|@anthropic-ai\|ANTHROPIC_API_KEY' modules/ apps/ infra/ | grep -v 'modules/07-ai-grading'

# alg:none re-introduction (regression check)
grep -rn 'algorithms.*none\|alg.*none' apps/ modules/01-auth/
```

ALL must return zero hits.

### Routing summary (this plan)

| Activity | Where |
|---|---|
| This plan itself | Anyone reads `docs/plans/PHASE_0_CLOSURE.md` (top-of-section then Phase 0 § Frozen contracts + § Allowed APIs + § Pattern files) |
| Section 1 (Dockerfile) | Opus self-execute; Phase 3 Opus review |
| Section 2 (route layer) | Opus self-execute scaffolding; Sonnet optional parallel for test sketches; Phase 3 Opus review; codex:rescue MANDATORY |
| Section 3 (dev-auth swap) | Opus self-execute; rolls into Section 2 or trailing per Open Question #4 |
| Section 4 (VPS deploy) | Haiku enumeration sweep; Opus Caddyfile + 06-deployment.md rewrite; codex:rescue on the deploy diff |
| Section 5 (drills) | Opus drives drills; Haiku doc-drift sweep |

---

## Open questions (NOT answered — for user)

1. **Is host port 9092 free on the VPS?** Resolved at Section 4 enumeration. If bound by another app, plan stalls until user picks an alternate port (recommendation: 9093, 9094 — survey free).

2. **`/healthz` vs `/api/health` in this pass.** Discovery confirmed [`apps/api/src/routes/health.ts:4`](../../apps/api/src/routes/health.ts#L4) already exposes `GET /api/health` with `skipAuth: true`. Compose healthcheck on line 88 hits this. **Recommendation: use the existing `/api/health`.** No new endpoint needed; route-layer plan does not add one. Caddyfile split routes `/api/*` so `/api/health` is reachable end-to-end.

3. **JWKS preload at server start vs lazy.** The Google SSO library uses lazy JWKS fetch on first `handleGoogleCallback`. Lazy = no startup-failure risk if Google JWKS is briefly unreachable. Preload = ~200ms first-request latency cut + startup-time visibility into Google reachability. **Recommendation: lazy** for Phase 0 — no SLA pressure yet, and a startup-failure-mode triggered by Google JWKS reachability is the wrong failure surface to introduce now. Phase 1+ revisit.

4. **Dev-auth shim deletion timing.** Same-commit (Section 2 + 3 merged) or trailing-commit (Section 3 separate)? **Recommendation: same-commit.** Hard cutover; coexistence buys nothing operationally; brief-disagreement window is the only risk. If trailing chosen, codex:rescue gate fires twice.

5. **Frontend container status.** [`docs/06-deployment.md`](../06-deployment.md) says 9091 = frontend, but no `infra/docker/assessiq-frontend/Dockerfile` exists. Section 4's Caddyfile target keeps the placeholder body for `/` (default route) until frontend ships. **Drill A's `/admin/login`** is served by Caddy's placeholder, not a real frontend — meaning Drill A as currently written CANNOT pass against the placeholder. **Two options:**
   - **(a) Ship frontend Dockerfile in scope here** — adds Section 1.5 between current Sections 1 and 2; Drill A becomes a real full-stack drill. ~1.5x session size.
   - **(b) Defer Drill A** — replace with a curl-only smoke that hits `/api/auth/google/start` and confirms 302; full-stack drill moves to a follow-up session when frontend Dockerfile ships. Smaller scope; Phase 0 closure has a known gap recorded.
   - User decides. Plan as written assumes **(b)** — Drill A's procedure includes the full-stack steps but its acceptance test is conditional on frontend container existence; failure-by-placeholder is documented as a deferred drill, not a real fail.

6. **`embed-secrets` list helper.** Library exports `createEmbedSecret`/`rotateEmbedSecret` only. Section 2's `GET /api/admin/embed-secrets` either (a) gets a new library helper added in the same commit (Phase 3 Opus review applies; ~10 LOC) or (b) the GET endpoint defers to a follow-up. **Recommendation: (a)** — single-query helper, the surface is small, and the route table is more complete with it.

7. **Session count to execute.** **Recommendation: 2 sessions.** Split point between Section 3 commit (working tree clean, all code on `origin/main`) and Section 4 (VPS-touching).
   - **Session 1 (this plan, sections 1-3):** Dockerfile + route layer + dev-auth swap. Phase 2 gates → Phase 3 Opus review → Phase 4 revise (≤2 loops) → codex:rescue gate → push. Estimated tool calls 60-90; estimated wall-clock 60-90 min. Cache warmth maintained via Phase 0 reads.
   - **Session 2 (this plan, sections 4-5):** VPS deploy + drills. Phase 0 warm-start (read SESSION_STATE handoff from session 1, pre-deploy enumeration via Haiku). Estimated tool calls 30-50; estimated wall-clock 30-45 min. Lower cache pressure (different surface).
   - **Reasoning:** Separates code-shipping risk (revertable via `git revert` cheaply) from VPS-touching risk (revertable but requires SSH + Caddyfile restore). Aligns with W4+W5 RCA prevention rule (avoid stalled trees from cross-cutting parallel work). The two sessions share NO files-in-flight, so they can even run in parallel `git worktree`s if user has bandwidth.
   - **One-session alternative:** acceptable if the user wants a focused continuous push and is willing to take the larger Phase 3 review surface (Sections 1+2+3+4 reviewed in one diff). Trade-off: less tool-call thrash from session warm-start, more cache pressure on the single Opus session. Recommendation stays at 2.

---

## Status

- **Plan version:** 1.0 (2026-05-01, orchestrator: Opus 4.7).
- **Predecessor plan:** [`docs/plans/PHASE_0_KICKOFF.md`](PHASE_0_KICKOFF.md) (Phase 0 foundation).
- **Successor plan:** Phase 1 G1.A onwards (`04-question-bank` + `16-help-system` per memory observation S101) — kicks off after this plan's Section 5 closes Phase 0.
- **Open questions outstanding:** 1, 4, 5, 7 (user-blocking); 2, 3, 6 (orchestrator-recommended defaults captured above).
- **Next action:** orchestrator delivers this plan to user for approval. On approval, opens Section 1 implementation as a fresh session per global Phase 0 warm-start.
