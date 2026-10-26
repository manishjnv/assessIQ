-- 0269_ct1_exp28_help.sql
--
-- Help for CT-1 (pattern upkeep, new edition, archive on /admin/exam-blueprints) and EXP-28 (reports column in the
-- review queue, Report a problem for candidates). Five new keys, version 1. Mirrors content/en/admin.yml and candidate.yml.
-- Idempotent: INSERT ... WHERE NOT EXISTS (compares key and text, as in 0264).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.blueprints.upkeep', 'admin', 'en',
  'Dates for the monthly check of this exam pattern.',
  $$## Pattern upkeep

Exam patterns change. Check each one against the official notice every month.

- **Last checked.** The date a person last confirmed the pattern.
- **Next check due.** The date the next check is due. A reminder email goes to the platform admins when it passes.
- **Owner.** The person who does the check.
- **Cap.** The most questions a test from this pattern may have. The default is 100.

The reminder email only reminds. A person does the check.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.blueprints.upkeep' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.blueprints.upkeep' AND locale = 'en'
    AND short_text = 'Dates for the monthly check of this exam pattern.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.blueprints.new_edition', 'admin', 'en',
  'Save a changed pattern as a new edition. The old edition stays.',
  $$## New edition

A verified edition is never changed. Tests already made from it must keep their rules.

1. Type a new edition label, for example 2027.
2. Change the numbers that changed in the official notice.
3. Tick the box only when you checked the notice. Then the edition is marked verified.
4. Save. The old edition stays in the list.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.blueprints.new_edition' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.blueprints.new_edition' AND locale = 'en'
    AND short_text = 'Save a changed pattern as a new edition. The old edition stays.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.blueprints.archive', 'admin', 'en',
  'Hide this pattern from new tests. Old tests keep working.',
  $$## Archive

Archive hides the pattern from the list and from new mocks. Nothing is deleted.

Tests and results made from the pattern are not changed.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.blueprints.archive' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.blueprints.archive' AND locale = 'en'
    AND short_text = 'Hide this pattern from new tests. Old tests keep working.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.review_queue.reports', 'admin', 'en',
  'How many candidates reported a problem with this question.',
  $$## Reports from candidates

A candidate can press **Report a problem** during a test. This column counts those reports for your organisation.

A report does not change the question, the marks or the review state. Read the reports, then use **Open review** to mark the question disputed or needing a fix.

Use the **Reported** tab to see only questions with reports.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.review_queue.reports' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.review_queue.reports' AND locale = 'en'
    AND short_text = 'How many candidates reported a problem with this question.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'candidate.attempt.report', 'candidate', 'en',
  'Tell us if this question looks wrong or unclear. Your test does not change.',
  $$## Report a problem

Press **Report a problem** if the question or its answer options look wrong, or if you cannot understand them.

- Pick what is wrong and add a short note if you want.
- Keep answering. Reporting does not stop your test and does not change your marks.
- Your organiser and the AssessIQ team will check the question.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'candidate.attempt.report' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'candidate.attempt.report' AND locale = 'en'
    AND short_text = 'Tell us if this question looks wrong or unclear. Your test does not change.'
);
