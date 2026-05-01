/**
 * Phase 0 email stub — per addendum § 8.
 *
 * Satisfies inviteUser()'s email dependency without an SMTP server.
 * Phase 3 SMTP wiring lands modules/13-notifications/src/smtp.ts with the
 * same EmailAdapter interface; this stub is removed then.
 *
 * Dev token retrieval: read the JSONL log with:
 *   tail -f ~/.assessiq/dev-emails.log | jq '.body'
 */

import { createLogger, config } from '@assessiq/core';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const emailLogger = createLogger().child({ module: 'email-stub' });

/** Shape of one JSONL record (addendum § 8 — exact field set). */
interface DevEmail {
  ts: string;
  to: string;
  subject: string;
  body: string;
  template_id: string;
}

function resolveLogPath(): string {
  // ASSESSIQ_DEV_EMAILS_LOG is not in the core ConfigSchema; read directly.
  // This env var is dev-only and has no production-safety implications.
  const envPath = process.env['ASSESSIQ_DEV_EMAILS_LOG'];
  if (envPath !== undefined && envPath.length > 0) return envPath;
  if (config.NODE_ENV === 'production') {
    return '/var/log/assessiq/dev-emails.log';
  }
  return join(homedir(), '.assessiq', 'dev-emails.log');
}

async function appendDevEmailLog(record: DevEmail): Promise<void> {
  const logPath = resolveLogPath();
  const dir = logPath.substring(0, logPath.lastIndexOf('/'));
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(logPath, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    emailLogger.warn({ err, logPath }, 'email-stub: could not write to dev-emails log');
  }
}

// ---------------------------------------------------------------------------
// Public API consumed by 03-users/invitations.ts
// ---------------------------------------------------------------------------

export interface SendInvitationEmailInput {
  to: string;
  role: string;
  invitationLink: string;
  tenantName?: string;
}

/**
 * Send (stub) an invitation email containing the plaintext invitation link.
 * The link encodes the plaintext token in the query string.
 * Per addendum § 8, the token appears inside `body`, not in a structured field.
 */
export async function sendInvitationEmail(input: SendInvitationEmailInput): Promise<void> {
  const subject = `You've been invited to AssessIQ as ${input.role}`;
  const body = [
    `Hello,`,
    ``,
    `You've been invited to join AssessIQ${input.tenantName !== undefined ? ` (${input.tenantName})` : ''} as ${input.role}.`,
    ``,
    `Accept your invitation by clicking the link below:`,
    input.invitationLink,
    ``,
    `This link expires in 7 days. If you did not expect this email, you can safely ignore it.`,
  ].join('\n');

  const record: DevEmail = {
    ts: new Date().toISOString(),
    to: input.to,
    subject,
    body,
    template_id: 'invitation.user',
  };

  emailLogger.info({ to: input.to, role: input.role }, 'email-stub: invitation email sent');
  await appendDevEmailLog(record);
}
