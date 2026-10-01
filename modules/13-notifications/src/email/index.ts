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
import { withTenant, getPool } from '@assessiq/tenancy';
import { renderTemplate } from './render.js';
import { resolveTransport } from './transport.js';
import {
  describeSmtpFailure,
  emailClassOf,
  emailJobOptions,
  isPermanentRecipientError,
} from './delivery-policy.js';
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
  const rendered = renderTemplate(template, vars as Parameters<typeof renderTemplate<T>>[1]);

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
      body: rendered.text,
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
        bodyText: rendered.text,
        bodyHtml: rendered.html,
        status: 'queued',
        provider: 'smtp',
      }),
    );
  }

  // 4. Enqueue 'email.send' BullMQ job.
  const queue = getEmailQueue();
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
    emailJobOptions(template),
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
          const pool = getPool();
          const client = await pool.connect();
          try {
            const row = await client.query<{ attempts: number }>(
              'SELECT attempts FROM email_log WHERE id = $1',
              [emailLogId],
            );
            if (row.rows[0] !== undefined) {
              attempts = (row.rows[0].attempts ?? 0) + 1;
            }
          } finally {
            client.release();
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
