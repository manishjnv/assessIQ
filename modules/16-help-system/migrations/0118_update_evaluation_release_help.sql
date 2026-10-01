-- 0118_update_evaluation_release_help.sql
--
-- Help content for the owner decision of 2026-10-01: the platform evaluator's last
-- accept / manual score / override now RELEASES the attempt to the company in the same
-- step (there is no separate "Release to company" click for a first evaluation), and
-- a company-sent-back attempt can be graded again with the attempt-level "Re-run AI".
-- 0116 described the old explicit release step; this rewrites those global v1 rows.
--   UPDATED  admin.evaluations.queue            "Ready to release" is now the sent-back /
--                                               re-evaluated case; the last accept releases
--   UPDATED  admin.evaluations.evaluate_next    the last accept releases the attempt
--   UPDATED  admin.evaluations.release_selected bulk release is now the recovery action
--   UPDATED  admin.evaluations.sent_back        re-evaluate with Re-run AI / Override, then
--                                               Release to company (never auto-released again)
--   UPDATED  admin.evaluations.accept_all       the completing accept releases, with a notice
--   UPDATED  admin.evaluations.manual_score     the last missing score releases too
--   UPDATED  admin.evaluations.release_to_company  recovery action + the success state
--   NEW      admin.evaluations.rerun_ai         "Re-run AI" on a sent-back attempt
-- Mirrors content/en/admin.yml. Follows the 0115 pattern (UPDATEs rewrite only the global
-- v1 rows; tenant overrides are untouched; safe to re-run). The new row uses
-- ON CONFLICT (tenant_id, key, locale, version) DO NOTHING.
-- 0011 / 0116 are NOT regenerated: editing an applied migration trips the
-- tools/migrate.ts checksum-drift guard at deploy.

UPDATE help_content
   SET long_md = $$## Evaluation queue

This is AssessIQ's work list. Each row is one attempt, from any company, that
has written answers and has not yet been released back to its company.

- **Oldest first.** Work from the top. **Evaluate next** opens the oldest row.
- **Blind evaluation.** You see the company, assessment and level, never the
  candidate's name or email.
- **Status.** *Awaiting evaluation* still needs grading. *Ready to release* is
  fully graded but not yet with the company, for example an attempt the company
  sent back that you have re-evaluated.
- **Sent back** means the company asked for another look; its note says why.

Accepting the last grade of an attempt releases it to its company by itself and
takes it off this list. The list refreshes by itself every 30 seconds.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.evaluations.queue' AND locale = 'en' AND version = 1;

UPDATE help_content
   SET long_md = $$## Evaluate next

Opens the oldest attempt currently in the list. If a company filter is set, it
opens that company's oldest attempt.

Work one attempt at a time: grade, accept or score each answer. The last accept
or score releases the attempt to its company by itself.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.evaluations.evaluate_next' AND locale = 'en' AND version = 1;

UPDATE help_content
   SET short_text = 'Releases every ticked, fully graded attempt to its company at once. The last accept already does this.',
       long_md = $$## Release selected to company

You rarely need this: accepting the last grade of an attempt already releases it
to its company. It is for attempts that are still listed as **Ready to
release**, for example ones the company sent back and you re-evaluated.

Only fully graded attempts (every question has a final grade) have a tick box.
Releasing hands the evaluation to the company, which then reviews the scores and
publishes them to candidates.

You may be asked for a fresh authenticator code. Afterwards you see how many
attempts were released and how many were skipped, and why.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.evaluations.release_selected' AND locale = 'en' AND version = 1;

UPDATE help_content
   SET long_md = $$## Sent back

After an evaluation is released, the company can send an attempt back with a
note, for example when a score looks wrong. The attempt returns to this queue
marked **Sent back** and keeps its existing grades.

Read the note, then use **Re-run AI** to grade the written answers again, or
**Override grade** to set a score yourself. Because the attempt is already
graded, accepting a new grade does not release it again: use **Release to
company** when you are done.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.evaluations.sent_back' AND locale = 'en' AND version = 1;

UPDATE help_content
   SET short_text = 'Accepts every AI proposal that did not fail. The accept that completes the attempt releases it to the company.',
       long_md = $$## Accept all

Commits every AI proposal on this attempt that has no failure. Proposals that
failed, or where the two AI models disagreed by two bands or more, are skipped
so you can **Re-run** them or enter a **manual score**.

When the accept gives every question a final grade, the evaluation is complete
and the attempt is **released to the company in that same step**. There is no
separate release click. Before that last accept the page tells you so, for
example "Accepting the last grade releases this result to Acme". If the company
publishes automatically, the student gets the result within a minute.

An attempt the company sent back is already graded, so accepting new grades on
it does not release it again. Use **Release to company** for that.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.evaluations.accept_all' AND locale = 'en' AND version = 1;

UPDATE help_content
   SET long_md = $$## Manual score

Use this when an answer has no grade, for example a KQL answer (the AI does not
grade those), or an AI proposal you do not want to accept.

- Enter a score from 0 up to the question's points.
- A reason is required. It is saved with the grade but kept out of the audit
  log.
- You may be asked for a fresh authenticator code.
- If it is the last missing grade, saving it completes the evaluation and
  releases the attempt to the company, just like the last accept.

A question can be scored manually only once. After that, use **Override grade**.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.evaluations.manual_score' AND locale = 'en' AND version = 1;

UPDATE help_content
   SET short_text = 'Hands a finished evaluation to the company. The last accept already does this; use it for sent-back attempts.',
       long_md = $$## Release to company

Accepting the last grade (or saving the last score or override) already releases
the attempt to the company, so most attempts never need this button. The page then
shows **Released to** the company, with a way back to the queue.

Use it for an attempt that is fully graded but still with AssessIQ. That is
mostly an attempt the company **sent back** and you re-evaluated: it was already
graded, so it is never released automatically. It is enabled when every question
has a final grade and none is flagged for review.

Releasing does not publish anything to the candidate. The company sees the
final scores and decides when to publish them, or has them published
automatically if it chose Automatic release. The company can send the attempt
back to this queue with a note.

You may be asked for a fresh authenticator code.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.evaluations.release_to_company' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.rerun_ai', 'admin', 'en',
  'Grades the written answers of a sent-back attempt again. Nothing changes until you accept the new grades.',
  $$## Re-run AI

Shown only on an attempt the company sent back (graded, not yet released). It runs
the AI over every written answer again, one attempt at a time. The run itself
commits nothing: each new result appears next to the grade it would replace.

- **Accept** a result to replace that question's grade, or **Accept all** to take
  every new result that did not fail. **Override** sets your own score instead.
- Accepting does not release the attempt. When the grades are right, use
  **Release to company**.
- It can take a few minutes. You can leave the page; the results are here when you
  come back.
- Only one grading run can be in progress at a time.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
