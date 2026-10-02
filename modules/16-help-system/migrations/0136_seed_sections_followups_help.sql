-- 0136_seed_sections_followups_help.sql
--
-- NEW  admin.attempts.section_scores     per-section score table on the admin attempt page
-- NEW  candidate.attempt.submit_sections final-submit dialog that counts every section
-- Mirrors content/en/admin.yml + candidate.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.section_scores', 'admin', 'en',
  'How this candidate scored in each section of the test.',
  $$## Section scores

For tests with sections, this table shows the points earned and the points
available in each section. It uses the same final grades as the total score.

- Shown only once the score is visible to you; never while the evaluation is
  still with AssessIQ.
- The results CSV has the same numbers as one **Section: name (%)** column
  per section.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'candidate.attempt.submit_sections', 'candidate', 'en',
  'Before you submit, check how many questions are unanswered in every section.',
  $$## Submitting a sectioned test

The confirmation lists every section with its unanswered questions.

- Sections marked **closed** are finished. You cannot change their answers.
- Only the current section can still be edited before you submit.
- Submitting ends the test.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
