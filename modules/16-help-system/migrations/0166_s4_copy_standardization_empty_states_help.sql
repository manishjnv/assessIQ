-- 0166_s4_copy_standardization_empty_states_help.sql
--
-- RW-20 (2026-10-09, hardening S4): help text follows the glossary in
-- docs/10-branding-guideline.md section 2.5 (organisation, release). New version of each
-- changed global key; older versions stay for history and reads take the newest version.
-- Mirrors content/en/*.yml; 0011 is regenerated from the same YAML for fresh databases.
--
-- Idempotent: each INSERT is skipped when a global row with the same key, locale,
-- short_text and long_md already exists.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.platform.domain', 'admin', 'en',
  'Optional email domain for the organisation (e.g. company.com). Used for display — not enforced as a sign-in restriction.',
  $$## Organisation domain (optional)

Recording the organisation's email domain (e.g. `company.com`) is informational
only. It is stored with the organisation record and shown in the organisation list
for operator reference.

It does **not** currently restrict sign-in to that domain or auto-assign
users. Domain-based sign-in and auto-provisioning are planned for a
future release.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.platform.domain' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.platform.domain' AND locale = 'en'
    AND short_text = 'Optional email domain for the organisation (e.g. company.com). Used for display — not enforced as a sign-in restriction.'
    AND long_md IS NOT DISTINCT FROM $$## Organisation domain (optional)

Recording the organisation's email domain (e.g. `company.com`) is informational
only. It is stored with the organisation record and shown in the organisation list
for operator reference.

It does **not** currently restrict sign-in to that domain or auto-assign
users. Domain-based sign-in and auto-provisioning are planned for a
future release.
$$
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.reports.landing.page', 'admin', 'en',
  'Start page for reports. Open a cohort report for an assessment, or a report for one candidate.',
  $$## Reports

This page lists the reports that you can open.

- **Cohort reports.** Each row is an assessment that is not a draft. Select **View report** to see the number of attempts, the average and percentile scores, and the archetype mix.
- **Individual reports.** Each row is a candidate with a released result. Select **View report** to see the score history of that person.
- An empty list means that no assessment has data yet. Publish an assessment and collect attempts first.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.reports.landing.page' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.reports.landing.page' AND locale = 'en'
    AND short_text = 'Start page for reports. Open a cohort report for an assessment, or a report for one candidate.'
    AND long_md IS NOT DISTINCT FROM $$## Reports

This page lists the reports that you can open.

- **Cohort reports.** Each row is an assessment that is not a draft. Select **View report** to see the number of attempts, the average and percentile scores, and the archetype mix.
- **Individual reports.** Each row is a candidate with a released result. Select **View report** to see the score history of that person.
- An empty list means that no assessment has data yet. Publish an assessment and collect attempts first.
$$
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'candidate.attempt.submit.confirm', 'candidate', 'en',
  'Once submitted, you cannot reopen the attempt. Verify your flagged questions first.',
  $$## Submitting your attempt

Once you submit, your attempt is **final**. AssessIQ does not allow editing answers after
submit, and there is no second attempt unless your administrator
explicitly grants one.

Before clicking the final **Submit** button, the **Review** screen shows:

- Flagged questions you wanted to revisit.
- Unanswered questions (a blank textarea or empty MCQ counts).
- Questions whose autosave is stale (rare — usually only seconds old).

Walk through any starred or unanswered items. When you are ready, click
**Submit**. AssessIQ asks you to confirm the submit in a final dialog and the
candidate timer freezes immediately.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'candidate.attempt.submit.confirm' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'candidate.attempt.submit.confirm' AND locale = 'en'
    AND short_text = 'Once submitted, you cannot reopen the attempt. Verify your flagged questions first.'
    AND long_md IS NOT DISTINCT FROM $$## Submitting your attempt

Once you submit, your attempt is **final**. AssessIQ does not allow editing answers after
submit, and there is no second attempt unless your administrator
explicitly grants one.

Before clicking the final **Submit** button, the **Review** screen shows:

- Flagged questions you wanted to revisit.
- Unanswered questions (a blank textarea or empty MCQ counts).
- Questions whose autosave is stale (rare — usually only seconds old).

Walk through any starred or unanswered items. When you are ready, click
**Submit**. AssessIQ asks you to confirm the submit in a final dialog and the
candidate timer freezes immediately.
$$
);
