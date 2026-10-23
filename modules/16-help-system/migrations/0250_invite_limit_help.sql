-- 0250_invite_limit_help.sql
--
-- EXP-37: help for the students-per-assessment limit on the invite dialog. Mirrors content/en/admin.yml.
-- New key only, version 1. Idempotent: INSERT ... WHERE NOT EXISTS, as in 0241.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.invite_limit', 'admin', 'en',
  'The most students you can invite to one assessment. Your plan sets it. To invite more, split them into two assessments.',
  $$## Students per assessment

Your plan sets the most students you can invite to one assessment. The default limit is 150 students. The limit keeps each assessment manageable for the platform and your reviewers.

If you need to invite more students, do one of these:

1. Split the students into two assessments. Run them at different times.
2. Contact support to ask for a higher limit.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.invite_limit' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.invite_limit' AND locale = 'en'
    AND short_text = '{SHORT}'
);
