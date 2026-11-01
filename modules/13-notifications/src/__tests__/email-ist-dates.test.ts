/**
 * Z-185: recipient mails show dates in Indian time (Asia/Kolkata), plain format, never GMT.
 * Sender-var checks use a mocked sendEmail; render checks use the real templates. No DB, no SMTP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendEmail = vi.hoisted(() =>
  vi.fn<(input: { vars: Record<string, unknown> }) => Promise<void>>(async () => undefined),
);
vi.mock('../email/index.js', () => ({ sendEmail }));

import { sendAssessmentInvitationEmail } from '../email/legacy-shims.js';
import { sendInvitationReminderEmail } from '../email/invitation-reminder.js';
import { sendTotpEnrolledEmail } from '../email/totp-enrolled.js';
import { sendTotpResetNoticeEmail } from '../email/totp-reset-notice.js';
import { renderTemplate } from '../email/render.js';

const AT = new Date('2026-11-08T04:02:44Z');
const IST = '8 Nov 2026, 9:32 am IST';

function lastVars(): Record<string, unknown> {
  const call = sendEmail.mock.calls[sendEmail.mock.calls.length - 1];
  if (!call) throw new Error('sendEmail was not called');
  return call[0].vars;
}

beforeEach(() => {
  sendEmail.mockClear();
});

describe('invitation_candidate (legacy shim)', () => {
  it('sends expiresAt in Indian time and the render shows it without GMT', async () => {
    await sendAssessmentInvitationEmail({
      to: 'jane@example.com',
      candidateName: 'Jane',
      assessmentName: 'Cloud Ops',
      invitationLink: 'https://assessiq.test/take/t1',
      expiresAt: AT,
      tenantName: 'Cloudco',
      tenantId: '22222222-2222-2222-2222-222222222222',
    });
    const vars = lastVars();
    expect(vars['expiresAt']).toBe(IST);
    const { html, text } = renderTemplate('invitation_candidate', vars as never);
    for (const body of [html, text]) {
      expect(body).toContain(IST);
      expect(body).not.toContain('GMT');
    }
  });
});

describe('invitation_reminder', () => {
  it('sends the deadline in Indian time and the render shows it without GMT', async () => {
    await sendInvitationReminderEmail({
      to: 'jane@example.com',
      candidateName: 'Jane',
      assessmentName: 'Cloud Ops',
      invitationLink: 'https://assessiq.test/take/t1',
      deadline: AT,
      tenantName: 'Cloudco',
      tenantId: '22222222-2222-2222-2222-222222222222',
    });
    const vars = lastVars();
    expect(vars['expiresAt']).toBe(IST);
    const { html, text, subject } = renderTemplate('invitation_reminder', vars as never);
    expect(subject).toContain(IST);
    for (const body of [html, text]) {
      expect(body).toContain(IST);
      expect(body).not.toContain('GMT');
    }
  });
});

describe('totp_enrolled (account owner notice)', () => {
  it('sends enrolledAt in Indian time and the render shows it without GMT', async () => {
    await sendTotpEnrolledEmail({
      to: 'jane@example.com',
      recipientName: 'Jane',
      tenantId: '22222222-2222-2222-2222-222222222222',
      tenantName: 'Cloudco',
      at: AT,
    });
    const vars = lastVars();
    expect(vars['enrolledAt']).toBe(IST);
    const { html, text } = renderTemplate('totp_enrolled', vars as never);
    for (const body of [html, text]) {
      expect(body).toContain(IST);
      expect(body).not.toContain('GMT');
    }
  });
});

describe('totp_reset_notice (admin reset notice)', () => {
  it('sends resetAt in Indian time and the render shows it without GMT', async () => {
    await sendTotpResetNoticeEmail({
      to: 'jane@example.com',
      recipientName: 'Jane',
      actorRole: 'admin',
      tenantId: '22222222-2222-2222-2222-222222222222',
      at: AT,
    });
    const vars = lastVars();
    expect(vars['resetAt']).toBe(IST);
    const { html, text } = renderTemplate('totp_reset_notice', vars as never);
    for (const body of [html, text]) {
      expect(body).toContain(IST);
      expect(body).not.toContain('GMT');
    }
  });
});

describe('credit_expiring (render)', () => {
  it('shows the expiry as Indian time and never GMT or UTC', () => {
    const { html, text } = renderTemplate('credit_expiring', {
      remaining: 150,
      expiresOn: '9 Nov 2026, 12:15 am IST',
      usageLink: 'https://assessiq.test/admin/settings?tab=plan',
    } as never);
    for (const body of [html, text]) {
      expect(body).toContain('9 Nov 2026, 12:15 am IST');
      expect(body).not.toContain('GMT');
      expect(body).not.toContain('UTC');
    }
  });
});

describe('recipient mails never break on a bad date', () => {
  it('invitation reminder sends the raw value instead of throwing', async () => {
    await expect(
      sendInvitationReminderEmail({
        to: 'jane@example.com',
        candidateName: 'Jane',
        assessmentName: 'Cloud Ops',
        invitationLink: 'https://assessiq.test/take/t1',
        deadline: 'not a date' as unknown as Date,
        tenantName: 'Cloudco',
        tenantId: '22222222-2222-2222-2222-222222222222',
      }),
    ).resolves.toBeUndefined();
    expect(lastVars()['expiresAt']).toBe('not a date');
  });
});
