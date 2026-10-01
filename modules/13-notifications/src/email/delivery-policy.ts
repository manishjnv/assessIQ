/**
 * modules/13-notifications/src/email/delivery-policy.ts
 *
 * Two delivery classes for `email.send` jobs, decided by template name:
 *
 *   auth — a person is waiting on this email right now (sign-in code / link,
 *          admin invitation) and the code or link expires in minutes. Jumps the
 *          queue; short retries (a late code is a useless code).
 *   bulk — everything else (candidate invitations, results, alerts, digests).
 *          Low priority; retried for ~45 h, so a provider daily-limit outage
 *          (Brevo free plan: 300/day, shared with other products) delays the
 *          email instead of losing it.
 *
 * BullMQ ordering — verified in the installed 5.76.5 (moveToActive-11.lua) and
 * on a real Redis: a worker pops the `wait` list FIRST and only touches the
 * `prioritized` set when `wait` is empty. So a job with NO priority (cron ticks,
 * webhook deliveries, auth emails) ALWAYS runs before ANY prioritized job,
 * whatever the number; among prioritized jobs a lower number runs first, FIFO
 * within one number. Therefore:
 *     auth  -> no `priority` (NOT priority 1: that would queue it behind cron)
 *     bulk  -> priority BULK_EMAIL_PRIORITY
 *     cron  -> unchanged (no priority)
 * Priority orders jobs; it does not preempt the one already running (the worker
 * has concurrency 1).
 *
 * Adding an email template? The Record below fails to compile until you classify it.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import type { JobsOptions } from 'bullmq';
import type { EmailTemplateName } from '../types.js';
import { webhookBackoffStrategy } from '../webhooks/retry-schedule.js';

export type EmailClass = 'auth' | 'bulk';

export const EMAIL_CLASS: Record<EmailTemplateName, EmailClass> = {
  // auth: sign-in codes / links and admin invitations
  admin_email_otp: 'auth',
  candidate_login_link: 'auth',
  invitation_admin: 'auth',
  // bulk: everything else (totp_enrolled is a receipt, not a code)
  invitation_candidate: 'bulk',
  totp_enrolled: 'bulk',
  attempt_submitted_candidate: 'bulk',
  attempt_graded_candidate: 'bulk',
  attempt_ready_for_review_admin: 'bulk',
  weekly_digest_admin: 'bulk',
  result_released: 'bulk',
  evaluation_queue_alert: 'bulk',
};

/** Class of a template id read back from job data; unknown ids are bulk. */
export function emailClassOf(templateId: string): EmailClass {
  return EMAIL_CLASS[templateId as EmailTemplateName] ?? 'bulk';
}

// ---------------------------------------------------------------------------
// Job options
// ---------------------------------------------------------------------------

export const AUTH_EMAIL_ATTEMPTS = 5;
export const AUTH_EMAIL_BACKOFF_MS = 5000; // exponential: 5 s, 10 s, 20 s, 40 s

/** Any positive integer works (1..2_097_152); non-prioritized jobs always go first. */
export const BULK_EMAIL_PRIORITY = 100;

/** `backoff.type` of bulk jobs; apps/api/src/worker.ts routes it to notificationsBackoffStrategy. */
export const BULK_EMAIL_BACKOFF_TYPE = 'email-bulk';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Wait before retry 1..10 (~45.4 h in total). attempts = 11. */
export const BULK_EMAIL_RETRY_DELAYS_MS: ReadonlyArray<number> = [
  1 * MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  1 * HOUR,
  2 * HOUR,
  4 * HOUR,
  6 * HOUR,
  8 * HOUR,
  12 * HOUR,
  12 * HOUR,
];

/**
 * Delay before the next attempt. BullMQ passes the 1-based number of attempts
 * already made (1 after the first failure — verified on 5.76.5), so the first
 * retry uses index 0. (webhookBackoffStrategy indexes with the raw value; that
 * off-by-one is pre-existing and left alone.)
 */
export function bulkEmailBackoffStrategy(attemptsMade: number): number {
  const i = Math.min(Math.max(attemptsMade, 1), BULK_EMAIL_RETRY_DELAYS_MS.length) - 1;
  return BULK_EMAIL_RETRY_DELAYS_MS[i] as number;
}

/**
 * The ONE custom backoff strategy of the shared `assessiq-cron` worker (BullMQ
 * allows a single `settings.backoffStrategy`). `type` is the job's
 * `backoff.type`: bulk emails use BULK_EMAIL_BACKOFF_TYPE, webhook deliveries
 * keep `'custom'` (literal published schedule).
 */
export function notificationsBackoffStrategy(attemptsMade: number, type?: string): number {
  return type === BULK_EMAIL_BACKOFF_TYPE
    ? bulkEmailBackoffStrategy(attemptsMade)
    : webhookBackoffStrategy(attemptsMade);
}

/** Enqueue options for an `email.send` job of this template. */
export function emailJobOptions(template: EmailTemplateName): JobsOptions {
  const keep = { removeOnComplete: 50, removeOnFail: 50 };
  if (EMAIL_CLASS[template] === 'auth') {
    return {
      ...keep,
      attempts: AUTH_EMAIL_ATTEMPTS,
      backoff: { type: 'exponential', delay: AUTH_EMAIL_BACKOFF_MS },
    };
  }
  return {
    ...keep,
    priority: BULK_EMAIL_PRIORITY,
    attempts: BULK_EMAIL_RETRY_DELAYS_MS.length + 1,
    backoff: { type: BULK_EMAIL_BACKOFF_TYPE },
  };
}

// ---------------------------------------------------------------------------
// SMTP failure classification
// ---------------------------------------------------------------------------

export interface SmtpFailure {
  /** Numeric SMTP reply code (550), when the server replied. */
  responseCode: number | null;
  /** Enhanced status code from the reply ("5.1.1"), when the server sent one. */
  enhancedCode: string | null;
  /** nodemailer error code (EENVELOPE, ECONNECTION, ETIMEDOUT, EAUTH, ...). */
  code: string | null;
  /** SMTP command that failed ("RCPT TO", "MAIL FROM", "DATA", ...). */
  command: string | null;
}

/** Pull the loggable parts out of a nodemailer error. Never returns the reply text (it echoes the recipient). */
export function describeSmtpFailure(err: unknown): SmtpFailure {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const response = typeof e['response'] === 'string' ? e['response'] : '';
  const enhanced = /^\d{3}[ -](\d\.\d{1,3}\.\d{1,3})\b/m.exec(response)?.[1] ?? null;
  return {
    responseCode: typeof e['responseCode'] === 'number' ? e['responseCode'] : null,
    enhancedCode: enhanced,
    code: typeof e['code'] === 'string' ? e['code'] : null,
    command: typeof e['command'] === 'string' ? e['command'] : null,
  };
}

/**
 * Permanent recipient error: SMTP enhanced status 5.1.x ("bad destination
 * mailbox address": no such user, bad address, bad domain). Retrying cannot
 * help, so the job is failed at once. Deliberately narrow: other 5xx replies
 * (quota / daily limit, policy, sender or auth problems) are NOT recipient
 * errors and keep retrying. 5.1.x on MAIL FROM is about the SENDER (our
 * config), so it keeps retrying too.
 */
export function isPermanentRecipientError(err: unknown): boolean {
  const f = describeSmtpFailure(err);
  return f.enhancedCode !== null && f.enhancedCode.startsWith('5.1.') && f.command !== 'MAIL FROM';
}
