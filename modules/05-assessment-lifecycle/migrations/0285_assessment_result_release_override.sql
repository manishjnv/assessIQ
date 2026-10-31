-- Per-assessment override of the result release mode (tenant default lives in tenant_settings, 02/0114).
-- WHAT  assessments.result_release_mode NULL = use the organisation default; 'manual' / 'auto' = this assessment's own rule.
--       assessments.result_release_auto_since = the start time of "automatic from now on" for this assessment.
--       It is NULL unless the override is 'auto' (CHECK below), so "auto" can never apply to results that were ready earlier.
-- Effective rule (09 release.ts, api auto-release sweep): COALESCE(a.mode, ts.mode); the since-time comes from the same
--       side that supplied the mode.
-- Columns on an existing table (assessments already has tenant_id + RLS); no policy change. Forward-only, idempotent.
-- Rollback: ALTER TABLE assessments DROP CONSTRAINT assessments_release_since_chk,
--           DROP COLUMN result_release_auto_since, DROP COLUMN result_release_mode;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS result_release_mode text NULL
  CHECK (result_release_mode IN ('manual', 'auto'));
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS result_release_auto_since timestamptz NULL;

ALTER TABLE assessments DROP CONSTRAINT IF EXISTS assessments_release_since_chk;
ALTER TABLE assessments ADD CONSTRAINT assessments_release_since_chk
  CHECK (result_release_auto_since IS NULL OR COALESCE(result_release_mode = 'auto', false));
