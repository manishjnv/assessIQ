# Phase 0 — Foundation Kickoff Plan

> **Generated:** 2026-04-30 by Opus 4.7 via `claude-mem:make-plan` after parallel doc-discovery sweeps.
> **Phase scope:** Modules `00-core`, `01-auth`, `02-tenancy`, `03-users`, `17-ui-system`.
> **Outcome:** Auth + tenancy + UI kit working end-to-end. Google SSO + TOTP login, RLS-enforced tenant isolation, design-token UI primitives wired into a Vite SPA, deploy-ready additive Compose stack on the shared VPS.
> **Window:** Week 1–2 per `PROJECT_BRAIN.md`.

This plan is the source of truth for Phase 0 across multiple VS Code sessions. Every session reads this doc as part of its Phase 0 warm-start (`CLAUDE.md` reading list).

---

## Discovery summary (consolidated)

Four Haiku discovery agents reported on 2026-04-30. Consolidated facts:

### Repo state
- **Pure specification scaffold.** Only `SKILL.md`s in modules; zero runtime code (no `.ts`, `.sql`, no `package.json`, `tsconfig.json`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `infra/` files at root). The literal `{docs,modules,infra}/` brace-expansion folder is **empty** — safe to ignore.
- Stack chosen and committed in `PROJECT_BRAIN.md`: Node 22 + Fastify, Postgres 16 + RLS, Redis 7 + BullMQ, React 18 + Vite. **Edge:** existing **Caddy** on the shared VPS (owned by ti-platform), fronted by **Cloudflare** (orange-cloud, Full Strict). AssessIQ does **not** ship its own nginx/certbot — that was the original plan but reality on the box is Caddy. See `docs/06-deployment.md` for the rewrite.

### Module contracts (extracted, not invented)
- **`00-core` — leaf module, zero deps.** Exposes `config` (Zod-validated env), `createLogger() / childLogger(bindings)`, `AppError` hierarchy (`ValidationError`, `AuthnError`, `AuthzError`, `NotFoundError`, `ConflictError`, `RateLimitError`), `withRequestContext / getRequestContext` (AsyncLocalStorage), `uuidv7()`, `shortId()` (12-char base32), `nowIso() / parseIso(s)`. `RequestContext` shape: `{requestId, tenantId, userId, roles, ip, ua}`. (Source: `modules/00-core/SKILL.md`.)
- **`02-tenancy` — depends on 00.** Exposes `getTenantById/BySlug`, `updateTenantSettings`, `suspendTenant`, `tenantContextMiddleware()` (Fastify preHandler, sets `req.tenant` and Postgres session var `app.current_tenant`), `withTenant<T>(tenantId, fn)`. Owns tables `tenants`, `tenant_settings`. RLS template (lines 522–528 of `docs/02-data-model.md`) **must be copied verbatim** for every tenant-scoped table. System role `assessiq_system` (`BYPASSRLS`) for cross-tenant ops, every use audited.
- **`03-users` — depends on 00, 02, 13-notifications.** Exposes user CRUD + invites + bulk import; roles `admin | reviewer | candidate`; statuses `active | disabled | pending`. Owns `users`, `user_invitations` (auth-bound fields like `token_hash` belong to 01-auth, not here). Soft delete via `deleted_at`.
- **`01-auth` — load-bearing, codex:rescue gated.** Five flows: Google SSO (`/api/auth/google/start`, `/api/auth/google/cb`), TOTP MFA (`/api/auth/totp/{enroll/start, enroll/confirm, verify, recovery}`), magic link (`/api/take/start`), embed JWT (HS256, claims `iss/aud='assessiq'/sub/tenant_id/email/name/assessment_id/exp/iat/jti`), API keys (`Authorization: Bearer aiq_live_<32-char-random>`, sha256 lookup). Session cookie `aiq_sess` (httpOnly, Secure, SameSite=Lax, 8h sliding, 30min idle). Middleware order: `requestId → rateLimit → cookieParser → sessionLoader → tenantContext → requireAuth`.
- **`17-ui-system` — depends on nothing at runtime, depends on `AccessIQ_UI_Template/` for visual identity.** Tokens namespaced `--aiq-*` (template currently uses `--*` short names — **must rename during port**). OKLCH palette anchored at hue 258 (accent `oklch(0.58 0.17 258)`). Density unit `--u: 4px` (rescales for `compact`/`comfortable`). Fonts Newsreader (serif) + Geist (sans) + JetBrains Mono. Pill-shape buttons mandatory. Big numbers serif with `font-variant-numeric: tabular-nums`. Count-up + ScoreRing animations are brand signatures.

### Allowed APIs (cite-only — do not invent)
- **Postgres RLS:** `current_setting('app.current_tenant')::uuid` — set per-request via `SET LOCAL app.current_tenant = '<uuid>';`. (`docs/02-data-model.md:519–536`.)
- **Embed JWT verify:** algorithm whitelist must be `["HS256"]`; reject any other `alg`. (`docs/04-auth-flows.md:201`.)
- **Recovery code hash:** argon2id (params unspecified — **see open question 3**).
- **Master key:** `ASSESSIQ_MASTER_KEY`, 32-byte base64, used for AES-256-GCM envelope encryption of TOTP secrets, recovery codes, embed secrets.
- **TOTP issuer string:** literal `"AssessIQ"` in otpauth URI. (`docs/04-auth-flows.md:104`.)

### Anti-patterns to refuse
- Any `if (domain === "soc")` branch — domain lives in question packs (Phase 1), not in core/auth/tenancy code.
- Any RLS-bearing table created without the two policies (`tenant_isolation`, `tenant_isolation_insert`) — migration linter must reject.
- Importing **anything** from `modules/17-ui-system/AccessIQ_UI_Template/` at runtime. The template is reference design, not a library. Hand-port idioms into typed components under `modules/17-ui-system/src/components/`.
- Importing the template harness files: `design-canvas.jsx`, `tweaks-panel.jsx`, `.design-canvas.state.json` — these are tooling.
- Any `claude` / Claude Code / Anthropic API call from this phase. Phase 0 is grading-free.
- `JWT.verify(token, secret)` without `algorithms: ["HS256"]` — `alg: none` attack vector.
- TOTP verify without timing-safe comparison and without rate-limiting per-user (5 fails / 15 min lockout).

---

## Decisions captured (2026-04-30)

All seven open questions are now resolved. Originally: 3 user-blocking + 4 orchestrator-default. The user-blocking three were answered after a read-only VPS scan (`docker ps`, port survey, Caddyfile inspect).

| # | Decision | Source |
| --- | --- | --- |
| 1 | **Google OAuth client provisioned.** `client_id` + `client_secret` placed in repo-root `.env.local` (gitignored via `.env.*` rule). Redirect URI: `https://assessiq.automateedge.cloud/api/auth/google/cb`. `hd` restriction TBD by user during 01-auth coding. | User confirmation |
| 2 | **VPS path = `/srv/assessiq/`.** Matches the `/srv/roadmap/` precedent already on the box. `/srv/assessiq/` confirmed empty. `docs/06-deployment.md` rewritten to match. | VPS scan + CLAUDE.md rule #8 |
| 3 | Recovery codes: **8 chars Crockford base32** (excludes I/L/O/U), **10 codes/user**, argon2id **`m=65536, t=3, p=4`**. Single-use. | Orchestrator default |
| 4 | **Tailwind in.** `--aiq-*` CSS tokens are source of truth for color/typography; Tailwind theme reads from them; utilities accelerate layout/spacing. | Orchestrator default |
| 5 | Redis session key: **`aiq:sess:<sha256(token)>`** → JSON `{userId, tenantId, totpVerified, expiresAt, createdAt, ip, ua}`, EXPIRE 8h, sliding refresh on authenticated request. | Orchestrator default |
| 6 | Rate limits: **10/min/IP** on `/api/auth/*`, **60/min/user**, **600/min/tenant** aggregate. Token bucket in Redis. **IP source:** Caddy-normalized request (CF-Connecting-IP via global trusted_proxies in the existing Caddyfile), NOT raw `X-Forwarded-For`. | Orchestrator default + VPS scan |
| 7 | **Dedicated `assessiq-postgres` container** (Postgres 16 Alpine, named volume `assessiq_pgdata`). Not shared with ti-platform's TimescaleDB. Same call for **`assessiq-redis`**. Daily logical dump to `/var/backups/assessiq/`. | VPS scan: ti-platform's PG has hardcoded shared creds; isolation cleaner |

### Deploy reality (replaces the original "nginx + certbot in our Compose" plan)

The original plan assumed AssessIQ ships its own nginx + certbot. VPS scan revealed:

- **Caddy already owns 80/443** (container `ti-platform-caddy-1`, Caddyfile at `/opt/ti-platform/caddy/Caddyfile`, Cloudflare IPs already in `trusted_proxies`).
- **Cloudflare orange-cloud is in front** of `automateedge.cloud`. HTTP-01 challenge would fail through CF; CF Origin Certificate is the path of least resistance.
- **Existing Caddyfile uses bridge-gateway upstreams** (`172.17.0.1:<port>`) to reach roadmap and accessbridge across Docker networks.

Resolved deploy plan:

- AssessIQ stack runs on its own `assessiq-net` Docker network. Only `assessiq-frontend` exposes a host port: **9091** (chosen because nothing on the box uses 90xx; avoids 80/443 Caddy, 3000 ti-ui, 8000 ti-api, 8080-8300 accessbridge/ti-nginx, 8090 roadmap-web, 9090 accessbridge-nginx, 9200/9300 opensearch).
- A single new server block is **appended** to `/opt/ti-platform/caddy/Caddyfile` (with timestamped backup before reload). Block proxies `assessiq.automateedge.cloud` → `172.17.0.1:9091`. **No edits to ti-platform's `docker-compose.yml`** — matches the existing roadmap/accessbridge pattern, strictly additive.
- TLS at the origin: **Cloudflare Origin Certificate** (RSA 2048, 15-year), placed at `/opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.{pem,key}` (`chmod 0600` on the key). CF zone SSL/TLS mode set to **Full (Strict)**.
- DNS: A record `assessiq.automateedge.cloud` → VPS IPv4 (`72.61.227.64`), **Proxied** in Cloudflare.

The full block + apply procedure live in `docs/06-deployment.md` (rewritten in the same PR as this plan).

---

## Session plan

Five sessions. Three serial groups: **G0.A** (one session, blocks everything), **G0.B** (two parallel sessions), **G0.C** (two parallel sessions). Each session is a separate VS Code window with a fresh Claude conversation.

### Group G0.A — Foundation backbone (sequential, single session, blocking)

**Session 1 — `00-core` + repo bootstrap**

#### What to implement
1. **Repo bootstrap** (no module yet — root scaffold):
   - Root `package.json` with pnpm workspaces (`packages/*`, `modules/*/`).
   - Root `tsconfig.base.json` (strict, ES2023, NodeNext modules); per-module `tsconfig.json` extending the base.
   - Root `vitest.config.ts` (workspace-aware), `eslint.config.js` (flat config, `@typescript-eslint`), `.editorconfig`, `.gitignore` additions (`dist/`, `node_modules/`, `.env`, `coverage/`, `.turbo/`).
   - `.env.example` covering: `NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, `ASSESSIQ_MASTER_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_COOKIE_NAME=aiq_sess`, `EMBED_JWT_SECRET_PROVISION_MODE=per-tenant`, `BASE_URL=https://assessiq.automateedge.cloud`.
   - `docker-compose.yml` (at repo root) — copy verbatim from `docs/06-deployment.md` § docker-compose. Five services (no nginx, no certbot): `assessiq-postgres`, `assessiq-redis`, `assessiq-api`, `assessiq-worker`, `assessiq-frontend`. `assessiq-net` bridge network. Only `assessiq-frontend` publishes a host port (`9091:80`). Container names explicit per CLAUDE.md rule #8.
   - **No `infra/nginx/`** — Caddy on the VPS handles edge TLS. Caddyfile snippet to append lives in `docs/06-deployment.md` § Reverse-proxy plan and is applied during the Phase 0 G0.A deploy step (after Cloudflare Origin Cert is generated and copied to the VPS).
   - `.github/workflows/ci.yml` — Node 22, pnpm install, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, secrets-scan from `.claude/hooks/precommit-gate.sh` patterns, RLS-policy linter (next bullet).
   - `tools/lint-rls-policies.ts` — small CI script that scans `**/migrations/*.sql` and rejects any `CREATE TABLE … tenant_id …` that lacks both `CREATE POLICY tenant_isolation` and `tenant_isolation_insert`.

2. **`modules/00-core/src/`** — implement the contract from `modules/00-core/SKILL.md`:
   - `config.ts` — Zod schema → `export const config` (singleton, throws on invalid env at import).
   - `logger.ts` — pino-based; `createLogger()` and `childLogger(bindings)`; binds `requestId` from AsyncLocalStorage automatically.
   - `errors.ts` — class hierarchy (`AppError` → `ValidationError`, `AuthnError`, `AuthzError`, `NotFoundError`, `ConflictError`, `RateLimitError`); each has `code`, `httpStatus`, `cause?`, `details?`.
   - `request-context.ts` — `withRequestContext(ctx, fn)` and `getRequestContext()`; backed by `node:async_hooks` `AsyncLocalStorage<RequestContext>`.
   - `ids.ts` — `uuidv7()` (use the `uuidv7` npm package), `shortId()` (12-char Crockford base32, crypto-random).
   - `time.ts` — `nowIso()`, `parseIso(s)`; throws on non-UTC inputs.
   - `index.ts` — barrel re-exporting the public contract only (no internal helpers).
   - `__tests__/` — vitest for each module: errors round-trip, request-context isolation across `Promise.all`, ID format/uniqueness, time UTC enforcement.

3. **`modules/00-core/SKILL.md`** — annotate at the top with the resolved decisions for open questions 3, 4, 5, 6 (or a pointer if recorded elsewhere).

#### Documentation references
- `modules/00-core/SKILL.md:1–57` — full contract.
- `docs/01-architecture-overview.md:67–80` — Fastify request flow (`requestId` flows from Caddy via `X-Request-Id`; Caddy itself receives client IP via Cloudflare `CF-Connecting-IP`).
- `docs/06-deployment.md` — Compose + Caddyfile snippet + Cloudflare DNS settings + bootstrap procedure. **This is the deploy spec; copy verbatim.**
- `CLAUDE.md` rule #8 — VPS namespacing.

#### Verification checklist
- [ ] `pnpm install && pnpm -r typecheck` passes from a fresh clone.
- [ ] `pnpm -r test` runs and `modules/00-core` tests are all green.
- [ ] `docker compose -f infra/docker-compose.yml config` validates (does not run).
- [ ] `tools/lint-rls-policies.ts` runs against an empty migrations dir without error and rejects a synthetic missing-policy fixture.
- [ ] `.env.example` lists every var named above; no secrets committed.
- [ ] `grep -r "claude\|anthropic\|ANTHROPIC_API_KEY" modules/ packages/ infra/` returns zero hits (Phase 0 is grading-free; CLAUDE.md rule #1).

#### Anti-pattern guards
- Don't use `console.log`; use the logger.
- Don't use `Date.now()` directly anywhere outside `time.ts`; tests stub time via injected clock.
- Don't import from `node:crypto` outside `ids.ts` — keeps audit footprint small.
- Don't add a `claude-code` script to `package.json`. Don't add `@anthropic-ai/claude-agent-sdk` to dependencies.

#### DoD (CLAUDE.md rule #9)
1. Commit with conventional message: `feat(core): bootstrap repo + 00-core module`. Use the noreply env-var pattern (global `CLAUDE.md` § Git push).
2. Deploy: skip — pure scaffold has no runtime; `docker compose config` validation only.
3. Document: update `docs/06-deployment.md` to reflect `/srv/assessiq/` and `assessiq-*` container names if those changed; update `modules/00-core/SKILL.md` "Status: implemented" with a date.
4. Handoff: append session entry to `docs/SESSION_STATE.md` with the 4-line agent-utilization footer.

---

### Group G0.B — parallel after G0.A merges (two sessions, fully independent)

#### Session 2 — `02-tenancy`

##### What to implement
- **Migration `migrations/0001_tenants.sql`** — copy `CREATE TABLE tenants` verbatim from `docs/02-data-model.md:35–45`. Then `tenant_settings` table per the SKILL.md branding/auth_methods JSONB shapes.
- **Migration `migrations/0002_rls_helpers.sql`** — define the `assessiq_system` Postgres role with `BYPASSRLS`. Default app role is `assessiq_app` (no BYPASSRLS).
- **Migration `migrations/0003_tenants_rls.sql`** — apply the two-policy template from `docs/02-data-model.md:522–528` to `tenants` and `tenant_settings`. (For `tenants` itself, `tenant_id` is the row's `id` — special-case the policy as `id = current_setting('app.current_tenant')::uuid`.)
- **`modules/02-tenancy/src/repository.ts`** — Postgres queries via `pg` driver; every query goes through `withTenant` so the session var is set.
- **`modules/02-tenancy/src/service.ts`** — `getTenantById/BySlug/updateTenantSettings/suspendTenant`. `suspendTenant` writes audit-log placeholder for now (14-audit-log lands in Phase 3; emit a `console.warn` + TODO comment with `// TODO(audit)` so a future grep finds it).
- **`modules/02-tenancy/src/middleware.ts`** — Fastify `preHandler` decoder: reads `req.session?.tenantId` (set by 01-auth's sessionLoader; until 01-auth lands, accept a header `x-aiq-test-tenant` ONLY when `NODE_ENV !== 'production'`). On hit, opens a pg client, runs `SET LOCAL app.current_tenant = $1`, attaches `req.tenant`, `req.db`. Releases on `onResponse`.
- **`modules/02-tenancy/src/with-tenant.ts`** — programmatic equivalent of the middleware for worker/cron contexts (Phase 1+ usage).
- **`__tests__/`** — vitest with a real ephemeral Postgres (testcontainers-node); verifies (a) cross-tenant SELECT under RLS returns zero rows, (b) `assessiq_system` role bypasses RLS as expected, (c) middleware sets the session var and clears it.

##### Documentation references
- `modules/02-tenancy/SKILL.md` — full contract.
- `docs/02-data-model.md:35–70` (tenants + tenant_settings) and `:519–536` (RLS template).
- `CLAUDE.md` rule #4 (multi-tenancy guard) — Phase 3 critique will bounce diffs that violate this.

##### Verification checklist
- [ ] All three migrations apply cleanly to a fresh Postgres 16.
- [ ] `tools/lint-rls-policies.ts` passes against the new migrations.
- [ ] Cross-tenant isolation test: insert two tenants, set context to A, SELECT * from `tenant_settings` returns only A's row.
- [ ] BYPASSRLS test: connect as `assessiq_system`, SELECT returns both rows.
- [ ] `tenantContextMiddleware` releases pg client even on handler throw (try/finally test).

##### Anti-pattern guards
- No `WHERE tenant_id = $1` in repositories — RLS is the enforcement layer; double-filtering hides RLS bugs.
- No `pg_set_session_authorization` hacks; only `SET LOCAL`.
- Never log tenant settings JSONB at INFO — may contain logos/URLs that bleed cross-tenant in shared logs.

##### DoD
1. Commit `feat(tenancy): tenants table + RLS isolation + middleware`.
2. Deploy: this is load-bearing; rule #8 says **codex:rescue gate**. Run `codex:rescue` adversarial review on the migration + middleware diff; record outcome in handoff. After accepted: SSH to `assessiq-vps`, enumerate (`docker ps`, `systemctl list-units --running`), confirm purely additive, then `docker compose -f /srv/assessiq/docker-compose.yml up -d assessiq-postgres` + apply migrations.
3. Document: append to `docs/02-data-model.md` (tables marked Status: live), update `modules/02-tenancy/SKILL.md`.
4. Handoff: SESSION_STATE entry with codex:rescue verdict in the footer.

---

#### Session 3 — `17-ui-system` (port the template into a Vite SPA)

##### What to implement
1. **Bootstrap the SPA** at `apps/web/`:
   - Vite + React 18 + TypeScript template (`pnpm create vite apps/web --template react-ts`).
   - Tailwind installed and configured to read color/font from `--aiq-*` CSS vars (per question 4 default). `tailwind.config.ts` extends theme with `colors: { accent: 'oklch(var(--aiq-color-accent) / <alpha-value>)' }` etc.
   - `apps/web/src/styles/tokens.css` — token namespace **renamed from `--*` to `--aiq-*`**. Copy from `modules/17-ui-system/AccessIQ_UI_Template/styles.css`. Keep OKLCH values, density `--u`, fonts. Add `[data-theme="dark"]` block per `docs/08-ui-system.md`.
   - Wire fonts via `<link>` to Google Fonts: Newsreader 400/600/700, Geist 400/500/600, JetBrains Mono 400/500. (Self-host in Phase 1 if perf budget needs it.)
2. **Component library** at `modules/17-ui-system/src/`:
   - Port `Button` (pill, primary/outline/ghost, sm/md/lg sizes) — TypeScript component reading from `--aiq-*` vars.
   - Port `Card` (no shadow at rest, hover border).
   - Port `Input` + `Label` + `FieldHelp` (10px radius, 4px focus halo).
   - Port `Chip` (default/accent/success variants, 11px mono uppercase).
   - Port `Icon` (24-path SVG sprite from `screens/atoms.jsx`).
   - Port `Logo` (mark + wordmark).
   - Port `Num` (serif, tabular-nums, count-up via `useCountUp` hook from atoms.jsx).
   - **Defer to Phase 1 or later:** `ScoreRing`, `Sparkline`, `QuestionNavigator` — these belong to attempt/results screens and aren't needed in Phase 0.
3. **Storybook** at `apps/storybook/` — one story per component above. Each story documents the prop interface and shows light + dark + density-compact variants.
4. **Theme provider** — `<ThemeProvider tenantBranding={...}>` reads `tenants.branding` JSONB and injects `--aiq-color-accent` override on `:root`. Stub the data source for Phase 0 (read from a static JSON fixture); 02-tenancy wires the live source in Phase 1.

##### Documentation references
- `modules/17-ui-system/SKILL.md` — port contract and "do not import template files at runtime" rule.
- `docs/08-ui-system.md:41–104` — token layer + density mechanic.
- `docs/08-ui-system.md:190–212` — server-side theming resolver (stub for Phase 0).
- `docs/10-branding-guideline.md` — full visual spec; especially `:14–19` fonts, `:79–81` palette, `:160` pill rule, `:183–186` brand-signature animations.
- **Source idioms to copy from:** `modules/17-ui-system/AccessIQ_UI_Template/styles.css:1–142` (CSS), `screens/atoms.jsx:1–76` (Icon, Logo, useCountUp).
- **Do NOT copy from:** `design-canvas.jsx`, `tweaks-panel.jsx`, `.design-canvas.state.json`.

##### Verification checklist
- [ ] `pnpm --filter web dev` boots; visiting `/` shows a "tokens-ok" page rendering Button/Card/Chip/Num samples in all variants.
- [ ] `pnpm --filter storybook dev` lists every Phase 0 component; each has a working story.
- [ ] Visual smoke: density toggle (`data-density="compact|cozy|comfortable"`) rescales spacing as documented.
- [ ] Tenant theming smoke: `<ThemeProvider tenantBranding={{primary:'#1a73e8'}}>` overrides accent on its subtree only.
- [ ] No imports of `AccessIQ_UI_Template/**` from `apps/web` or `modules/**` (grep check + ESLint `no-restricted-imports` rule).
- [ ] All buttons render as pills (border-radius 999px) — visual snapshot or computed-style assertion.

##### Anti-pattern guards
- Don't export raw `--*` token names from the library — public surface is `--aiq-*` only.
- Don't add box-shadow to cards. Don't add square-cornered buttons. Don't render big numbers in sans-serif. (CLAUDE.md `docs/10-branding-guideline.md` invariants.)
- Don't introduce a CSS-in-JS library; tokens + Tailwind utilities only.
- Don't ship server-rendered theming yet; Phase 0 stub is a static fixture.

##### DoD
1. Commit `feat(ui-system): vite spa scaffold + design tokens + base components`.
2. Deploy: skip for Phase 0 (no public route yet); Compose `assessiq-frontend` will pick this up in G0.C session 5 once the auth flow renders a real screen.
3. Document: update `modules/17-ui-system/SKILL.md` ("Status: components ported — Button, Card, Input, Chip, Icon, Logo, Num. Deferred: ScoreRing, Sparkline, QuestionNav."), update `docs/08-ui-system.md` token-namespace migration note from "TODO" to "complete".
4. Handoff: SESSION_STATE entry.

---

### Group G0.C — parallel after G0.B merges (two sessions)

#### Session 4 — `01-auth` (LOAD-BEARING — codex:rescue mandatory before push)

##### What to implement
1. **Migrations** (`modules/01-auth/migrations/`):
   - `010_oauth_identities.sql`, `011_sessions.sql`, `012_totp.sql`, `013_recovery_codes.sql`, `014_embed_secrets.sql`, `015_api_keys.sql`. Schemas per `docs/04-auth-flows.md`.
   - All tables `tenant_id` + RLS where applicable. `sessions.token_hash` is `bytea` (sha256 of cookie value).
   - Apply RLS template; CI linter must pass.
2. **`src/google-sso.ts`** — endpoints `/api/auth/google/start`, `/api/auth/google/cb`. Verify `id_token` (RS256, JWKS cached, `iss=accounts.google.com`, `aud=GOOGLE_CLIENT_ID`, `exp`, `nonce` matches state cookie). Resolve user via `oauth_identities` then `users (tenant_id, email)`. Mint pre-MFA session.
3. **`src/totp.ts`** — `enroll/start` (generate 32-byte secret, encrypt with `ASSESSIQ_MASTER_KEY` AES-256-GCM, return otpauth URI with issuer `"AssessIQ"`), `enroll/confirm` (verify + persist), `verify` (timing-safe), `recovery` (Crockford base32 8-char codes, argon2id `m=65536, t=3, p=4`, 10 codes per user, single-use). Account lockout: 5 fails / 15 min via Redis counter.
4. **`src/sessions.ts`** — Redis schema `aiq:sess:<sha256(token)>` → JSON `{userId, tenantId, totpVerified, expiresAt, createdAt, ip, ua}`. TTL 8h, sliding refresh on each authenticated request, 30min idle eviction.
5. **`src/embed-jwt.ts`** — `mintEmbedToken(payload, tenantSecret)` (HS256), `verifyEmbedToken(token)` — **must whitelist algorithms `["HS256"]`** and reject any other. Replay cache: Redis SET keyed `aiq:embed:jti:<jti>` with TTL = `exp - now`.
6. **`src/api-keys.ts`** — generate `aiq_live_<32-char-random>`, store sha256 only, scopes per `modules/01-auth/SKILL.md`. Rate limit per key.
7. **`src/middleware/`** — `requestId`, `rateLimit` (token bucket: 10/min/IP for `/api/auth/*`, 60/min/user, 600/min/tenant), `cookieParser`, `sessionLoader`, `requireAuth`, `requireRole(role)`, `requireScope(scope)`. Stack order matches `docs/04-auth-flows.md:91–97`.
8. **Magic link** — `POST /api/take/start {token}` mints session with `totp_verified=true` (candidates skip MFA).
9. **`__tests__/`** — Vitest + supertest. Critical cases: `alg: none` rejection on embed JWT, expired session refused, idle timeout, replay-cache blocks reused JTI, TOTP timing-safe (no early-return on mismatch), recovery code single-use, account lockout after 5 fails.

##### Documentation references
- `modules/01-auth/SKILL.md` — public contract.
- `docs/04-auth-flows.md` — full flows; **especially:201** (HS256 whitelist), **:281** (security checklist), **:48–68** (Google callback).
- `docs/03-api-contract.md:282–284` — JWT signing snippet.
- Decisions from open questions 3, 5, 6 baked in.

##### Verification checklist
- [ ] All migrations apply; RLS-policy linter passes.
- [ ] Vitest suite green; coverage ≥ 90% on `src/totp.ts`, `src/embed-jwt.ts`, `src/sessions.ts`.
- [ ] `alg: none` token rejected; modified-payload-with-valid-sig rejected; expired token rejected; reused jti rejected.
- [ ] TOTP verify timing variance ≤ noise floor (microbenchmark; 100 iters of valid-vs-invalid difference < 1ms).
- [ ] Manual smoke: Google SSO end-to-end with the user's real Google account → lands on `/admin/mfa` with `aiq_sess` cookie set, `totp_verified=false`.
- [ ] After TOTP verify: session promoted, `req.session.totpVerified === true`, `requireAuth` passes.
- [ ] Magic link path: candidate session minted, `requireAuth` passes for `/api/take/*`, blocked from `/api/admin/*`.
- [ ] **codex:rescue adversarial review accepted** — record verdict in handoff.

##### Anti-pattern guards
- **NEVER** call `jwt.verify(token, secret)` without `algorithms: ["HS256"]`. The `alg: none` confusion is the canonical embed-JWT vuln.
- Never compare TOTP codes with `===`; use `crypto.timingSafeEqual`.
- Never log full session tokens, JWTs, or recovery codes — only `sha256` prefixes (first 8 chars) for tracing.
- Never skip the rate-limit middleware on auth endpoints in dev "for convenience" — leaks into staging.
- Don't add `claude` / `anthropic` / `claude-agent-sdk` imports anywhere. Phase 0 is grading-free.
- Don't set `SameSite=None` on `aiq_sess`; `Lax` per spec.

##### DoD
1. **Pre-commit:** Phase 2 deterministic gates pass (tests, secrets-scan, RLS linter, `TODO|FIXME|XXX` count). **Phase 3:** Opus reviews the diff. **codex:rescue** runs adversarial pass on auth + JWT + session code. Log verdict.
2. Commit `feat(auth): google-sso + totp + sessions + embed-jwt + api-keys`. Noreply env-var pattern.
3. Deploy: enumerate VPS, apply migrations as additive, restart `assessiq-api` only. Smoke endpoint: `curl -I https://assessiq.automateedge.cloud/api/auth/google/start` returns 302.
4. Document: `docs/04-auth-flows.md` Status fields → live; `docs/03-api-contract.md` confirms shipped endpoints; `modules/01-auth/SKILL.md` resolves the open questions.
5. Handoff: SESSION_STATE with **codex:rescue verdict line in the agent-utilization footer**.

---

#### Session 5 — `03-users` + admin login screen

##### What to implement
1. **Migration `020_users.sql`** — copy `CREATE TABLE users` verbatim from `docs/02-data-model.md:75–88` plus index `users (tenant_id, role) WHERE deleted_at IS NULL`. RLS policies applied.
2. **Migration `021_user_invitations.sql`** — record table only (token_hash and crypto live in 01-auth's session/totp tables).
3. **`modules/03-users/src/`** — implement the contract: `listUsers/getUser/createUser/updateUser/softDelete/restore/inviteUser/acceptInvitation`. Defer `bulkImport(csv)` to Phase 1 (out of Phase 0 scope; flag with `// TODO(phase-1): bulk CSV import`).
4. **`acceptInvitation(token)`** integrates with 01-auth: validates the invitation token, marks user `active`, mints a fresh session via `01-auth.sessions.create()`. **This is the only cross-module write coupling in Phase 0.**
5. **`13-notifications` stub** — `src/email-stub.ts` that logs invitation emails to the console + writes to a file at `/var/log/assessiq/dev-emails.log` in non-production. Real SMTP wiring is Phase 3. `inviteUser()` calls this stub.
6. **Frontend pages** in `apps/web/src/pages/`:
   - `/admin/login` — Google SSO start button (calls `/api/auth/google/start`). Editorial split-hero layout per `screens/login.jsx`.
   - `/admin/mfa` — TOTP enrollment (QR code) + verify form.
   - `/admin/users` — minimal list view (table of users in current tenant, role filter, status badge, invite button). Uses `Button`, `Chip`, `Input` from G0.B session 3.
7. **`__tests__/`** — vitest service tests + Playwright E2E for admin-login flow (mock Google), arriving at `/admin/users` after MFA.

##### Documentation references
- `modules/03-users/SKILL.md`.
- `docs/02-data-model.md:75–88` for users table.
- `docs/04-auth-flows.md` for invitation accept flow.
- `screens/login.jsx` for the visual reference (port idioms; do not import).

##### Verification checklist
- [ ] Migrations apply; RLS-policy linter passes.
- [ ] Service tests green.
- [ ] Playwright E2E: real Google SSO → MFA enroll → MFA verify → `/admin/users` shows the bootstrap admin user. Run in CI against a containerized stack.
- [ ] Soft-delete test: deleted user excluded from `listUsers` default; included with `?includeDeleted=true`.
- [ ] Invitation flow: `inviteUser({email})` → token in dev-emails log → `acceptInvitation(token)` mints session.
- [ ] Cross-tenant: admin in tenant A cannot see tenant B's users (RLS test against API).

##### Anti-pattern guards
- Don't bypass RLS by querying as `assessiq_system` from request handlers. System role is for ops/migrations only.
- Don't store invitation tokens plaintext; only `sha256(token)` in DB.
- Don't email candidates from this module — only admins/reviewers receive email in Phase 0. Candidates use magic links (handled by 01-auth + 05-assessment-lifecycle in Phase 1).
- Don't soft-delete admins without checking they aren't the last admin in the tenant — assert `tenant has ≥ 1 active admin` before commit.

##### DoD
1. Commit `feat(users): user crud + invitations + admin login flow`.
2. Deploy: additive — apply users migration, deploy `assessiq-frontend` for the first time. Verify with smoke E2E from a real browser.
3. Document: `modules/03-users/SKILL.md` Status: live (Phase 0 surface); `docs/03-api-contract.md` user endpoints confirmed; `docs/04-auth-flows.md` admin-login flow marked live.
4. Handoff: SESSION_STATE entry. Phase 0 closes here.

---

## Final phase — Phase 0 verification (orchestrator-only, no new session)

After all five sessions land, the orchestrator runs a single verification pass:

1. **Manual full-stack smoke** — fresh browser, hit `https://assessiq.automateedge.cloud/admin/login`, complete Google SSO → MFA enroll → land on `/admin/users`. Invite a second admin via the UI; accept the invitation in another browser session; verify both admins coexist.
2. **Tenant isolation drill** — using `assessiq_system` role, insert a second tenant and a user in it. As the first tenant's admin, hit `/api/users` and confirm the second tenant's user is NOT in the response.
3. **Token whitelist drill** — craft an `alg: none` embed JWT and hit `/embed?token=...`; expect 401.
4. **Replay drill** — replay a valid embed JWT; second use returns 401.
5. **VPS additive-deploy audit** — `ssh assessiq-vps`, run `docker ps` (only `assessiq-*` added), `systemctl list-units --state=running --no-pager` (no new units expected), `diff /opt/ti-platform/caddy/Caddyfile.bak.<latest> /opt/ti-platform/caddy/Caddyfile` (only the AssessIQ server block appended; no other lines changed), `ls /opt/ti-platform/caddy/ssl/` (only the new `assessiq.automateedge.cloud.{pem,key}` files added). Confirm no other apps' configs or containers touched.
6. **Doc drift sweep** — for each module: `SKILL.md` Status field reflects live; `docs/02-data-model.md`, `docs/03-api-contract.md`, `docs/04-auth-flows.md`, `docs/06-deployment.md`, `docs/08-ui-system.md`, `docs/10-branding-guideline.md` all reflect what shipped. Phase 0 entry appended to a Phase Log section in `PROJECT_BRAIN.md`.
7. **codex:rescue final pass** on the merged Phase 0 surface — security-adjacent diff is the entire 01-auth + 02-tenancy footprint plus middleware order. Log final verdict.

If any step fails: open one bounce-back session, fix, re-verify the failed step only.

---

## Routing summary (for future-me)

| Activity | Where |
|---|---|
| This plan | Anyone reads `docs/plans/PHASE_0_KICKOFF.md` |
| Each session's day-one read | `PROJECT_BRAIN.md` + `docs/01-architecture-overview.md` + this file's session block + the module's `SKILL.md` |
| Subagent delegation inside a session | Per global `CLAUDE.md` orchestration playbook (Sonnet for mechanical implements, Haiku for grep sweeps, Opus for diff critique) |
| Adversarial review | `codex:rescue` for sessions 2 (RLS), 4 (auth) — mandatory; sessions 1, 3, 5 — judgment call |
| Out-of-scope deferrals | bulk CSV import, ScoreRing, Sparkline, QuestionNav, real SMTP, audit-log writes, dark-mode toggle UI, custom domains per tenant — all noted in their respective SKILL.md as "Phase 1+" |

---

## Status

- **Plan version:** 1.0 (2026-04-30, orchestrator: Opus 4.7)
- **Open questions outstanding:** 1, 2, 7 (user); 3, 4, 5, 6 default to orchestrator decisions captured above
- **Next action:** orchestrator pings user with the three user-blocking questions; on answers, runs a one-commit "decisions captured" PR updating relevant `SKILL.md`s; then opens session 1.
