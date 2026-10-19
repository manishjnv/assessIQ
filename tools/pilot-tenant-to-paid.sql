-- tools/pilot-tenant-to-paid.sql
-- WRITTEN ONLY. DO NOT RUN until the owner approves the pilot tenant's new tier.
-- Purpose: move the pilot tenant off the 'free' tier BEFORE PLAN_TIERS_ENFORCED is flipped,
-- so the Free limits (5 candidates, 5 packs, 25 credits, 5 AI attempts) never hit it.
--
-- Safe by default: the script ends with ROLLBACK, so a blind run changes nothing.
-- To apply: change the last line from ROLLBACK to COMMIT, then run it once.
--
-- Run on the VPS (postgres role; tenant_plans has no UPDATE policy for the app role):
--   ssh assessiq-vps 'docker exec -i assessiq-postgres psql -U assessiq -d assessiq \
--     -v pilot_slug=<tenant-slug> -v new_tier=pro -v new_credits=NULL' < tools/pilot-tenant-to-paid.sql
--   new_tier: pro | enterprise | internal.  new_credits: a number, or NULL for no credit cap.
--
-- This SQL does not write an audit row. Prefer the super-admin screen
-- (PATCH /api/admin/super/tenants/:id/plan) when the owner wants an audit trail;
-- this file is the fallback for a direct DB change.

BEGIN;

-- 1. Show the row before the change (stop here if it is not the pilot tenant).
SELECT te.id, te.slug, p.tier, p.included_credits, p.ai_answers_included_override, p.status
  FROM tenants te LEFT JOIN tenant_plans p ON p.tenant_id = te.id
 WHERE te.slug = :'pilot_slug';

-- 2. Move the tier. Updates the existing row; inserts one if the tenant has none.
INSERT INTO tenant_plans (tenant_id, tier, included_credits)
SELECT te.id, :'new_tier', :new_credits
  FROM tenants te WHERE te.slug = :'pilot_slug'
ON CONFLICT (tenant_id) DO UPDATE
   SET tier = EXCLUDED.tier,
       included_credits = EXCLUDED.included_credits,
       ai_answers_included_override = NULL,   -- use the paid-tier default again
       updated_at = now();

-- 3. Show the row after the change.
SELECT te.slug, p.tier, p.included_credits, p.ai_answers_included_override, p.status
  FROM tenants te JOIN tenant_plans p ON p.tenant_id = te.id
 WHERE te.slug = :'pilot_slug';

ROLLBACK;  -- change to COMMIT only after the owner approves
