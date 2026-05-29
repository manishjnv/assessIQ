-- modules/20-data-rights/migrations/0102_users_erased_at.sql
-- Module 20 S1 — Add users.erased_at TIMESTAMPTZ NULL.
--
-- PURPOSE:
--   Marker timestamp for DPDP / GDPR erasure executed on a candidate's
--   user row. Distinct from `deleted_at` (admin soft-delete):
--     - deleted_at: admin removed the user; row may still hold PII.
--     - erased_at: PII columns (name, email) have been tombstoned per
--                  the DPDP right-to-erasure flow. Row remains so
--                  14-audit-log immutability and 18-certification HMAC
--                  signatures stay intact (see SKILL.md D1).
--   The two are orthogonal. A row may be deleted-but-not-erased (admin
--   removed but PII retained) or erased-but-not-deleted (PII tombstoned,
--   row still visible to admin as "deleted_user_<hash>").
--
-- IDEMPOTENCY:
--   IF NOT EXISTS guards make this safe to re-run. The existing
--   `users_tenant_role_idx` (deleted_at IS NULL) is unchanged; this
--   migration adds a parallel partial index for the retention purge
--   cron (S5) to find non-erased candidates efficiently.
--
-- RLS UNCHANGED:
--   The users table's existing tenant_isolation policies cover this
--   column without modification. No new policy needed.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS erased_at TIMESTAMPTZ;

COMMENT ON COLUMN users.erased_at IS
  'DPDP / GDPR erasure marker. When set, name and email columns hold tombstone values per modules/20-data-rights/SKILL.md D1. Distinct from deleted_at (admin soft-delete).';

-- Partial index for the S5 retention purge cron.
-- WHERE clauses target: candidates not yet erased, with the lookup
-- driven by (tenant_id, role, erased_at) selectivity.
CREATE INDEX IF NOT EXISTS users_tenant_candidate_not_erased_idx
  ON users (tenant_id, created_at)
  WHERE role = 'candidate'
    AND erased_at IS NULL
    AND deleted_at IS NULL;
