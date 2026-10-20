-- tools/pilot-tenant-to-paid.sql
-- Moves up to TWO named pilot tenants off the 'free' tier BEFORE PLAN_TIERS_ENFORCED is flipped,
-- so the Free limits (5 candidates, 5 packs, credit hard stop, 5 AI attempts) never hit them.
-- Only tenants whose tier is still 'free' are changed. A tenant that is already pro, enterprise
-- or internal is shown and left alone. Nothing else is touched.
--
-- Safe by default: the script ends with ROLLBACK, so a blind run changes nothing.
-- To apply: change the last line from ROLLBACK to COMMIT, then run it once.
--
-- Run on the VPS (postgres role; tenant_plans has no UPDATE policy for the app role):
--   ssh assessiq-vps 'docker exec -i assessiq-postgres psql -U assessiq -d assessiq --     -v slug_1=<tenant-slug> -v slug_2=<tenant-slug-or-same> -v new_tier=pro -v new_credits=NULL' --     < tools/pilot-tenant-to-paid.sql
--   new_tier: pro | enterprise | internal.  new_credits: a number, or NULL for no credit cap
--   (a NULL cap means unlimited: no ledger burn and no hard stop).
--
-- This SQL does not write an audit row. Prefer the super-admin screen
-- (PATCH /api/admin/super/tenants/:id/plan) when an audit trail is wanted;
-- this file is the fallback for a direct DB change.

BEGIN;

-- 1. Show the rows before the change.
SELECT te.slug, te.status AS tenant_status, p.tier, p.included_credits, p.ai_answers_included_override, p.status
  FROM tenants te LEFT JOIN tenant_plans p ON p.tenant_id = te.id
 WHERE te.slug IN (:'slug_1', :'slug_2') ORDER BY te.slug;

-- 2. Move the tier, only for tenants that are still 'free' (and active). Updates the existing row.
UPDATE tenant_plans p
   SET tier = :'new_tier',
       included_credits = :new_credits,
       ai_answers_included_override = NULL,   -- use the paid-tier default again
       updated_at = now()
  FROM tenants te
 WHERE te.id = p.tenant_id
   AND te.slug IN (:'slug_1', :'slug_2')
   AND te.status = 'active'
   AND p.tier = 'free';

-- 3. Show the rows after the change, with the credit ledger.
SELECT te.slug, p.tier, p.included_credits, p.ai_answers_included_override, p.status
  FROM tenants te JOIN tenant_plans p ON p.tenant_id = te.id
 WHERE te.slug IN (:'slug_1', :'slug_2') ORDER BY te.slug;
SELECT te.slug, g.source, g.credits, g.remaining, g.expires_at::date AS expires
  FROM tenants te JOIN credit_grants g ON g.tenant_id = te.id
 WHERE te.slug IN (:'slug_1', :'slug_2') ORDER BY te.slug, g.granted_at;

ROLLBACK;  -- change to COMMIT only after the owner approves
