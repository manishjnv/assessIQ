// AssessIQ — modules/18-certification/src/__tests__/list-mine.test.ts
//
// Phase 5 Session 5 — unit tests for listForUser (GET /api/certificates).
//
// Strategy: mock withTenant + repo.listCertificates; compute real HMAC hashes
// via signCertificate so the signed_hash_valid assertions exercise the actual
// verifyCertificateSignature call path.

import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CERT_SIGNING_SECRET_ENV, signCertificate } from '../crypto.js';

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
    listCertificates: vi.fn(),
    findByCredentialId: vi.fn(),
  };
});

import { withTenant } from '@assessiq/tenancy';
import * as repo from '../repository.js';
import { listForUser } from '../service.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const CANDIDATE = 'bbbbbbbb-0000-0000-0000-000000000002';
const SECRET = 'test-hmac-secret-for-list-mine';

function fakeCert(overrides: Partial<Record<string, unknown>> = {}) {
  const base: Record<string, unknown> = {
    id: 'cccccccc-0000-0000-0000-000000000003',
    tenant_id: TENANT,
    attempt_id: 'dddddddd-0000-0000-0000-000000000004',
    candidate_id: CANDIDATE,
    template_key: 'aiq-standard',
    credential_id: 'AIQ-2026-05-ABCDEF',
    tier: 'completion' as const,
    display_name: 'Test Candidate',
    course_title: 'Security Ops L1',
    level: 'L1',
    signed_hash: '',
    issued_at: '2026-05-01T10:00:00Z',
    revoked_at: null,
    revoke_reason: null,
    pdf_downloads: 0,
    linkedin_shares: 0,
    verification_views: 0,
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-01T10:00:00Z',
    ...overrides,
  };
  // Compute a real signed_hash unless the caller explicitly set one.
  if (!overrides['signed_hash']) {
    base['signed_hash'] = signCertificate(
      {
        id: base['id'] as string,
        tenant_id: base['tenant_id'] as string,
        candidate_id: base['candidate_id'] as string,
        attempt_id: base['attempt_id'] as string,
        template_key: base['template_key'] as string,
        credential_id: base['credential_id'] as string,
        tier: base['tier'] as 'completion' | 'distinction' | 'honors',
        display_name: base['display_name'] as string,
        course_title: base['course_title'] as string,
        level: base['level'] as string,
        issued_at: base['issued_at'] as string,
      },
      SECRET,
    );
  }
  return base;
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

describe('listForUser', () => {
  it("returns the candidate's own certs with signed_hash_valid=true for valid hashes", async () => {
    const cert = fakeCert();
    vi.mocked(repo.listCertificates).mockResolvedValue({ items: [cert as any], total: 1 });
    const mockClient = { query: vi.fn() };
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn(mockClient as any));

    const result = await listForUser(TENANT, CANDIDATE);

    expect(repo.listCertificates).toHaveBeenCalledWith(
      mockClient,
      TENANT,
      expect.objectContaining({ candidate_id: CANDIDATE }),
    );
    expect(result.certificates).toHaveLength(1);
    expect(result.certificates[0]!.signed_hash_valid).toBe(true);
    expect(result.certificates[0]!.verify_url).toContain(cert['credential_id']);
    expect(result.certificates[0]!.pdf_url).toContain(cert['credential_id']);
  });

  it('marks a tampered cert as signed_hash_valid=false', async () => {
    const cert = fakeCert({ signed_hash: 'deadbeef' + '0'.repeat(56) });
    vi.mocked(repo.listCertificates).mockResolvedValue({ items: [cert as any], total: 1 });
    const mockClient = { query: vi.fn() };
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn(mockClient as any));

    const result = await listForUser(TENANT, CANDIDATE);
    expect(result.certificates[0]!.signed_hash_valid).toBe(false);
  });

  it('returns revoked cert with revoked_at and revoke_reason set', async () => {
    const cert = fakeCert({ revoked_at: '2026-05-10T12:00:00Z', revoke_reason: 'Test revoke' });
    vi.mocked(repo.listCertificates).mockResolvedValue({ items: [cert as any], total: 1 });
    const mockClient = { query: vi.fn() };
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn(mockClient as any));

    const result = await listForUser(TENANT, CANDIDATE);
    expect(result.certificates[0]!.revoked_at).toBe('2026-05-10T12:00:00Z');
    expect(result.certificates[0]!.revoke_reason).toBe('Test revoke');
  });

  it('returns empty list when candidate has no certs', async () => {
    vi.mocked(repo.listCertificates).mockResolvedValue({ items: [], total: 0 });
    const mockClient = { query: vi.fn() };
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn(mockClient as any));

    const result = await listForUser(TENANT, CANDIDATE);
    expect(result.certificates).toHaveLength(0);
  });

  it('constructs verify_url and pdf_url from credential_id', async () => {
    const cert = fakeCert({ credential_id: 'AIQ-2026-05-XYZABC' });
    vi.mocked(repo.listCertificates).mockResolvedValue({ items: [cert as any], total: 1 });
    const mockClient = { query: vi.fn() };
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn(mockClient as any));

    const result = await listForUser(TENANT, CANDIDATE);
    expect(result.certificates[0]!.verify_url).toContain('AIQ-2026-05-XYZABC');
    expect(result.certificates[0]!.pdf_url).toBe('/api/certificates/AIQ-2026-05-XYZABC/pdf');
  });
});
