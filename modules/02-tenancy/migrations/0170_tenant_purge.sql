-- 0170_tenant_purge.sql
--
-- RW-48b: 6-month retention purge of archived tenants (modules/02-tenancy/src/purge.ts).
--
-- Widen tenants_status_check to allow 'purged'. A purged tenant keeps its
-- tenants row as a tombstone; status 'purged' is also the idempotency marker
-- (the sweep only selects status = 'archived'). Strict superset of 0077.
-- Touches only the tenants table (02-tenancy owns it); no data row changes.

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('active', 'suspended', 'archived', 'provisioning', 'purged'));
