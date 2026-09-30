-- 0108_seed_company_name_help.sql
--
-- Help content for the tenant-admin "Company name" field on /admin/settings
-- (modules/10-admin-dashboard/src/pages/tenant-settings.tsx):
--   - data-help-id="admin.settings.company_name"
--
-- Forward migration (0011 is already applied in prod); mirrors the new entry in
-- content/en/admin.yml. Same pattern as 0093/0094/0097/0099/0105.
-- Idempotent: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.company_name', 'admin', 'en',
  'The company name shown in the app header and in emails to your candidates.',
  $$## Company name

This is your organisation's **display name**. It appears in the app header
and in emails sent to your candidates (invitations, reminders).

- Use 2–120 characters; extra spaces are tidied automatically.
- Changing it does **not** change your sign-in address, tenant ID, or
  anything candidates use to log in.
- The new name also appears on certificates you issue or view afterwards.
- Each change is recorded in the audit log.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
