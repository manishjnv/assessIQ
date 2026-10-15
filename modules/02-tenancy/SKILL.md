# 02-tenancy — Multi-tenant isolation

## Purpose
Tenant CRUD, settings, branding, and the runtime mechanism that pins every request and DB query to the correct tenant. Enforces isolation at three layers: service call sites (`withTenant`, request scope), repository (query is RLS-only — no double filter), and database (RLS policies). **FU-D6 (2026-10-06):** the request-scope layer is `withTenant` called from each route/service, not a registered Fastify middleware — see `src/middleware.ts` header (SUPERSEDED) and `apps/api/src/middleware/auth-chain.ts` for the real chain.

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
renameTenant(adminUserId, tenantId, rawName): Promise<RenameTenantResult>  // tenant-admin renames OWN company; normalizeTenantName (2-120, collapse ws, no control chars); UPDATE tenants.name + 1 tenant.renamed auditInTx in one tx; same-name = noOp. Route: PATCH /api/admin/tenant. Display-only: never touches slug/id/status.

// middleware — Fastify hook pair (preHandler + onResponse) — SUPERSEDED, NOT REGISTERED (FU-D5/FU-D6, 2026-10-06): see src/middleware.ts header
tenantContextMiddleware(): TenantContextHooks
//   .preHandler  : acquire pg client, BEGIN, SET LOCAL ROLE assessiq_app,
//                  set_config('app.current_tenant', $1, true), attach req.tenant + req.db
//   .onResponse  : COMMIT (2xx/3xx) or ROLLBACK (4xx/5xx), release client

// repo helper — programmatic equivalent of the middleware for worker/CLI/cron
withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>

// system-role helper (RW-38, 2026-10-11) — the only sanctioned way to run under assessiq_system
withSystemRole<T>(reason: string, fn: (client: PoolClient) => Promise<T>): Promise<T>

// pool — singleton, lazy
getPool(): pg.Pool
closePool(): Promise<void>
setPoolForTesting(connectionString): Promise<pg.Pool>   // test escape hatch, not exported via index.ts
```

`tenantContextMiddleware` returns the two Fastify hook functions (`preHandler`, `onResponse`) rather than a single `preHandler`. **FU-D6 (2026-10-06): corrected — this hook pair is SUPERSEDED and not registered anywhere.** The 01-auth session loader does not register these hooks; tenant context is established per call site via `withTenant`. Phase 0 deliberately avoids a hard `fastify` dependency — hooks are structurally typed against `TenantRequest` / `TenantReply` interfaces so tests exercise them without booting the framework.

## Data model touchpoints
Owns: `tenants`, `tenant_settings`. Migrations at `modules/02-tenancy/migrations/`:
- `0001_tenants.sql` — `pgcrypto` extension; `tenants` and `tenant_settings` tables; RLS + two policies on `tenant_settings`.
- `0002_rls_helpers.sql` — `assessiq_app` (no BYPASSRLS) and `assessiq_system` (BYPASSRLS) roles; baseline GRANTs and `ALTER DEFAULT PRIVILEGES` so future tables inherit.
- `0003_tenants_rls.sql` — RLS + two policies on `tenants` itself (custom: `id = current_setting(...)`).

Migrations apply via `psql` on the VPS. The generic runner `tools/migrate.ts` exists, but production does not use it (state 2026-10-02): older migrations were applied by hand and `schema_migrations` is incomplete. New migrations are applied by hand, one by one, in number order, before the image rebuild. See `docs/06-deployment.md` § "Applying new migrations by hand".

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
`assessiq_system` has `BYPASSRLS`. Used only for: cross-tenant analytics, support tooling, backups, **and tenant creation** (the `tenants_isolation_insert WITH CHECK (id = current_setting(...))` policy means a non-bypass role cannot insert a new tenant before its own context exists). Every use goes through `withSystemRole(reason, fn)` (RW-38, commit `66a7c50`).

**`withSystemRole(reason, fn)` contract.**
- `reason` must be a non-empty string. Otherwise it throws `ValidationError` (`INVALID_SYSTEM_ROLE_REASON`).
- It runs `BEGIN`, then `SET LOCAL ROLE assessiq_system`, then `fn`. It uses `COMMIT` on success and `ROLLBACK` on error.
- It logs `system-role.tx` with `{reason, caller}` (stream `app`) before the transaction starts.
- It uses the same `onCommit` hook model as `withTenant`. Hooks run after `COMMIT`.
- It throws `SYSTEM_ROLE_INSIDE_TENANT` when called inside a `withTenant` scope (`AsyncLocalStorage` marker). Open the system transaction first, or use two separate calls.
- Mixed pattern: read under the system role, then `SET LOCAL ROLE assessiq_app` plus `set_config('app.current_tenant', ...)` for an audited tenant write in the same transaction. This is allowed. Comment the switch at each site.

**Raw connects.** `tools/pool-connect.allowlist.txt` lists the files that may call `pool.connect()` directly (four entries, each with a reason). `pnpm lint:rls` fails on an unlisted raw connect and on a stale entry. Details: `docs/02-data-model.md` § "Row-Level Security policies".

**Audit.** The helper does not write an audit row. An audit row needs a tenant, and many system reads are cross-tenant. A caller that changes tenant data writes its own `auditInTx` row in the tenant part of the transaction.

`getTenantBySlug` is part of the public surface but throws in Phase 0 — slug-lookup happens before tenant context is established (login flow), so it requires `withSystemRole`. The helper now exists (RW-38); `getTenantBySlug` itself is still not wired.

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

## Status

**Implemented — 2026-05-01 (Phase 0 Session 2 / G0.B-2).**

- 3 migrations applied to ephemeral testcontainer postgres + integration tests passing.
- 11/11 vitest cases passing (1 documented `test.todo` for production-NODE_ENV header rejection — blocked by 00-core's eager config singleton, unblocks in Phase 1 with config injection).
- Public surface: `getTenantById`, `updateTenantSettings`, `suspendTenant`, `tenantContextMiddleware`, `withTenant`, `getPool`/`closePool`. `getTenantBySlug` deferred to Phase 1. `withSystemRole` landed later (RW-38, 2026-10-11).
- codex:rescue verdict: **accepted** with one Phase 4 revision (INSERT-policy test added) — see `docs/SESSION_STATE.md` agent-utilization footer.


## Tenant result release mode (SP2, 2026-10-01)

Migration `0114` adds `tenant_settings.result_release_mode` (`manual` default | `auto`) and `result_release_auto_since` (NULL while manual). `updateResultReleaseMode(adminUserId, tenantId, mode)` is the only mutator (not part of the generic settings patch): UPDATE + one `tenant.settings.updated` audit row in one tx; manual→auto stamps `result_release_auto_since = now()`, auto→manual clears it; a same-mode request is a no-op (no write, no audit). The auto-release sweep (apps/api worker) only publishes attempts whose evaluation was released at/after `result_release_auto_since`, so switching to auto never releases results already waiting (the admin uses bulk release for those).

## `createTenant` audit row (RV59, 2026-10-03)

`createTenant` now uses its super-admin id and writes one `tenant.provisioned` audit row with `auditInTx` inside its own transaction, in the NEW tenant's audit log (same rule as `suspendTenant`). Actor = the super admin, entity = the new tenant, `after = { slug, name }` (`name` is redacted by the sanitizer). The route's later `tenant.created` row and its failure row are unchanged. Tests: `audit-writes.test.ts`, `create-tenant.test.ts`. See docs/11 section 30.6.

## `withTenant` `onCommit` hook (FR2 FU-B5, 2026-10-03)

`onCommit(client, hook)` in `src/with-tenant.ts` registers a function that runs after COMMIT and after `client.release()`. It never runs on rollback. It returns `false` and drops the hook if the client is not inside an open `withTenant`. A hook error is swallowed (the work is already committed); the hook owns its own logging, as `fanoutAuditEvent` does. Used by `auditInTx` (module 14) for webhook fan-out. Other transaction helpers (raw `BEGIN`) have no hooks. Test: `src/__tests__/with-tenant-on-commit.test.ts`.

## Archived-tenant purge (RW-48b, 2026-10-15)

`purgeArchivedTenants({ now, enabled, minDays })` in `src/purge.ts`. Nightly job `tenant-purge-cron` (03:30 UTC, `apps/api/src/worker.ts`, no AI). Selects `status='archived'` tenants whose `updated_at` is at least 180 days old (`minDays` clamps to 180 or more; `updated_at` is the archive time, there is no `archived_at`). Skips the platform tenant. Per tenant, in one `withSystemRole` tx: deletes every `tenant_id` row from all public tables except `audit_log`, `tenants` and `users`, plus rows of no-`tenant_id` tables that FK to the tenant's users (table list and FK order come from the catalog); users stay as pseudonymised tombstones (as in 20-data-rights erasure), counted as `users_pseudonymised`, sets `status='purged'` (tombstone, migration `0170_tenant_purge.sql`), writes one `tenant.purged` audit row with per-table counts. A failure rolls back only that tenant. Gate: `TENANT_PURGE_ENABLED=true`; otherwise dry run (lists candidates, changes nothing). `0170` only widens the `tenants.status` CHECK; the `audit_log` FK is untouched. Test: `src/__tests__/purge.test.ts`.

## withSystemRole and the pool.connect allowlist (RW-38, 2026-10-11)

**What.** `withTenant` and `withSystemRole` share one private transaction scaffold in `src/with-tenant.ts`. Every hand-rolled system-role transaction in modules and `apps/api` now calls `withSystemRole`. Three local wrappers are deleted. Four raw `pool.connect()` sites stay, each listed with a reason in `tools/pool-connect.allowlist.txt`: `15-analytics/refresh-mv-job.ts`, `02-tenancy/middleware.ts`, `16-help-system/service.ts` (`withGlobalsOnly`) and `18-certification/repository.ts` (`withPublicVerifyContext`).

**Why.** The old sites differed in error handling, none logged why the system role was used, and one could miss `RESET ROLE`. One helper with a mandatory `reason` fixes all three.

**Considered and rejected.** (1) Audit every system call by construction. The audit row needs a tenant, and many system reads are cross-tenant. This is why the old "deferred until 14-audit-log" plan was dropped. (2) A separate `withSystemReadOnly`. Module 07 keeps a thin wrapper that adds `SET TRANSACTION READ ONLY`.

**Not included.** `refresh-mv-job` stays a raw connect because `REFRESH MATERIALIZED VIEW` needs the MV owner role. The superseded, unregistered `middleware.ts` is not converted.

**Behaviour changes.** Candidate-login token consume (`01-auth`) now runs in a transaction. Before, it used a session-level `SET ROLE`. The `13-notifications` email retry count now reads `email_log` under `withTenant`. Before, the read was RLS-blind and always fell back to attempt 1.

**Downstream impact.** New system-role code must use `withSystemRole` with a reason. A new raw connect needs an allowlist line. Log event: `system-role.tx` (`docs/11-observability.md`). Test: `src/__tests__/with-system-role.test.ts`.
