/**
 * modules/13-notifications/src/__tests__/email-send-flow.test.ts
 *
 * Unit tests for the email.send BullMQ job processor (processEmailSendJob).
 *
 * Regression coverage for the 2026-05-09 email_log status-tracking bug:
 *   - emailLogId was being coerced to its .length (number 36) in the
 *     worker harness result adapter, and updateEmailLogStatus lacked
 *     rowCount observability. Fix: remove adapter in worker.ts, return
 *     rowCount from updateEmailLogStatus, add error logging on 0 rows.
 *
 * Contract assertions:
 *   a) updateEmailLogStatus is called with the correct string UUID, never
 *      with the number 36 (length of a UUID string).
 *   b) Status transitions: 'sending' (before SMTP) → 'sent' (after SMTP).
 *   c) sent_at is populated on the 'sent' update.
 *   d) providerMessageId is populated on the 'sent' update.
 *   e) Return value contains emailLogId as a string UUID, not a number.
 *   f) On zero-rows-affected, processor still completes (no throw).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted() runs before vi.mock() factories so these refs
// are safe to use inside the factory closures.
// ---------------------------------------------------------------------------

const { mockSendMail, mockUpdateEmailLogStatus } = vi.hoisted(() => ({
  mockSendMail: vi.fn(),
  mockUpdateEmailLogStatus: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — must appear before any import of the modules under test
// ---------------------------------------------------------------------------

vi.mock('@assessiq/core', () => ({
  config: {
    NODE_ENV: 'test',
    SMTP_URL: 'smtp://smtp.test:587',  // non-empty → real transport path
    EMAIL_FROM: 'AssessIQ <noreply@test.assessiq.com>',
    REDIS_URL: 'redis://localhost:6379',
    ASSESSIQ_BASE_URL: 'https://assessiq.test',
    ASSESSIQ_MASTER_KEY: Buffer.alloc(32).toString('base64'),
    LOG_DIR: undefined,
    LOG_LEVEL: 'error',
    SESSION_SECRET: Buffer.alloc(32).toString('base64'),
    SESSION_COOKIE_NAME: 'aiq_sess',
    EMBED_JWT_SECRET_PROVISION_MODE: 'per-tenant',
    MFA_REQUIRED: false,
    AI_PIPELINE_MODE: 'claude-code-vps',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  },
  streamLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  uuidv7: () => 'mock-uuid-from-core',
  ValidationError: class ValidationError extends Error {
    constructor(message: string, public details?: unknown) { super(message); }
  },
  AuthzError: class AuthzError extends Error {
    constructor(message: string) { super(message); }
  },
}));

// Mock withTenant: calls fn with a fake client, returns the callback's result.
vi.mock('@assessiq/tenancy', () => ({
  withTenant: async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) =>
    fn({ __fakeClient: true }),
  getPool: () => ({
    connect: async () => ({
      query: async () => ({ rows: [{ attempts: 0 }] }),
      release: () => undefined,
    }),
  }),
}));

// Mock the transport — returns a non-null transport with a controllable sendMail.
vi.mock('../email/transport.js', () => ({
  resolveTransport: vi.fn(() => ({ sendMail: mockSendMail })),
}));

// Mock the repository — spies with controllable return values.
vi.mock('../repository.js', () => ({
  insertEmailLog: vi.fn().mockResolvedValue({}),
  updateEmailLogStatus: mockUpdateEmailLogStatus,
  getEmailLogById: vi.fn().mockResolvedValue(null),
  insertWebhookEndpoint: vi.fn(),
  listWebhookEndpoints: vi.fn().mockResolvedValue([]),
  getWebhookEndpointById: vi.fn().mockResolvedValue(null),
  getWebhookEndpointSecret: vi.fn().mockResolvedValue(null),
  deleteWebhookEndpoint: vi.fn(),
  findEndpointsForEvent: vi.fn().mockResolvedValue([]),
  insertWebhookDelivery: vi.fn(),
  getWebhookDeliveryById: vi.fn().mockResolvedValue(null),
  updateWebhookDeliveryStatus: vi.fn().mockResolvedValue(1),
  listWebhookDeliveries: vi.fn().mockResolvedValue([]),
  insertInAppNotification: vi.fn(),
  listInAppNotificationsForUser: vi.fn().mockResolvedValue([]),
  markInAppNotificationRead: vi.fn(),
}));

// Mock BullMQ (imported transitively via the module barrel).
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({ quit: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Imports — AFTER mocks
// ---------------------------------------------------------------------------

import { processEmailSendJob, type EmailSendJobData } from '../email/index.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Fixed UUID — exactly 36 characters.
 * The regression bug surfaced as the number 36 (uuid.length) being passed
 * to updateEmailLogStatus instead of the string value below. The assertions
 * verify the string is passed, not the integer.
 */
const FIXED_EMAIL_LOG_ID = '019e0da4-22ac-72df-86cd-abcdef123456';

const BASE_JOB_DATA: EmailSendJobData = {
  emailLogId: FIXED_EMAIL_LOG_ID,
  tenantId: 'tenant-acme',
  to: 'candidate@acme.com',
  subject: 'Your SOC assessment invitation',
  bodyHtml: '<p>Hello</p>',
  bodyText: 'Hello',
  templateId: 'invitation_candidate',
};

// ---------------------------------------------------------------------------
// Happy-path: SMTP succeeds
// ---------------------------------------------------------------------------

describe('processEmailSendJob — SMTP success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: '<test-provider-msg-id@smtp.test>' });
    // Default: 1 row affected for every update (normal case)
    mockUpdateEmailLogStatus.mockResolvedValue(1);
  });

  it('(a) calls updateEmailLogStatus with the string UUID, never with number 36', async () => {
    await processEmailSendJob(BASE_JOB_DATA);

    const allCalls = mockUpdateEmailLogStatus.mock.calls;
    expect(allCalls.length).toBeGreaterThanOrEqual(1);

    for (const [_client, id] of allCalls) {
      // id must be the exact string UUID — NOT the number 36
      expect(typeof id).toBe('string');
      expect(id).toBe(FIXED_EMAIL_LOG_ID);
      expect(id).not.toBe(FIXED_EMAIL_LOG_ID.length); // not 36
    }
  });

  it('(b) transitions status: first call "sending", second call "sent"', async () => {
    await processEmailSendJob(BASE_JOB_DATA);

    const calls = mockUpdateEmailLogStatus.mock.calls;
    expect(calls).toHaveLength(2);

    const [, , firstUpdates] = calls[0]!;
    expect(firstUpdates).toMatchObject({ status: 'sending' });

    const [, , secondUpdates] = calls[1]!;
    expect(secondUpdates).toMatchObject({ status: 'sent' });
  });

  it('(c) sent_at is populated on the "sent" update', async () => {
    const before = new Date();
    await processEmailSendJob(BASE_JOB_DATA);
    const after = new Date();

    const calls = mockUpdateEmailLogStatus.mock.calls;
    const [, , sentUpdates] = calls[1]!; // second call is 'sent'
    expect(sentUpdates.sentAt).toBeInstanceOf(Date);
    expect((sentUpdates.sentAt as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect((sentUpdates.sentAt as Date).getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('(d) providerMessageId is populated on the "sent" update', async () => {
    await processEmailSendJob(BASE_JOB_DATA);

    const calls = mockUpdateEmailLogStatus.mock.calls;
    const [, , sentUpdates] = calls[1]!;
    expect(sentUpdates.providerMessageId).toBe('<test-provider-msg-id@smtp.test>');
  });

  it('(e) return value has emailLogId as string UUID, not number', async () => {
    const result = await processEmailSendJob(BASE_JOB_DATA);

    expect(typeof result.emailLogId).toBe('string');
    expect(result.emailLogId).toBe(FIXED_EMAIL_LOG_ID);
    // Regression guard: must not be the number 36
    expect(result.emailLogId).not.toBe(36);
    expect(result.status).toBe('sent');
  });

  it('return value includes providerMessageId', async () => {
    const result = await processEmailSendJob(BASE_JOB_DATA);
    expect(result.providerMessageId).toBe('<test-provider-msg-id@smtp.test>');
  });
});

// ---------------------------------------------------------------------------
// Observability: zero-rows-affected case
// ---------------------------------------------------------------------------

describe('processEmailSendJob — zero rows affected (f)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: '<msg-id@smtp.test>' });
    // Simulate no row found for the emailLogId (e.g. RLS miss or stale id)
    mockUpdateEmailLogStatus.mockResolvedValue(0);
  });

  it('(f) does NOT throw when rowCount=0, processor still completes', async () => {
    // The processor must not throw — BullMQ would retry unnecessarily.
    await expect(processEmailSendJob(BASE_JOB_DATA)).resolves.toBeDefined();
  });

  it('still returns emailLogId as a string when no rows affected', async () => {
    const result = await processEmailSendJob(BASE_JOB_DATA);
    expect(typeof result.emailLogId).toBe('string');
    expect(result.emailLogId).toBe(FIXED_EMAIL_LOG_ID);
  });
});

// ---------------------------------------------------------------------------
// tenantId=null path: DB updates are skipped
// ---------------------------------------------------------------------------

describe('processEmailSendJob — tenantId null (no-DB path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: '<no-tenant-msg@test.com>' });
    mockUpdateEmailLogStatus.mockResolvedValue(1);
  });

  it('does not call updateEmailLogStatus when tenantId is null', async () => {
    await processEmailSendJob({ ...BASE_JOB_DATA, tenantId: null });
    expect(mockUpdateEmailLogStatus).not.toHaveBeenCalled();
  });

  it('still delivers the email and returns success', async () => {
    const result = await processEmailSendJob({ ...BASE_JOB_DATA, tenantId: null });
    expect(result.status).toBe('sent');
    expect(mockSendMail).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// SMTP failure path
// ---------------------------------------------------------------------------

describe('processEmailSendJob — SMTP failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockRejectedValue(new Error('SMTP connection refused'));
    mockUpdateEmailLogStatus.mockResolvedValue(1);
  });

  it('re-throws the SMTP error so BullMQ can retry', async () => {
    await expect(processEmailSendJob(BASE_JOB_DATA)).rejects.toThrow('SMTP connection refused');
  });

  it('calls updateEmailLogStatus with status="failed" after SMTP error', async () => {
    await expect(processEmailSendJob(BASE_JOB_DATA)).rejects.toThrow();

    const calls = mockUpdateEmailLogStatus.mock.calls;
    // First call is 'sending', then 'failed'
    const failCall = calls.find(([, , u]) => u.status === 'failed');
    expect(failCall).toBeDefined();
    const [, failId] = failCall!;
    // Even on error path: id must be string UUID, never a number
    expect(typeof failId).toBe('string');
    expect(failId).toBe(FIXED_EMAIL_LOG_ID);
  });
});

