-- owned by modules/04-question-bank
-- Adds two deterministic (no-AI) question types: 'numeric' ("enter the value")
-- and 'multi_select' ("select all that apply"). Scoring lives in
-- modules/09-scoring/src/mcq.ts (same grader='deterministic' path as MCQ).
-- Only the CHECK constraint changes; content shapes are validated in app code
-- (modules/04-question-bank/src/types.ts). Idempotent.
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_type_check;
ALTER TABLE questions ADD CONSTRAINT questions_type_check
  CHECK (type IN ('mcq','subjective','kql','scenario','log_analysis','numeric','multi_select'));
