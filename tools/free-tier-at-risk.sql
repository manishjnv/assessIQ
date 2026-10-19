-- tools/free-tier-at-risk.sql
-- READ-ONLY. SELECT only. Lists every tenant that flipping PLAN_TIERS_ENFORCED=true
-- (with the Free plan limits of docs/design/2026-10-20-free-tier-limits.md) would
-- block or change. A tenant with no tenant_plans row is treated as free (same as the code).
--
-- Run on the VPS (the postgres role bypasses RLS, so all tenants are visible):
--   ssh assessiq-vps 'docker exec -i assessiq-postgres psql -U assessiq -d assessiq' < tools/free-tier-at-risk.sql
--   (use the DB user name from the compose file if it differs)
--
-- Read the output:
--   at_risk = true  -> the flip blocks or changes this tenant. Fix first (move it to a paid tier,
--                      see tools/pilot-tenant-to-paid.sql, or get the owner OK).
-- Limits (keep in step with TIER_LIMITS.free in modules/19-billing/src/service.ts):
--   candidates 5 in total, licensed packs 5, credits 25 (hard stop at 100 %), AI attempts 5.
-- Locked on Free (FEATURE_MIN_TIER): webhooks, API keys, embed, audit viewer, own email sender.

WITH t AS (
  SELECT te.id AS tenant_id, te.slug, COALESCE(p.tier, 'free') AS tier,
         p.tier IS NULL AS no_plan_row, p.included_credits
    FROM tenants te
    LEFT JOIN tenant_plans p ON p.tenant_id = te.id
),
cand AS (  -- candidates ever created (soft-deleted and erased rows stay counted)
  SELECT tenant_id, COUNT(*)::int AS n FROM users WHERE role = 'candidate' GROUP BY 1
),
packs AS (
  SELECT tenant_id, COUNT(*)::int AS n FROM tenant_entitlements WHERE status = 'active' GROUP BY 1
),
credits AS (
  SELECT tenant_id, COUNT(*)::int AS n FROM billing_events WHERE event_type = 'assessment_graded' GROUP BY 1
),
ai AS (  -- same source as countAiAttemptsEver(): cached proposals UNION accepted AI events
  SELECT tenant_id, COUNT(DISTINCT attempt_id)::int AS n FROM (
    SELECT tenant_id, id AS attempt_id FROM attempts
     WHERE ai_proposals IS NOT NULL AND ai_proposals <> '[]'::jsonb
    UNION
    SELECT tenant_id, attempt_id FROM billing_events WHERE event_type = 'ai_answer_evaluated'
  ) s GROUP BY 1
),
hooks AS (SELECT tenant_id, COUNT(*)::int AS n FROM webhook_endpoints GROUP BY 1),
keys  AS (SELECT tenant_id, COUNT(*)::int AS n FROM api_keys WHERE status = 'active' GROUP BY 1),
emb   AS (SELECT tenant_id, COUNT(*)::int AS n FROM embed_secrets WHERE status <> 'revoked' GROUP BY 1),
certs AS (SELECT tenant_id, COUNT(*)::int AS n FROM certificates GROUP BY 1),
aud   AS (  -- audit viewer use is not stored; an audit export action is the nearest signal
  SELECT tenant_id, COUNT(*)::int AS n FROM audit_log WHERE action ILIKE '%export%' GROUP BY 1
)
SELECT t.slug, t.tier, t.no_plan_row,
       COALESCE(cand.n, 0)    AS candidates_ever,   -- limit 5
       COALESCE(packs.n, 0)   AS licensed_packs,    -- limit 5
       COALESCE(credits.n, 0) AS credits_used,      -- limit 25 (t.included_credits)
       t.included_credits,
       COALESCE(ai.n, 0)      AS ai_attempts,       -- limit 5
       COALESCE(hooks.n, 0)   AS webhook_endpoints, -- locked on Free
       COALESCE(keys.n, 0)    AS api_keys_active,   -- locked on Free
       COALESCE(emb.n, 0)     AS embed_secrets,     -- locked on Free
       COALESCE(certs.n, 0)   AS certificates,      -- allowed on Free (no "Trial" mark)
       COALESCE(aud.n, 0)     AS audit_export_events, -- locked on Free (audit viewer)
       (COALESCE(cand.n, 0) > 5 OR COALESCE(packs.n, 0) > 5
        OR COALESCE(credits.n, 0) >= 25 OR COALESCE(ai.n, 0) > 5
        OR COALESCE(hooks.n, 0) > 0 OR COALESCE(keys.n, 0) > 0
        OR COALESCE(emb.n, 0) > 0 OR COALESCE(aud.n, 0) > 0) AS at_risk
  FROM t
  LEFT JOIN cand USING (tenant_id) LEFT JOIN packs USING (tenant_id)
  LEFT JOIN credits USING (tenant_id) LEFT JOIN ai USING (tenant_id)
  LEFT JOIN hooks USING (tenant_id) LEFT JOIN keys USING (tenant_id)
  LEFT JOIN emb USING (tenant_id) LEFT JOIN certs USING (tenant_id)
  LEFT JOIN aud USING (tenant_id)
 WHERE t.tier = 'free'
 ORDER BY at_risk DESC, t.slug;
