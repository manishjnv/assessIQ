-- modules/20-data-rights/migrations/0238_attempt_retention_days.sql
-- FUT-11 — optional per-tenant window for the behavioural-event log of finished attempts.
--
-- NULL (default) = keep forever, so nothing changes until a tenant opts in.
-- The nightly sweep (attempt-retention.ts) deletes attempt_events rows only. Answers,
-- scores, gradings and certificates are never touched. Candidate PII has its own window
-- (retention_days, 0103).
-- Rollback: ALTER TABLE tenant_settings DROP COLUMN attempt_retention_days;

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS attempt_retention_days INT NULL
    CHECK (attempt_retention_days IS NULL OR attempt_retention_days BETWEEN 30 AND 3650);

COMMENT ON COLUMN tenant_settings.attempt_retention_days IS
  'FUT-11: days to keep attempt_events rows after an attempt ends. NULL = keep forever. Only attempt_events is deleted.';
