/**
 * modules/13-notifications/src/email/evaluation-queue-alert.ts
 *
 * sendEvaluationQueueAlertEmail — the platform owner's "evaluations are waiting"
 * alert (Phase II SP11, 2026-10-01). Called by the worker job
 * `evaluation.queue_alert` (apps/api jobs/evaluation-queue-alert.ts, at most once per
 * 24 h) when queue items have waited more than 24 hours.
 *
 * Contract:
 *   - One email per address (the platform admins from SUPER_ADMIN_EMAILS); the
 *     content is counts + a link to the platform queue — never a tenant, assessment
 *     or candidate name.
 *   - Logged under the PLATFORM tenant (config.PLATFORM_TENANT_ID) so email_log
 *     records the send like every other email.
 *   - BEST-EFFORT per recipient: a failing address is logged and skipped, never
 *     thrown. Returns how many sends were queued, so the caller can retry the whole
 *     alert later when nothing went out.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { config, streamLogger } from '@assessiq/core';
import { sendEmail } from './index.js';

const log = streamLogger('webhook'); // email sends go to webhook.log per § 8 stream table

export async function sendEvaluationQueueAlertEmail(input: {
  to: string[];
  /** Queue items older than 24 hours. */
  count: number;
  /** Age of the oldest item, hours (any precision; rounded to 1 dp here). */
  oldestAgeHours: number;
}): Promise<{ sent: number }> {
  const queueLink = new URL('/admin/platform/evaluations', config.ASSESSIQ_BASE_URL).toString();
  const oldestAgeHours = Math.round(input.oldestAgeHours * 10) / 10;

  let sent = 0;
  for (const to of input.to) {
    try {
      await sendEmail({
        to,
        template: 'evaluation_queue_alert',
        vars: { count: input.count, oldestAgeHours, queueLink },
        tenantId: config.PLATFORM_TENANT_ID,
      });
      sent += 1;
    } catch (err) {
      log.warn({ err }, 'evaluation_queue_alert.email_failed');
    }
  }
  return { sent };
}
