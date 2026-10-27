-- 0271_exp17_upload_override_help.sql
--
-- Help for the three organisation-upload limit overrides in the super-admin billing drawer (EXP-17).
-- Three new keys, version 1. Mirrors content/en/admin.yml. Idempotent: INSERT ... WHERE NOT EXISTS (as in 0269).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.platform.upload_override_per_upload', 'admin', 'en',
  'Most questions in one upload for this organisation. Leave empty to use the plan default.',
  $$## Questions per upload

This sets the most questions one organisation upload file may hold.

- **Empty box.** The limit of the plan tier applies.
- **Number.** Type a whole number from 0 to 1000000. 0 means the organisation cannot upload.

Only a platform admin can change this. Saving needs a fresh authenticator code and is written to the audit log.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.platform.upload_override_per_upload' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.platform.upload_override_per_upload' AND locale = 'en'
    AND short_text = 'Most questions in one upload for this organisation. Leave empty to use the plan default.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.platform.upload_override_per_month', 'admin', 'en',
  'Most uploads each month for this organisation. Leave empty to use the plan default.',
  $$## Uploads per month

This sets how many uploads the organisation may make in one month.

- **Empty box.** The limit of the plan tier applies.
- **Number.** Type a whole number from 0 to 1000000. 0 means the organisation cannot upload.

Only a platform admin can change this. Saving needs a fresh authenticator code and is written to the audit log.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.platform.upload_override_per_month' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.platform.upload_override_per_month' AND locale = 'en'
    AND short_text = 'Most uploads each month for this organisation. Leave empty to use the plan default.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.platform.upload_override_total', 'admin', 'en',
  'Most uploaded questions in total for this organisation. Leave empty to use the plan default.',
  $$## Total uploaded questions

This sets the most uploaded questions the organisation may keep in all.

- **Empty box.** The limit of the plan tier applies.
- **Number.** Type a whole number from 0 to 1000000. 0 means the organisation cannot upload.

Only a platform admin can change this. Saving needs a fresh authenticator code and is written to the audit log.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.platform.upload_override_total' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.platform.upload_override_total' AND locale = 'en'
    AND short_text = 'Most uploaded questions in total for this organisation. Leave empty to use the plan default.'
);
