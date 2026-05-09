/**
 * Unit test: inviteUsers passes tenantId through to the email-send call.
 *
 * Mocks all external dependencies so this suite runs without a Postgres
 * testcontainer or Redis. The key assertion is that the `sendInvitationEmail`
 * shim in ./email.js is called with `tenantId` present in its input, which
 * ensures the email_log INSERT is not skipped by sendEmail's tenantId guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock external packages before importing the service
// ---------------------------------------------------------------------------

vi.mock('@assessiq/core', () => ({
  streamLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  config: {
    ASSESSIQ_BASE_URL: 'https://assessiq.test',
    NODE_ENV: 'test',
  },
  uuidv7: () => `test-uuid-${Math.random().toString(36).slice(2)}`,
  NotFoundError: class NotFoundError extends Error {
    details: unknown;
    constructor(msg: string, opts?: { details: unknown }) { super(msg); this.details = opts?.details; }
  },
  ConflictError: class ConflictError extends Error {
    details: unknown;
    constructor(msg: string, opts?: { details: unknown }) { super(msg); this.details = opts?.details; }
  },
  ValidationError: class ValidationError extends Error {
    details: unknown;
    constructor(msg: string, opts?: { details: unknown }) { super(msg); this.details = opts?.details; }
  },
}));

// withTenant passes through to the callback with a mock client
vi.mock('@assessiq/tenancy', () => ({
  withTenant: async (
    _tenantId: string,
    fn: (client: unknown) => Promise<unknown>,
  ) => fn({ query: vi.fn() }),
  getPool: () => ({ connect: vi.fn() }),
}));

// tenancyRepo.findTenantById → returns a tenant row so tenantName resolves
vi.mock('../../../02-tenancy/src/repository.js', () => ({
  findTenantById: vi.fn().mockResolvedValue({ name: 'Acme Corp', slug: 'acme', id: 'tenant-1' }),
}));

// qbRepo mocks
vi.mock('../../../04-question-bank/src/repository.js', () => ({
  findPackById: vi.fn().mockResolvedValue({ id: 'pack-1', status: 'published', version: 1 }),
  findLevelById: vi.fn().mockResolvedValue({ id: 'level-1', pack_id: 'pack-1', duration_minutes: 30 }),
}));

// repo mocks — assessment + user + invitation queries
vi.mock('../repository.js', () => ({
  findAssessmentById: vi.fn().mockResolvedValue({
    id: 'assessment-1',
    name: 'SOC L1 May',
    status: 'published',
    pack_id: 'pack-1',
    level_id: 'level-1',
    question_count: 5,
  }),
  findUserForInvitation: vi.fn().mockResolvedValue({
    id: 'user-1',
    email: 'candidate@example.com',
    name: 'Jane Candidate',
    role: 'candidate',
    status: 'active',
  }),
  findInvitationByAssessmentAndUser: vi.fn().mockResolvedValue(null),
  insertInvitation: vi.fn().mockImplementation((_client: unknown, input: { id?: string; expiresAt: Date }) => ({
    id: input.id ?? 'inv-1',
    assessment_id: 'assessment-1',
    user_id: 'user-1',
    token_hash: 'hash123',
    expires_at: input.expiresAt,
    status: 'pending',
    invited_by: 'admin-1',
    created_at: new Date(),
  })),
  countInvitationsByAssessment: vi.fn().mockResolvedValue({}),
}));

// tokens mock
vi.mock('../tokens.js', () => ({
  generateInvitationToken: () => ({ plaintext: 'tok_abc123', hash: 'sha256hash' }),
  hashInvitationToken: (p: string) => `sha256_${p}`,
  DEFAULT_INVITATION_TTL_HOURS: 168,
}));

// state-machine mock
vi.mock('../state-machine.js', () => ({
  assertCanTransition: vi.fn(),
  assertValidWindow: vi.fn(),
  assertReopenAllowed: vi.fn(),
  canTransition: vi.fn().mockReturnValue(true),
  nextStateOnTimeBoundary: vi.fn(),
  ASSESSMENT_STATUSES: ['draft', 'published', 'active', 'closed', 'cancelled'],
}));

// ---------------------------------------------------------------------------
// Key mock: capture calls to the local email shim.
// Uses vi.hoisted so the variable is accessible inside the hoisted vi.mock factory.
// ---------------------------------------------------------------------------

const { mockSendInvitationEmail } = vi.hoisted(() => ({
  mockSendInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../email.js', () => ({
  sendInvitationEmail: mockSendInvitationEmail,
}));

// ---------------------------------------------------------------------------
// Import service under test AFTER mocks
// ---------------------------------------------------------------------------

import { inviteUsers } from '../service.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('inviteUsers — tenantId pass-through to email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendInvitationEmail.mockResolvedValue(undefined);
  });

  it('passes tenantId to sendInvitationEmail call args', async () => {
    const tenantId = 'tenant-1';
    const assessmentId = 'assessment-1';

    await inviteUsers(tenantId, assessmentId, ['user-1'], 'admin-1');

    expect(mockSendInvitationEmail).toHaveBeenCalledOnce();
    const callArgs = mockSendInvitationEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs).toMatchObject({
      tenantId: 'tenant-1',
      to: 'candidate@example.com',
      candidateName: 'Jane Candidate',
      assessmentName: 'SOC L1 May',
    });
  });

  it('tenantId in email args matches the tenantId passed to inviteUsers', async () => {
    const tenantId = 'tenant-xyz';

    // Override repo mocks to return an assessment with a different tenant
    const repoModule = await import('../repository.js');
    vi.mocked(repoModule.findAssessmentById).mockResolvedValueOnce({
      id: 'assessment-1',
      name: 'SOC L1 May',
      status: 'published',
      pack_id: 'pack-1',
      level_id: 'level-1',
      question_count: 5,
      tenant_id: tenantId,
      pack_version: 1,
      description: null,
      randomize: true,
      opens_at: null,
      closes_at: null,
      settings: {},
      created_by: 'admin-1',
      created_at: new Date(),
      updated_at: new Date(),
    });

    const tenancyModule = await import('../../../02-tenancy/src/repository.js');
    vi.mocked(tenancyModule.findTenantById).mockResolvedValueOnce({
      id: tenantId, name: 'XYZ Corp', slug: 'xyz',
    } as Awaited<ReturnType<typeof tenancyModule.findTenantById>>);

    await inviteUsers(tenantId, 'assessment-1', ['user-1'], 'admin-1');

    expect(mockSendInvitationEmail).toHaveBeenCalledOnce();
    const callArgs = mockSendInvitationEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs['tenantId']).toBe(tenantId);
  });
});
