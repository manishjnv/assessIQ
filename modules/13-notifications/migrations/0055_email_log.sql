-- modules/13-notifications/migrations/0055_email_log.sql
-- Phase 3 G3.B — email delivery audit log.
--
-- Tracks every outbound email: queued → sending → sent|failed|bounced.
-- Written by the email.send BullMQ job processor (modules/13-notifications/src/email/index.ts).
-- Status transitions:
--   'queued'   — row inserted at enqueue time, before the job fires.
--   'sending'  — job processor set this before opening SMTP connection.
--   'sent'     — SMTP accepted the message; provider_message_id populated.
--   'failed'   — all retry attempts exhausted OR permanent error class.
--   'bounced'  — provider delivery notification (Phase 4 webhook ingest).
--
-- WHY a separate table (not just BullMQ job history):
--   BullMQ retains completed/failed jobs up to removeOnComplete/removeOnFail cap
--   (currently 50). email_log is the durable, auditable record with PII-safe
--   fields (to_address, subject) that compliance needs past 50 jobs. It also
--   carries provider_message_id for cross-referencing Resend/SES bounce reports.
--
-- WHAT is NOT in Phase 3:
--   - Bounce/complaint webhook ingest (Phase 4).
--   - Per-tenant template overrides (Phase 4).
--   - Unsubscribe tracking (Phase 4).
--
-- RLS: standard tenant_id-direct variant (same pattern as assessments).

CREATE TABLE email_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  to_address          TEXT NOT NULL,
  subject             TEXT NOT NULL,
  template_id         TEXT NOT NULL,
  body_text           TEXT,
  body_html           TEXT,
  status              TEXT NOT NULL CHECK (status IN ('queued','sending','sent','failed','bounced')),
  provider            TEXT,
  provider_message_id TEXT,
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON email_log
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert
  ON email_log
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Hot path: listing recent emails by tenant (admin UI, daily triage).
CREATE INDEX email_log_tenant_created_idx ON email_log (tenant_id, created_at DESC);

-- Partial index covering only the actively-monitored states — keeps index small
-- since 'sent' rows dominate the table over time.
CREATE INDEX email_log_tenant_status_partial_idx
  ON email_log (tenant_id, status)
  WHERE status IN ('queued', 'failed', 'bounced');
