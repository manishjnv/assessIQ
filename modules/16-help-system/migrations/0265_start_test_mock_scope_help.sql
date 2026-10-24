-- 0265_start_test_mock_scope_help.sql
--
-- Help for the mock scope and topics controls on the Start a test page (EXP-35, EXP-11): two new keys, version 1.
-- Mirrors content/en/admin.yml.
-- Idempotent: INSERT ... WHERE NOT EXISTS. The guard compares the real key and text, as in 0263.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.start_test.mock_scope', 'admin', 'en',
  'Choose the full test, or only some subjects, and a smaller size.',
  $$## What the mock covers

- **Full test.** All sections of the exam, at full size.
- **Chosen subjects only.** Tick the subjects you want. The mock has only those sections.
- **Size.** Use 75, 50 or 25 percent of the questions and of the time for each section.

A shorter mock is a practice test. It has no cut-off. Marks per question stay the same. It costs the same credits as any mock.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.start_test.mock_scope' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.start_test.mock_scope' AND locale = 'en'
    AND short_text = 'Choose the full test, or only some subjects, and a smaller size.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.start_test.mock_topics', 'admin', 'en',
  'Pick topics for the mock. Leave empty to draw from the whole question set.',
  $$## Topics for a mock

- **Empty.** The mock draws questions from the whole question set.
- **Topics picked.** The mock has one section for each topic. The questions are shared between the topics as evenly as possible.
- **Limit.** Pick up to 10 topics. The number of questions must be at least the number of topics, and at most 100.

A topic needs enough questions linked to it. If a topic has too few, the test cannot start for a student.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.start_test.mock_topics' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.start_test.mock_topics' AND locale = 'en'
    AND short_text = 'Pick topics for the mock. Leave empty to draw from the whole question set.'
);
