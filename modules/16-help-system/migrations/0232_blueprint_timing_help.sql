-- 0232_blueprint_timing_help.sql
--
-- Z-51 (option b): help for the two blueprint fields in the assessment create form,
-- whole-test minutes and marks per section. Mirrors content/en/admin.yml.
-- New keys only, version 1. Idempotent: INSERT ... WHERE NOT EXISTS, as in 0231.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.blueprint.whole_test_minutes', 'admin', 'en',
  'Total test time in minutes, 1 to 600. Blank sets no whole-test time.',
  $$## Whole-test minutes

Set the total time for the whole test, in whole minutes (1 to 600). The value is saved with the blueprint.

- **Blank.** No whole-test time is set.
- **Not yet applied.** The test timer does not use this value for a blueprint test yet.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.blueprint.whole_test_minutes' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.blueprint.whole_test_minutes' AND locale = 'en'
    AND short_text = 'Total test time in minutes, 1 to 600. Blank sets no whole-test time.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.blueprint.marks_per_question', 'admin', 'en',
  'Marks for each question in this blueprint, 0 to 1000. Blank keeps each question''s points.',
  $$## Marks per section

Set the marks for each question drawn by this blueprint, from 0 to 1000. The value is saved with the blueprint.

- **Blank.** Each question keeps its own points.
- **Not yet applied.** Scoring does not use this value for a blueprint test yet.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.blueprint.marks_per_question' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.blueprint.marks_per_question' AND locale = 'en'
    AND short_text = 'Marks for each question in this blueprint, 0 to 1000. Blank keeps each question''s points.'
);
