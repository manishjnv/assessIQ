-- EXP-22: (1) prefix index on question_source.seed_ref (withdraw by template prefix);
-- (2) one template_generated question per (tenant, seed_ref). Forward-only, idempotent.
CREATE INDEX IF NOT EXISTS question_source_seed_ref_prefix_idx
  ON question_source (tenant_id, seed_ref text_pattern_ops) WHERE seed_ref IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM question_source WHERE origin = 'template_generated' AND seed_ref IS NOT NULL
     GROUP BY tenant_id, seed_ref HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'EXP-22: duplicate template_generated seed_ref rows exist; unique index question_source_template_seed_uniq NOT created';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS question_source_template_seed_uniq
      ON question_source (tenant_id, seed_ref) WHERE origin = 'template_generated';
  END IF;
END $$;
