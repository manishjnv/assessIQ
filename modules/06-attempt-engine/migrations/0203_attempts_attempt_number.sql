-- owned by modules/06-attempt-engine
-- 0203 — Z-39 retake policy: attempts.attempt_number.
-- Until now UNIQUE (assessment_id, user_id) allowed one attempt per candidate
-- per assessment. A retake needs several rows, so the unique key becomes
-- (assessment_id, user_id, attempt_number). Two simultaneous starts compute the
-- same next number; the second INSERT hits this key, so the limit
-- (assessments.max_attempts + invitation extra_attempts) cannot be exceeded.
-- Every existing row is attempt 1 (the default). Forward-only.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'attempts' AND column_name = 'attempt_number'
  ) THEN
    ALTER TABLE attempts ADD COLUMN attempt_number SMALLINT NOT NULL DEFAULT 1;
    ALTER TABLE attempts
      ADD CONSTRAINT attempts_attempt_number_chk CHECK (attempt_number >= 1);
    ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_assessment_id_user_id_key;
    ALTER TABLE attempts
      ADD CONSTRAINT attempts_assessment_user_number_key
      UNIQUE (assessment_id, user_id, attempt_number);
  END IF;
END $$;
