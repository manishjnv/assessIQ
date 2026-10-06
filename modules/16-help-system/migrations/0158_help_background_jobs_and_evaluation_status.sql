-- 0158_help_background_jobs_and_evaluation_status.sql
--
-- FU-D9/FU-D10 (2026-10-06): the three worker help rows move to the Platform
-- page "Background jobs" section: admin.worker -> admin.platform.jobs,
-- admin.worker.failed -> admin.platform.jobs.failed, admin.worker.retry ->
-- admin.platform.jobs.retry (all tenants and versions; same pattern as 0155).
-- Their global v1 text is rewritten (no "/admin/worker" page, no "Grade all").
-- FU-C1: admin.grading.jobs.page text rewritten for the Evaluation status page;
-- three NEW keys admin.grading.jobs.{counts,oldest,by_assessment}.
-- Mirrors content/en/admin.yml; 0011 is regenerated in the same commit.
-- Idempotent: the rename deletes an old row only when the new key already has
-- the same (tenant_id, locale, version) row (fresh DB after regenerated 0011).

-- 1. Rename (delete old rows that already exist under the new key, then UPDATE key).
DELETE FROM help_content o
 USING (VALUES
  ('admin.worker', 'admin.platform.jobs'),
  ('admin.worker.failed', 'admin.platform.jobs.failed'),
  ('admin.worker.retry', 'admin.platform.jobs.retry')
  ) AS c(old_key, new_key)
 WHERE o.key = c.old_key
   AND EXISTS (SELECT 1 FROM help_content n
                WHERE n.key = c.new_key AND n.locale = o.locale AND n.version = o.version
                  AND n.tenant_id IS NOT DISTINCT FROM o.tenant_id);

UPDATE help_content o
   SET key = c.new_key
  FROM (VALUES
  ('admin.worker', 'admin.platform.jobs'),
  ('admin.worker.failed', 'admin.platform.jobs.failed'),
  ('admin.worker.retry', 'admin.platform.jobs.retry')
  ) AS c(old_key, new_key)
 WHERE o.key = c.old_key;

-- 2. Rewrite the global v1 text of the moved rows and of the evaluation status page.

UPDATE help_content
   SET short_text = 'Health of the shared background queue: email, webhooks and cron jobs. AI evaluation never runs here.',
       long_md = $$## Background jobs

This section shows the state of the one background queue that every company
shares. The queue handles:

- **Email delivery** — invitations, reminders, result emails
- **Webhook delivery** — payloads to company-configured endpoints
- **Cron jobs** — assessment window transitions and attempt timer sweeps

**This queue never runs AI evaluation.** Evaluation starts only when a
platform admin selects it on the Evaluations page.

| Card | What it shows |
|---|---|
| Waiting / Delayed | Jobs that have not started. Zero is healthy. |
| Active | Jobs running right now. |
| Completed | Jobs completed since the queue was created. |
| Failed | Jobs that used all their retries. They are listed below. |

The counts are cached for 5 seconds on the server. Select **Refresh** to read again.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.platform.jobs' AND locale = 'en' AND version = 1;

UPDATE help_content
   SET short_text = 'Failed jobs used all their retries. Select a job id to see its payload and the end of the error stack.',
       long_md = $$## Failed jobs

A job appears here when it has used all its retries (at most 5, with
exponential backoff) without success.

| Column | Content |
|---|---|
| Job | First 8 characters of the job id. Select it to expand. |
| Type | The job name, for example `email.send` or `assessment-boundary-cron` |
| Last error | First line of the final failure reason |
| Tries | How many times the job ran |
| Failed at | Time of the final failure |

The expanded row shows the job payload (sensitive fields are redacted on the
server) and the last 1 KB of the error stack.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.platform.jobs.failed' AND locale = 'en' AND version = 1;

UPDATE help_content
   SET short_text = 'Re-queues the failed job with the same payload. Use it after the cause is fixed, for example an email outage.',
       long_md = $$## Retry a failed job

**Retry** puts the job back in the queue with the same payload and one more
attempt counted. It runs on the next worker tick.

Retry only after the cause is fixed:

| Job type | Retry when |
|---|---|
| `email.send` | The email service is back and the address is valid |
| `webhook.deliver` | The receiving endpoint answers again |
| cron jobs | The database or Redis issue is resolved; both jobs are safe to run again |

A job that is not in the failed state cannot be retried (the server answers 409).
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.platform.jobs.retry' AND locale = 'en' AND version = 1;

UPDATE help_content
   SET short_text = 'Where the written answers of your candidates are in the evaluation queue. Nothing is started here.',
       long_md = $$## Evaluation status

This page shows how many attempts wait for evaluation, how long the oldest
one has waited, and the counts for each assessment. You do not start any
evaluation from here.

- **Multiple-choice answers.** Scored when the candidate submits. They never wait.
- **Written answers.** AssessIQ evaluates them in submission order. Until that is done, the attempt shows *Awaiting evaluation* and no one sees a score.
- **Ready to publish.** Open the attempt on the Attempts page. You can publish it, override a grade, or send it back.
- **Score bands.** Each written answer gets 0, 25, 50, 75 or 100.
- If an attempt waits longer than the turnaround you were given, contact your AssessIQ operator.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.grading.jobs.page' AND locale = 'en' AND version = 1;

-- 3. New keys for the Evaluation status page.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.grading.jobs.counts', 'admin', 'en',
  'The same three numbers as the dashboard cards: in queue, awaiting evaluation, ready to publish.',
  $$## Counts

- **In queue** — submitted attempts that AssessIQ has not evaluated yet.
- **Awaiting evaluation** — in queue, plus evaluated attempts that AssessIQ has not released to you yet.
- **Ready to publish** — evaluated and released. Open them on the Attempts page to publish.

The numbers update every 30 seconds while the page is open.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.grading.jobs.oldest', 'admin', 'en',
  'How long the oldest attempt in the queue has waited since the candidate submitted it.',
  $$## Waiting time

The line shows the submit time of the oldest attempt still in the queue and
how long ago that was. Attempts are evaluated in submission order.

No fixed turnaround is promised on this page. If an attempt waits longer than
the turnaround you were given, contact your AssessIQ operator.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.grading.jobs.by_assessment', 'admin', 'en',
  'One row per assessment with the three counts. Select the name to open the assessment.',
  $$## By assessment

Each row is one assessment that has at least one submitted attempt, with its
in-queue, awaiting-evaluation and ready-to-publish counts. The rows add up
to the totals above. Select the assessment name to open its page.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
