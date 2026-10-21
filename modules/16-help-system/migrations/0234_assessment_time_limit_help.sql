-- 0234_assessment_time_limit_help.sql
--
-- Optional time limit per assessment: help for the Time limit box on the Start a test page and the
-- Time limit card on the assessment detail page. Mirrors content/en/admin.yml.
-- New keys only, version 1. Idempotent: INSERT ... WHERE NOT EXISTS, as in 0232.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.start_test.time_limit', 'admin', 'en',
  'Time limit for this test in minutes, 1 to 600. Blank uses the time of the difficulty.',
  $$## Time limit

Set how many minutes a candidate has for this test, from 1 to 600.

- **Blank.** The test uses the time of the difficulty you chose. The grey number in the box shows it.
- **A number.** The test uses this time instead.
- **Running attempts.** A candidate who has started keeps the time they started with.
- **Full mock.** A full mock sets its own section times. This box does not apply to it.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.start_test.time_limit' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.start_test.time_limit' AND locale = 'en'
    AND short_text = 'Time limit for this test in minutes, 1 to 600. Blank uses the time of the difficulty.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.time_limit', 'admin', 'en',
  'Time limit in minutes, 1 to 600. Blank uses the time of the difficulty.',
  $$## Time limit

Set how many minutes a candidate has for this assessment, from 1 to 600.

- **Blank.** The assessment uses the time of its difficulty level.
- **A number.** The assessment uses this time instead.
- **Any status.** You can change it after publish. It applies to attempts that start later.
- **Running attempts.** A candidate who has started keeps the time they started with.
- **Sections.** An assessment with section times uses those section times.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.time_limit' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.time_limit' AND locale = 'en'
    AND short_text = 'Time limit in minutes, 1 to 600. Blank uses the time of the difficulty.'
);
