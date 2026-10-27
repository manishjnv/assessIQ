-- AssessIQ - modules/18-certification/migrations/0272_certificate_valid_until.sql
--
-- X3a: optional expiry date for a certificate. Display-only metadata.
-- NULL = never expires (every existing row). Not part of the HMAC signed payload.
-- Additive; no backfill. Table already has tenant_id and RLS.

ALTER TABLE certificates ADD COLUMN IF NOT EXISTS valid_until timestamptz NULL;
