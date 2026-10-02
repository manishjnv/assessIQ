-- 0148_seed_page_help.sql
--
-- NEW  admin.tenant_settings.page, admin.generate_wizard.page, admin.attempts.detail.page, admin.evaluations.detail.page, admin.grading.jobs.page, admin.question.editor.page, admin.reports.individual.page, admin.reports.landing.page
-- Page-level help (drawer key <page>.page) for eight admin pages that had none.
-- Mirrors content/en/admin.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.tenant_settings.page', 'admin', 'en',
  'Company name, how results reach candidates, and how long candidate personal data is kept.',
  $$## Settings

This page holds the settings for your company. Only company admins can open it.

- **Company name.** Change the name that your team and candidates see.
- **Result release.** Choose when candidates receive results. With Manual, you publish each result yourself. With Automatic, a result goes out when it is ready.
- **Data retention.** Set the number of days that the company keeps personal data of candidates.
- **Erased candidates.** See the candidates whose personal data was removed. Their names and emails cannot be read.
- You may be asked for a fresh authenticator code when you change the release mode.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.generate_wizard.page', 'admin', 'en',
  'Platform tool that makes draft questions for a level, a domain and its categories, ready for review.',
  $$## Generate questions

This tool is for AssessIQ platform admins. Companies do not write question packs.

- **Set up.** Pick a level, a domain and the categories. For each category, choose the question types and the number of questions for each type.
- **Generate.** The tool works on one category at a time. You can leave the page. The work continues and you can return later.
- **Review.** Read each draft as a formatted question. You can edit a draft, approve it, or approve many at once.
- **Types.** Multiple-choice, log analysis, scenario, KQL and subjective questions are made here. Numeric, multi-select and ordering questions are written by hand.
- Nothing reaches a candidate until you approve it.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.detail.page', 'admin', 'en',
  'One candidate attempt: review the final scores and publish them to the candidate.',
  $$## Attempt

This page shows one attempt from one candidate.

- **Status.** *Awaiting evaluation* means AssessIQ is still scoring the written answers. No score is shown yet.
- **Ready to publish.** You can read every question, the answer and the score band. Bands are 0, 25, 50, 75 or 100.
- **Override.** Record a different grade and give a reason. The first grade stays on record.
- **Send back.** Return the attempt to AssessIQ with a note about what to check again.
- **Publish to candidate.** The candidate sees the result. You cannot change a published result.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.detail.page', 'admin', 'en',
  'Evaluate one attempt for a company. You do not see the candidate''s name.',
  $$## Evaluate an attempt

This page is for AssessIQ platform admins. It shows one attempt from the evaluation queue.

- **Blind view.** You see the company, the assessment and the level. You do not see the name or email of the candidate.
- **Grade.** Grade all questions, read the proposed score and evidence for each answer, and accept it. You can run the grading again, override a grade, or enter a score by hand.
- **Release.** When you accept the last grade, the attempt goes to the company. The company reviews it and publishes it.
- **Sent back.** If the company sent the attempt back, read the note. Then grade again and use **Release to company**.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.grading.jobs.page', 'admin', 'en',
  'How results are scored and what you do with them. Nothing to run on this page.',
  $$## Grading

This page explains how grading works. You do not start any grading from here.

- **Multiple-choice answers.** They are scored when the candidate submits.
- **Written answers.** AssessIQ evaluates them. Until that is done, the attempt shows *Awaiting evaluation* and no one sees a score.
- **Ready to publish.** Open the attempt on the Attempts page. You can publish it, override a grade, or send it back.
- **Score bands.** Each written answer gets 0, 25, 50, 75 or 100.
- If an attempt waits too long, contact your AssessIQ operator.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question.editor.page', 'admin', 'en',
  'Create a question, or view and edit its rubric. Only platform admins can change questions.',
  $$## Question

AssessIQ platform admins write all questions. Company admins can view them but cannot change them.

- **New question.** Choose the type, the topic and the points. Then write the content. You can add a hint for the candidate that tells how to answer.
- **Question page.** The question text is read-only. You can edit the hint and the rubric.
- **Rubric.** For written answers, the rubric lists what a good answer must show. The anchor weight and the reasoning weight must add up to 100.
- **Status.** Approve a draft to make it active. Archive a question to stop candidates from getting it.
- A rubric saves only when you select **Save rubric**.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.reports.individual.page', 'admin', 'en',
  'The scores of one candidate over time, one card for each attempt.',
  $$## Individual report

This page shows the history of one candidate across your assessments.

- **Latest band.** The band from the most recent attempt.
- **Score trend.** A small chart that shows how the score changed. It appears when the candidate has two or more attempts.
- **Attempts.** Each card shows the assessment, the level, the date and the band with its percent.
- **Archetype chart.** When the data is available, a chart shows the strengths of the candidate.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.reports.landing.page', 'admin', 'en',
  'Start page for reports. Open a cohort report for an assessment, or a report for one candidate.',
  $$## Reports

This page lists the reports that you can open.

- **Cohort reports.** Each row is an assessment that is not a draft. Select **View report** to see the number of attempts, the average and percentile scores, and the archetype mix.
- **Individual reports.** Each row is a candidate with a published result. Select **View report** to see the score history of that person.
- An empty list means that no assessment has data yet. Publish an assessment and collect attempts first.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
