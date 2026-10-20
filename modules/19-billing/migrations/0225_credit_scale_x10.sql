-- modules/19-billing/migrations/0225_credit_scale_x10.sql
-- Z-95: credit scale x10 (owner 2026-10-20). 1 new credit = 1/10 of an old credit; the
-- monetary value of each test is unchanged. New burn: mock 10, real 20, real+camera 30.
-- Free monthly refill 200. Counts only, no prices.
--
-- Idempotent: the one-time scaling is guarded by a comment on credit_grants
-- (no new table, no new column). Running this file twice does not scale twice.
-- Rollback (NOT automatic): divide credits, remaining, shortfall and included_credits by 10,
-- restore the policy limit 20, clear the comment.

DO $$
BEGIN
  IF COALESCE(obj_description('credit_grants'::regclass, 'pg_class'), '') NOT LIKE '%x10 applied%' THEN
    -- 0215 trigger blocks raising `remaining`; drop it for the one-time scale, then recreate it as in 0215.
    DROP TRIGGER IF EXISTS credit_grants_remaining_decrease_only ON credit_grants;
    UPDATE credit_grants SET credits = credits * 10, remaining = remaining * 10;
    CREATE TRIGGER credit_grants_remaining_decrease_only BEFORE UPDATE ON credit_grants
      FOR EACH ROW EXECUTE FUNCTION credit_grants_remaining_decrease_only();

    UPDATE credit_burns SET credits = credits * 10, shortfall = shortfall * 10;
    UPDATE tenant_plans SET included_credits = included_credits * 10 WHERE included_credits IS NOT NULL;

    COMMENT ON TABLE credit_grants IS 'Z-95 credit scale x10 applied';
  END IF;
END
$$;

-- The app role may only insert the free monthly grant, now up to 200 credits.
DROP POLICY IF EXISTS tenant_isolation_insert ON credit_grants;
CREATE POLICY tenant_isolation_insert ON credit_grants
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid AND source = 'free_monthly'
              AND credits = remaining AND credits <= 200);
