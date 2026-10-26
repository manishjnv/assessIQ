/**
 * modules/13-notifications/src/email/pattern-review-due.ts
 *
 * sendPatternReviewDueEmail — CT-0 monthly reminder to the platform admins that exam patterns
 * (exam_blueprints) are past their next_check_due date. Called by the worker job
 * `blueprint.upkeep_reminder`. Counts + a link only. BEST-EFFORT per recipient.
 * The check itself is manual. NEVER import claude / @anthropic-ai from this file (Rule #1).
 */
import { config, streamLogger } from '@assessiq/core';
import { sendEmail } from './index.js';

const log = streamLogger('webhook');

export async function sendPatternReviewDueEmail(input: { to: string[]; count: number }): Promise<{ sent: number }> {
  const listLink = new URL('/admin/exam-blueprints', config.ASSESSIQ_BASE_URL).toString();
  let sent = 0;
  for (const to of input.to) {
    try {
      await sendEmail({ to, template: 'pattern_review_due', vars: { count: input.count, listLink }, tenantId: config.PLATFORM_TENANT_ID });
      sent += 1;
    } catch (err) {
      log.warn({ err }, 'pattern_review_due.email_failed');
    }
  }
  return { sent };
}
