-- modules/19-billing/migrations/0080_billing_backfill.sql
-- Phase A1 Session 1 — existing-tenant billing plan backfill.
--
-- PURPOSE:
--   Provisions tenant_plans rows for all tenants that existed before the
--   billing module was deployed. New tenants created after deploy are
--   provisioned at creation time via provisionDefaultPlan() in the
--   createCompany hook.
--
-- EXECUTION CONTEXT:
--   Run as superuser or assessiq_system (BYPASSRLS) directly in psql.
--   No app.current_tenant GUC needed — this script bypasses RLS.
--   Do NOT run via the application's withTenant() — that would require
--   a current_tenant GUC set for every row, which is impractical for a
--   one-time bulk backfill.
--
-- IDEMPOTENCY:
--   Both INSERT … ON CONFLICT DO NOTHING statements are safe to re-run.
--   Re-running after a partial failure will skip rows that were already
--   inserted and fill in any that were missed.
--
-- DESIGN DECISIONS:
--
--   1. Internal tenants (platform + wipro-soc) receive tier='internal',
--      included_credits=NULL (unlimited). These are operator/test tenants
--      that must never be flagged as over-quota regardless of usage volume.
--
--   2. All other tenants receive tier='free', included_credits=25.
--      This is the DEFAULT_FREE_CREDITS value in service.ts. If the product
--      team changes the default, this migration and service.ts should be
--      updated together.
--
--   3. Slug-based identification.
--      IMPORTANT: the operator MUST verify the actual slugs for the platform
--      and internal tenants in production before applying:
--        SELECT id, slug FROM tenants ORDER BY slug;
--      Adjust the slug lists in both INSERT statements below if the platform
--      tenant's slug differs from 'platform'. The 'wipro-soc' slug is the
--      internal assessment tenant seeded during initial provisioning.
--
-- APPLY ORDER:
--   Must run AFTER 0078_tenant_plans.sql.
--   Can run any time after the table exists — safe to run in a maintenance
--   window after the application has been redeployed with the billing module.
--
-- DO NOT APPLY manually without verifying slug names first (see note 3 above).

-- ---------------------------------------------------------------------------
-- Internal / platform tenants → unlimited credits
-- ---------------------------------------------------------------------------

INSERT INTO tenant_plans (tenant_id, tier, included_credits)
SELECT id, 'internal', NULL
  FROM tenants
 WHERE slug IN ('platform', 'wipro-soc')
ON CONFLICT (tenant_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- All other tenants → free tier, 25 credits
-- ---------------------------------------------------------------------------

INSERT INTO tenant_plans (tenant_id, tier, included_credits)
SELECT id, 'free', 25
  FROM tenants
 WHERE slug NOT IN ('platform', 'wipro-soc')
ON CONFLICT (tenant_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- VERIFICATION (run after applying; adjust expected slug list as needed)
-- ---------------------------------------------------------------------------

-- SELECT t.slug, p.tier, p.included_credits
--   FROM tenants t
--   JOIN tenant_plans p ON p.tenant_id = t.id
--  ORDER BY t.slug;

-- NOTE: Operator MUST verify the actual platform/internal tenant slugs in prod
-- (`SELECT id, slug FROM tenants`) before applying — adjust the slug list above
-- if the platform tenant's slug differs from 'platform'. The query above
-- should return one row per tenant with no NULLs in the tier column.
