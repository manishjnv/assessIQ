-- owned by modules/07-ai-grading
-- Phase 2 G2.A Session 1.a — tenant_grading_budgets table (D6).
--
-- Phase 1 (claude-code-vps mode) does not consume budget — the admin's Max
-- subscription is flat-rate, not per-call. The table ships now so module 10
-- billing UI has a stable target and so the future anthropic-api runtime's
-- budget-exhaustion gate (D6) can read from a populated row without a
-- separate migration.
--
-- WHY PK = tenant_id (special-case RLS variant):
--   Same shape as `tenants` itself — the row's PK *is* the tenant
--   discriminator. The RLS policy uses `id = current_setting(...)` rather
--   than `tenant_id = current_setting(...)`. lint-rls-policies.ts
--   special-cases this table in its `TENANTS_LIKE` set alongside `tenants`.
--
-- WHY no row-per-tenant seed:
--   Module 10's admin-budget handler returns a default shape ("0/0/null/80")
--   when no row exists. Tenants without a budget row are treated as
--   "unlimited / not yet configured" rather than "0 budget / locked out".
--   Phase 3+ admin UI will UPSERT a row when the admin saves a budget config.

CREATE TABLE tenant_grading_budgets (
  tenant_id            UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  monthly_budget_usd   NUMERIC(10,2) NOT NULL DEFAULT 0,
  used_usd             NUMERIC(10,2) NOT NULL DEFAULT 0,
  period_start         DATE NOT NULL DEFAULT CURRENT_DATE,
  alert_threshold_pct  NUMERIC(5,2) NOT NULL DEFAULT 80,
  alerted_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenant_grading_budgets ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_grading_budgets
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON tenant_grading_budgets
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
