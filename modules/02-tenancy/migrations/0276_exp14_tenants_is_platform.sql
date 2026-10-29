-- EXP-14 phase 1 (design docs/design/2026-10-21-future-ready-question-store.md D3, section 10).
-- WHAT  tenants.is_platform marks the ONE platform tenant (owner of the master question store).
-- WHY   the licensed-read function (phase 2) must know who the platform is from a database column.
--       A session setting is not safe: the app role can set any app.* value (with-tenant.ts).
-- NOT INCLUDED  any policy or reader change (phase 2). The startup assert that this row equals
--       PLATFORM_TENANT_ID is added with the phase 2 function.
-- Forward-only, idempotent. Rollback: DROP INDEX tenants_one_platform_uq; ALTER TABLE tenants DROP COLUMN is_platform;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT false;

UPDATE tenants SET is_platform = true WHERE slug = 'platform' AND NOT is_platform;

-- At most one platform tenant.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_platform_uq ON tenants ((true)) WHERE is_platform;
