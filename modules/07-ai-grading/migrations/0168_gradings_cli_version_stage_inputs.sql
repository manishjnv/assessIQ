-- 0168_gradings_cli_version_stage_inputs.sql
--
-- RW-41 (reproducibility). The stored anchor_hits / reasoning_band are
-- post-processed (coerced, schema-validated, possibly edited by the admin).
-- Recording the raw tool inputs the model submitted per stage, plus the claude
-- CLI version that produced them, lets a row be replayed and diffed against a
-- later skill version.
--
-- Both columns are nullable: NULL for deterministic / pattern / override rows
-- and for rows written before this migration. No backfill. Same table, so no
-- RLS change.

ALTER TABLE gradings
  ADD COLUMN IF NOT EXISTS cli_version TEXT,
  ADD COLUMN IF NOT EXISTS stage_inputs JSONB;

COMMENT ON COLUMN gradings.cli_version IS 'claude CLI version that produced the row (claude-code-vps runtime); NULL for deterministic/pattern/override rows';
COMMENT ON COLUMN gradings.stage_inputs IS 'raw tool-call inputs per stage {anchors, band, escalate} as submitted by the model; NULL when not AI-graded';
