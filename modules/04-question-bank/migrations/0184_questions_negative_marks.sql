-- owned by modules/04-question-bank
-- 0184 — per-question negative marks (EX-1).
--
-- negative_marks — points deducted for a WRONG, ATTEMPTED answer on a deterministic question type
--   (mcq, numeric, multi_select, ordering, structured_case). NULL = use the assessment default
--   (assessments.settings.scoring.negative_marks_default, else 0). AI-graded types ignore it.
--   The effective value is frozen per attempt in attempt_questions.negative_marks (migration 0185).
-- RLS on questions is unchanged (column add; row policy + GRANTs cover it).
-- Apply BEFORE deploying the code that reads/writes the column.

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS negative_marks NUMERIC(6,2) NULL
  CHECK (negative_marks IS NULL OR negative_marks >= 0);

COMMENT ON COLUMN questions.negative_marks IS
  'NULL = use the assessment default; penalty for a wrong attempted answer on deterministic types (EX-1)';
