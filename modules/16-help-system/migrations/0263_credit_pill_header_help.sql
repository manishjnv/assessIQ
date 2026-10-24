-- 0263_credit_pill_header_help.sql
--
-- Credit pill and header button help (Z-149, Z-151): three new keys, plus new versions of two time limit keys.
-- Mirrors content/en/admin.yml.
--   New keys (version 1): admin.shell.credit_pill, admin.assessments.send_test_now, admin.assessments.new_advanced.
--   New versions (highest existing version + 1, same key): admin.start_test.time_limit and
--   admin.assessments.time_limit. The "Blank" bullet now says the time limit comes from the question set,
--   or from the minutes entered above. This replaces the difficulty wording of 0234.
-- Idempotent: INSERT ... WHERE NOT EXISTS. The guard compares the real key and text, as in 0262 and 0240.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.shell.credit_pill', 'admin', 'en',
  'The number shows your available credits and the credits granted this month.',
  $$## Credit pill

The number at the top of the page shows your credits.

- **Available.** The credits you can use now.
- **Granted this month.** The credits added to your plan this month.
- **Held.** Credits held for invited students are not available.
- **Details.** Click the number to open Plan and usage.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.shell.credit_pill' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.shell.credit_pill' AND locale = 'en'
    AND short_text = 'The number shows your available credits and the credits granted this month.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.send_test_now', 'admin', 'en',
  'The fast way: pick a question set, choose the test type, invite students and publish in one step.',
  $$## Send a test now

Use this when one question set is enough for the test.

- **One step.** Pick a question set, choose the test type, invite students and publish.
- **Result.** The test goes live for the students you invite.
- **More settings.** Use the other button to set everything before you publish.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.send_test_now' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.send_test_now' AND locale = 'en'
    AND short_text = 'The fast way: pick a question set, choose the test type, invite students and publish in one step.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.new_advanced', 'admin', 'en',
  'Build an assessment with all settings. It stays a draft until you publish.',
  $$## Build with all settings

Use this to set every part of the assessment yourself.

- **All settings.** Set the question set, the test type, the time limit and the invitations.
- **Draft.** The assessment stays a draft until you publish it.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.new_advanced' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.new_advanced' AND locale = 'en'
    AND short_text = 'Build an assessment with all settings. It stays a draft until you publish.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.start_test.time_limit', 'admin', 'en',
  'Time limit for this test in minutes, 1 to 600. Blank uses the time of the difficulty.',
  $$## Time limit

Set how many minutes a candidate has for this test, from 1 to 600.

- **Blank.** The time limit comes from the question set, or from the minutes you enter above. The grey number in the box shows it.
- **A number.** The test uses this time instead.
- **Running attempts.** A candidate who has started keeps the time they started with.
- **Full mock.** A full mock sets its own section times. This box does not apply to it.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.start_test.time_limit' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.start_test.time_limit' AND locale = 'en'
    AND short_text = 'Time limit for this test in minutes, 1 to 600. Blank uses the time of the difficulty.'
    AND long_md LIKE '%The time limit comes from the question set, or from the minutes you enter above.%'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.time_limit', 'admin', 'en',
  'Time limit in minutes, 1 to 600. Blank uses the time of the difficulty.',
  $$## Time limit

Set how many minutes a candidate has for this assessment, from 1 to 600.

- **Blank.** The time limit comes from the question set, or from the minutes you enter above.
- **A number.** The assessment uses this time instead.
- **Any status.** You can change it after publish. It applies to attempts that start later.
- **Running attempts.** A candidate who has started keeps the time they started with.
- **Sections.** An assessment with section times uses those section times.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.time_limit' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.time_limit' AND locale = 'en'
    AND long_md LIKE '%The time limit comes from the question set, or from the minutes you enter above.%'
);
