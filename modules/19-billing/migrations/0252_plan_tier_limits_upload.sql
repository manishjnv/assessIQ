-- modules/19-billing/migrations/0252_plan_tier_limits_upload.sql
-- EXP-17 (owner decisions 2026-10-22): organisation question-upload limits kept in PLAN DATA, not code.
-- plan_tier_limits: platform reference data (no tenant_id, so no RLS). NULL = unlimited, 0 = upload not allowed.
-- The app role gets SELECT only; the owner changes numbers through the system role / super-admin tooling.
-- tenant_plans gets nullable per-tenant overrides (NULL = the tier row applies). tenant_plans has no UPDATE
-- policy for the app role, so a tenant admin cannot raise their own limits.
-- Tier mapping: code tiers are free|pro|enterprise|internal. Owner "Starter" has no code tier yet, so it is seeded
-- as an informational 'starter' row (unused until that tier exists); owner "Pro" = code tier 'pro'.
-- Forward-only, idempotent: seed rows use ON CONFLICT DO NOTHING so a number the owner changed is never reset.
-- Rollback (NOT automatic): DROP TABLE plan_tier_limits; ALTER TABLE tenant_plans DROP COLUMN upload_*_override.

CREATE TABLE IF NOT EXISTS plan_tier_limits (
  tier                  TEXT PRIMARY KEY,
  upload_max_per_upload INT NULL CHECK (upload_max_per_upload IS NULL OR upload_max_per_upload >= 0),
  upload_per_month      INT NULL CHECK (upload_per_month IS NULL OR upload_per_month >= 0),
  upload_max_total      INT NULL CHECK (upload_max_total IS NULL OR upload_max_total >= 0)
);

INSERT INTO plan_tier_limits (tier, upload_max_per_upload, upload_per_month, upload_max_total) VALUES
  ('free',       0,    0,    0),
  ('starter',    500,  5,    2000),
  ('pro',        2000, 20,   10000),
  ('enterprise', NULL, NULL, NULL),
  ('internal',   NULL, NULL, NULL)
ON CONFLICT (tier) DO NOTHING;

REVOKE INSERT, UPDATE, DELETE ON plan_tier_limits FROM assessiq_app;
GRANT SELECT ON plan_tier_limits TO assessiq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_tier_limits TO assessiq_system;

-- assessiq_app is a member of assessiq_system (0002) and so inherits its table privileges: the REVOKE alone does
-- not stop a write made as the app role. This statement trigger does: it refuses every write while current_user is
-- assessiq_app. The system role and the migration/superuser role are not blocked.
CREATE OR REPLACE FUNCTION plan_tier_limits_app_readonly() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF current_user = 'assessiq_app' THEN
    RAISE EXCEPTION 'plan_tier_limits is read-only for the app role' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END
$f$;
DROP TRIGGER IF EXISTS plan_tier_limits_app_readonly ON plan_tier_limits;
CREATE TRIGGER plan_tier_limits_app_readonly
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON plan_tier_limits
  FOR EACH STATEMENT EXECUTE FUNCTION plan_tier_limits_app_readonly();

ALTER TABLE tenant_plans
  ADD COLUMN IF NOT EXISTS upload_max_per_upload_override INT NULL CHECK (upload_max_per_upload_override IS NULL OR upload_max_per_upload_override >= 0),
  ADD COLUMN IF NOT EXISTS upload_per_month_override      INT NULL CHECK (upload_per_month_override IS NULL OR upload_per_month_override >= 0),
  ADD COLUMN IF NOT EXISTS upload_max_total_override      INT NULL CHECK (upload_max_total_override IS NULL OR upload_max_total_override >= 0);
