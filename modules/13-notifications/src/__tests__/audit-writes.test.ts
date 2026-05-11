/**
 * G3.D audit-write sweep — coverage tests for modules/13-notifications.
 *
 * Mirrors modules/09-scoring/src/__tests__/audit-writes.test.ts and
 * modules/03-users/src/__tests__/audit-writes.test.ts.
 *
 * Admin mutations (audited — 3 sites):
 *   createWebhookEndpoint → webhook.created
 *   deleteWebhookEndpoint → webhook.deleted (before-state snapshot)
 *   replayDelivery        → webhook.replayed
 *
 * Operational mutations (NOT audited — negative invariant):
 *   emitWebhookToEndpoint (via emitWebhook) → insertWebhookDelivery, no audit
 *   processEmailSendJob (BullMQ worker)      → updateEmailLogStatus, no audit
 *   notifyInApp (system-triggered)           → insertInAppNotification, no audit
 *
 * Atomicity: auditInTx throws → the service call rejects, proving the audit
 * failure propagates (not swallowed as best-effort).
 *
 * Strategy: all DB interaction is mocked (no testcontainers). withTenant calls
 * fn({ __fakeClient: true }) and propagates any error — sufficient to verify
 * that auditInTx is called inside the callback and that throws bubble up.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted() runs before vi.mock() factories.
// ---------------------------------------------------------------------------

const { mockAuditInTx, mockInsertWebhookEndpoint, mockDeleteWebhookEndpoint,
        mockGetWebhookEndpointById, mockInsertWebhookDelivery,
        mockGetWebhookDeliveryById, mockUpdateEmailLogStatus,
        mockInsertInAppNotification } = vi.hoisted(() => ({
  mockAuditInTx:              vi.fn().mockResolvedValue(undefined),
  mockInsertWebhookEndpoint:  vi.fn(),
  mockDeleteWebhookEndpoint:  vi.fn().mockResolvedValue(undefined),
  mockGetWebhookEndpointById: vi.fn(),
  mockInsertWebhookDelivery:  vi.fn(),
  mockGetWebhookDeliveryById: vi.fn(),
  mockUpdateEmailLogStatus:   vi.fn().mockResolvedValue(1),
  mockInsertInAppNotification: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — must appear before imports of modules under test.
// ---------------------------------------------------------------------------

vi.mock('@assessiq/audit-log', () => ({
  auditInTx: mockAuditInTx,
  // audit() not used after G3.D upgrade; present for completeness.
  audit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@assessiq/core', () => ({
  config: {
    NODE_ENV: 'test',
    REDIS_URL: 'redis://localhost:6379',
    SMTP_URL: 'smtp://smtp.test:587',
    EMAIL_FROM: 'AssessIQ <noreply@test.assessiq.com>',
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
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  uuidv7: () => `test-uuid-${Math.random().toString(36).slice(2)}`,
  ValidationError: class ValidationError extends Error {
    constructor(message: string, public details?: unknown) { super(message); }
  },
  AuthzError: class AuthzError extends Error {
    constructor(message: string) { super(message); }
  },
}));

// withTenant executes the callback with a fake client and propagates errors.
// This is sufficient to verify that auditInTx is called inside the callback
// and that exceptions thrown by auditInTx propagate to the caller.
const FAKE_CLIENT = { __fakeClient: true };
vi.mock('@assessiq/tenancy', () => ({
  withTenant: async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) =>
    fn(FAKE_CLIENT),
  getPool: () => ({
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
  }),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({ quit: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({ messageId: 'mock-id' }),
    }),
  },
}));

vi.mock('../repository.js', () => ({
  insertWebhookEndpoint:         mockInsertWebhookEndpoint,
  deleteWebhookEndpoint:         mockDeleteWebhookEndpoint,
  getWebhookEndpointById:        mockGetWebhookEndpointById,
  listWebhookEndpoints:          vi.fn().mockResolvedValue([]),
  getWebhookEndpointSecret:      vi.fn().mockResolvedValue(null),
  findEndpointsForEvent:         vi.fn().mockResolvedValue([]),
  insertWebhookDelivery:         mockInsertWebhookDelivery,
  getWebhookDeliveryById:        mockGetWebhookDeliveryById,
  updateWebhookDeliveryStatus:   vi.fn().mockResolvedValue(undefined),
  listWebhookDeliveries:         vi.fn().mockResolvedValue([]),
  insertEmailLog:                vi.fn().mockResolvedValue({ id: 'email-log-id' }),
  updateEmailLogStatus:          mockUpdateEmailLogStatus,
  getEmailLogById:               vi.fn().mockResolvedValue(null),
  insertInAppNotification:       mockInsertInAppNotification,
  listInAppNotificationsForUser: vi.fn().mockResolvedValue([]),
  markInAppNotificationRead:     vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports — AFTER all vi.mock() declarations.
// ---------------------------------------------------------------------------

import { createWebhookEndpoint, deleteWebhookEndpoint,
         replayDelivery, emitWebhook } from '../webhooks/service.js';
import { notifyInApp } from '../in-app/service.js';
import { processEmailSendJob, type EmailSendJobData } from '../email/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = 'aaaaaaaa-0001-7000-8000-000000000001';
const ACTOR  = 'bbbbbbbb-0002-7000-8000-000000000002';

const ENDPOINT_ROW = {
  id: 'cccccccc-0003-7000-8000-000000000003',
  tenant_id: TENANT,
  name: 'My SIEM',
  url: 'https://siem.example.com/hook',
  events: ['attempt.graded', 'attempt.submitted'],
  status: 'active' as const,
  requires_fresh_mfa: false,
  created_at: new Date('2026-05-11T00:00:00Z'),
};

const DELIVERY_ROW = {
  id: 'dddddddd-0004-7000-8000-000000000004',
  endpoint_id: ENDPOINT_ROW.id,
  event: 'attempt.graded',
  payload: { attempt_id: 'att_1' },
  status: 'failed' as const,
  http_status: 500,
  attempts: 3,
  retry_at: null,
  delivered_at: null,
  last_error: 'HTTP 500',
  created_at: new Date('2026-05-11T01:00:00Z'),
};

// ---------------------------------------------------------------------------
// beforeEach: reset call counts (mocked module cache remains, only history cleared)
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path returns for repo mocks.
  mockInsertWebhookEndpoint.mockResolvedValue(ENDPOINT_ROW);
  mockGetWebhookEndpointById.mockResolvedValue(ENDPOINT_ROW);
  mockGetWebhookDeliveryById.mockResolvedValue(DELIVERY_ROW);
  mockInsertWebhookDelivery.mockResolvedValue({
    ...DELIVERY_ROW,
    id: 'eeeeeeee-0005-7000-8000-000000000005',
    status: 'pending',
    http_status: null,
    attempts: 0,
    last_error: null,
    created_at: new Date(),
  });
  mockInsertInAppNotification.mockImplementation((_client: unknown, input: { id: string; tenantId: string; audience: string; userId: string | null; role: string | null; kind: string; message: string; link: string | null }) => ({
    id: input.id,
    tenant_id: input.tenantId,
    audience: input.audience,
    user_id: input.userId,
    role: input.role,
    kind: input.kind,
    message: input.message,
    link: input.link,
    read_at: null,
    created_at: new Date(),
  }));
});

// ===========================================================================
// Section 1: createWebhookEndpoint → webhook.created
// ===========================================================================

describe('createWebhookEndpoint → webhook.created audit', () => {
  it('calls auditInTx with action=webhook.created, entityType=webhook_endpoint', async () => {
    await createWebhookEndpoint({
      tenantId: TENANT,
      name: 'My SIEM',
      url: 'https://siem.example.com/hook',
      events: ['attempt.graded'],
      requiresFreshMfa: false,
      actorUserId: ACTOR,
    });

    expect(mockAuditInTx).toHaveBeenCalledOnce();
    const [, input] = mockAuditInTx.mock.calls[0]!;
    expect(input.action).toBe('webhook.created');
    expect(input.entityType).toBe('webhook_endpoint');
    expect(input.tenantId).toBe(TENANT);
    expect(input.actorKind).toBe('user');
    expect(input.actorUserId).toBe(ACTOR);
  });

  it('before is absent (INSERT — no prior state)', async () => {
    await createWebhookEndpoint({
      tenantId: TENANT,
      name: 'Hook',
      url: 'https://hook.example.com',
      events: ['attempt.graded'],
      requiresFreshMfa: false,
      actorUserId: ACTOR,
    });

    const [, input] = mockAuditInTx.mock.calls[0]!;
    expect(input.before).toBeUndefined();
  });

  it('after contains name, url, events, requires_fresh_mfa', async () => {
    await createWebhookEndpoint({
      tenantId: TENANT,
      name: 'Hook',
      url: 'https://hook.example.com',
      events: ['attempt.graded', 'attempt.submitted'],
      requiresFreshMfa: true,
      actorUserId: ACTOR,
    });

    const [, input] = mockAuditInTx.mock.calls[0]!;
    expect(input.after).toMatchObject({
      name: 'Hook',
      url: 'https://hook.example.com',
      events: ['attempt.graded', 'attempt.submitted'],
      requires_fresh_mfa: true,
    });
  });

  it('actorKind=system when actorUserId is omitted', async () => {
    await createWebhookEndpoint({
      tenantId: TENANT,
      name: 'Hook',
      url: 'https://hook.example.com',
      events: ['attempt.graded'],
      requiresFreshMfa: false,
      // no actorUserId
    });

    const [, input] = mockAuditInTx.mock.calls[0]!;
    expect(input.actorKind).toBe('system');
    expect(input.actorUserId).toBeUndefined();
  });

  it('auditInTx client arg is the withTenant client (same object reference)', async () => {
    await createWebhookEndpoint({
      tenantId: TENANT,
      name: 'Hook',
      url: 'https://hook.example.com',
      events: ['attempt.graded'],
      requiresFreshMfa: false,
    });

    const [client] = mockAuditInTx.mock.calls[0]!;
    expect(client).toBe(FAKE_CLIENT);
  });

  it('atomicity: auditInTx throws → createWebhookEndpoint rejects (audit failure is not swallowed)', async () => {
    mockAuditInTx.mockRejectedValueOnce(new Error('simulated audit failure'));

    await expect(
      createWebhookEndpoint({
        tenantId: TENANT,
        name: 'Hook',
        url: 'https://hook.example.com',
        events: ['attempt.graded'],
        requiresFreshMfa: false,
        actorUserId: ACTOR,
      }),
    ).rejects.toThrow('simulated audit failure');
  });
});

// ===========================================================================
// Section 2: deleteWebhookEndpoint → webhook.deleted (with before-state)
// ===========================================================================

describe('deleteWebhookEndpoint → webhook.deleted audit', () => {
  it('calls auditInTx with action=webhook.deleted', async () => {
    await deleteWebhookEndpoint(TENANT, ENDPOINT_ROW.id, ACTOR);

    expect(mockAuditInTx).toHaveBeenCalledOnce();
    const [, input] = mockAuditInTx.mock.calls[0]!;
    expect(input.action).toBe('webhook.deleted');
    expect(input.entityType).toBe('webhook_endpoint');
    expect(input.entityId).toBe(ENDPOINT_ROW.id);
    expect(input.tenantId).toBe(TENANT);
    expect(input.actorKind).toBe('user');
    expect(input.actorUserId).toBe(ACTOR);
  });

  it('before captures name, url, events, status from the pre-delete snapshot', async () => {
    await deleteWebhookEndpoint(TENANT, ENDPOINT_ROW.id, ACTOR);

    const [, input] = mockAuditInTx.mock.calls[0]!;
    expect(input.before).toMatchObject({
      name: ENDPOINT_ROW.name,
      url: ENDPOINT_ROW.url,
      events: ENDPOINT_ROW.events,
      status: ENDPOINT_ROW.status,
    });
    expect(input.after).toBeUndefined();
  });

  it('before is absent when endpoint not found (still audits the attempted delete)', async () => {
    mockGetWebhookEndpointById.mockResolvedValueOnce(null);

    await deleteWebhookEndpoint(TENANT, 'nonexistent-id', ACTOR);

    const [, input] = mockAuditInTx.mock.calls[0]!;
    expect(input.before).toBeUndefined();
  });

  it('reads before-state BEFORE the delete (correct ordering)', async () => {
    const callOrder: string[] = [];
    mockGetWebhookEndpointById.mockImplementation(async () => {
      callOrder.push('getById');
      return ENDPOINT_ROW;
    });
    mockDeleteWebhookEndpoint.mockImplementation(async () => {
      callOrder.push('delete');
    });
    mockAuditInTx.mockImplementation(async () => {
      callOrder.push('audit');
    });

    await deleteWebhookEndpoint(TENANT, ENDPOINT_ROW.id, ACTOR);

    expect(callOrder).toEqual(['getById', 'delete', 'audit']);
  });

  it('atomicity: auditInTx throws → deleteWebhookEndpoint rejects', async () => {
    mockAuditInTx.mockRejectedValueOnce(new Error('audit failure'));

    await expect(
      deleteWebhookEndpoint(TENANT, ENDPOINT_ROW.id, ACTOR),
    ).rejects.toThrow('audit failure');
  });
});

// ===========================================================================
// Section 3: replayDelivery → webhook.replayed
// ===========================================================================

describe('replayDelivery → webhook.replayed audit', () => {
  it('calls auditInTx with action=webhook.replayed', async () => {
    await replayDelivery(TENANT, DELIVERY_ROW.id, ACTOR);

    expect(mockAuditInTx).toHaveBeenCalledOnce();
    const [, input] = mockAuditInTx.mock.calls[0]!;
    expect(input.action).toBe('webhook.replayed');
    expect(input.entityType).toBe('webhook_delivery');
    expect(input.entityId).toBe(DELIVERY_ROW.id); // original delivery
    expect(input.tenantId).toBe(TENANT);
    expect(input.actorKind).toBe('user');
    expect(input.actorUserId).toBe(ACTOR);
  });

  it('after includes original_delivery_id, endpoint_id, event, new_delivery_id', async () => {
    await replayDelivery(TENANT, DELIVERY_ROW.id, ACTOR);

    const [, input] = mockAuditInTx.mock.calls[0]!;
    expect(input.after).toMatchObject({
      original_delivery_id: DELIVERY_ROW.id,
      endpoint_id: DELIVERY_ROW.endpoint_id,
      event: DELIVERY_ROW.event,
    });
    expect(input.after.new_delivery_id).toBeDefined();
    expect(typeof input.after.new_delivery_id).toBe('string');
  });

  it('throws when original delivery not found (no audit row written)', async () => {
    mockGetWebhookDeliveryById.mockResolvedValueOnce(null);

    await expect(replayDelivery(TENANT, 'nonexistent-del', ACTOR)).rejects.toThrow(
      'Delivery not found: nonexistent-del',
    );

    expect(mockAuditInTx).not.toHaveBeenCalled();
  });

  it('atomicity: auditInTx throws → replayDelivery rejects', async () => {
    mockAuditInTx.mockRejectedValueOnce(new Error('audit failure'));

    await expect(replayDelivery(TENANT, DELIVERY_ROW.id, ACTOR)).rejects.toThrow('audit failure');
  });
});

// ===========================================================================
// Section 4: Operational paths — MUST NOT call auditInTx
//
// These tests lock in the invariant that delivery-tracking and system-triggered
// notification writes are NOT audited. If anyone adds auditInTx to these paths,
// the corresponding test below will fail as an intentional trip-wire.
// ===========================================================================

describe('operational paths — no auditInTx', () => {
  it('emitWebhook (delivery enqueue) does NOT call auditInTx', async () => {
    // emitWebhook calls findEndpointsForEvent → for each matching endpoint
    // calls emitWebhookToEndpoint → insertWebhookDelivery. None of this
    // should touch auditInTx.
    await emitWebhook({
      tenantId: TENANT,
      event: 'attempt.graded',
      payload: { attempt_id: 'att_1' },
    });

    expect(mockAuditInTx).not.toHaveBeenCalled();
  });

  it('notifyInApp (system-triggered in-app notification) does NOT call auditInTx', async () => {
    await notifyInApp({
      tenantId: TENANT,
      audience: 'role',
      role: 'admin',
      kind: 'grading.complete',
      message: 'An attempt has been graded and is ready for review.',
    });

    expect(mockAuditInTx).not.toHaveBeenCalled();
  });

  it('processEmailSendJob (BullMQ email worker) does NOT call auditInTx', async () => {
    const jobData: EmailSendJobData = {
      emailLogId: 'ffffffff-0006-7000-8000-000000000006',
      tenantId: TENANT,
      to: 'candidate@example.com',
      subject: 'Your assessment invitation',
      bodyHtml: '<p>Hello</p>',
      bodyText: 'Hello',
      templateId: 'invitation_candidate',
    };

    await processEmailSendJob(jobData);

    expect(mockAuditInTx).not.toHaveBeenCalled();
  });
});
