-- owned by modules/04-question-bank
-- Adds the deterministic (no-AI) question type 'ordering' ("put these steps in the
-- right order"). Scoring lives in modules/09-scoring/src/mcq.ts (orderingFraction,
-- same grader='deterministic' path as MCQ). Only the CHECK constraint changes;
-- the content shape is validated in app code (modules/04-question-bank/src/types.ts).
-- Idempotent.
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_type_check;
ALTER TABLE questions ADD CONSTRAINT questions_type_check
  CHECK (type IN ('mcq','subjective','kql','scenario','log_analysis','numeric','multi_select','ordering'));
