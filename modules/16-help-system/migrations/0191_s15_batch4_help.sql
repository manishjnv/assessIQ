-- 0191_s15_batch4_help.sql
--
-- S15 (2026-10-17): help rows for the batch 4 UI.
--   RW-84  candidate progress page: candidate.progress, .history, .trend, .subjects
--   RW-60  per-question statistics: admin.question.editor.stats, .discrimination, .gradient, .miscalibrated
--   RW-83  one-screen Start a test: admin.start_test, .set, .candidates, .emails, .window, .send, .result
--   RW-80  per-question feedback: admin.tenant_settings.result_feedback_level (+ .none, .right_wrong,
--          .with_expected_answer, .with_ai_justification), candidate.results.feedback,
--          .expected, .explanation, .study
--   RCA 2026-10-17 rename: admin.question_editor.negative_marks -> admin.question.editor.negative_marks
--          (same text, version 1; the UPDATE below moves the existing row, no new row)
-- Mirrors content/en/*.yml (rows copied from the regenerated seeds/help_content.sql).
-- Idempotent: the UPDATE skips when the new key already exists; INSERT ... ON CONFLICT DO NOTHING.
-- Production help rows come from forward migrations, not from the seed (docs/06-deployment.md, Seeds).

UPDATE help_content SET key = 'admin.question.editor.negative_marks' WHERE tenant_id IS NULL AND key = 'admin.question_editor.negative_marks' AND NOT EXISTS (SELECT 1 FROM help_content h2 WHERE h2.tenant_id IS NULL AND h2.key = 'admin.question.editor.negative_marks' AND h2.locale = help_content.locale AND h2.version = help_content.version);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.progress',
  'candidate',
  'en',
  'Your released results over time: score trend, test history and strengths by subject.',
  $$## Progress

This page shows how you do across tests. It uses only results that your
organisation has **released** to you.

- Your score trend shows each test from the oldest to the newest.
- Your test list shows the date, score and result of each test.
- Your strengths show how well you answer questions in each subject.

A result that is not released does not appear here.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.progress.history',
  'candidate',
  'en',
  'Each released test with its date, score, result and a certificate link.',
  $$## Your tests

Each row is one released test. It shows the date, your score, and whether
you passed. If you earned a certificate, select **View** to open it.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.progress.trend',
  'candidate',
  'en',
  'Your average and best score, and a line of your scores over time.',
  $$## Score trend

The line shows your score for each released test, from the oldest to the
newest. You need at least two released tests to see the line.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.progress.subjects',
  'candidate',
  'en',
  'How many questions you answered right in each subject.',
  $$## Strengths by subject

Each row shows one subject and the number of questions you answered right.

- **Strong**: 75% or more right.
- **Developing**: 50% to 74% right.
- **Focus**: less than 50% right. Practise this subject first.

Questions that have no subject are grouped under **Other**.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.results.feedback',
  'candidate',
  'en',
  'Open this to see each question, your answer and whether it was right.',
  $$## Review your answers

Your organisation chooses what this section shows. It lists each question with your answer and the outcome. A "What to study" line shows the topic to practise.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.results.feedback.expected',
  'candidate',
  'en',
  'The correct answer. It shows only for questions that are marked by rule.',
  $$## Expected answer

This is the correct answer. It shows for questions with one fixed answer, such as multiple choice. Written answers have no fixed answer.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.results.feedback.explanation',
  'candidate',
  'en',
  'A short note about how your written answer was marked.',
  $$## Why this mark

This note says how strong your written answer was and gives a short reason. It is a summary, not the full marking.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.results.feedback.study',
  'candidate',
  'en',
  'The topic to practise for this question.',
  $$## What to study

This line names the unit and subject of the question. If the question has no unit, it shows the topic.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question.editor.stats',
  'admin',
  'en',
  'Item statistics for this question: success rate, discrimination and level fit.',
  $$## Item statistics (Phase C)

This card shows how candidates did on this one question. The data comes from released results only. It refreshes each night.

- **Attempts:** graded, released answers to this question.
- **Exposure:** how many times the question was shown in a submitted attempt.
- **Phase C needs 30 or more attempts.** Below that, treat the numbers as a hint.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question.editor.stats.discrimination',
  'admin',
  'en',
  'Discrimination shows if strong candidates answer this question better than weak ones.',
  $$## Discrimination

The value is the correlation between a correct answer here and the score on all other questions. A value of 0.2 or more is good. A lower value gets the **Noise** label. The question may be unclear, or its key may be wrong. The value is empty when every candidate scored the same.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question.editor.stats.gradient',
  'admin',
  'en',
  'Mean success per level. L1 should be higher than L2, and L2 higher than L3.',
  $$## Level gradient

Each row is the mean success of all questions in that level of this pack. Multiple choice uses the share of correct answers. Written answers use the mean band divided by 4. The gap between neighbouring levels should be at least 15 points. The row of this question is marked.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question.editor.stats.miscalibrated',
  'admin',
  'en',
  'Miscalibrated means the real difficulty does not match the level label.',
  $$## Miscalibrated

The flag appears only with 30 or more attempts. It shows when a top-level question is passed by 90% or more of candidates, or a lowest-level question by 25% or fewer. It also shows when the level order is inverted by more than 15 points. Review the question, or move it to another level.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.start_test',
  'admin',
  'en',
  'Start a test in one screen: pick a set, pick candidates, and send.',
  $$## Start a test

This screen does four steps for you. It creates the assessment, publishes it, and sends the invitations. For more control, use the **Assessments** page.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.start_test.set',
  'admin',
  'en',
  'Pick a question set your organisation is licensed for.',
  $$## Question set

Choose one set. Then choose the difficulty and the number of questions. The time limit comes from the difficulty. A set that is not yet imported is copied into your organisation when you send.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.start_test.candidates',
  'admin',
  'en',
  'Choose candidates from your list. Only active candidates show.',
  $$## Candidates

Search, then tick the candidates to invite. You can also paste email addresses in the box below the list.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.start_test.emails',
  'admin',
  'en',
  'Paste one email address per line. Add a name after a comma if you wish.',
  $$## Paste email addresses

Use one address per line, or separate addresses with commas. An address that is not yet in your organisation becomes a new candidate. You can send to 200 addresses at one time.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.start_test.window',
  'admin',
  'en',
  'Candidates can start the test between these two times.',
  $$## Window

The test opens now and closes in 7 days. Change the times if you need to. Candidates cannot start the test after it closes.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.start_test.send',
  'admin',
  'en',
  'Create the assessment, publish it, and send the invitations.',
  $$## Send invitations

Each step shows on the screen. If a step fails, the screen shows which step and links to the assessment so you can finish there.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.start_test.result',
  'admin',
  'en',
  'The assessment is live. See how many candidates got an invitation.',
  $$## Result

Skipped candidates show with the reason, for example already invited. Open the assessment to see the status of each candidate.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.tenant_settings.result_feedback_level',
  'admin',
  'en',
  'Choose what a candidate sees for each question after you release a result.',
  $$## Per-question feedback

This setting decides what a candidate sees for each question. It applies only to results that you have released.

- **No question details (default).** The candidate sees only the score.
- **Right or wrong.** The candidate sees if each answer was right, wrong or partly right. A "What to study" line shows the topic.
- **With the expected answer.** Adds the correct answer. It shows only for questions that the system marks by rule, such as multiple choice.
- **With a short reason.** Adds a plain-words note for written answers that were graded with AI.
- You may be asked for a fresh authenticator code when you change this setting.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.tenant_settings.result_feedback_level.none',
  'admin',
  'en',
  'The candidate sees only the score. No question details.',
  $$## No question details

The candidate sees the total score and the result. The candidate does not see any question.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.tenant_settings.result_feedback_level.right_wrong',
  'admin',
  'en',
  'The candidate sees if each answer was right, wrong or partly right, and what to study.',
  $$## Right or wrong

For each question the candidate sees the answer they gave and the outcome. A "What to study" line shows the topic of the question.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.tenant_settings.result_feedback_level.with_expected_answer',
  'admin',
  'en',
  'Adds the correct answer for questions that the system marks by rule.',
  $$## With the expected answer

This level adds the correct answer. It shows for multiple choice, multiple select, number, ordering and structured case questions. Written answers show no expected answer.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.tenant_settings.result_feedback_level.with_ai_justification',
  'admin',
  'en',
  'Adds a short plain-words note for written answers that were graded with AI.',
  $$## With a short reason

This level adds a short note for written answers. The note is a clean version of the grader reason. It keeps the first two sentences and removes internal markers. The candidate never sees the raw AI text.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
