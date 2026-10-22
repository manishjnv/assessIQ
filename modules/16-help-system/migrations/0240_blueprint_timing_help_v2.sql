-- 0240_blueprint_timing_help_v2.sql
--
-- Z-42 (S42): the blueprint timer and marks are now applied by module 06. New version 2 of the two help keys from 0232
-- (they said "not yet applied"). Mirrors content/en/admin.yml.
-- New version per key = highest existing version + 1; skipped when the same text is already present. Idempotent.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.blueprint.whole_test_minutes', 'admin', 'en',
  'One timer for the whole test, 1 to 600 minutes. It replaces the time limit. Blank keeps the usual time.',
  $$## Whole-test minutes

Set the total time for the whole test, in whole minutes (1 to 600). The value is saved with the blueprint.

- **Set.** The candidate gets this one timer. It wins over the time limit of the test and the time of the difficulty.
- **Blank.** The usual time applies: the time limit of the test, else the time of the difficulty.
- **Frozen.** A test that is already running keeps its time. A change affects only new tests.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.blueprint.whole_test_minutes' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.blueprint.whole_test_minutes' AND locale = 'en'
    AND short_text = 'One timer for the whole test, 1 to 600 minutes. It replaces the time limit. Blank keeps the usual time.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.blueprint.marks_per_question', 'admin', 'en',
  'Whole marks for each question in this blueprint, 1 to 1000. Blank keeps each question''s points.',
  $$## Marks per question

Set the marks for each question drawn by this blueprint, as a whole number from 1 to 1000.

- **Set.** Every question drawn by this blueprint is worth this many marks. The question's own points are not used.
- **Blank.** Each question keeps its own points.
- **Frozen.** A test that is already running keeps its marks. A change affects only new tests.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.blueprint.marks_per_question' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.blueprint.marks_per_question' AND locale = 'en'
    AND short_text = 'Whole marks for each question in this blueprint, 1 to 1000. Blank keeps each question''s points.'
);
