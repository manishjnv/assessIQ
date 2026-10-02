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

-- Fail loudly rather than leave points nullable (codex review 2026-10-02): a row
-- whose question no longer exists would otherwise keep NULL and score wrongly.
-- Checked on prod before applying: 0 such rows (21 total).
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM attempt_questions WHERE points IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '0128: % attempt_questions rows have no matching question; repair before applying', n;
  END IF;
END $$;
ALTER TABLE attempt_questions ALTER COLUMN points SET NOT NULL;

-- Accepted residuals (codex review): (a) the trigger reads questions under the
-- inserting role's RLS, so an invisible question makes the insert FAIL on NOT NULL
-- (loud, never a wrong value); startAttempt always passes points explicitly. (b)
-- points are read in the same transaction as the frozen question_version, a few ms
-- later; question_versions stores no points, so a points edit landing inside that
-- window could pair version N with the new value. Negligible window; documented.

COMMENT ON COLUMN attempt_questions.points IS
  'questions.points frozen at attempt start; the score_max source for every grading row of the attempt.';
