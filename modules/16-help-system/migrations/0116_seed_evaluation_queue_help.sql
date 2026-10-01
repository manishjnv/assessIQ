-- 0116_seed_evaluation_queue_help.sql
--
-- Help content for the scoring / result-release change, Phase II (spec
-- 2026-10-01 §5b, frontend): the super-admin evaluation queue + evaluate page,
-- the tenant "awaiting evaluation / send back / publish" states, and the bulk
-- "Publish all ready" button.
--   NEW  admin.evaluations.queue            queue table
--   NEW  admin.evaluations.age_badge        age badge (amber 24 h, red 48 h)
--   NEW  admin.evaluations.tenant_filter    company filter
--   NEW  admin.evaluations.evaluate_next    "Evaluate next"
--   NEW  admin.evaluations.release_selected bulk "Release selected to company"
--   NEW  admin.evaluations.sent_back        "Sent back" marker + note
--   NEW  admin.evaluations.accept_all       "Accept all" on the evaluate page
--   NEW  admin.evaluations.manual_score     manual score form (KQL / ungraded)
--   NEW  admin.evaluations.release_to_company "Release to company"
--   NEW  admin.attempts.awaiting_evaluation tenant banner
--   NEW  admin.attempts.send_back           "Send back for re-evaluation"
--   NEW  admin.attempts.release_button      "Publish to candidate" (the id was in
--                                           the UI but had no help row)
--   NEW  admin.assessments.release_all      "Publish all ready"
-- Mirrors content/en/admin.yml. Follows the 0115 / 0110 pattern.
-- Idempotent: INSERTs use ON CONFLICT (tenant_id, key, locale, version) DO NOTHING.
-- 0011 is NOT regenerated: editing an applied migration trips the
-- tools/migrate.ts checksum-drift guard at deploy.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.queue', 'admin', 'en',
  'Every company''s attempts with written answers that are waiting for AssessIQ to evaluate, oldest first.',
  $$## Evaluation queue

This is AssessIQ's work list. Each row is one attempt, from any company, that
has written answers and has not yet been released back to its company.

- **Oldest first.** Work from the top. **Evaluate next** opens the oldest row.
- **Blind evaluation.** You see the company, assessment and level, never the
  candidate's name or email.
- **Status.** *Awaiting evaluation* still needs grading. *Ready to release* is
  fully graded and only needs releasing to the company.
- **Sent back** means the company asked for another look; its note says why.

The list refreshes by itself every 30 seconds.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.age_badge', 'admin', 'en',
  'How long the attempt has been waiting. Amber from 24 hours, red from 48 hours.',
  $$## Age

Time since the candidate submitted.

- **Grey** — under 24 hours.
- **Amber** — 24 hours or more.
- **Red** — 48 hours or more.

Candidates are told to expect their result within a set time, so clear the red
and amber rows first.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.tenant_filter', 'admin', 'en',
  'Show only one company''s attempts. The counts above the table follow the filter.',
  $$## Company filter

Narrow the queue to a single company. The two counts above the table recount
for that company. Choose **All companies** to see everything again.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.evaluate_next', 'admin', 'en',
  'Opens the oldest attempt in the list, honouring the company filter, so you can evaluate it.',
  $$## Evaluate next

Opens the oldest attempt currently in the list. If a company filter is set, it
opens that company's oldest attempt.

Work one attempt at a time: grade, accept or score each answer, then release
the attempt to its company.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.release_selected', 'admin', 'en',
  'Release every ticked, fully graded attempt to its company in one step.',
  $$## Release selected to company

Only attempts that are **Ready to release** (every question has a final grade)
have a tick box. Releasing hands the evaluation to the company, which then
reviews the scores and publishes them to candidates.

You may be asked for a fresh authenticator code. Afterwards you see how many
attempts were released and how many were skipped, and why.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.sent_back', 'admin', 'en',
  'The company sent this attempt back for re-evaluation. Its note says what to look at again.',
  $$## Sent back

After you release an evaluation, the company can send an attempt back with a
note, for example when a score looks wrong. The attempt returns to this queue
marked **Sent back** and keeps its existing grades.

Read the note, adjust the grades if needed, then release the attempt again.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.accept_all', 'admin', 'en',
  'Accepts every AI proposal that did not fail. Failed ones are skipped so you can re-run or score them by hand.',
  $$## Accept all

Commits every AI proposal on this attempt that has no failure. Proposals that
failed, or where the two AI models disagreed by two bands or more, are skipped
so you can **Re-run** them or enter a **manual score**.

Accepting records the grade but does not release the attempt. Once every
question has a final grade you can **Release to company**.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.manual_score', 'admin', 'en',
  'Score an answer by hand when it has no grade, such as KQL. A reason is required.',
  $$## Manual score

Use this when an answer has no grade, for example a KQL answer (the AI does not
grade those), or an AI proposal you do not want to accept.

- Enter a score from 0 up to the question's points.
- A reason is required. It is saved with the grade but kept out of the audit
  log.
- You may be asked for a fresh authenticator code.

A question can be scored manually only once. After that, use **Override grade**.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.release_to_company', 'admin', 'en',
  'Hands the finished evaluation to the company so it can review and publish it. Needs every question graded.',
  $$## Release to company

Enabled when every question on the attempt has a final grade and none is
flagged for review.

Releasing does not publish anything to the candidate. The company sees the
final scores and decides when to publish them, or has them published
automatically if it chose Automatic release. The company can send the attempt
back to this queue with a note.

You may be asked for a fresh authenticator code.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.awaiting_evaluation', 'admin', 'en',
  'AssessIQ is still evaluating the written answers. Scores appear here once the evaluation is released to you.',
  $$## Awaiting AssessIQ evaluation

Multiple-choice answers are scored automatically, but written answers are
evaluated by AssessIQ evaluators with AI assistance. Until they release the
evaluation to you, no scores are shown here and the result cannot be published.

When the evaluation is released the attempt becomes **Ready to publish**.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.send_back', 'admin', 'en',
  'Return this attempt to AssessIQ for another look, with a note saying why. It leaves your Ready to publish list.',
  $$## Send back for re-evaluation

Use this when a score looks wrong and you would rather AssessIQ re-check it than
change it yourself. You must write a note that says what to look at.

- The attempt goes back to AssessIQ's queue and shows as **Awaiting evaluation**.
- It cannot be published until AssessIQ releases it to you again.
- You can still **Override** a single score yourself instead, with a reason.

Results that are already published cannot be sent back.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.release_button', 'admin', 'en',
  'Publish this result to the candidate, who is emailed. Published results can''t be changed.',
  $$## Publish to candidate

Shows the candidate their final result and emails them. A summary of the scores
opens first so you can check them before confirming.

- Available when the attempt is **Ready to publish**.
- A certificate is issued if the candidate qualifies.
- Published results are final: scores can no longer be overridden.

With Automatic release turned on in Settings, results publish themselves as soon
as AssessIQ releases the evaluation to you.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessments.release_all', 'admin', 'en',
  'Publish every evaluated attempt of this assessment to its candidate at once. Attempts not ready are skipped.',
  $$## Publish all ready

Publishes, in one step, every attempt of this assessment that is **Ready to
publish**. Each candidate is emailed their result.

- Attempts that are still awaiting evaluation, were sent back, or whose
  candidate data was erased are skipped, and you see how many.
- Published results are final and cannot be changed.
- To publish one attempt at a time, open it from the Attempts page instead.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
