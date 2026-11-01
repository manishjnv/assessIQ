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
