-- EXP-23: record the pack of each frozen question, so a section that names its own pack draws only from it
-- without joining `questions` (a join hides shared platform questions from a tenant: the FUT-8 trap).
-- NULL = frozen before EXP-23: readers treat it as the assessment pack (zero-fail rule).
-- Column on an existing table; RLS unchanged. Forward-only, idempotent. Not included: backfill of old pools.
ALTER TABLE assessment_frozen_pool ADD COLUMN IF NOT EXISTS pack_id uuid NULL;
