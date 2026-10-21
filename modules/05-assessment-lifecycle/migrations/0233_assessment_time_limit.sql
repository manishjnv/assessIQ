-- owned by modules/05-assessment-lifecycle
-- 0233 — optional time limit per assessment: assessments.duration_minutes.
--   NULL (the default) = use the level time (levels.duration_minutes), so every
--   existing assessment keeps its time. 1..600 = the admin set a time for this
--   assessment. Effective time = COALESCE(assessments.duration_minutes,
--   levels.duration_minutes). A running attempt keeps the seconds it copied at
--   start (attempts.duration_seconds), so a later edit never changes it.
-- No new table and no new policy: the assessments RLS policies already cover the column.
-- Forward-only, idempotent.
ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS duration_minutes INT NULL
  CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 600);
