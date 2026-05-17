-- modules/19-billing/migrations/0082_entitlements_backfill.sql
-- Phase B1 — existing-tenant entitlement backfill.
--
-- PURPOSE:
--   Provisions domain-level tenant_entitlements rows for all tenants that
--   already have live question content (at least one 'active' question in a
--   'published' pack). Without this backfill, Phase B2 enforcement would
--   immediately block every existing tenant from using generation features
--   that they have legitimately used before the entitlement model was deployed.
--
-- EXECUTION CONTEXT:
--   Run as superuser or assessiq_system (BYPASSRLS) directly in psql.
--   No app.current_tenant GUC needed — this script bypasses RLS.
--   Do NOT run via the application's withTenant() — that would require a
--   current_tenant GUC set for every row, which is impractical for a
--   one-time bulk backfill.
--
-- IDEMPOTENCY:
--   The INSERT … ON CONFLICT DO NOTHING is safe to re-run. Re-running after a
--   partial failure will skip rows that were already inserted and fill in any
--   that were missed.
--
-- DESIGN DECISIONS:
--
--   1. Domain-level entitlements only (scope_type = 'domain').
--      Phase B1 introduces the entitlement table and backfills existing content.
--      Pack-level entitlements (scope_type = 'pack') are Phase B2 scope and
--      are NOT backfilled here.
--
--   2. Join: question_packs → questions via questions.pack_id.
--      questions.pack_id is a direct FK to question_packs.id (0012_questions.sql).
--      question_packs.domain is the TEXT domain label (0010_question_packs.sql).
--      question_packs.tenant_id is the tenant FK (0010_question_packs.sql).
--      The join is:
--        question_packs qp
--        JOIN questions q ON q.pack_id = qp.id AND q.status = 'active'
--      filtered by qp.status = 'published' AND qp.domain IS NOT NULL AND qp.domain <> ''.
--      This gives us: "every domain where tenant X has at least one active
--      question in a published pack" — exactly the intent.
--
--   3. granted_by = NULL.
--      Backfill rows represent implied entitlements, not explicit operator grants.
--      The audit trail is this migration itself (timestamp in the row's granted_at
--      defaults to now() at apply time).
--
--   4. status = 'active' on all backfill rows.
--      These represent pre-existing legitimate access; no reason to revoke them.
--
-- APPLY ORDER:
--   Must run AFTER 0081_tenant_entitlements.sql.
--   Must run BEFORE any B2 deploy that enforces entitlement checks.
--   Safe to run in a maintenance window after the B1 application redeployment.
--
-- DO NOT APPLY without first verifying the join returns expected rows (see
-- verification query below). Operator must confirm before applying to production.

-- ---------------------------------------------------------------------------
-- Backfill: domain entitlements from live question content
-- ---------------------------------------------------------------------------

INSERT INTO tenant_entitlements (tenant_id, scope_type, scope_id, granted_by, status)
SELECT DISTINCT qp.tenant_id, 'domain', qp.domain, NULL, 'active'
FROM question_packs qp
JOIN questions q ON q.pack_id = qp.id AND q.status = 'active'
WHERE qp.status = 'published'
  AND qp.domain IS NOT NULL
  AND qp.domain <> ''
ON CONFLICT (tenant_id, scope_type, scope_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- VERIFICATION (run after applying — do NOT skip this step)
-- ---------------------------------------------------------------------------

-- Query 1: For each tenant, compare granted domains vs distinct live-question domains.
-- Every tenant-domain pair with live content must appear in tenant_entitlements.
-- If any row has entitlements_count = 0 but live_domain_count > 0, B2 will 403
-- that tenant for those domains — investigate before deploying B2.
--
-- SELECT
--   t.slug,
--   live.domain,
--   live.live_question_count,
--   e.granted_at,
--   e.status
-- FROM (
--   SELECT qp.tenant_id, qp.domain, COUNT(q.id) AS live_question_count
--   FROM question_packs qp
--   JOIN questions q ON q.pack_id = qp.id AND q.status = 'active'
--   WHERE qp.status = 'published'
--     AND qp.domain IS NOT NULL
--     AND qp.domain <> ''
--   GROUP BY qp.tenant_id, qp.domain
-- ) live
-- JOIN tenants t ON t.id = live.tenant_id
-- LEFT JOIN tenant_entitlements e
--   ON e.tenant_id = live.tenant_id
--   AND e.scope_type = 'domain'
--   AND e.scope_id = live.domain
--   AND e.status = 'active'
-- ORDER BY t.slug, live.domain;
--
-- Expected: every row has e.granted_at IS NOT NULL (i.e. the LEFT JOIN found a match).
-- Any row with e.granted_at IS NULL = missing entitlement = B2 will block that tenant.

-- NOTE: Operator MUST run this verification query after applying and confirm
-- zero rows with e.granted_at IS NULL before deploying B2 enforcement. If gaps
-- exist, re-run this migration (idempotent) or grant manually via the super-admin
-- entitlement UI added in B1.
