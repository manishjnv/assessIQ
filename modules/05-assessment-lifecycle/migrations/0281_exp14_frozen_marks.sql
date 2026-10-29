-- EXP-14 phase 2, part 3 (design docs/design/2026-10-21-future-ready-question-store.md D4, section 12).
-- Module 05 owns assessment_frozen_pool, so the parts that need it live here (module 04 stays free of it).
-- WHAT
--   1. assessment_frozen_pool.negative_marks + marks_frozen: the freeze copies the question's penalty and sets
--      marks_frozen = true. 06 attempt start reads the frozen marks when marks_frozen, so a master edit of a shared
--      question cannot change a running test. DEFAULT false: rows frozen before this migration keep reading the live
--      question exactly as before (old tests score the same).
--   2. Index assessment_frozen_pool(question_id) for the pinned lookup (policy in 0282).
-- Forward-only, idempotent.
-- Rollback: DROP INDEX assessment_frozen_pool_question_idx;
--           ALTER TABLE assessment_frozen_pool DROP COLUMN negative_marks, DROP COLUMN marks_frozen;

ALTER TABLE assessment_frozen_pool
  ADD COLUMN IF NOT EXISTS negative_marks numeric,
  ADD COLUMN IF NOT EXISTS marks_frozen boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS assessment_frozen_pool_question_idx ON assessment_frozen_pool (question_id);
