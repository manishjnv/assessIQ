-- 0075_tenant_isolation_null_safe_cast.sql
-- Phase 5 — RLS hardening on the certificates table.
--
-- Closes the cast-crash hazard surfaced by RCA 2026-05-13 "Verify path
-- silently 404/500 in prod". The original policies in 0046 used:
--
--   USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
--
-- with the missing_ok=true flag on current_setting, which returns NULL when
-- the GUC is unset. NULL::uuid succeeds (returns NULL), and the resulting
-- equality is NULL→UNKNOWN→FALSE — RLS denies. That branch is safe.
--
-- The unsafe branch is when the GUC is explicitly set to the empty string ''.
-- Postgres ::uuid casts on '' throw `22P02 invalid input syntax for type uuid`
-- BEFORE the policy expression can short-circuit. When the broken policy is
-- OR'd with another permissive policy (e.g. `public_verify_lookup` from
-- migration 0074), Postgres still raises the cast exception — the OR cannot
-- "rescue" the query.
--
-- 2026-05-13's withPublicVerifyContext fix (commit 58759d7) sets a sentinel
-- UUID inside the transaction so the cast succeeds. This migration is the
-- belt-and-braces complement: rewrite the cert tenant_isolation policies to
-- be NULL/empty-string safe by construction. The new predicate is strictly
-- STRICTER than the old one — every input that previously returned TRUE
-- still returns TRUE; inputs that previously crashed now return FALSE
-- (RLS denies, which is the safe failure mode).
--
-- Scope is limited to the certificates table — the same cast pattern exists
-- on other tables, but they don't (yet) ship an OR'd permissive policy that
-- exposes the hazard. Broader sweep deferred until that need arises (and a
-- dedicated adversarial review covers the cross-cutting change).
--
-- Tested via re-running the verify smoke against prod after apply (404 on
-- non-existent credential — no `unhandled error` log line, latency unchanged).
--
-- ┌─────────────────────────── OPS NOTE ───────────────────────────┐
-- │ DROP POLICY takes AccessExclusiveLock on the table. This blocks │
-- │ all concurrent reads and writes for the duration of the         │
-- │ transaction. On an empty table or low-traffic table, the wait   │
-- │ is sub-millisecond. The real risk is colliding with a           │
-- │ long-lived withPublicVerifyContext transaction — the DROP will  │
-- │ block until that transaction commits, and new reads queue       │
-- │ behind it.                                                       │
-- │                                                                  │
-- │ Pre-apply check (run against the target DB):                    │
-- │   SELECT pid, query_start, state, query                         │
-- │   FROM pg_stat_activity                                          │
-- │   WHERE state <> 'idle' AND query ILIKE '%certificates%';       │
-- │ If any long-running rows surface, wait for them to finish or    │
-- │ apply during a low-traffic window.                              │
-- └──────────────────────────────────────────────────────────────────┘

BEGIN;

-- SELECT policy --------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON certificates;

CREATE POLICY tenant_isolation ON certificates
  FOR SELECT
  USING (
    current_setting('app.current_tenant', true) IS NOT NULL
    AND current_setting('app.current_tenant', true) <> ''
    AND tenant_id = current_setting('app.current_tenant', true)::uuid
  );

-- INSERT policy --------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation_insert ON certificates;

CREATE POLICY tenant_isolation_insert ON certificates
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_tenant', true) IS NOT NULL
    AND current_setting('app.current_tenant', true) <> ''
    AND tenant_id = current_setting('app.current_tenant', true)::uuid
  );

-- UPDATE policy --------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation_update ON certificates;

CREATE POLICY tenant_isolation_update ON certificates
  FOR UPDATE
  USING (
    current_setting('app.current_tenant', true) IS NOT NULL
    AND current_setting('app.current_tenant', true) <> ''
    AND tenant_id = current_setting('app.current_tenant', true)::uuid
  );

-- public_verify_lookup (from migration 0074) is intentionally NOT touched.
-- It is the OR'd permissive policy that the hardened tenant_isolation must
-- co-exist with for the public verify page to work.

COMMIT;
