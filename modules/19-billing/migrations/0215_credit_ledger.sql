-- modules/19-billing/migrations/0215_credit_ledger.sql
-- Z-93: credit ledger. Grants (with expiry) and append-only burns, one per attempt.
-- tenant_plans.included_credits NULL still means "unlimited" (never burns, never refuses).
-- Additive only. Grant amounts are counts, not prices.

CREATE TABLE IF NOT EXISTS credit_grants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source      TEXT NOT NULL CHECK (source IN ('purchase','free_monthly','bonus','pilot')),
  credits     INTEGER NOT NULL CHECK (credits >= 0),
  remaining   INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= credits),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  invoice_ref TEXT,
  note        TEXT,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_grants_tenant_expiry_idx ON credit_grants (tenant_id, expires_at);

-- One free refill per tenant per UTC month (idempotent monthly job).
-- date_trunc on timestamptz is not immutable; the AT TIME ZONE form on timestamptz is.
CREATE UNIQUE INDEX IF NOT EXISTS credit_grants_free_monthly_uniq
  ON credit_grants (tenant_id, (date_trunc('month', granted_at AT TIME ZONE 'UTC')))
  WHERE source = 'free_monthly';

ALTER TABLE credit_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON credit_grants
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- The app role may only insert the free monthly grant (new-tenant provisioning).
-- Purchases, bonuses and pilot grants go through the system role (super admin).
CREATE POLICY tenant_isolation_insert ON credit_grants
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid AND source = 'free_monthly'
              AND credits = remaining AND credits <= 20);

-- Burn decrements `remaining` under the app role in the grading transaction.
CREATE POLICY tenant_isolation_update ON credit_grants
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON credit_grants FROM assessiq_app;
GRANT UPDATE (remaining) ON credit_grants TO assessiq_app;

-- `remaining` may only go down (a burn or an expiry). Blocks raising it to undo burns.
CREATE OR REPLACE FUNCTION credit_grants_remaining_decrease_only() RETURNS trigger AS $$
BEGIN
  IF NEW.remaining > OLD.remaining THEN
    RAISE EXCEPTION 'credit_grants.remaining can only decrease';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS credit_grants_remaining_decrease_only ON credit_grants;
CREATE TRIGGER credit_grants_remaining_decrease_only BEFORE UPDATE ON credit_grants
  FOR EACH ROW EXECUTE FUNCTION credit_grants_remaining_decrease_only();

-- A paid invoice reference grants once (a double click or retry cannot grant twice).
CREATE UNIQUE INDEX IF NOT EXISTS credit_grants_purchase_invoice_uniq
  ON credit_grants (tenant_id, invoice_ref) WHERE invoice_ref IS NOT NULL AND source = 'purchase';

CREATE TABLE IF NOT EXISTS credit_burns (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt_id UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  grant_id   UUID REFERENCES credit_grants(id),
  credits    INTEGER NOT NULL CHECK (credits >= 0),
  shortfall  INTEGER NOT NULL DEFAULT 0 CHECK (shortfall >= 0),
  test_type  TEXT NOT NULL CHECK (test_type IN ('mock','real','real_camera')),
  burned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS credit_burns_tenant_idx ON credit_burns (tenant_id, burned_at);

ALTER TABLE credit_burns ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON credit_burns
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON credit_burns
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON credit_burns FROM assessiq_app;

-- Backfill: one grant per existing finite plan. remaining = allowance minus graded
-- attempts in the current cycle window (same rule as repository.ts CYCLE_WINDOW_START_SQL).
INSERT INTO credit_grants (tenant_id, source, credits, remaining, expires_at, note)
SELECT p.tenant_id,
       CASE WHEN p.tier = 'free' THEN 'free_monthly' ELSE 'pilot' END,
       CASE WHEN p.tier = 'free' THEN LEAST(p.included_credits, 20) ELSE p.included_credits END,
       GREATEST(CASE WHEN p.tier = 'free' THEN LEAST(p.included_credits, 20) ELSE p.included_credits END - (
         SELECT COUNT(*)::int FROM billing_events b
          WHERE b.tenant_id = p.tenant_id AND b.event_type = 'assessment_graded'
            AND b.occurred_at >= (p.cycle_start + make_interval(months => GREATEST(0, (
                  EXTRACT(YEAR FROM age(now(), p.cycle_start)) * 12
                  + EXTRACT(MONTH FROM age(now(), p.cycle_start)))::int)))
       ), 0),
       now() + interval '12 months',
       'Z-93 backfill from tenant_plans'
  FROM tenant_plans p
 WHERE p.included_credits IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM credit_grants g WHERE g.tenant_id = p.tenant_id)
ON CONFLICT DO NOTHING;
