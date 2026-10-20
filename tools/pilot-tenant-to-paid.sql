-- tools/pilot-tenant-to-paid.sql
-- Puts up to TWO named pilot tenants on the SAME paid tier with the SAME credit grant.
-- Owner decision 2026-10-20: birla and wipro-soc are treated equally; wipro-soc is the test organisation.
-- Every named tenant that is active is changed, whatever its tier is now (free or internal).
--
-- What it does, in one transaction:
--   1. Shows the plan rows and the credit grants before.
--   2. Sets tier = :new_tier and included_credits = :pilot_credits on both tenants.
--   3. Zeroes the leftover free_monthly grant of both tenants (a paid tenant gets no free refill).
--   4. Adds ONE pilot grant of :pilot_credits credits (valid 12 months) to each tenant, only if the
--      tenant has no pilot grant with the note 'pilot grant 2026-10-20' yet (safe to run twice).
--   5. Shows the rows after.
--
-- Safe by default: the script ends with ROLLBACK, so a blind run changes nothing.
-- To apply: change the last line from ROLLBACK to COMMIT, then run it once.
--
-- Run on the VPS (postgres role; tenant_plans has no UPDATE policy for the app role):
--   ssh assessiq-vps 'docker exec -i assessiq-postgres psql -U assessiq -d assessiq --     -v slug_1=birla -v slug_2=wipro-soc -v new_tier=pro -v pilot_credits=4500' --     < tools/pilot-tenant-to-paid.sql
--   new_tier: pro | enterprise | internal. pilot_credits: a whole number in the CURRENT credit
--   unit (mock 10, real 20, real with camera 30).
--   Run it only AFTER migration 0225 (credit scale x10) is applied.
--
-- This SQL does not write an audit row. The super-admin screen
-- (POST /api/admin/super/tenants/:id/credits) writes one; this file is the direct fallback.

BEGIN;

-- 1. Before.
SELECT te.slug, te.status AS tenant_status, p.tier, p.included_credits, p.status AS plan_status
  FROM tenants te LEFT JOIN tenant_plans p ON p.tenant_id = te.id
 WHERE te.slug IN (:'slug_1', :'slug_2') ORDER BY te.slug;
SELECT te.slug, g.source, g.credits, g.remaining, g.expires_at::date AS expires
  FROM tenants te JOIN credit_grants g ON g.tenant_id = te.id
 WHERE te.slug IN (:'slug_1', :'slug_2') ORDER BY te.slug, g.granted_at;

-- 2. Same tier and the same credit limit on both tenants (active tenants only).
UPDATE tenant_plans p
   SET tier = :'new_tier',
       included_credits = :pilot_credits,
       ai_answers_included_override = NULL,   -- use the paid-tier default again
       updated_at = now()
  FROM tenants te
 WHERE te.id = p.tenant_id
   AND te.slug IN (:'slug_1', :'slug_2')
   AND te.status = 'active';

-- 3. A paid tenant has no free refill: zero what is left of the free monthly grant.
UPDATE credit_grants g
   SET remaining = 0
  FROM tenants te
 WHERE te.id = g.tenant_id
   AND te.slug IN (:'slug_1', :'slug_2')
   AND g.source = 'free_monthly'
   AND g.remaining > 0;

-- 4. The same pilot grant for each tenant, once.
INSERT INTO credit_grants (tenant_id, source, credits, remaining, expires_at, note)
SELECT te.id, 'pilot', :pilot_credits, :pilot_credits, now() + interval '12 months', 'pilot grant 2026-10-20'
  FROM tenants te
 WHERE te.slug IN (:'slug_1', :'slug_2')
   AND te.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM credit_grants x WHERE x.tenant_id = te.id AND x.note = 'pilot grant 2026-10-20');

-- 5. After.
SELECT te.slug, p.tier, p.included_credits, p.status
  FROM tenants te JOIN tenant_plans p ON p.tenant_id = te.id
 WHERE te.slug IN (:'slug_1', :'slug_2') ORDER BY te.slug;
SELECT te.slug, g.source, g.credits, g.remaining, g.expires_at::date AS expires
  FROM tenants te JOIN credit_grants g ON g.tenant_id = te.id
 WHERE te.slug IN (:'slug_1', :'slug_2') ORDER BY te.slug, g.granted_at;

ROLLBACK;  -- change to COMMIT only after the owner approves
