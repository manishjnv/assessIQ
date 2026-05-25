-- owned by modules/04-question-bank
-- 0091_platform_domain_source.sql
--
-- Adds domain PROVENANCE so platform-managed domains can be propagated to (and
-- archived across) every company tenant WITHOUT ever clobbering a tenant-LOCAL
-- domain that happens to share a slug.
--
-- BACKGROUND
--   The `domains` table is tenant-scoped (one row per (tenant_id, slug), RLS by
--   tenant_id). Two kinds of rows live in it today, structurally identical:
--     (a) PLATFORM domains — the canonical taxonomy. Seeded into the platform
--         master tenant (0083) and copied into every company tenant (0019 for
--         existing tenants; seedTenantTaxonomy() at provisioning for new ones).
--     (b) TENANT-LOCAL domains — created by a tenant admin via
--         POST /api/admin/domains (e.g. WIPRO-SOC's `threat-hunting`,
--         `vulnerability-management`). These belong to that tenant alone.
--   There was NO column distinguishing (a) from (b). The new platform
--   domain-management feature (super-admin create/archive that PROPAGATES across
--   tenants) needs that distinction: a platform ARCHIVE must flip every
--   platform-origin copy of a slug while leaving any tenant-local domain on the
--   same slug untouched.
--
-- WHAT THIS MIGRATION DOES
--   1. ADD COLUMN `source` ('platform' | 'tenant'), default 'tenant'.
--   2. Extend the status CHECK to allow 'archived' (was 'active'|'inactive';
--      only 'active' is ever written today — 'inactive' is unused legacy). The
--      management feature archives with status='archived' and reactivates with
--      status='active', matching the question_packs vocabulary.
--   3. BACKFILL provenance on existing rows:
--        - the platform master tenant's own rows  → 'platform'
--        - every company-tenant row whose slug is in the platform domain set
--          → 'platform' (these are the seeded copies)
--        - everything else stays 'tenant' (tenant-local creations).
--
-- WHY backfill-by-slug-membership is SAFE
--   UNIQUE(tenant_id, slug) means there is exactly ONE row per slug per tenant,
--   so a platform slug and a tenant-local slug can never coexist as two rows in
--   the same tenant. For the 9 platform slugs the single row IS the seeded
--   platform copy (tenant admins never created those). Tenant-local slugs
--   (threat-hunting / vulnerability-management are DOMAIN slugs unique to
--   WIPRO-SOC; note they are also CATEGORY slugs under `soc`, but categories are
--   a different table) are NOT in the platform DOMAIN set, so they correctly
--   stay 'tenant'. Verified against prod (2026-05-25).
--
-- FORWARD-ONLY / ADDITIVE. Idempotent: ADD COLUMN IF NOT EXISTS + the two
-- backfill UPDATEs are no-ops on a second run (everything already 'platform').
-- On a fresh DB with no platform tenant the subquery is NULL/empty and nothing
-- is backfilled — all rows stay 'tenant', which is correct (the platform tenant
-- is bootstrapped by hand and re-running this migration after that bootstrap
-- would then mark its rows).

-- 1) Provenance column. Default 'tenant' so any pre-existing row is treated as
--    tenant-local until the backfill below proves otherwise.
ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'tenant'
  CHECK (source IN ('platform','tenant'));

-- 2) Allow 'archived' in addition to the existing 'active'|'inactive'. The
--    inline column CHECK from 0018 is named `domains_status_check` by Postgres.
ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_status_check;
ALTER TABLE domains
  ADD CONSTRAINT domains_status_check CHECK (status IN ('active','inactive','archived'));

-- 3a) The platform master library's own rows are platform-origin by definition.
UPDATE domains
   SET source = 'platform', updated_at = now()
 WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'platform' LIMIT 1)
   AND source <> 'platform';

-- 3b) Every company-tenant row whose slug exists in the platform domain set is a
--     propagated copy of a platform domain. Tenant-local slugs (not in the
--     platform set) are left as 'tenant'.
UPDATE domains d
   SET source = 'platform', updated_at = now()
 WHERE d.slug IN (
         SELECT slug FROM domains
          WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'platform' LIMIT 1)
       )
   AND d.source <> 'platform';
