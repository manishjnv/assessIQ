/* eslint-disable @typescript-eslint/no-explicit-any */
// AssessIQ — modules/18-certification/src/__tests__/share-linkedin.test.ts
//
// Phase 5 Session 6 — unit tests for incrementShareCount
// (POST /api/certificates/:credentialId/share-linkedin).
//
// Strategy: mock withTenant + repo.findByCredentialId + repo.incrementCounter
// to exercise the service logic in isolation.
//
// Test-to-HTTP mapping:
//   1. owner resolves void                      → route sends 204
//   2. wrong owner → CertificateAccessDeniedError  → route sends 403
//   3. revoked cert → CertificateRevokedException  → route sends 410
//   4. not found → CertificateNotFoundError         → route sends 404
//   5. invalid format → CredentialIdSchema.safeParse fails → route sends 422

import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CERT_SIGNING_SECRET_ENV } from '../crypto.js';

// ---------------------------------------------------------------------------
// Module mocks — declared before SUT import.
// ---------------------------------------------------------------------------

vi.mock('@assessiq/audit-log', () => ({ auditInTx: vi.fn() }));

vi.mock('@assessiq/tenancy', () => ({
  withTenant: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock('../repository.js', async () => {
  const actual = await vi.importActual<typeof import('../repository.js')>('../repository.js');
  return {
    ...actual,
    findByCredentialId: vi.fn(),
    incrementCounter: vi.fn(),
  };
});

import { withTenant } from '@assessiq/tenancy';
import * as repo from '../repository.js';
import { incrementShareCount } from '../service.js';
import {
  CertificateAccessDeniedError,
  CertificateNotFoundError,
  CertificateRevokedException,
  CredentialIdSchema,
} from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const CANDIDATE = 'bbbbbbbb-0000-0000-0000-000000000002';
const OTHER_USER = 'ffffffff-0000-0000-0000-000000000006';
const SECRET = 'test-hmac-secret-share-linkedin';
const CRED_ID = 'AIQ-2026-05-ABCDEF';

function fakeCert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cccccccc-0000-0000-0000-000000000003',
    tenant_id: TENANT,
    attempt_id: 'dddddddd-0000-0000-0000-000000000004',
    candidate_id: CANDIDATE,
    template_key: 'aiq-standard',
    credential_id: CRED_ID,
    tier: 'completion' as const,
    display_name: 'Test Candidate',
    course_title: 'Security Ops L1',
    level: 'L1',
    signed_hash: 'fakehash' + '0'.repeat(56),
    issued_at: '2026-05-01T10:00:00Z',
    revoked_at: null as string | null,
    revoke_reason: null as string | null,
    pdf_downloads: 0,
    linkedin_shares: 0,
    verification_views: 0,
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-01T10:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env[CERT_SIGNING_SECRET_ENV] = SECRET;
});
afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('incrementShareCount', () => {
  it('owner calls their cert — resolves void and calls incrementCounter with linkedin_shares (→ 204)', async () => {
    const cert = fakeCert();
    vi.mocked(repo.findByCredentialId).mockResolvedValue(cert as any);
    vi.mocked(repo.incrementCounter).mockResolvedValue(undefined);
    const mockClient = { query: vi.fn() };
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn(mockClient as any));

    await expect(incrementShareCount(TENANT, CRED_ID, CANDIDATE)).resolves.toBeUndefined();

    expect(repo.findByCredentialId).toHaveBeenCalledWith(mockClient, CRED_ID, TENANT);
    expect(repo.incrementCounter).toHaveBeenCalledWith(mockClient, cert.id, 'linkedin_shares');
  });

  it('wrong owner — throws CertificateAccessDeniedError without touching the counter (→ 403)', async () => {
    const cert = fakeCert(); // cert.candidate_id = CANDIDATE, caller is OTHER_USER
    vi.mocked(repo.findByCredentialId).mockResolvedValue(cert as any);
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn({} as any));

    await expect(
      incrementShareCount(TENANT, CRED_ID, OTHER_USER),
    ).rejects.toBeInstanceOf(CertificateAccessDeniedError);

    expect(repo.incrementCounter).not.toHaveBeenCalled();
  });

  it('revoked cert — throws CertificateRevokedException without touching the counter (→ 410)', async () => {
    const cert = fakeCert({ revoked_at: '2026-05-10T12:00:00Z', revoke_reason: 'Compromised' });
    vi.mocked(repo.findByCredentialId).mockResolvedValue(cert as any);
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn({} as any));

    await expect(
      incrementShareCount(TENANT, CRED_ID, CANDIDATE),
    ).rejects.toBeInstanceOf(CertificateRevokedException);

    expect(repo.incrementCounter).not.toHaveBeenCalled();
  });

  it('non-existent credential_id — throws CertificateNotFoundError (→ 404)', async () => {
    vi.mocked(repo.findByCredentialId).mockResolvedValue(null);
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn({} as any));

    await expect(
      incrementShareCount(TENANT, 'AIQ-2026-05-XXXXXX', CANDIDATE),
    ).rejects.toBeInstanceOf(CertificateNotFoundError);

    expect(repo.incrementCounter).not.toHaveBeenCalled();
  });

  it('invalid credential_id format — CredentialIdSchema rejects it (→ 422 at route layer)', () => {
    // This validation fires in the route handler before incrementShareCount is called.
    // Confirm the schema correctly rejects a malformed ID.
    const bad = CredentialIdSchema.safeParse('bad');
    expect(bad.success).toBe(false);

    // Well-formed IDs still pass so the schema is not over-restrictive.
    const good = CredentialIdSchema.safeParse('AIQ-2026-05-ABCDEF');
    expect(good.success).toBe(true);
  });
});
