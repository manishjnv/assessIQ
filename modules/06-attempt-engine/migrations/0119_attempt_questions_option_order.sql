-- owned by modules/06-attempt-engine
-- 0119 — per-attempt MCQ option order (per-student option shuffle).
--
-- option_order — for an MCQ the candidate sees shuffled, the permutation chosen
--   at attempt start: option_order[k] (JS index k, SQL index k+1) is the ORIGINAL
--   option index (into the frozen question_versions.content.options) that is
--   DISPLAYED at position k. NULL = original order (every pre-existing row, every
--   non-MCQ, and every MCQ whose options refer to each other, e.g. "All of the
--   above" — those are never shuffled).
--
-- WHY a column on attempt_questions (not a new table):
--   the order is frozen per (attempt, question) exactly like question_version, is
--   written once by the same INSERT, and is read by the same primary-key lookups.
--
-- STORED ANSWERS STAY IN ORIGINAL-INDEX SPACE. The server translates the
--   candidate's displayed index to the original index before attempt_answers is
--   written, and back again when it serves the candidate's own answers, so scoring
--   (09), admin review (07/10), exports (15/20) and analytics need no change and
--   the candidate never receives this column.
--
-- Additive and nullable: no default, no backfill, no CHECK, no index. Old and
--   in-flight attempts keep NULL = original order. RLS on attempt_questions is
--   row-level (JOIN to attempts.tenant_id, migration 0031) and so already covers
--   the new column; table-level GRANTs (0002) cover it too — no policy change.
--   Apply this migration BEFORE the code that reads the column is deployed.

ALTER TABLE attempt_questions
  ADD COLUMN IF NOT EXISTS option_order SMALLINT[] NULL;

COMMENT ON COLUMN attempt_questions.option_order IS
  'Per-attempt MCQ option permutation: option_order[display position] = original option index. NULL = original order. Never exposed to candidates.';
