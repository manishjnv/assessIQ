/* eslint-disable @typescript-eslint/no-explicit-any */
// AssessIQ — modules/18-certification/src/__tests__/admin-reissue.test.ts
//
// Phase 5 Session 5 — unit tests for reissue (POST /api/admin/certificates/:credentialId/reissue).
//
// Covers: happy path with name change, undefined display_name (preserve existing),
// 404 not-found, 410 revoked, and signature validity after reissue.

import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CERT_SIGNING_SECRET_ENV, signCertificate, verifyCertificateSignature } from '../crypto.js';

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
    reissueCertificate: vi.fn(),
  };
});

import { auditInTx } from '@assessiq/audit-log';
import { withTenant } from '@assessiq/tenancy';
import * as repo from '../repository.js';
import { reissue } from '../service.js';
import { CertificateNotFoundError, CertificateRevokedException } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const CANDIDATE = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACTOR = 'eeeeeeee-0000-0000-0000-000000000005';
const SECRET = 'test-hmac-secret-reissue';
const CRED_ID = 'AIQ-2026-05-REISSU';

function makeCert(displayName = 'Original Name') {
  const base = {
    id: 'cccccccc-0000-0000-0000-000000000003',
    tenant_id: TENANT,
    attempt_id: 'dddddddd-0000-0000-0000-000000000004',
    candidate_id: CANDIDATE,
    template_key: 'aiq-standard',
    credential_id: CRED_ID,
    tier: 'distinction' as const,
    display_name: displayName,
    course_title: 'Security Ops L2',
    level: 'L2',
    signed_hash: '',
    issued_at: '2026-05-01T10:00:00Z',
    revoked_at: null as string | null,
    revoke_reason: null as string | null,
    pdf_downloads: 2,
    linkedin_shares: 1,
    verification_views: 5,
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-01T10:00:00Z',
  };
  base.signed_hash = signCertificate(
    {
      id: base.id,
      tenant_id: base.tenant_id,
      candidate_id: base.candidate_id,
      attempt_id: base.attempt_id,
      template_key: base.template_key,
      credential_id: base.credential_id,
      tier: base.tier,
      display_name: base.display_name,
      course_title: base.course_title,
      level: base.level,
      issued_at: base.issued_at,
    },
    SECRET,
  );
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

describe('reissue', () => {
  it('happy path: preserves credential_id + issued_at, updates display_name + signed_hash, emits audit', async () => {
    const orig = makeCert('Original Name');
    const newDisplayName = 'Corrected Name';
    // Simulate what the repo will return after the UPDATE.
    const updatedCert = {
      ...orig,
      display_name: newDisplayName,
      signed_hash: signCertificate(
        {
          id: orig.id,
          tenant_id: orig.tenant_id,
          candidate_id: orig.candidate_id,
          attempt_id: orig.attempt_id,
          template_key: orig.template_key,
          credential_id: orig.credential_id,
          tier: orig.tier,
          display_name: newDisplayName,
          course_title: orig.course_title,
          level: orig.level,
          issued_at: orig.issued_at,
        },
        SECRET,
      ),
    };

    vi.mocked(repo.findByCredentialId).mockResolvedValue(orig);
    vi.mocked(repo.reissueCertificate).mockResolvedValue(updatedCert);
    vi.mocked(auditInTx as any).mockResolvedValue(undefined);
    const mockClient = { query: vi.fn() };
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn(mockClient as any));

    const result = await reissue(TENANT, CRED_ID, newDisplayName, ACTOR);

    // Stable identity fields are preserved.
    expect(result.credential_id).toBe(orig.credential_id);
    expect(result.issued_at).toBe(orig.issued_at);
    expect(result.display_name).toBe(newDisplayName);

    // New signed_hash validates against the updated display_name.
    const valid = verifyCertificateSignature(
      {
        id: result.id,
        tenant_id: result.tenant_id,
        candidate_id: result.candidate_id,
        attempt_id: result.attempt_id,
        template_key: result.template_key,
        credential_id: result.credential_id,
        tier: result.tier,
        display_name: result.display_name,
        course_title: result.course_title,
        level: result.level,
        issued_at: result.issued_at,
      },
      result.signed_hash,
      SECRET,
    );
    expect(valid).toBe(true);

    // Audit row emitted with correct action and before/after.
    expect(auditInTx).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({
        action: 'certificates.reissued',
        actorKind: 'user',
        actorUserId: ACTOR,
        entityType: 'certificate',
        entityId: orig.id,
      }),
    );
    const auditCall = vi.mocked(auditInTx).mock.calls[0]?.[1];
    expect(auditCall?.before).toEqual({ display_name: 'Original Name' });
    expect(auditCall?.after).toEqual({ display_name: 'Corrected Name' });
  });

  it('preserves display_name when undefined is passed (keeps existing name)', async () => {
    const orig = makeCert('Unchanged Name');
    vi.mocked(repo.findByCredentialId).mockResolvedValue(orig);
    vi.mocked(repo.reissueCertificate).mockResolvedValue({ ...orig });
    vi.mocked(auditInTx as any).mockResolvedValue(undefined);
    const mockClient = { query: vi.fn() };
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn(mockClient as any));

    await reissue(TENANT, CRED_ID, undefined, ACTOR);

    expect(repo.reissueCertificate).toHaveBeenCalledWith(
      mockClient,
      orig.id,
      TENANT,
      'Unchanged Name',
      expect.any(String),
    );
  });

  it('throws CertificateRevokedException (410) when cert is revoked', async () => {
    const orig = makeCert();
    orig.revoked_at = '2026-05-10T12:00:00Z';
    vi.mocked(repo.findByCredentialId).mockResolvedValue(orig);
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn({} as any));

    await expect(reissue(TENANT, CRED_ID, 'New Name', ACTOR))
      .rejects.toBeInstanceOf(CertificateRevokedException);

    expect(repo.reissueCertificate).not.toHaveBeenCalled();
    expect(auditInTx).not.toHaveBeenCalled();
  });

  it('throws CertificateNotFoundError (404) when credential_id not found', async () => {
    vi.mocked(repo.findByCredentialId).mockResolvedValue(null);
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn({} as any));

    await expect(reissue(TENANT, 'AIQ-2026-05-XXXXXX', 'Name', ACTOR))
      .rejects.toBeInstanceOf(CertificateNotFoundError);

    expect(repo.reissueCertificate).not.toHaveBeenCalled();
    expect(auditInTx).not.toHaveBeenCalled();
  });

  it('normalises credential_id to uppercase before repo lookup', async () => {
    vi.mocked(repo.findByCredentialId).mockResolvedValue(null);
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn({} as any));

    await reissue(TENANT, 'aiq-2026-05-reissu', 'Name', ACTOR).catch(() => {});

    expect(repo.findByCredentialId).toHaveBeenCalledWith(
      expect.anything(),
      'AIQ-2026-05-REISSU',
      TENANT,
    );
  });

  it('propagates audit failure so the outer transaction rolls back', async () => {
    const orig = makeCert('Name');
    const updated = { ...orig };
    vi.mocked(repo.findByCredentialId).mockResolvedValue(orig);
    vi.mocked(repo.reissueCertificate).mockResolvedValue(updated);
    vi.mocked(auditInTx as any).mockRejectedValue(new Error('audit_log INSERT failed'));
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn({} as any));

    await expect(reissue(TENANT, CRED_ID, 'Name', ACTOR))
      .rejects.toThrow(/audit_log INSERT failed/);

    expect(repo.reissueCertificate).toHaveBeenCalledTimes(1);
    expect(auditInTx).toHaveBeenCalledTimes(1);
  });
});
