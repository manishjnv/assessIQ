# 02-tenancy — Multi-tenant isolation

## Purpose
Tenant CRUD, settings, branding, and the runtime mechanism that pins every request and DB query to the correct tenant. Enforces isolation at three layers: middleware (request scope), repository (query is RLS-only — no double filter), and database (RLS policies).

## Scope
- **In:** `tenants` and `tenant_settings` CRUD; tenant resolver from session/JWT/API key; `set_config('app.current_tenant', ...)` per request; RLS policy management; tenant lifecycle (suspend, archive); branding upload + serving; embed-origin allow-list management.
- **Out:** users (03), assessments (05), the visual theming pipeline (17 reads `tenants.branding` but doesn't write).

## Dependencies
- `00-core` (config, logger, errors)
- `14-audit-log` (every tenant settings change is audited — landing in Phase 3)

## Public surface
```ts
// service
getTenantById(id): Promise<Tenant>
getTenantBySlug(slug): Promise<Tenant>      // Phase 1 — requires withSystemRole
updateTenantSettings(id, patch): Promise<TenantSettings>
suspendTenant(id, reason): Promise<void>

// middleware — Fastify hook pair (preHandler + onResponse)
tenantContextMiddleware(): TenantContextHooks
//   .preHandler  : acquire pg client, BEGIN, SET LOCAL ROLE assessiq_app,
//                  set_config('app.current_tenant', $1, true), attach req.tenant + req.db
//   .onResponse  : COMMIT (2xx/3xx) or ROLLBACK (4xx/5xx), release client

// repo helper — programmatic equivalent of the middleware for worker/CLI/cron
withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>

// pool — singleton, lazy
getPool(): pg.Pool
closePool(): Promise<void>
setPoolForTesting(connectionString): Promise<pg.Pool>   // test escape hatch, not exported via index.ts
```

`tenantContextMiddleware` returns the two Fastify hook functions (`preHandler`, `onResponse`) rather than a single `preHandler`. The 01-auth session loader will register both hooks once on the Fastify instance in G0.C session 4. Phase 0 deliberately avoids a hard `fastify` dependency — hooks are structurally typed against `TenantRequest` / `TenantReply` interfaces so tests exercise them without booting the framework.

## Data model touchpoints
Owns: `tenants`, `tenant_settings`. Migrations at `modules/02-tenancy/migrations/`:
- `0001_tenants.sql` — `pgcrypto` extension; `tenants` and `tenant_settings` tables; RLS + two policies on `tenant_settings`.
- `0002_rls_helpers.sql` — `assessiq_app` (no BYPASSRLS) and `assessiq_system` (BYPASSRLS) roles; baseline GRANTs and `ALTER DEFAULT PRIVILEGES` so future tables inherit.
- `0003_tenants_rls.sql` — RLS + two policies on `tenants` itself (custom: `id = current_setting(...)`).

Migrations apply via `psql` on the VPS; a generic `tools/migrate.ts` runner is deferred to G0.C/01-auth which has six migrations and benefits more.

## Critical: RLS policy template
```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation_insert ON <table>
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

The `, true` second arg to `current_setting` makes it return NULL instead of erroring when the GUC is unset. The comparison `tenant_id = NULL` evaluates FALSE (SQL three-value logic), so an unauthenticated session sees zero rows — fail-closed. Without `, true` an un-set context throws "unrecognized configuration parameter", a worse failure mode.

Every new domain table MUST get this two-policy template in the **same migration file** as the `CREATE TABLE`. The linter (`tools/lint-rls-policies.ts`) enforces this per-file. The `tenants` table is a documented special case — its own `id` is the tenant key (see `0003_tenants_rls.sql`).

## System-level escapes
`assessiq_system` has `BYPASSRLS`. Used only for: cross-tenant analytics, support tooling, backups, **and tenant creation** (the `tenants_isolation_insert WITH CHECK (id = current_setting(...))` policy means a non-bypass role cannot insert a new tenant before its own context exists). Every query under this role must be audited via `14-audit-log` (Phase 3). A `withSystemRole(fn)` helper is deferred until 14-audit-log lands so every system-role op gets an audit row by construction.

`getTenantBySlug` is part of the public surface but throws in Phase 0 — slug-lookup happens before tenant context is established (login flow), so it requires `withSystemRole`. Phase 1 wires it in.

## Connection / role posture
- Production `DATABASE_URL` should connect as `assessiq_app` (created by `0002_rls_helpers.sql`, no password — set via `ALTER ROLE` from a Docker secret post-migration). Migrations run as the postgres superuser (`POSTGRES_USER` from compose).
- `withTenant` and the middleware both run `SET LOCAL ROLE assessiq_app` defensively inside the per-call transaction. If `DATABASE_URL` accidentally connects as the superuser (dev mistake), this re-engages RLS within the transaction. In production where the URL already targets `assessiq_app`, it's a cheap no-op.

## Anti-patterns refused (CLAUDE.md hard rule #4)
- `WHERE tenant_id = $1` in `tenant_settings` queries — RLS is the enforcement layer; double-filtering masks RLS bugs (a misconfigured BYPASSRLS role would still return the right row via WHERE — silent regression).
- `pg_set_session_authorization` — only `SET LOCAL ROLE` + `set_config(..., true)`.
- INFO-level logging of `tenant_settings` JSONB — may leak branding URLs, webhook URLs.
- Importing from this module without first establishing a tenant context — the API surface is built around `withTenant` / `tenantContextMiddleware`.

## Help/tooltip surface
- `admin.settings.tenant.branding` — how branding fields propagate to UI
- `admin.settings.tenant.domain` — how domain restriction works with SSO
- `admin.settings.embed-origins` — what origins to add and why
- `admin.settings.data-region` — implications for compliance

## Open questions
- Tenant deletion (vs archive) — deferred; keeps things simpler
- Per-tenant custom domains (`assess.client.com`) — Phase 3 with TLS via ACME-DNS
- `withSystemRole(fn)` helper — deferred until `14-audit-log` so every system-role op is audited by construction (Phase 1+).

## Status

**Implemented — 2026-05-01 (Phase 0 Session 2 / G0.B-2).**

- 3 migrations applied to ephemeral testcontainer postgres + integration tests passing.
- 11/11 vitest cases passing (1 documented `test.todo` for production-NODE_ENV header rejection — blocked by 00-core's eager config singleton, unblocks in Phase 1 with config injection).
- Public surface: `getTenantById`, `updateTenantSettings`, `suspendTenant`, `tenantContextMiddleware`, `withTenant`, `getPool`/`closePool`. `getTenantBySlug` deferred to Phase 1 (`withSystemRole` dependency).
- codex:rescue verdict: **accepted** with one Phase 4 revision (INSERT-policy test added) — see `docs/SESSION_STATE.md` agent-utilization footer.
