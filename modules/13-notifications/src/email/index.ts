/**
 * modules/13-notifications/src/email/index.ts
 *
 * sendEmail — the canonical email send function for Phase 3.
 *
 * Flow:
 *   1. Render template (Handlebars, Zod-validated vars).
 *   2. Write email_log row with status='queued'.
 *   3. Enqueue 'email.send' BullMQ job. Priority + retry policy depend on the
 *      template's class (delivery-policy.ts): auth emails jump the queue with
 *      short retries; bulk emails are low priority and retried for ~45 h.
 *      The job processor (registered in apps/api/src/worker.ts) opens the
 *      SMTP connection, sends, and updates the email_log row.
 *
 * email_log.status: queued -> sending -> sent. A failure BullMQ will retry goes
 * back to 'queued' (+ last_error, attempts); 'failed' means final — attempts
 * exhausted or a permanent recipient error (SMTP 5.1.x), as 0055 documents.
 *
 * Stub-fallback (P3.D9):
 *   If SMTP_URL is empty/unset AND no per-tenant smtp_url → fall back to
 *   dev-emails.log JSONL write + emit WARN log.
 *   This prevents the deploy from breaking before Resend creds are provisioned.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Queue, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { config, streamLogger, uuidv7 } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import { renderTemplate } from './render.js';
import { isCandidateBrandedTemplate, loadTenantLogoUrl } from './tenant-logo.js';
import { resolveTransport } from './transport.js';
import {
  describeSmtpFailure,
  emailClassOf,
  emailJobOptions,
  isPermanentRecipientError,
} from './delivery-policy.js';
import { bulkCounterKey, istDate, readBulkDailyCap, reserveBulkSlot } from './bulk-cap.js';
import * as repo from '../repository.js';
import type { SendEmailInput, EmailTemplateName } from '../types.js';

const log = streamLogger('webhook'); // email sends go to webhook.log per § 8 stream table

// ---------------------------------------------------------------------------
// BullMQ queue (lazy-init)
// ---------------------------------------------------------------------------

let _emailQueue: Queue | null = null;

function getEmailQueue(): Queue {
  if (_emailQueue === null) {
    const redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    _emailQueue = new Queue('assessiq-cron', { connection: redis });
  }
  return _emailQueue;
}

// Separate short-timeout connection for the bulk-cap counter, so a Redis outage
// fails open fast instead of hanging sendEmail (the Queue connection retries forever).
let _counterRedis: Redis | null = null;

function getCounterRedis(): Redis {
  if (_counterRedis === null) {
    _counterRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
    _counterRedis.on?.('error', () => undefined); // ponytail: errors surface per command (fail-open below)
  }
  return _counterRedis;
}

const CAP_REDIS_TIMEOUT_MS = 2000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('redis timeout')), CAP_REDIS_TIMEOUT_MS).unref?.()),
  ]);
}

/** Tenant view of the bulk queue for GET /api/admin/email-queue. */
export interface EmailQueueStatus {
  queuedCount: number;
  nextSendAt: string | null;
  dailyCap: number;
  sentToday: number;
}

/**
 * Bulk emails of this tenant that the daily cap pushed to a later day. BullMQ
 * retry backoffs also sit in the delayed set, but only cap-deferred jobs carry
 * `opts.delay` (set at enqueue), so that is the filter.
 */
export async function getEmailQueueStatus(tenantId: string): Promise<EmailQueueStatus> {
  const dailyCap = readBulkDailyCap();
  const delayed = await getEmailQueue().getDelayed(0, 9999);
  let queuedCount = 0;
  let next: number | null = null;
  for (const job of delayed) {
    const data = job.data as Partial<EmailSendJobData> | undefined;
    if (job.name !== 'email.send' || data?.tenantId !== tenantId) continue;
    const delay = job.opts?.delay ?? 0;
    if (delay <= 0) continue;
    // A retried job keeps its old opts.delay; its send time is in the past, so skip it.
    if (job.timestamp + delay <= Date.now()) continue;
    queuedCount++;
    const at = job.timestamp + delay;
    if (next === null || at < next) next = at;
  }
  let sentToday = 0;
  try {
    const raw = await withTimeout(getCounterRedis().get(bulkCounterKey(istDate(Date.now()))));
    sentToday = Math.min(Number(raw ?? 0) || 0, dailyCap);
  } catch (err) {
    log.warn({ err }, 'email.bulk_cap: could not read today counter');
  }
  return { queuedCount, nextSendAt: next === null ? null : new Date(next).toISOString(), dailyCap, sentToday };
}

// ---------------------------------------------------------------------------
// Dev-emails.log fallback path
// ---------------------------------------------------------------------------

interface DevEmail {
  ts: string;
  to: string;
  subject: string;
  body: string;
  template_id: string;
}

function resolveDevLogPath(): string {
  const envPath = process.env['ASSESSIQ_DEV_EMAILS_LOG'];
  if (envPath !== undefined && envPath.length > 0) return envPath;
  if (config.NODE_ENV === 'production') {
    return '/var/log/assessiq/dev-emails.log';
  }
  return join(homedir(), '.assessiq', 'dev-emails.log');
}

async function appendDevEmailLog(record: DevEmail): Promise<void> {
  const logPath = resolveDevLogPath();
  const dir = dirname(logPath);
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(logPath, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    log.warn({ err, logPath }, 'email: could not write to dev-emails log');
  }
}

// ---------------------------------------------------------------------------
// Public sendEmail function
// ---------------------------------------------------------------------------

export async function sendEmail<T extends EmailTemplateName>(
  input: SendEmailInput<T>,
): Promise<void> {
  const { to, template, vars, tenantId } = input;

  // 1. Render template first (fail fast on bad vars before hitting DB).
  //    Candidate-facing templates carry the tenant logo (Logo phase L3b): the
  //    caller may pass logoUrl (batch senders load it once); otherwise it
  //    is loaded here from the tenant row. No logo = rendered as before.
  const logoUrl =
    input.logoUrl !== undefined
      ? input.logoUrl
      : tenantId !== undefined && tenantId.length > 0 && isCandidateBrandedTemplate(template)
        ? await loadTenantLogoUrl(tenantId)
        : null;
  const rendered = renderTemplate(template, vars as Parameters<typeof renderTemplate<T>>[1], {
    logoUrl,
    ...(input.orgName !== undefined ? { orgName: input.orgName } : {}),
  });

  // 2. Check if SMTP is configured (stub-fallback path).
  const transport = resolveTransport(); // Phase 3: platform-level only
  if (transport === null) {
    // SMTP not configured — write to dev-emails.log + WARN.
    log.warn(
      { to, template, tenantId },
      'email: SMTP_URL not configured — falling back to dev-emails.log',
    );
    await appendDevEmailLog({
      ts: new Date().toISOString(),
      to,
      subject: rendered.subject,
      // Dev convenience only: a redacted-body mail (a one-time code) is never written to a production file.
      body: input.redactLogBody === true && config.NODE_ENV === 'production' ? '[redacted]' : rendered.text,
      template_id: template,
    });
    return;
  }

  // 3. Write email_log row with status='queued'.
  //    If tenantId is not provided, we skip the DB write (dev/test path).
  const emailLogId = uuidv7();

  if (tenantId !== undefined && tenantId.length > 0) {
    await withTenant(tenantId, (client) =>
      repo.insertEmailLog(client, {
        id: emailLogId,
        tenantId,
        toAddress: to,
        subject: rendered.subject,
        templateId: template,
        bodyText: input.redactLogBody === true ? null : rendered.text,
        bodyHtml: input.redactLogBody === true ? null : rendered.html,
        status: 'queued',
        provider: 'smtp',
      }),
    );
  }

  // 4. Enqueue 'email.send' BullMQ job.
  const queue = getEmailQueue();
  const jobOpts = emailJobOptions(template);
  if (emailClassOf(template) === 'bulk') {
    // Q11: spread bulk mail over days. Fail-open: Redis trouble sends now.
    try {
      const delay = await withTimeout(reserveBulkSlot(getCounterRedis(), readBulkDailyCap()));
      if (delay > 0) jobOpts.delay = delay;
    } catch (err) {
      log.warn({ err, template }, 'email.bulk_cap: Redis unavailable, sending without the daily cap');
    }
  }
  await queue.add(
    'email.send',
    {
      emailLogId,
      tenantId: tenantId ?? null,
      to,
      subject: rendered.subject,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      templateId: template,
    },
    jobOpts,
  );

  log.info({ emailLogId, to, template, tenantId, emailClass: emailClassOf(template) }, 'email.queued');
}

// ---------------------------------------------------------------------------
// email.send job processor (called by worker.ts via runJobWithLogging)
// ---------------------------------------------------------------------------

export interface EmailSendJobData {
  emailLogId: string;
  tenantId: string | null;
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  templateId: string;
}

/** Where this run sits in the BullMQ retry sequence (the worker passes it). */
export interface EmailSendAttempt {
  /** 1-based number of this attempt (job.attemptsMade + 1). */
  attempt: number;
  /** job.opts.attempts. */
  maxAttempts: number;
}

export async function processEmailSendJob(
  data: EmailSendJobData,
  ctx?: EmailSendAttempt,
): Promise<{ emailLogId: string; status: string; providerMessageId?: string }> {
  const { emailLogId, tenantId, to, subject, bodyHtml, bodyText, templateId } = data;

  const transport = resolveTransport();
  if (transport === null) {
    // This shouldn't happen (sendEmail checked before enqueuing), but guard.
    log.warn({ emailLogId, to }, 'email.send job: no transport, falling back to dev-log');
    await appendDevEmailLog({
      ts: new Date().toISOString(),
      to,
      subject,
      body: bodyText,
      template_id: templateId,
    });
    return { emailLogId, status: 'sent_dev' };
  }

  // Mark 'sending' before opening SMTP connection.
  if (tenantId !== null) {
    const rowsAffected = await withTenant(tenantId, (client) =>
      repo.updateEmailLogStatus(client, emailLogId, {
        status: 'sending',
        attempts: ctx?.attempt ?? 1,
      }),
    );
    if (rowsAffected === 0) {
      log.error({ emailLogId }, 'email_log.update.no_rows_affected');
    } else {
      log.debug({ emailLogId, rowsAffected }, 'email_log.update.ok');
    }
  }

  try {
    const result = await transport.sendMail({
      from: config.EMAIL_FROM,
      to,
      subject,
      text: bodyText,
      html: bodyHtml,
    });

    const providerMessageId = String(result.messageId ?? '');

    if (tenantId !== null) {
      const rowsAffected = await withTenant(tenantId, (client) =>
        repo.updateEmailLogStatus(client, emailLogId, {
          status: 'sent',
          providerMessageId,
          sentAt: new Date(),
          attempts: ctx?.attempt ?? 1,
        }),
      );
      if (rowsAffected === 0) {
        log.error({ emailLogId }, 'email_log.update.no_rows_affected');
      } else {
        log.debug({ emailLogId, rowsAffected }, 'email_log.update.ok');
      }
    }

    log.info({ emailLogId, to, template: templateId, providerMessageId }, 'email.sent');
    return { emailLogId, status: 'sent', providerMessageId };

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const smtp = describeSmtpFailure(err);
    const permanent = isPermanentRecipientError(err);
    // "Final" = no BullMQ retry follows. Callers that pass no attempt info
    // (legacy / tests) keep the old behaviour: every failure is final.
    const isFinal = permanent || ctx === undefined || ctx.attempt >= ctx.maxAttempts;

    // One warning per failed attempt. SMTP codes only — the reply text echoes
    // the recipient address, so it is not logged here.
    log.warn(
      {
        emailLogId,
        template: templateId,
        emailClass: emailClassOf(templateId),
        attempt: ctx?.attempt,
        maxAttempts: ctx?.maxAttempts,
        smtpCode: smtp.responseCode,
        enhancedCode: smtp.enhancedCode,
        errCode: smtp.code,
        permanent,
        willRetry: !isFinal,
      },
      'email.send.attempt_failed',
    );

    if (tenantId !== null) {
      // BullMQ's attempt number when the worker passes it; otherwise the
      // legacy read-modify-write on the log row.
      let attempts = ctx?.attempt ?? 1;
      if (ctx === undefined) {
        try {
          const row = await withTenant(tenantId, (client) =>
            client.query<{ attempts: number }>(
              'SELECT attempts FROM email_log WHERE id = $1',
              [emailLogId],
            ),
          );
          if (row.rows[0] !== undefined) {
            attempts = (row.rows[0].attempts ?? 0) + 1;
          }
        } catch {
          // ignore secondary error
        }
      }

      const failRowsAffected = await withTenant(tenantId, (client) =>
        repo.updateEmailLogStatus(client, emailLogId, {
          // 'failed' = final. A failure BullMQ will retry goes back to 'queued'
          // so a 45 h bulk retry window does not read as a failed email.
          status: isFinal ? 'failed' : 'queued',
          lastError: errorMessage,
          attempts,
        }),
      );
      if (failRowsAffected === 0) {
        log.error({ emailLogId }, 'email_log.update.no_rows_affected');
      } else {
        log.debug({ emailLogId, rowsAffected: failRowsAffected }, 'email_log.update.ok');
      }
    }

    if (permanent) {
      // BullMQ fails an UnrecoverableError at once — no retry.
      throw new UnrecoverableError(
        `Permanent recipient error (SMTP ${smtp.responseCode ?? '5xx'} ${smtp.enhancedCode ?? ''}), not retried: ${errorMessage}`,
      );
    }

    // Re-throw so BullMQ retries.
    throw err;
  }
}
