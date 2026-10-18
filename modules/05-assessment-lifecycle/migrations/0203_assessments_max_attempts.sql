-- owned by modules/05-assessment-lifecycle
-- 0203 — Z-39 retake policy: assessments.max_attempts and
-- assessment_invitations.extra_attempts.
--   max_attempts NULL or 1 = no retake (the default). 2..10 = a candidate may
--   sit the test up to that many times. The limit is enforced by 06 startAttempt
--   and by the invitation re-open path in this module.
--   extra_attempts = attempts an admin granted to ONE candidate on top of
--   max_attempts (one audit row per grant, written by the service).
-- No FK and no new table: both tables keep their existing RLS policies.
-- The sibling file 0203_attempts_attempt_number.sql (module 06) adds the
-- per-attempt number and the unique key that makes the limit race-safe.
-- Forward-only.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'assessments' AND column_name = 'max_attempts'
  ) THEN
    ALTER TABLE assessments ADD COLUMN max_attempts SMALLINT;
    ALTER TABLE assessments
      ADD CONSTRAINT assessments_max_attempts_chk
      CHECK (max_attempts IS NULL OR max_attempts BETWEEN 1 AND 10);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'assessment_invitations' AND column_name = 'extra_attempts'
  ) THEN
    ALTER TABLE assessment_invitations ADD COLUMN extra_attempts SMALLINT NOT NULL DEFAULT 0;
    ALTER TABLE assessment_invitations
      ADD CONSTRAINT assessment_invitations_extra_attempts_chk
      CHECK (extra_attempts BETWEEN 0 AND 10);
  END IF;
END $$;
