-- RLS isolation for the tenants table.
--
-- WHY tenants has a custom policy:
--   For all other domain tables the tenant discriminator is a `tenant_id` column
--   (a FK back to tenants). But the `tenants` table IS the anchor — its own `id`
--   column IS the tenant key. So the policy checks `id = current_setting(...)`,
--   not `tenant_id = current_setting(...)`.
--   The linter (tools/lint-rls-policies.ts:116-128) knows about this special case
--   and accepts the custom column reference. Because `tenants` has no `tenant_id`
--   column, the linter does not require policies in the same file as the
--   CREATE TABLE (0001_tenants.sql); this dedicated file makes the intent explicit.
--
-- WHY current_setting(..., true) — the `, true` second argument:
--   With `true`, current_setting returns NULL instead of raising
--   "unrecognized configuration parameter" when the GUC has never been SET.
--   RLS then evaluates `id = NULL` which is FALSE (SQL three-value logic),
--   so every row is filtered out. This is fail-closed behaviour: an
--   unauthenticated or misconfigured session sees zero rows rather than all rows.
--   Without the `, true` flag, any session that omits `SET LOCAL app.current_tenant`
--   would crash with an error — a worse developer experience and a harder-to-audit
--   failure mode.
--
-- REMINDER for future tables:
--   Every new tenant-scoped table needs the two-policy template applied in the
--   SAME migration file as the CREATE TABLE. The linter (tools/lint-rls-policies.ts)
--   enforces the presence of both CREATE POLICY tenant_isolation and
--   CREATE POLICY tenant_isolation_insert in any migration file that defines a
--   table with a tenant_id column.

-- tenants: row's own id is the tenant key (special case — see lint-rls-policies.ts:118)
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
  USING (id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON tenants
  FOR INSERT
  WITH CHECK (id = current_setting('app.current_tenant', true)::uuid);
