-- 0105_seed_data_rights_help.sql
--
-- Help content for the two DPDP data-rights actions on the admin Users page
-- (modules/10-admin-dashboard/src/pages/users.tsx):
--   - data-help-id="admin.user.data_export"  ("Download data" menu item)
--   - data-help-id="admin.user.erase"        ("Erase personal data" menu item)
--
-- WHY a separate migration instead of regenerating 0011:
--   0011_seed_help_content.sql is already applied in production and the runner
--   never re-applies a migration by content, so help rows authored after 0011
--   must ship as a forward migration. Source of truth is
--   content/en/admin.yml (these rows mirror their new entries there).
--   Same pattern as 0093, 0094, 0097, 0099.
--
-- Idempotent: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING. Global
-- rows (tenant_id IS NULL) must be inserted as the postgres superuser, which
-- BYPASSes the help_content INSERT RLS policy.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.user.data_export', 'admin', 'en',
  'Download a JSON copy of everything AssessIQ holds about this candidate — for fulfilling a data-access request.',
  $$## Download candidate data

Produces a JSON file containing every piece of data the platform holds for
this candidate, including:

- **Profile** — name, email, role, account status, created date.
- **Attempts** — each assessment attempt with start/end times, status, and
  the candidate's submitted answers for each question.
- **Certificates** — any issued certificates, including the name snapshot
  recorded at issuance (even if the profile has since been erased).
- **Consents** — any recorded consent or terms-acceptance events.
- **Audit events** — platform-generated events tied to this user ID
  (logins, role changes, lifecycle actions).

Use this action to fulfil a **Data-Access Request (DAR)** under the Digital
Personal Data Protection Act (DPDP) or equivalent legislation. The file is
downloaded directly to your browser — it is not stored on the AssessIQ
servers after download.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.user.erase', 'admin', 'en',
  'Permanently erase this candidate''s personal data (DPDP right to erasure). Certificates are preserved for verification.',
  $$## Erase candidate data

Fulfils the **Right to Erasure** (also known as the right to be forgotten)
under the Digital Personal Data Protection Act (DPDP) and similar laws.

**What is erased — irreversibly:**

- Name and email address (replaced with a tombstone placeholder).
- Free-text answers submitted during assessments.
- IP address and device-fingerprint data from session records.

**What is preserved:**

- **Issued certificates** remain valid. The candidate's name was snapshotted
  at the moment of issuance and is retained on the certificate record so
  that public certificate-verification links continue to work. The live
  profile name is erased; the certificate snapshot is not.
- Aggregate scoring rows (band, level) are retained without PII for
  platform analytics.
- The audit log entry recording this erasure action is preserved (required
  for regulatory accountability).

**This action is irreversible.** You must enter a reason and acknowledge
the action before it is applied. The reason is recorded in the audit log.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
