-- modules/20-data-rights/migrations/0103_tenant_retention_days.sql
-- Module 20 S1 — Add tenant_settings.retention_days INT NOT NULL DEFAULT 730.
--
-- PURPOSE:
--   Per-tenant candidate-data retention window in DAYS. The S5 retention
--   cron uses this to identify candidates whose data is past the
--   tenant's policy window and runs the same erasure flow as a
--   candidate-initiated DSR request.
--
-- DISTINCT FROM audit_retention_years:
--   `audit_retention_years` (added in 14-audit-log migration 0050, default
--   7 years) governs how long the audit_log forensic chain is kept.
--   `retention_days` (this migration, default 730 = 2 years) governs how
--   long candidate PII is kept in live tables before tombstoning.
--   Intentionally different defaults: audit needs 7y for compliance
--   forensics; PII gets minimized at 2y for HR-grade retention.
--
-- RANGE:
--   1–3650 days (10 years upper bound) — matches audit-log's 1–10y range.
--   Tenants in shorter-mandate sectors (healthcare 5y, generic SaaS 3y)
--   can override below the default via the admin settings UI (S5).
--
-- IDEMPOTENCY:
--   IF NOT EXISTS guard. CHECK constraint enforces range at write time.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS retention_days INT NOT NULL DEFAULT 730
    CHECK (retention_days BETWEEN 1 AND 3650);

COMMENT ON COLUMN tenant_settings.retention_days IS
  'Per-tenant candidate-data retention window in DAYS. The retention cron tombstones candidate PII when MAX(attempts.submitted_at) for a candidate is older than this window. Distinct from audit_retention_years (audit_log forensic-chain window). See modules/20-data-rights/SKILL.md D4.';
