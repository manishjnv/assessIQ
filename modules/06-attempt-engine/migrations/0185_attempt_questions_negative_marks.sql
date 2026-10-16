-- owned by modules/06-attempt-engine
-- 0185 — freeze negative marks per attempt question (EX-1; same idea as points in 0128).
--
-- negative_marks — COALESCE(questions.negative_marks, assessment default, 0) AT ATTEMPT START,
--   written by the same INSERT that freezes question_version and points. Scoring (09) reads this
--   column, so a later edit of the question or the assessment cannot move a candidate's score.
--
-- No trigger backstop (unlike 0128): DEFAULT 0 is the backstop. An INSERT that omits the column
--   freezes 0 = no penalty, which is the safe pre-EX-1 behaviour. Existing rows take 0.
-- RLS on attempt_questions is unchanged (column add; row policy + GRANTs cover it).
-- Apply BEFORE deploying the code that reads/writes the column.

ALTER TABLE attempt_questions
  ADD COLUMN IF NOT EXISTS negative_marks NUMERIC(6,2) NOT NULL DEFAULT 0
  CHECK (negative_marks >= 0);

COMMENT ON COLUMN attempt_questions.negative_marks IS
  'Penalty for a wrong attempted answer, frozen at attempt start; see 0128 (EX-1)';
