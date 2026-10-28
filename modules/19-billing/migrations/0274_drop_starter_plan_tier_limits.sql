-- modules/19-billing/migrations/0274_drop_starter_plan_tier_limits.sql
-- EXP-40 (owner 2026-10-23, plans simplified to Free and Paid): remove the informational 'starter' row that 0252
-- seeded in plan_tier_limits. No code tier 'starter' exists: tenant_plans.tier is CHECK-limited to
-- free|pro|enterprise|internal (0078), and getUploadLimits joins on that tier, so nothing reads this row.
-- Checked 2026-10-28: no tenant_plans row has tier 'starter' (production counts: free 4, internal 2, pro 2).
-- The guard below stops the migration if one ever appears. Idempotent: a second run deletes nothing.
-- plan_tier_limits_app_readonly (0252) blocks only the assessiq_app role; this runs as the migration role.
-- Rollback (NOT automatic): INSERT INTO plan_tier_limits VALUES ('starter', 500, 5, 2000) ON CONFLICT DO NOTHING;

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_plans WHERE tier = 'starter') THEN
    RAISE EXCEPTION 'tenant_plans still uses tier starter; migrate those tenants before dropping the row';
  END IF;
END
$m$;

DELETE FROM plan_tier_limits WHERE tier = 'starter';
