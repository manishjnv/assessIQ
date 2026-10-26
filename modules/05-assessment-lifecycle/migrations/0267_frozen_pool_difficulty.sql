-- owned by modules/05-assessment-lifecycle
-- 0267 - CT-0: freeze difficulty_est with the frozen pool row.
-- WHY  module 06 read questions.difficulty_est live for frozen pools, so editing a question could change
--      what a published test draws (FUT-9 difficulty ranges). The value is now copied at freeze time.
-- Backfill: existing frozen rows get the question's CURRENT value once (the best information left).
-- Not included: any change to the draw rule. Column on an existing table; RLS unchanged. Forward-only.
ALTER TABLE assessment_frozen_pool ADD COLUMN IF NOT EXISTS difficulty_est smallint NULL;

UPDATE assessment_frozen_pool fp
   SET difficulty_est = q.difficulty_est
  FROM questions q
 WHERE q.id = fp.question_id AND fp.difficulty_est IS NULL AND q.difficulty_est IS NOT NULL;
