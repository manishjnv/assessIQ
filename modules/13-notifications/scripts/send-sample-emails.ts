/**
 * modules/13-notifications/scripts/send-sample-emails.ts
 *
 * One-off review utility — renders each of the 9 production email templates
 * with realistic fixture data and sends to a single recipient (default:
 * manishjnvk@gmail.com) via the platform SMTP transport.
 *
 * Bypasses BullMQ + email_log — direct nodemailer.sendMail. Intended for
 * design review only; do NOT call from production code paths.
 *
 * Run:
 *   pnpm --filter @assessiq/notifications exec tsx scripts/send-sample-emails.ts
 *
 *   # Custom recipient:
 *   RECIPIENT=foo@bar.com pnpm --filter @assessiq/notifications exec tsx \
 *     scripts/send-sample-emails.ts
 *
 *   # Single template only:
 *   ONLY=admin_email_otp pnpm --filter @assessiq/notifications exec tsx \
 *     scripts/send-sample-emails.ts
 *
 * Env required: SMTP_URL, EMAIL_FROM. Loaded via @assessiq/core config.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { renderTemplate } from '../src/email/render.js';
import type { EmailTemplateName, TemplateVarsMap } from '../src/types.js';

// ---------------------------------------------------------------------------
// Minimal .env.local loader (bypasses @assessiq/core to avoid pulling in
// DB/Redis/secret requirements that this script does not need).
// ---------------------------------------------------------------------------

function loadDotEnvLocal(): void {
  // Walk upwards from this file to find the repo root .env.local.
  const candidates = [
    resolve(process.cwd(), '.env.local'),
    resolve(process.cwd(), '../../.env.local'),
    resolve(process.cwd(), '../../../.env.local'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error('[FATAL] .env.local not found in cwd or two levels up');
    process.exit(10);
  }
  const raw = readFileSync(found, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  console.log(`[CONFIG] Loaded ${found}`);
}

loadDotEnvLocal();

const RECIPIENT = process.env['RECIPIENT'] ?? 'manishjnvk@gmail.com';
const ONLY = process.env['ONLY'];
const SMTP_URL = process.env['SMTP_URL'] ?? '';
const EMAIL_FROM = process.env['EMAIL_FROM'] ?? 'AssessIQ <noreply@automateedge.cloud>';

// ---------------------------------------------------------------------------
// Realistic fixture vars per template
// ---------------------------------------------------------------------------

const NOW = new Date();
const IN_3_DAYS = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
const WEEK_END = new Date(NOW.getTime() - NOW.getDay() * 24 * 60 * 60 * 1000);

const FIXTURES: { [K in EmailTemplateName]: TemplateVarsMap[K] } = {
  invitation_admin: {
    recipientEmail: RECIPIENT,
    role: 'Reviewer',
    invitationLink: 'https://app.assessiq.in/admin/accept-invite?token=sample-invite-token-admin',
    tenantName: 'Wipro SOC Practice',
    expiresInDays: 7,
  },
  invitation_candidate: {
    candidateName: 'Priya Sharma',
    assessmentName: 'SOC Analyst — L1 Triage',
    invitationLink: 'https://app.assessiq.in/take?token=sample-candidate-token',
    expiresAt: IN_3_DAYS.toISOString().split('T')[0]!,
    tenantName: 'Wipro SOC Practice',
  },
  candidate_login_link: {
    display_name: 'Priya Sharma',
    link_url: 'https://app.assessiq.in/c/login?token=sample-magic-link-token',
    expires_minutes: 15,
  },
  totp_enrolled: {
    recipientName: 'Manish Kumar',
    enrolledAt: NOW.toISOString(),
    tenantName: 'AssessIQ Platform',
  },
  attempt_submitted_candidate: {
    candidateName: 'Priya Sharma',
    assessmentName: 'SOC Analyst — L1 Triage',
    submittedAt: NOW.toISOString(),
    tenantName: 'Wipro SOC Practice',
  },
  attempt_graded_candidate: {
    candidateName: 'Priya Sharma',
    assessmentName: 'SOC Analyst — L1 Triage',
    tenantName: 'Wipro SOC Practice',
    resultsLink: 'https://app.assessiq.in/c/results/sample-attempt-id',
  },
  attempt_ready_for_review_admin: {
    assessmentName: 'SOC Analyst — L1 Triage',
    candidateName: 'Priya Sharma',
    attemptId: '01985f4c-3a2b-7c40-9d8e-sample',
    reviewLink: 'https://app.assessiq.in/admin/attempts/01985f4c-3a2b-7c40-9d8e-sample',
    tenantName: 'Wipro SOC Practice',
  },
  admin_email_otp: {
    code: '482917',
    expires_minutes: 10,
  },
  weekly_digest_admin: {
    tenantName: 'Wipro SOC Practice',
    weekEnding: WEEK_END.toISOString().split('T')[0]!,
    totalAttempts: 47,
    completedAttempts: 41,
    pendingReview: 6,
    gradedThisWeek: 38,
    dashboardLink: 'https://app.assessiq.in/admin',
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!SMTP_URL || SMTP_URL.trim().length === 0) {
    console.error('[FATAL] SMTP_URL is empty — set it in .env.local before running.');
    process.exit(2);
  }

  console.log(`[CONFIG] FROM = ${EMAIL_FROM}`);
  console.log(`[CONFIG] TO   = ${RECIPIENT}`);
  // Print ONLY the host:port (everything after the last '@'). The previous
  // ':[^@]+@' redaction leaked the password when the SMTP username is itself an
  // email containing '@' (e.g. smtps://user@gmail.com:PASS@smtp.gmail.com) — the
  // regex matched '//user@' and left PASS in cleartext. Never reconstruct the
  // credential portion for logging.
  console.log(`[CONFIG] SMTP host = ${SMTP_URL.replace(/^.*@/, '')}`);
  console.log('');

  const transport = nodemailer.createTransport(SMTP_URL);
  try {
    await transport.verify();
    console.log('[VERIFY] SMTP transport OK\n');
  } catch (err) {
    console.error('[FATAL] SMTP transport verify failed:', err);
    process.exit(3);
  }

  const templates = Object.keys(FIXTURES) as EmailTemplateName[];
  const targets = ONLY ? templates.filter((t) => t === ONLY) : templates;

  if (targets.length === 0) {
    console.error(`[FATAL] ONLY="${ONLY}" matched no templates. Choices: ${templates.join(', ')}`);
    process.exit(4);
  }

  let ok = 0;
  let failed = 0;

  for (const tpl of targets) {
    const startMs = Date.now();
    try {
      const rendered = renderTemplate(tpl, FIXTURES[tpl]);
      const tagged = {
        from: EMAIL_FROM,
        to: RECIPIENT,
        subject: `[AssessIQ SAMPLE · ${tpl}] ${rendered.subject}`,
        text: `(Sample for design review — template "${tpl}")\n\n${rendered.text}`,
        html: rendered.html,
        headers: {
          'X-AssessIQ-Sample': 'true',
          'X-AssessIQ-Template': tpl,
        },
      };
      const result = await transport.sendMail(tagged);
      const elapsed = Date.now() - startMs;
      console.log(
        `[OK   ${String(elapsed).padStart(4)}ms] ${tpl.padEnd(34)} → ${result.messageId}`,
      );
      ok += 1;
    } catch (err) {
      const elapsed = Date.now() - startMs;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[FAIL ${String(elapsed).padStart(4)}ms] ${tpl.padEnd(34)} → ${msg}`,
      );
      failed += 1;
    }
  }

  console.log('');
  console.log(`[DONE] ${ok} sent · ${failed} failed`);
  transport.close();

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('[UNCAUGHT]', err);
  process.exit(5);
});
