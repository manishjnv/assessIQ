# 02-tenancy — Multi-tenant isolation

## Purpose
Tenant CRUD, settings, branding, and the runtime mechanism that pins every request and DB query to the correct tenant. Enforces isolation at three layers: middleware (request scope), repository (query filter), and database (RLS).

## Scope
- **In:** `tenants` and `tenant_settings` CRUD; tenant resolver from session/JWT/API key; `setLocal app.current_tenant` per request; RLS policy management; tenant lifecycle (suspend, archive); branding upload + serving; embed-origin allow-list management.
- **Out:** users (03), assessments (05), the visual theming pipeline (17 reads `tenants.branding` but doesn't write).

## Dependencies
- `00-core`
- `14-audit-log` (every tenant settings change is audited)

## Public surface
```ts
// service
getTenantById(id): Promise<Tenant>
getTenantBySlug(slug): Promise<Tenant>
updateTenantSettings(id, patch): Promise<TenantSettings>
suspendTenant(id, reason): Promise<void>

// middleware
tenantContextMiddleware(): preHandler  // sets req.tenant + DB session var

// repo helpers
withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>
```

## Data model touchpoints
Owns: `tenants`, `tenant_settings`.

Provides RLS policies on every other domain table — see `infra/postgres/init/02-rls.sql`.

## Critical: RLS policy template
```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = current_setting('app.current_tenant')::uuid);
CREATE POLICY tenant_isolation_insert ON <table>
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
```
Every new domain table MUST get these two policies in its migration. Migration linter rejects PRs that add a `tenant_id` column without policies.

## System-level escapes
A separate Postgres role `assessiq_system` has `BYPASSRLS`. Used only for: cross-tenant analytics jobs, support tooling, backups. Every query under that role logs to `audit_log` with `actor_kind='system'`.

## Help/tooltip surface
- `admin.settings.tenant.branding` — how branding fields propagate to UI
- `admin.settings.tenant.domain` — how domain restriction works with SSO
- `admin.settings.embed-origins` — what origins to add and why
- `admin.settings.data-region` — implications for compliance

## Open questions
- Tenant deletion (vs archive) — deferred; keeps things simpler
- Per-tenant custom domains (`assess.client.com`) — Phase 3 with TLS via ACME-DNS
