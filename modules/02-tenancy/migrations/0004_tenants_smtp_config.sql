-- owned by modules/02-tenancy
-- Phase 1 G1.B Session 3 — additive `smtp_config` JSONB column on `tenants`.
--
-- Decision #12 (Phase 1 plan): `13-notifications` Phase 1 scope is real SMTP
-- via per-tenant Hostinger relay. This migration adds the column that holds
-- each tenant's SMTP credentials so a future module-13 SMTP driver can read
-- them. Phase 1 G1.B Session 3 itself ships ONLY the column — the active
-- nodemailer driver swap-in is deferred (see SESSION_STATE handoff). The
-- module-05 invitation flow uses the existing dev-emails.log stub until the
-- driver lands.
--
-- Shape (per modules/05-assessment-lifecycle/SKILL.md § Decisions captured —
-- decision #12):
--   {
--     "host": "smtp.hostinger.com",
--     "port": 465,
--     "secure": true,
--     "user": "no-reply@<tenant-domain>",
--     "password_enc": "<base64 AES-256-GCM ciphertext>",
--     "from_address": "no-reply@<tenant-domain>",
--     "from_name": "AssessIQ"
--   }
--
-- The column is NULLABLE — most tenants will run without per-tenant SMTP in
-- early Phase 1. The future SMTP driver fail-closes when smtp_config IS NULL
-- in production (returns 503 SmtpNotConfigured). RLS on `tenants` is already
-- in place (0003_tenants_rls.sql); no new policy needed for the column add.
--
-- ADDITIVE-ONLY: this migration only adds a column. It does not change RLS,
-- does not rewrite existing rows, and does not introduce a NOT NULL default
-- that would block deploys with existing data. Safe to apply on a live VPS
-- with running tenants.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS smtp_config JSONB;

COMMENT ON COLUMN tenants.smtp_config IS
  'Per-tenant SMTP credentials for outbound email. NULL = use dev stub (Phase 1) / fail-closed in Phase 1.5+ when the SMTP driver lands. Shape: {host, port, secure, user, password_enc, from_address, from_name}. password_enc is AES-256-GCM ciphertext under ASSESSIQ_MASTER_KEY.';
