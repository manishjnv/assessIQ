-- 0270_ct2_create_test_help.sql
--
-- Help for CT-2, the Create a test page (/admin/create-test). Ten new keys, version 1. Mirrors content/en/admin.yml.
-- Idempotent: INSERT ... WHERE NOT EXISTS (compares key and text, as in 0264).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.create_test.page', 'admin', 'en',
  'One page to create any test and save it as a draft.',
  $$## Create a test

Pick the exam and question set, choose what the test covers, set the type and save a draft.

A draft sends nothing and costs nothing. Open the assessment afterwards to check it and invite your students.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.create_test.page' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.create_test.page' AND locale = 'en'
    AND short_text = 'One page to create any test and save it as a draft.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.create_test.exam', 'admin', 'en',
  'Pick an exam pattern, or use a question set directly.',
  $$## Exam

An exam pattern gives the sections, timing and marks of a real exam.

Choose **No exam pattern** to build a test from a question set only.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.create_test.exam' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.create_test.exam' AND locale = 'en'
    AND short_text = 'Pick an exam pattern, or use a question set directly.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.create_test.set', 'admin', 'en',
  'The question set the test draws from.',
  $$## Question set

Only sets your organisation may use are listed. The set is copied into your organisation when you save the draft.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.create_test.set' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.create_test.set' AND locale = 'en'
    AND short_text = 'The question set the test draws from.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.create_test.cover', 'admin', 'en',
  'Choose what the test covers.',
  $$## What to cover

- **Whole set.** Questions come from the whole set with an equal share of each topic.
- **Chosen topics.** Pick topics and give each a number of questions.
- **Exam pattern.** Use the sections of the chosen exam, all of them or some, at full size or smaller.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.create_test.cover' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.create_test.cover' AND locale = 'en'
    AND short_text = 'Choose what the test covers.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.create_test.topics', 'admin', 'en',
  'Pick topics and set the number of questions for each.',
  $$## Chosen topics

Pick up to 10 topics. Each row has its own count. You can use one topic, fewer questions or uneven counts.

**Split evenly** shares the total equally. A test has at most 100 questions. If a topic has too few questions, saving stops and names the topic.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.create_test.topics' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.create_test.topics' AND locale = 'en'
    AND short_text = 'Pick topics and set the number of questions for each.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.create_test.topic_picker', 'admin', 'en',
  'Tick the topics to include.',
  $$## Topic list

Tick a topic to add a row. Untick it, or press Remove, to take it out.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.create_test.topic_picker' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.create_test.topic_picker' AND locale = 'en'
    AND short_text = 'Tick the topics to include.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.create_test.type', 'admin', 'en',
  'Mock, Real or Real + camera.',
  $$## Test type

The type sets the rules and the credit cost. Mock is for practice. Real is a graded test. Real + camera adds the camera.

The type cannot change after you publish.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.create_test.type' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.create_test.type' AND locale = 'en'
    AND short_text = 'Mock, Real or Real + camera.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.create_test.time', 'admin', 'en',
  'The time limit for the whole test, in minutes.',
  $$## Time limit

Leave it empty to use the time of the difficulty. A suggested time is shown from the average time per question. An exam pattern sets its own time.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.create_test.time' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.create_test.time' AND locale = 'en'
    AND short_text = 'The time limit for the whole test, in minutes.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.create_test.name', 'admin', 'en',
  'The test name and the window when students can start.',
  $$## Name and window

Students can start between **Opens** and **Closes**. You can change these later while the test is a draft.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.create_test.name' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.create_test.name' AND locale = 'en'
    AND short_text = 'The test name and the window when students can start.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.create_test.save', 'admin', 'en',
  'Save the test as a draft. Nothing is sent.',
  $$## Save as draft

This creates the assessment as a draft. It does not publish the test, invite anyone or charge credits. Open the assessment to finish and invite your students.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.create_test.save' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.create_test.save' AND locale = 'en'
    AND short_text = 'Save the test as a draft. Nothing is sent.'
);
