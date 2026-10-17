-- owned by modules/09-scoring
-- 0199 — Z-16: pass mark snapshot on the attempt score row.
-- pass_mark_pct is the assessment pass mark used for this result. It is copied
-- when the score row is first written and never changed by a re-score, so a
-- later edit of the assessment cannot change an old result.
-- Backfill copies assessments.passing_score_pct (added by 0198) once, only when
-- the column is added. tenant_id and the RLS policies on attempt_scores are
-- unchanged. Forward-only.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'attempt_scores' AND column_name = 'pass_mark_pct'
  ) THEN
    ALTER TABLE attempt_scores ADD COLUMN pass_mark_pct SMALLINT NOT NULL DEFAULT 60;
    UPDATE attempt_scores s
       SET pass_mark_pct = ass.passing_score_pct
      FROM attempts a
      JOIN assessments ass ON ass.id = a.assessment_id
     WHERE a.id = s.attempt_id;
    ALTER TABLE attempt_scores
      ADD CONSTRAINT attempt_scores_pass_mark_pct_chk
      CHECK (pass_mark_pct BETWEEN 1 AND 100);
  END IF;
END $$;
