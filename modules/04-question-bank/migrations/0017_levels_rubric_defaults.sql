-- Migration 0017: add rubric_defaults JSONB column to levels table.
--
-- Purpose: store per-level calibration hints for the AI rubric generator.
-- The generator reads this column to bias its output toward the level's
-- expected complexity profile without changing the RubricSchema contract.
--
-- Shape of rubric_defaults (NULL means generator falls back to ordinal-only
-- calibration from levelOrdinal):
--
--   {
--     "profile": "foundational" | "practitioner" | "expert",
--     "anchorComplexity": "short" | "medium" | "dense",
--     "bandStrictness": "lenient" | "standard" | "strict"
--   }
--
-- Column is NULLABLE — existing levels keep NULL, generator falls back to
-- ordinal-based calibration. Admin may set this via the level-edit page.
--
-- RLS: levels inherits tenant isolation via the question_packs FK chain.
-- No tenant_id column needed here.

ALTER TABLE levels ADD COLUMN rubric_defaults JSONB DEFAULT NULL;

-- Optional index for future analytics queries on profile distributions.
-- Non-blocking for small Phase 1 tables.
CREATE INDEX IF NOT EXISTS idx_levels_rubric_defaults_profile
  ON levels ((rubric_defaults->>'profile'))
  WHERE rubric_defaults IS NOT NULL;
