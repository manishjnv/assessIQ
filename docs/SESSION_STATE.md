# Session — 2026-05-01 (Phase 0 closure — W4 + W5 triage)

**Headline:** Phase 0 closed — G0.C-4 (01-auth, `d9cfeb4`) + G0.C-5 mock-seam swap (`be96623`) shipped after triage of a 30+ file stalled working tree from two parallel sessions; W5 (`1e403e0`) and observability (`f402637`) had already shipped between sessions.

**Commits this session:**

- `d9cfeb4` — feat(auth): google-sso + totp + sessions + embed-jwt + api-keys (41 files, +6358)
- `be96623` — fix(users): swap acceptInvitation mock seam for real @assessiq/auth.sessions (7 files, +82/-64)

**Tests:** 99/100 @assessiq/auth (1 documented constant-time microbenchmark flake under noisy local Docker), 27/27 @assessiq/users with real-auth integration, workspace typecheck 9/9 clean, RLS linter green (11 migrations / 9 tables), secrets scan + ambient-AI grep clean.

**Next:** Open Phase 1 G1.A per [docs/plans/PHASE_1_KICKOFF.md](plans/PHASE_1_KICKOFF.md) — `04-question-bank` standalone module.

**Open questions:**

- Container-side deploy of `assessiq-api` + `assessiq-worker` + `assessiq-redis` is blocked on Dockerfiles at `infra/docker/` (carry-forward from f402637 SESSION_STATE). Until the API container ships, Phase 0 closure steps 1, 3, 4 (manual full-stack smoke / alg=none drill / replay drill) are deferred to "first api deploy." Steps 2 (tenant isolation) and 5 (VPS additive audit) executed and passed live.
- `apps/api/src/routes/auth/*.ts` Fastify route layer doesn't yet exist. The library (`@assessiq/auth.{startGoogleSso, handleGoogleCallback, totp.*, verifyEmbedToken, ...}`) is ready; the routes that wrap those library calls into HTTP endpoints are the next deliverable. The `apps/web` admin UI shipped in W5 (`/admin/login`, `/admin/mfa`, `/admin/invite/accept`) currently calls a dev-auth shim — `FIXME(post-01-auth)` markers in `apps/web` + `apps/api/src/middleware/dev-auth.ts` mark every swap site.
- `tools/migrate.ts` lexical sort puts `010_oauth_identities.sql` before `020_users.sql`, which would FK-fail on a fresh DB. Production avoided this because W2 + W5 migrations were applied via `psql -f` before W4 migrations existed. Phase 1 should rewrite migrate.ts to topological-sort by FK references or to apply per-module-directory in declared dependency order. Test-side workaround landed in `modules/03-users/src/__tests__/users.test.ts:125-156`.
- `api-keys.ts:215-223` fire-and-forget `last_used_at` UPDATE silently no-ops under RLS without tenant context — wrap in `withTenant` or system role. Audit field, not security. Phase 1 follow-up.
- `totp.ts:125-135` `recordFailure` post-crash TTL drift — INCR may run without a subsequent EXPIRE if the process dies between the two calls, persisting `FAIL_KEY` indefinitely (operational annoyance: 6th fail after auto-unlock immediately re-locks). Phase 1 follow-up.

---

## Agent utilization

- **Opus:** Phase 0 warm-start parallel reads (PROJECT_BRAIN, 01-architecture-overview, SESSION_STATE for f402637, RCA_LOG, PHASE_0_KICKOFF, modules/01-auth/SKILL.md, modules/03-users/SKILL.md, modules/02-tenancy/SKILL.md, plus `git status` + `git log`); reality-check that surfaced "W5 already shipped, W4 is staged but not committed" before any code touched; full Phase B gate sweep (workspace typecheck, RLS linter, secrets scan, ambient-AI grep, `pnpm -r test`); Phase 5 invariant verification by direct read of every staged 01-auth source file + all 6 migrations (HS256 whitelist + decode-header fast-reject, `keyDecoder` round-trip, SADD per-user index carry-forward at sessions.ts:133-134, CF-Connecting-IP fail-closed in production, `normalizeEmail` carry-forward in google-sso.ts:331, RLS two-policy template on every tenant-bearing table, fail-closed `current_setting(..., true)` semantics); Opus-direct adversarial review (codex:rescue takeover by user request) yielding 3 documented Phase 1 follow-ups, of which #1 was patched inline (require-auth.ts:66-77 — API-key paths now throw `AuthzError` on `roles`/`freshMfa` gates instead of silently passing); commit + push of W4 (`d9cfeb4`) with the noreply env-var pattern; mock-seam swap in 03-users (real `@assessiq/auth.sessions` import + Redis testcontainer + dependency-ordered migration apply + real-token assertion in test); commit + push of swap (`be96623`); VPS deploy enumeration + additive `psql -f` apply of migrations 010-015 to `assessiq-postgres` (verified 10 tables / 20 RLS policies / cross-tenant isolation drill PASSED via `assessiq_app` role + `app.current_tenant` GUC); Caddyfile diff confirms only the AssessIQ block changed; SKILL.md + 04-auth-flows.md + 03-api-contract.md status-field updates; RCA_LOG.md W4+W5 stall entry; this handoff.
- **Sonnet:** n/a — every change in this triage was either a small targeted edit (require-auth patch, mock-seam swap, test-setup edits) or a verification read against an existing addendum-pinned contract. No mechanical N-file rollouts where Sonnet would beat Opus self-execution. Cache stayed warm across the W4 source reads, making direct edits cheaper than subagent cold-start.
- **Haiku:** n/a — no bulk multi-file fact-distillation needed. The VPS post-deploy enumeration was a single SSH call returning a small structured table; the Caddyfile diff was a single command; the schema_migrations + table-list queries were `psql` one-liners.
- **codex:rescue:** **takeover (opus-direct) — accepted.** User explicitly invoked "opus takeover" (twice) when codex:rescue was about to fire on the W4 diff per global CLAUDE.md security/auth/classifier rule. Opus performed the full adversarial pass directly against every staged source file + 6 migrations, plus the mock-seam swap diff. Verdict: accepted (no must-fix-before-push items). Three Phase-1 follow-ups recorded above; finding #1 patched inline. Codex CLI runtime itself is healthy and stop-time review gate is enabled (per the runtime status line that landed in this file during codex:setup discovery).

---

## Detail — what changed at the file level

**Code (load-bearing — Opus-authored, Opus diff-reviewed line-by-line — 2 commits this session):**

Commit `d9cfeb4` — W4 (01-auth):

- `modules/01-auth/migrations/010-015` — 6 SQL files, all with `tenant_id` denormalized + standard two-policy RLS template + `current_setting(..., true)` fail-closed; tables `oauth_identities`, `sessions`, `user_credentials` (TOTP), `totp_recovery_codes`, `embed_secrets`, `api_keys`.
- `modules/01-auth/src/embed-jwt.ts` (355 lines) — HS256-only verify with decode-header fast-reject, two-key rotation grace (sig-mismatch only), JTI replay cache via Redis SET NX, 600s lifetime cap, iat-future-skew check, audience-locked.
- `modules/01-auth/src/totp.ts` (425 lines) — RFC 4226 20-byte SHA-1, ±1 drift, AES-256-GCM envelope, `crypto.timingSafeEqual` via `constantTimeEqual`, `keyDecoder` round-trip per RCA, 5/15min Redis lockout, argon2id m=65536/t=3/p=4 recovery codes.
- `modules/01-auth/src/sessions.ts` (281 lines) — Redis-first cache + Postgres durable mirror via `withTenant`, 8h sliding TTL, 30min idle eviction, sweep-on-disable per-user index (`SADD aiq:user:sessions:<userId>` + `EXPIRE 9h` carry-forward from 03-users SKILL § 7).
- `modules/01-auth/src/google-sso.ts` (456 lines) — RS256 JWKS verify with hard `algorithms:["RS256"]`, state+nonce CSRF via `constantTimeEqual`, `normalizeEmail` carry-forward, JIT-link via `INSERT ... ON CONFLICT DO NOTHING`, status-active + deleted_at-null guards.
- `modules/01-auth/src/api-keys.ts` (246 lines) — `aiq_live_<43-char base62>` (256-bit entropy), sha256 storage, plaintext returned once, system-role lookup (the only auth-path BYPASSRLS use), `admin:*` wildcard scope.
- `modules/01-auth/src/middleware/{request-id,cookie-parser,rate-limit,session-loader,api-key-auth,require-auth,types,index}.ts` — full auth chain. `rate-limit.ts` uses three independent Redis-Lua atomic buckets (10/60s IP, 60/60s user, 600/60s tenant) with CF-Connecting-IP fail-closed in production. `session-loader.ts` does defense-in-depth user-status check (catches sessions that survived the disable sweep). `require-auth.ts` patched in-this-commit so role / freshMfa gates throw `AuthzError` on API-key-backed requests instead of silently passing.
- `modules/01-auth/src/{crypto-util,redis,magic-link,types.d}.ts` — AES-256-GCM envelope + sha256/constantTimeEqual/randomToken helpers; lazy ioredis singleton with test escape-hatch; candidate-session helper for Phase 1 magic-link route layer; Fastify type augmentation for `req.session` / `req.apiKey` / `req.cookies`.
- `modules/01-auth/src/__tests__/{api-keys,embed-jwt,google-sso,middleware,sessions,totp}.test.ts` — 100 vitest cases against postgres:16-alpine + redis:7-alpine testcontainers.
- `modules/01-auth/{package.json,tsconfig.json,vitest.config.ts,.gitignore}` — workspace member `@assessiq/auth`.
- Spillover (additive only): `modules/00-core/vitest.config.ts`, `modules/02-tenancy/vitest.config.ts` (resolves the silent-skip RCA where root-config include patterns failed to match per-module test runs); `modules/02-tenancy/src/index.ts` re-exports `setPoolForTesting` (cross-module test reach); `vitest.setup.ts` adds three Google SSO test placeholders; `.gitignore` adds AGENTS.md.

Commit `be96623` — mock-seam swap:

- `modules/03-users/src/invitations.ts` — `import { sessions } from '@assessiq/auth'` replaces local mock import.
- `modules/03-users/src/__mocks__/auth-sessions.ts` — DELETED.
- `modules/03-users/package.json` — adds `@assessiq/auth: workspace:*`.
- `modules/03-users/SKILL.md` — Status section updated from "mock seam" to integrated.
- `modules/03-users/src/__tests__/users.test.ts` — adds redis:7-alpine container, dependency-ordered migration apply (tenancy → users(020) → auth(010-015) → invitations(021) instead of pure lexical), real-token assertion (43-char base64url) replacing `/^mock_/`.
- `modules/01-auth/src/index.ts` — exports `setRedisForTesting` + `closeRedis` (test escape hatch parity with `02-tenancy.setPoolForTesting`).

**Docs:**

- `modules/01-auth/SKILL.md` — added `## Status` section (live, codex:rescue verdict, three Phase-1 follow-ups recorded).
- `docs/04-auth-flows.md` — Flow 1 status note rewritten from "Window 5 UI live, W4 pending" to "Window 4 closure — library + DB layer LIVE end-to-end."
- `docs/03-api-contract.md` — Admin tenants & users status note rewritten from "Window 5 user-management slice live" to "Phase 0 closure — W4 + W5 both shipped, route-layer Fastify wiring is the next deliverable."
- `docs/RCA_LOG.md` — appended W4+W5 stall RCA at top (parallel-session-without-worktree-isolation incident, with prevention rules + the migrate.ts ordering follow-up).

**Why this design (the "considered and rejected" list per DoD detail rule):**

- *codex:rescue subagent for the adversarial pass* — rejected for THIS diff because the user explicitly invoked "opus takeover." Cache was warm across all 24 staged source files + 6 migrations, so Opus-direct review was both faster and (per user signal) preferred. The verdict format mirrored what codex:rescue produces: explicit accept/revise/reject + numbered must-fix list + summary. Future security/auth diffs default back to codex:rescue per CLAUDE.md unless the user takes over again.
- *Squashing the mock-seam swap into the W4 commit* — rejected. The swap is a clean documented post-merge follow-up per `modules/03-users/SKILL.md` § 12 ("5-line follow-up commit"); squashing buries a real cross-module wiring change inside a 6358-line auth diff and makes the commit history less recoverable. Two commits cleaner.
- *Patching follow-ups #2 and #3 in this session* — rejected. #1 (require-auth foot-gun) was a 3-line change that fit cleanly into the W4 commit and tightened the contract before push. #2 (api-keys last_used_at RLS no-op) and #3 (TOTP recordFailure TTL drift) need either an integration-test sketch or wider thinking about test-only DB connections; not in this triage's scope. Recorded as Phase-1 follow-ups in SKILL.md + this handoff.
- *Bootstrapping `schema_migrations` on the VPS during this deploy* — rejected. The migration runner has a separate latent ordering bug; doing the bootstrap now would commit to a checksum baseline that the next migrate.ts run might re-apply. `psql -f` direct apply matches the W2/W5 deploy pattern and is idempotent. Phase 1 should rewrite migrate.ts (topological sort) AND backfill `schema_migrations` together.
- *Live API smoke (`curl -I /api/auth/google/start` expecting 302)* — rejected because no API container is running on the VPS yet (Caddy returns the Phase-0 placeholder 200 per the prior 502 RCA). Closure verification steps 1, 3, 4 are deferred to "first api deploy" — explicitly out-of-scope for this session per SESSION_STATE for f402637 ("Container-side deploy of `assessiq-api` + `assessiq-worker` not in this session's scope — needs Dockerfiles which still don't exist at `infra/docker/`").
