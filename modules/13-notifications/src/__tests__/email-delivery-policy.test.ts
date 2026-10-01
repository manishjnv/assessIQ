/**
 * modules/13-notifications/src/__tests__/email-delivery-policy.test.ts
 *
 * Smoke tests for the two email delivery classes (2026-10-01):
 *   - every template is classified; auth = sign-in codes/links + admin invitations
 *   - enqueue options per class: auth = no priority + 5 attempts exponential;
 *     bulk = priority + 11 attempts + the 'email-bulk' custom backoff (~45 h)
 *   - the worker's single backoff strategy routes by backoff.type
 *   - SMTP 5.1.x is a permanent recipient error (UnrecoverableError, no retry);
 *     daily-limit-style 5xx / 4xx keep retrying
 *   - email_log: retryable failure -> 'queued', final -> 'failed'; one warning
 *     per failed attempt with the SMTP code and no recipient data
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSendMail, mockUpdateEmailLogStatus, mockAdd, mockLog } = vi.hoisted(() => ({
  mockSendMail: vi.fn(),
  mockUpdateEmailLogStatus: vi.fn(),
  mockAdd: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@assessiq/core', () => ({
  config: {
    NODE_ENV: 'test',
    SMTP_URL: 'smtp://smtp.test:587',
    EMAIL_FROM: 'AssessIQ <noreply@test.assessiq.com>',
    REDIS_URL: 'redis://localhost:6379',
  },
  streamLogger: () => mockLog,
  uuidv7: () => '019e0da4-22ac-72df-86cd-abcdef123456',
}));

vi.mock('@assessiq/tenancy', () => ({
  withTenant: async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn({}),
  getPool: () => ({
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
  }),
}));

vi.mock('../email/transport.js', () => ({
  resolveTransport: vi.fn(() => ({ sendMail: mockSendMail })),
}));

vi.mock('../email/render.js', () => ({
  renderTemplate: () => ({ subject: 'Subject', html: '<p>hi</p>', text: 'hi' }),
}));

vi.mock('../repository.js', () => ({
  insertEmailLog: vi.fn().mockResolvedValue({}),
  updateEmailLogStatus: mockUpdateEmailLogStatus,
}));

// Real UnrecoverableError (the processor throws it); fake Queue to capture add().
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: vi.fn().mockImplementation(() => ({ add: mockAdd })),
}));
vi.mock('ioredis', () => ({ Redis: vi.fn().mockImplementation(() => ({})) }));

import { UnrecoverableError } from 'bullmq';
import { EmailTemplateNameSchema } from '../types.js';
import { sendEmail, processEmailSendJob, type EmailSendJobData } from '../email/index.js';
import {
  BULK_EMAIL_BACKOFF_TYPE,
  BULK_EMAIL_PRIORITY,
  BULK_EMAIL_RETRY_DELAYS_MS,
  EMAIL_CLASS,
  bulkEmailBackoffStrategy,
  emailJobOptions,
  isPermanentRecipientError,
  notificationsBackoffStrategy,
} from '../email/delivery-policy.js';
import { webhookBackoffStrategy } from '../webhooks/retry-schedule.js';

const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Classification + enqueue options
// ---------------------------------------------------------------------------

describe('email classes', () => {
  it('classifies every template; auth = sign-in codes/links + admin invitations only', () => {
    const names = EmailTemplateNameSchema.options;
    expect(Object.keys(EMAIL_CLASS).sort()).toEqual([...names].sort());
    const auth = names.filter((n) => EMAIL_CLASS[n] === 'auth').sort();
    expect(auth).toEqual(['admin_email_otp', 'candidate_login_link', 'invitation_admin']);
    for (const bulk of ['invitation_candidate', 'result_released', 'evaluation_queue_alert'] as const) {
      expect(EMAIL_CLASS[bulk]).toBe('bulk');
    }
  });
});

describe('enqueue options', () => {
  it('auth: NO priority (unprioritized jobs run before any prioritized one), 5 attempts, exponential 5 s', () => {
    for (const t of ['admin_email_otp', 'candidate_login_link', 'invitation_admin'] as const) {
      const o = emailJobOptions(t);
      expect(o.priority).toBeUndefined();
      expect(o.attempts).toBe(5);
      expect(o.backoff).toEqual({ type: 'exponential', delay: 5000 });
    }
  });

  it('bulk: low priority (> 0), 11 attempts, custom email-bulk backoff', () => {
    for (const t of ['invitation_candidate', 'result_released', 'evaluation_queue_alert'] as const) {
      const o = emailJobOptions(t);
      expect(o.priority).toBe(BULK_EMAIL_PRIORITY);
      expect(o.priority).toBeGreaterThan(0);
      expect(o.attempts).toBe(BULK_EMAIL_RETRY_DELAYS_MS.length + 1);
      expect(o.attempts).toBe(11);
      expect(o.backoff).toEqual({ type: BULK_EMAIL_BACKOFF_TYPE });
    }
  });

  it('sendEmail enqueues email.send with the class options', async () => {
    mockAdd.mockClear();
    const vars = { code: '123456', expires_minutes: 10 };
    await sendEmail({ to: 'a@example.com', template: 'admin_email_otp', vars, tenantId: 't1' });
    await sendEmail({
      to: 'b@example.com',
      template: 'invitation_candidate',
      vars: {
        candidateName: 'B',
        assessmentName: 'A',
        invitationLink: 'https://x.test/i',
        expiresAt: '2026-10-08T00:00:00Z',
        tenantName: 'T',
      },
      tenantId: 't1',
    });

    const [authCall, bulkCall] = mockAdd.mock.calls;
    expect(authCall![0]).toBe('email.send');
    expect(authCall![2]).not.toHaveProperty('priority');
    expect(authCall![2]).toMatchObject({ attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
    expect(bulkCall![0]).toBe('email.send');
    expect(bulkCall![2]).toMatchObject({ priority: 100, attempts: 11, backoff: { type: 'email-bulk' } });
  });
});

describe('bulk backoff', () => {
  it('first retry is 1 min (BullMQ passes attemptsMade 1-based); ~45 h in total; clamps at 12 h', () => {
    // 1 m, 5 m, 15 m, 1 h, 2 h, 4 h, 6 h, 8 h, 12 h, 12 h
    const expected = [1, 5, 15, 60, 120, 240, 360, 480, 720, 720].map((m) => m * 60_000);
    expect(BULK_EMAIL_RETRY_DELAYS_MS).toEqual(expected);
    expect(expected.map((_, i) => bulkEmailBackoffStrategy(i + 1))).toEqual(expected);
    expect(bulkEmailBackoffStrategy(11)).toBe(12 * HOUR);
    const total = BULK_EMAIL_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(44 * HOUR);
    expect(total).toBeLessThan(48 * HOUR);
  });

  it('the shared worker strategy routes by backoff.type; webhook behaviour is untouched', () => {
    expect(notificationsBackoffStrategy(1, 'email-bulk')).toBe(60_000);
    expect(notificationsBackoffStrategy(4, 'email-bulk')).toBe(HOUR);
    expect(notificationsBackoffStrategy(2, 'custom')).toBe(webhookBackoffStrategy(2));
    expect(notificationsBackoffStrategy(2)).toBe(webhookBackoffStrategy(2));
  });
});

// ---------------------------------------------------------------------------
// SMTP failure classification
// ---------------------------------------------------------------------------

describe('isPermanentRecipientError', () => {
  const smtpError = (response: string, command = 'RCPT TO', code = 'EENVELOPE') =>
    Object.assign(new Error(`Recipient command failed: ${response}`), {
      code,
      command,
      response,
      responseCode: Number(response.slice(0, 3)),
    });

  it('SMTP 5.1.x (no such user / bad address) is permanent', () => {
    expect(isPermanentRecipientError(smtpError('550 5.1.1 <a@b.c>: Recipient address rejected: User unknown'))).toBe(true);
    expect(isPermanentRecipientError(smtpError('553 5.1.3 The recipient address is not a valid RFC-5321 address'))).toBe(true);
    expect(isPermanentRecipientError(smtpError('550-5.1.1 The email account does not exist\n550 5.1.1 Learn more'))).toBe(true);
  });

  it('daily-limit / quota / policy / transient / sender-side / connection errors keep retrying', () => {
    expect(isPermanentRecipientError(smtpError('550 5.7.1 Daily user sending quota exceeded', 'DATA', 'EMESSAGE'))).toBe(false);
    expect(isPermanentRecipientError(smtpError('552 5.2.2 Mailbox full'))).toBe(false);
    expect(isPermanentRecipientError(smtpError('554 Transaction failed: daily limit reached', 'DATA', 'EMESSAGE'))).toBe(false);
    expect(isPermanentRecipientError(smtpError('421 4.7.0 Try again later', 'CONN', 'ECONNECTION'))).toBe(false);
    expect(isPermanentRecipientError(smtpError('450 4.1.1 greylisted'))).toBe(false);
    expect(isPermanentRecipientError(smtpError('550 5.1.8 Bad sender address', 'MAIL FROM'))).toBe(false);
    expect(isPermanentRecipientError(Object.assign(new Error('x'), { code: 'ECONNECTION' }))).toBe(false);
    expect(isPermanentRecipientError(new Error('SMTP connection refused'))).toBe(false);
    expect(isPermanentRecipientError('boom')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processEmailSendJob
// ---------------------------------------------------------------------------

const JOB: EmailSendJobData = {
  emailLogId: '019e0da4-22ac-72df-86cd-abcdef123456',
  tenantId: 'tenant-acme',
  to: 'candidate@acme.com',
  subject: 'Your SOC assessment invitation',
  bodyHtml: '<p>Hello</p>',
  bodyText: 'Hello',
  templateId: 'invitation_candidate',
};

const rcptRejected = () =>
  Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <candidate@acme.com>: User unknown"), {
    code: 'EENVELOPE',
    command: 'RCPT TO',
    response: '550 5.1.1 <candidate@acme.com>: User unknown',
    responseCode: 550,
  });

const dailyLimit = () =>
  Object.assign(new Error('Message failed: 550 5.7.1 Daily sending limit exceeded'), {
    code: 'EMESSAGE',
    command: 'DATA',
    response: '550 5.7.1 Daily sending limit exceeded',
    responseCode: 550,
  });

/** The email_log update that carries the failure (the one with lastError). */
function failureRow(): Record<string, unknown> {
  const call = mockUpdateEmailLogStatus.mock.calls.find(([, , u]) => u.lastError !== undefined);
  return call![2] as Record<string, unknown>;
}

describe('processEmailSendJob — failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateEmailLogStatus.mockResolvedValue(1);
  });

  it('SMTP 5.1.1 is NOT retried: UnrecoverableError, email_log failed at once, warning with the SMTP code', async () => {
    mockSendMail.mockRejectedValue(rcptRejected());

    const err = await processEmailSendJob(JOB, { attempt: 1, maxAttempts: 11 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).name).toBe('UnrecoverableError'); // what BullMQ checks
    expect(failureRow()).toMatchObject({ status: 'failed', attempts: 1 });

    const warn = mockLog.warn.mock.calls.find(([, msg]) => msg === 'email.send.attempt_failed');
    expect(warn![0]).toMatchObject({
      template: 'invitation_candidate',
      emailClass: 'bulk',
      attempt: 1,
      maxAttempts: 11,
      smtpCode: 550,
      enhancedCode: '5.1.1',
      permanent: true,
      willRetry: false,
    });
  });

  it('daily-limit style failure is rethrown unchanged (BullMQ retries); email_log goes back to queued', async () => {
    const limit = dailyLimit();
    mockSendMail.mockRejectedValue(limit);

    await expect(processEmailSendJob(JOB, { attempt: 3, maxAttempts: 11 })).rejects.toBe(limit);

    expect(failureRow()).toMatchObject({ status: 'queued', attempts: 3 });
    const warn = mockLog.warn.mock.calls.find(([, msg]) => msg === 'email.send.attempt_failed');
    expect(warn![0]).toMatchObject({ smtpCode: 550, enhancedCode: '5.7.1', permanent: false, willRetry: true, attempt: 3 });
  });

  it('the last attempt marks email_log failed', async () => {
    mockSendMail.mockRejectedValue(dailyLimit());
    await expect(processEmailSendJob(JOB, { attempt: 11, maxAttempts: 11 })).rejects.toThrow();
    expect(failureRow()).toMatchObject({ status: 'failed', attempts: 11 });
  });

  it('the failure warning carries no recipient data and no SMTP reply text', async () => {
    mockSendMail.mockRejectedValue(rcptRejected());
    await processEmailSendJob(JOB, { attempt: 1, maxAttempts: 11 }).catch(() => undefined);
    const warnings = JSON.stringify(mockLog.warn.mock.calls);
    expect(warnings).not.toContain('candidate@acme.com');
    expect(warnings).not.toContain('User unknown');
  });

  it('marks sending/sent with the real attempt number', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<m@smtp.test>' });
    await processEmailSendJob(JOB, { attempt: 4, maxAttempts: 11 });
    const statuses = mockUpdateEmailLogStatus.mock.calls.map(([, , u]) => [u.status, u.attempts]);
    expect(statuses).toEqual([
      ['sending', 4],
      ['sent', 4],
    ]);
  });
});
