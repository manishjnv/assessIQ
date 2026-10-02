-- owned by modules/06-attempt-engine
-- 0128 — freeze question points per attempt (E12).
--
-- points — questions.points AT ATTEMPT START, written by the same INSERT that
--   freezes question_version. Scoring (09 MCQ, 07 AI/manual grading) reads this
--   column, so a later edit of questions.points can no longer move the score of a
--   candidate who has not been graded yet.
--
-- Backfill: existing rows take the question's current points (best available; the
--   pre-existing behaviour). NOT NULL is applied only once every row is filled.
-- RLS on attempt_questions is unchanged (column add; row policy + GRANTs cover it).
-- Apply BEFORE deploying the code that reads/writes the column.

ALTER TABLE attempt_questions ADD COLUMN IF NOT EXISTS points INT;

UPDATE attempt_questions aq
   SET points = q.points
  FROM questions q
 WHERE q.id = aq.question_id
   AND aq.points IS NULL;

-- Backstop: an INSERT that omits points (any future/raw insert path) still freezes
-- questions.points AS OF THAT INSERT, so NOT NULL never rejects and the value is
-- never read lazily. startAttempt also writes it explicitly.
CREATE OR REPLACE FUNCTION attempt_questions_default_points() RETURNS trigger AS $f$
BEGIN
  IF NEW.points IS NULL THEN
    SELECT points INTO NEW.points FROM questions WHERE id = NEW.question_id;
  END IF;
  RETURN NEW;
END
$f$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attempt_questions_default_points ON attempt_questions;
CREATE TRIGGER attempt_questions_default_points
  BEFORE INSERT ON attempt_questions
  FOR EACH ROW EXECUTE FUNCTION attempt_questions_default_points();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM attempt_questions WHERE points IS NULL) THEN
    ALTER TABLE attempt_questions ALTER COLUMN points SET NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN attempt_questions.points IS
  'questions.points frozen at attempt start; the score_max source for every grading row of the attempt.';
