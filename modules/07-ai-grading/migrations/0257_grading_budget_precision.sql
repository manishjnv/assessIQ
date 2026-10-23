-- owned by modules/07-ai-grading
-- Z-163 (D6 budget gate): the ledger must hold sub-cent amounts and real token counts.
--
-- WHY: one API-graded answer costs about US$0.008. NUMERIC(10,2) rounds every increment to cents, so
-- the total drifts. NUMERIC(14,6) keeps micro-dollars. Widening keeps all existing values.
-- monthly_budget_usd stays NUMERIC(10,2): a budget is set in whole cents. 0 = unlimited / not configured.
-- RLS is unchanged (the existing tenant_isolation policies cover the new columns).

ALTER TABLE tenant_grading_budgets
  ALTER COLUMN used_usd TYPE NUMERIC(14,6),
  ADD COLUMN used_input_tokens  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN used_output_tokens BIGINT NOT NULL DEFAULT 0;
