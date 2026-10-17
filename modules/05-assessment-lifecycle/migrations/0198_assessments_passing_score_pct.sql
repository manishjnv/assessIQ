-- owned by modules/05-assessment-lifecycle
-- 0198 — Z-16: per-assessment pass mark (assessments.passing_score_pct).
-- The mark is pre-filled from levels.passing_score_pct at create time and is
-- editable only while the assessment is draft (service rule, assessments.ts).
-- Backfill copies each existing assessment's level value once. The backfill
-- runs only when the column is added, so a re-run never overwrites an edit.
-- No FK, no new table: assessments keeps its tenant_id and RLS policies.
-- Forward-only.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'assessments' AND column_name = 'passing_score_pct'
  ) THEN
    ALTER TABLE assessments ADD COLUMN passing_score_pct SMALLINT NOT NULL DEFAULT 60;
    UPDATE assessments a
       SET passing_score_pct = LEAST(100, GREATEST(1, l.passing_score_pct))
      FROM levels l
     WHERE l.id = a.level_id;
    ALTER TABLE assessments
      ADD CONSTRAINT assessments_passing_score_pct_chk
      CHECK (passing_score_pct BETWEEN 1 AND 100);
  END IF;
END $$;
