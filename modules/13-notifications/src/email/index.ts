/**
 * modules/13-notifications/src/email/index.ts
 *
 * sendEmail — the canonical email send function for Phase 3.
 *
 * Flow:
 *   1. Render template (Handlebars, Zod-validated vars).
 *   2. Write email_log row with status='queued'.
 *   3. Enqueue 'email.send' BullMQ job.
 *      The job processor (registered in apps/api/src/worker.ts) opens the
 *      SMTP connection, sends, and updates the email_log row.
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
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config, streamLogger, uuidv7 } from '@assessiq/core';
import { withTenant, getPool } from '@assessiq/tenancy';
import { renderTemplate } from './render.js';
import { resolveTransport } from './transport.js';
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
    {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  );

  log.info({ emailLogId, to, template, tenantId }, 'email.queued');
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

export async function processEmailSendJob(
  data: EmailSendJobData,
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
    await withTenant(tenantId, (client) =>
      repo.updateEmailLogStatus(client, emailLogId, {
        status: 'sending',
        attempts: 1,
      }),
    );
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
      await withTenant(tenantId, (client) =>
        repo.updateEmailLogStatus(client, emailLogId, {
          status: 'sent',
          providerMessageId,
          sentAt: new Date(),
          attempts: 1,
        }),
      );
    }

    log.info({ emailLogId, to, template: templateId, providerMessageId }, 'email.sent');
    return { emailLogId, status: 'sent', providerMessageId };

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (tenantId !== null) {
      // Get current attempts from log
      let currentAttempts = 1;
      try {
        const pool = getPool();
        const client = await pool.connect();
        try {
          const row = await client.query<{ attempts: number }>(
            'SELECT attempts FROM email_log WHERE id = $1',
            [emailLogId],
          );
          if (row.rows[0] !== undefined) {
            currentAttempts = (row.rows[0].attempts ?? 0) + 1;
          }
        } finally {
          client.release();
        }
      } catch {
        // ignore secondary error
      }

      await withTenant(tenantId, (client) =>
        repo.updateEmailLogStatus(client, emailLogId, {
          status: 'failed',
          lastError: errorMessage,
          attempts: currentAttempts,
        }),
      );
    }

    // Re-throw so BullMQ retries.
    throw err;
  }
}
