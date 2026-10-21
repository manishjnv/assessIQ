-- 0239_attempt_retention_help.sql
--
-- Z-132: help for the attempt activity log retention field on the organisation settings page. Mirrors content/en/admin.yml.
-- New key only, version 1. Idempotent: INSERT ... WHERE NOT EXISTS, as in 0235.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.tenant_settings.attempt_retention_days', 'admin', 'en',
  'How many days to keep the activity log of finished tests (tab switches, focus changes, answer saves). Leave blank to keep it forever. Range 30 to 3650. Answers, scores and certificates are never deleted by this setting.',
  $$## Keep attempt activity log for

How many days to keep the activity log of finished tests (tab switches, focus changes, answer saves). Leave blank to keep it forever. Range 30 to 3650. Answers, scores and certificates are never deleted by this setting.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.attempt_retention_days' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.attempt_retention_days' AND locale = 'en'
    AND short_text = 'How many days to keep the activity log of finished tests (tab switches, focus changes, answer saves). Leave blank to keep it forever. Range 30 to 3650. Answers, scores and certificates are never deleted by this setting.'
);
