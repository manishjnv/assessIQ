-- 0077_tenants_status_provisioning.sql
--
-- Widen tenants_status_check to allow 'provisioning'.
--
-- WHY: createTenant (modules/02-tenancy/src/service.ts:167) inserts a new
-- tenant at status='provisioning' as the first step of the reviewed
-- soft-create pattern (provisioning -> seedTenantTaxonomy -> inviteUser ->
-- activateTenant flips to 'active'; a failure after step 1 leaves the tenant
-- 'provisioning' so no half-live 'active' tenant ever exists). 0001_tenants.sql
-- defined the column with an inline (auto-named) CHECK of only
-- ('active','suspended','archived'). The slice-1 super-admin work shipped
-- createTenant + POST /api/admin/super/companies but no migration widened the
-- constraint, so every create-company attempt failed with
-- 23514 "violates check constraint tenants_status_check" -> HTTP 500.
-- (RCA 2026-05-17 — "Create company INTERNAL ERROR".)
--
-- SAFETY: pure-additive. Prod has only status='active' tenants (3); the new
-- constraint is a strict superset of the old, so no existing row can violate
-- it. The inline CHECK from 0001 is auto-named tenants_status_check (confirmed
-- via pg_constraint and the production error message); DROP IF EXISTS by that
-- name then re-ADD with the same explicit name is idempotent.
--
-- Applied SURGICALLY by Opus (per hard carry-over: never tools/migrate.ts;
-- recorded in schema_migrations with sha256).

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('active', 'suspended', 'archived', 'provisioning'));
