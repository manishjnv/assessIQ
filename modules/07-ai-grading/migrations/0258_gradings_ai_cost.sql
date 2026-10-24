-- owned by modules/07-ai-grading
-- Z-163 (API switch checklist item f): store the real AI cost and token counts on each AI grading row.
--
-- WHY: the D6 ledger (tenant_grading_budgets, 0257) only holds a per-company monthly total. The owner needs the
-- cost per answer, per question type and per company to check the price rule against real usage.
-- WHAT: three nullable columns, written once when the admin accepts an AI proposal (the usage comes from the
-- server-side proposals cache, never from the client). NULL for CLI-graded, rule, reuse, manual and override rows,
-- and for rows written before this migration. No backfill.
-- cost_usd: NUMERIC(14,6) like the ledger (one answer costs about US$0.008). Tokens: BIGINT like the ledger;
-- input_tokens counts cache reads and writes too (same rule as the ledger).
-- RLS: unchanged. The existing tenant_isolation policy on gradings covers new columns.
-- Rollback: ALTER TABLE gradings DROP COLUMN cost_usd, DROP COLUMN input_tokens, DROP COLUMN output_tokens;

ALTER TABLE gradings
  ADD COLUMN IF NOT EXISTS cost_usd      NUMERIC(14,6),
  ADD COLUMN IF NOT EXISTS input_tokens  BIGINT,
  ADD COLUMN IF NOT EXISTS output_tokens BIGINT;

COMMENT ON COLUMN gradings.cost_usd IS 'US$ cost of the AI calls behind this row (anthropic-api runtime only); NULL otherwise';
COMMENT ON COLUMN gradings.input_tokens IS 'input tokens incl. cache read/write (anthropic-api runtime only); NULL otherwise';
COMMENT ON COLUMN gradings.output_tokens IS 'output tokens (anthropic-api runtime only); NULL otherwise';
