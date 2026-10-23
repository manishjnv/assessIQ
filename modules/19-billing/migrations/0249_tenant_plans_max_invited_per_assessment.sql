-- modules/19-billing/migrations/0249_tenant_plans_max_invited_per_assessment.sql
-- EXP-37: capacity limit of INVITED students per assessment, kept in plan data.
-- NULL = unlimited. New rows default to 150; internal-tier tenants are unlimited (NULL).
-- Forward-only and idempotent: the backfill runs ONLY when this run creates the column, so a
-- re-run never overwrites a value the super admin has set.
-- Rollback (NOT automatic): ALTER TABLE tenant_plans DROP COLUMN max_invited_per_assessment.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'tenant_plans' AND column_name = 'max_invited_per_assessment'
  ) THEN
    ALTER TABLE tenant_plans
      ADD COLUMN max_invited_per_assessment INT NULL DEFAULT 150
      CHECK (max_invited_per_assessment IS NULL OR max_invited_per_assessment > 0);
    -- Existing rows took the default 150; internal tenants are unlimited.
    UPDATE tenant_plans SET max_invited_per_assessment = NULL WHERE tier = 'internal';
  END IF;
END
$$;

COMMENT ON COLUMN tenant_plans.max_invited_per_assessment IS
  'EXP-37: most ACTIVE invitations (pending, viewed, started) one assessment may hold; NULL = unlimited';
