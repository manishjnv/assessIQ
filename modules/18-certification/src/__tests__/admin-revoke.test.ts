// AssessIQ — modules/18-certification/src/__tests__/admin-revoke.test.ts
//
// Phase 5 Session 5 — unit tests for revoke (POST /api/admin/certificates/:credentialId/revoke).
//
// Happy path, 404 not-found, 409 already-revoked, and audit atomicity.

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
    revokeCertificate: vi.fn(),
  };
});

import { auditInTx } from '@assessiq/audit-log';
import { withTenant } from '@assessiq/tenancy';
import * as repo from '../repository.js';
import { revoke } from '../service.js';
import { CertificateAlreadyRevokedError, CertificateNotFoundError } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const CANDIDATE = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACTOR = 'eeeeeeee-0000-0000-0000-000000000005';
const SECRET = 'test-hmac-secret-revoke';
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

describe('revoke', () => {
  it('happy path: persists revoked_at and emits certificates.revoked audit row', async () => {
    const cert = fakeCert();
    const revokedCert = { ...cert, revoked_at: '2026-05-12T00:00:00Z', revoke_reason: 'Compromised' };
    vi.mocked(repo.findByCredentialId).mockResolvedValue(cert);
    vi.mocked(repo.revokeCertificate).mockResolvedValue(revokedCert);
    vi.mocked(auditInTx as any).mockResolvedValue(undefined);
    const mockClient = { query: vi.fn() };
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn(mockClient as any));

    const result = await revoke(TENANT, CRED_ID, 'Compromised', ACTOR);

    // repo.revokeCertificate called with correct args.
    expect(repo.revokeCertificate).toHaveBeenCalledWith(mockClient, cert.id, TENANT, 'Compromised');

    // Audit row emitted with correct action and actor.
    expect(auditInTx).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({
        action: 'certificates.revoked',
        actorKind: 'user',
        actorUserId: ACTOR,
        entityType: 'certificate',
        entityId: cert.id,
      }),
    );

    // Before/after captured correctly.
    const auditCall = vi.mocked(auditInTx).mock.calls[0]?.[1];
    expect(auditCall?.before).toEqual({ revoked_at: null });
    expect(auditCall?.after).not.toHaveProperty('revoke_reason');
    expect(auditCall?.after).toMatchObject({ revoked_at: '2026-05-12T00:00:00Z' });

    // Return value is the updated row.
    expect(result.revoked_at).toBe('2026-05-12T00:00:00Z');
    expect(result.revoke_reason).toBe('Compromised');
  });

  it('throws CertificateNotFoundError when credential_id not found', async () => {
    vi.mocked(repo.findByCredentialId).mockResolvedValue(null);
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn({} as any));

    await expect(revoke(TENANT, 'AIQ-2026-05-XXXXXX', 'reason', ACTOR))
      .rejects.toBeInstanceOf(CertificateNotFoundError);

    expect(repo.revokeCertificate).not.toHaveBeenCalled();
    expect(auditInTx).not.toHaveBeenCalled();
  });

  it('throws CertificateAlreadyRevokedError when revoked_at is already set', async () => {
    const cert = fakeCert({ revoked_at: '2026-05-11T00:00:00Z', revoke_reason: 'Old reason' });
    vi.mocked(repo.findByCredentialId).mockResolvedValue(cert);
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn({} as any));

    await expect(revoke(TENANT, CRED_ID, 'New reason', ACTOR))
      .rejects.toBeInstanceOf(CertificateAlreadyRevokedError);

    // No mutation or audit when already revoked.
    expect(repo.revokeCertificate).not.toHaveBeenCalled();
    expect(auditInTx).not.toHaveBeenCalled();
  });

  it('normalises credential_id to uppercase before repo lookup', async () => {
    vi.mocked(repo.findByCredentialId).mockResolvedValue(null);
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn({} as any));

    await revoke(TENANT, 'aiq-2026-05-abcdef', 'reason', ACTOR).catch(() => {});

    expect(repo.findByCredentialId).toHaveBeenCalledWith(
      expect.anything(),
      'AIQ-2026-05-ABCDEF',
      TENANT,
    );
  });

  it('propagates audit failure so the outer transaction rolls back', async () => {
    const cert = fakeCert();
    const revokedCert = { ...cert, revoked_at: '2026-05-12T00:00:00Z', revoke_reason: 'Test' };
    vi.mocked(repo.findByCredentialId).mockResolvedValue(cert);
    vi.mocked(repo.revokeCertificate).mockResolvedValue(revokedCert);
    vi.mocked(auditInTx as any).mockRejectedValue(new Error('audit_log INSERT failed'));
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn({} as any));

    await expect(revoke(TENANT, CRED_ID, 'Test', ACTOR))
      .rejects.toThrow(/audit_log INSERT failed/);

    expect(repo.revokeCertificate).toHaveBeenCalledTimes(1);
    expect(auditInTx).toHaveBeenCalledTimes(1);
  });
});
