-- owned by modules/02-tenancy
-- 0205 (Z-50) - per-tenant switch for the "Distinction" wording on certificates.
--
-- Every candidate who passes gets a certificate. The stored tier on the credential
-- (completion or distinction, set by module 18 at issue time) never changes. This
-- flag only controls whether the word "Distinction" is DISPLAYED (PDF, public verify
-- page, share preview, candidate certificate list). It is read at render time, so
-- switching it also changes how already issued certificates are shown; no row in
-- `certificates` is rewritten and no signature changes.
--
-- Default FALSE (off): the owner enables it per organisation. Additive and idempotent.
-- Rollback: UPDATE tenant_settings SET certificate_show_distinction = false.
-- The column stays in place.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS certificate_show_distinction BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tenant_settings.certificate_show_distinction IS
  'When true, certificates with stored tier distinction show the word Distinction. Changed only by updateCertificateShowDistinction (audited).';
