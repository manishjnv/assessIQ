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

import { streamLogger, config } from '@assessiq/core';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const emailLogger = streamLogger('app').child({ module: 'email-stub' });

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
  // Use path.dirname() — the previous lastIndexOf('/') hand-roll silently broke
  // on Windows paths (pure backslash separators returned -1 → empty dir → mkdir
  // failed → write was swallowed by the catch). path.dirname handles both
  // separators correctly.
  const dir = dirname(logPath);
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

// ---------------------------------------------------------------------------
// Assessment-invitation email — Phase 1 G1.B Session 3
// ---------------------------------------------------------------------------
//
// Used by modules/05-assessment-lifecycle/email.ts to notify candidates of a
// new assessment they've been invited to. Same dev-emails.log stub path as
// sendInvitationEmail — Phase 1.5+ swap-in points the candidate-side flow
// at the per-tenant SMTP driver behind tenants.smtp_config.
//
// IMPORTANT — the plaintext token lives inside `body` (in the
// invitationLink). Do not surface it in any other field, do not log it
// outside of the JSONL record write, do not echo it through INFO logs.

export interface SendAssessmentInvitationEmailInput {
  to: string;
  candidateName: string;
  assessmentName: string;
  invitationLink: string;
  expiresAt: Date;
  tenantName: string;
}

export async function sendAssessmentInvitationEmail(
  input: SendAssessmentInvitationEmailInput,
): Promise<void> {
  const subject = `You've been invited to take "${input.assessmentName}" on AssessIQ`;
  const body = [
    `Hi ${input.candidateName},`,
    ``,
    `You've been invited to take the assessment "${input.assessmentName}" on AssessIQ (${input.tenantName}).`,
    ``,
    `Start the assessment by clicking the link below:`,
    input.invitationLink,
    ``,
    `This invitation expires on ${input.expiresAt.toISOString()}.`,
    ``,
    `If you did not expect this email, you can safely ignore it.`,
  ].join('\n');

  const record: DevEmail = {
    ts: new Date().toISOString(),
    to: input.to,
    subject,
    body,
    template_id: 'invitation.assessment',
  };

  // Note: assessmentName is fine to log (admin-authored), but never echo
  // input.invitationLink at INFO level — it contains the plaintext token.
  emailLogger.info(
    { to: input.to, assessment: input.assessmentName, template_id: record.template_id },
    'email-stub: assessment invitation sent',
  );
  await appendDevEmailLog(record);
}
