/**
 * Evaluation-queue alert — worker job `evaluation.queue_alert` (Phase II SP11, 2026-10-01).
 *
 * The platform super admin is the only person who can evaluate written answers
 * (modules/07-ai-grading platform queue). When items sit in that queue for more than
 * 24 hours the owner is emailed — at most once per 24 hours:
 *
 *   1. count queue items older than 24 h (one READ-ONLY cross-tenant query under the
 *      assessiq_system role, same pattern as jobs/auto-release.ts) and the oldest age;
 *   2. if > 0, claim the Redis key `aiq:alert:evaluation_queue` with SET NX EX 24 h —
 *      the atomic "already alerted in the last 24 h" gate;
 *   3. email every address in SUPER_ADMIN_EMAILS (template evaluation_queue_alert:
 *      count, oldest age, link to /admin/platform/evaluations). If nothing at all was
 *      sent, the key is deleted so the next hourly tick retries.
 *
 * No AI call anywhere on this path: it only counts rows and sends mail. Imports
 * @assessiq/tenancy + @assessiq/notifications only — the worker must never import
 * @assessiq/ai-grading (lint:ambient-ai), which is also why the queue predicate below
 * is duplicated from modules/07-ai-grading repository listSuperEvaluationQueue.
 * KEEP THE TWO IN SYNC: attempts with at least one non-MCQ question that are either
 * unevaluated (submitted / auto_submitted / pending_admin_grading) or graded-but-not-
 * released (evaluation_released_at IS NULL), candidate not erased, tenant active.
 */

import { config, streamLogger } from '@assessiq/core';
import { getPool } from '@assessiq/tenancy';
import { sendEvaluationQueueAlertEmail } from '@assessiq/notifications';

const log = streamLogger('worker');

export const EVAL_QUEUE_ALERT_JOB_NAME = 'evaluation.queue_alert';
export const EVAL_QUEUE_ALERT_INTERVAL_MS = 60 * 60_000;
export const EVAL_QUEUE_ALERT_REDIS_KEY = 'aiq:alert:evaluation_queue';
const ALERT_TTL_SECONDS = 24 * 60 * 60;

// type (not interface): the worker's JobResult is Record<string, unknown>
export type EvaluationQueueAlertResult = {
  /** Queue items older than 24 h. */
  overdue: number;
  oldestAgeHours: number;
  /** An alert email went out on this tick. */
  alerted: boolean;
  sent: number;
};

/** The two Redis commands the gate needs (ioredis satisfies this; tests pass a fake). */
export interface AlertRedis {
  set(key: string, value: string, mode: 'EX', seconds: number, nx: 'NX'): Promise<'OK' | null>;
  del(key: string): Promise<number>;
}

export interface EvaluationQueueAlertDeps {
  countOverdue?: () => Promise<{ count: number; oldestAgeHours: number }>;
  recipients?: string[];
  send?: typeof sendEvaluationQueueAlertEmail;
}

/** SUPER_ADMIN_EMAILS is a comma-separated list; normalised (trim + lower-case) and de-duplicated. */
export function superAdminRecipients(): string[] {
  return [
    ...new Set(
      config.SUPER_ADMIN_EMAILS.split(',')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0),
    ),
  ];
}

/** Queue items older than 24 h + the oldest age. One READ-ONLY system-role query (exported for the test). */
export async function countOverdueEvaluations(): Promise<{ count: number; oldestAgeHours: number }> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL ROLE assessiq_system');
    const res = await client.query<{ n: number; oldest_hours: number }>(
      `SELECT COUNT(*)::int AS n,
              COALESCE(MAX(EXTRACT(EPOCH FROM (now() - COALESCE(a.submitted_at, a.started_at))) / 3600.0), 0)::float8
                AS oldest_hours
         FROM attempts a
         JOIN tenants t ON t.id = a.tenant_id AND t.status = 'active'
         JOIN users u   ON u.id = a.user_id  AND u.erased_at IS NULL
        WHERE (a.status IN ('submitted', 'auto_submitted', 'pending_admin_grading')
               OR (a.status = 'graded' AND a.evaluation_released_at IS NULL))
          AND COALESCE(a.submitted_at, a.started_at) <= now() - interval '24 hours'
          AND EXISTS (SELECT 1
                        FROM attempt_questions aq
                        JOIN questions q ON q.id = aq.question_id
                       WHERE aq.attempt_id = a.id AND q.type NOT IN ('mcq', 'numeric', 'multi_select', 'ordering'))`,
    );
    await client.query('COMMIT');
    const row = res.rows[0];
    return { count: row?.n ?? 0, oldestAgeHours: row?.oldest_hours ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // connection likely dead — surface the original error
    });
    throw err;
  } finally {
    client.release();
  }
}

/** One hourly tick. Dependencies are injectable for the unit test. */
export async function processEvaluationQueueAlertTick(
  redis: AlertRedis,
  deps: EvaluationQueueAlertDeps = {},
): Promise<EvaluationQueueAlertResult> {
  const countOverdue = deps.countOverdue ?? countOverdueEvaluations;
  const send = deps.send ?? sendEvaluationQueueAlertEmail;
  const recipients = deps.recipients ?? superAdminRecipients();

  const { count, oldestAgeHours } = await countOverdue();
  const result: EvaluationQueueAlertResult = { overdue: count, oldestAgeHours, alerted: false, sent: 0 };
  if (count === 0) return result;

  if (recipients.length === 0) {
    log.warn({ job: EVAL_QUEUE_ALERT_JOB_NAME, overdue: count }, 'evaluation-queue-alert: SUPER_ADMIN_EMAILS is empty');
    return result;
  }

  // Atomic gate: only the tick that creates the key sends. TTL = the 24 h cool-down.
  const claimed = await redis.set(
    EVAL_QUEUE_ALERT_REDIS_KEY,
    new Date().toISOString(),
    'EX',
    ALERT_TTL_SECONDS,
    'NX',
  );
  if (claimed !== 'OK') return result;

  const { sent } = await send({ to: recipients, count, oldestAgeHours });
  result.sent = sent;
  result.alerted = sent > 0;
  if (sent === 0) {
    // Nothing went out — free the gate so the next hourly tick tries again.
    await redis.del(EVAL_QUEUE_ALERT_REDIS_KEY);
    log.error({ job: EVAL_QUEUE_ALERT_JOB_NAME, overdue: count }, 'evaluation-queue-alert: no email could be sent');
  } else {
    log.info({ job: EVAL_QUEUE_ALERT_JOB_NAME, overdue: count, oldestAgeHours, sent }, 'evaluation-queue-alert: sent');
  }
  return result;
}
