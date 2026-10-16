-- PT-4: per-tenant override of the AI answers included per month.
-- NULL = use the tier default (TIER_AI_ANSWERS_INCLUDED in service.ts).
ALTER TABLE tenant_plans
  ADD COLUMN IF NOT EXISTS ai_answers_included_override INT NULL
  CHECK (ai_answers_included_override IS NULL OR ai_answers_included_override >= 0);

COMMENT ON COLUMN tenant_plans.ai_answers_included_override IS
  'PT-4: contract override of AI answers included per cycle; NULL = tier default';
