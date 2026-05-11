// AssessIQ — modules/18-certification/src/__tests__/service.test.ts
//
// Phase 5 Session 2 — service-level tests for issueCertificate.
//
// Strategy: mock the repository module + auditInTx so we exercise the
// service's idempotence + upgrade + collision-retry + atomicity logic
// without spinning up a Postgres testcontainer. Schema-level invariants
// (UNIQUE constraints, RLS) are covered by the migration; service-level
// invariants are covered here.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { PoolClient } from 'pg';

import { CERT_SIGNING_SECRET_ENV } from '../crypto.js';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before the SUT import.
// ---------------------------------------------------------------------------

vi.mock('@assessiq/audit-log', () => ({
  auditInTx: vi.fn(),
}));

vi.mock('../repository.js', async () => {
  // Preserve CredentialIdCollisionError as a real class so `instanceof` works
  // in the service. Other exports become vi.fn() mocks.
  const actual = await vi.importActual<typeof import('../repository.js')>(
    '../repository.js',
  );
  return {
    ...actual,
    findByAttempt: vi.fn(),
    findByCredentialId: vi.fn(),
    listCertificates: vi.fn(),
    insertCertificate: vi.fn(),
    upgradeCertificateTier: vi.fn(),
    revokeCertificate: vi.fn(),
    incrementCounter: vi.fn(),
    CredentialIdCollisionError: actual.CredentialIdCollisionError,
  };
});

// SUT + mocked deps (imported AFTER vi.mock calls so the mocks are wired).
import { auditInTx } from '@assessiq/audit-log';
import * as repo from '../repository.js';
import {
  MAX_CREDENTIAL_ID_RETRIES,
  issueCertificate,
} from '../service.js';
import { CREDENTIAL_ID_REGEX } from '../types.js';
import type { Certificate, IssueCertificateInput, Tier } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const CANDIDATE_ID = '33333333-3333-3333-3333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-4444-444444444444';
const ACTOR_ID = '55555555-5555-5555-5555-555555555555';

function makeInput(tier: Tier = 'completion'): IssueCertificateInput {
  return {
    tenant_id: TENANT_ID,
    attempt_id: ATTEMPT_ID,
    candidate_id: CANDIDATE_ID,
    template_key: 'soc-l1-completion',
    display_name: 'Jane Doe',
    course_title: 'SOC Analyst L1',
    level: 'L1',
    tier,
    actor_user_id: ACTOR_ID,
  };
}

function makeExistingCert(overrides: Partial<Certificate> = {}): Certificate {
  return {
    id: '66666666-6666-6666-6666-666666666666',
    tenant_id: TENANT_ID,
    attempt_id: ATTEMPT_ID,
    candidate_id: CANDIDATE_ID,
    template_key: 'soc-l1-completion',
    credential_id: 'AIQ-2026-05-EXIST0',
    tier: 'completion',
    display_name: 'Jane Doe',
    course_title: 'SOC Analyst L1',
    level: 'L1',
    signed_hash: 'deadbeef'.repeat(8),
    issued_at: '2026-05-10T10:00:00Z',
    revoked_at: null,
    revoke_reason: null,
    pdf_downloads: 0,
    linkedin_shares: 0,
    verification_views: 0,
    created_at: '2026-05-10T10:00:00Z',
    updated_at: '2026-05-10T10:00:00Z',
    ...overrides,
  };
}

// Minimal stub — service only calls repo methods which are mocked.
const fakeClient = {} as unknown as PoolClient;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env[CERT_SIGNING_SECRET_ENV] = 'service-test-secret';
});

beforeEach(() => {
  vi.mocked(repo.findByAttempt).mockReset();
  vi.mocked(repo.insertCertificate).mockReset();
  vi.mocked(repo.upgradeCertificateTier).mockReset();
  vi.mocked(auditInTx).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path: first-time issuance
// ---------------------------------------------------------------------------

describe('issueCertificate — happy path issue', () => {
  it('inserts a new certificate and emits one certification.cert.issue audit', async () => {
    vi.mocked(repo.findByAttempt).mockResolvedValue(null);
    // Echo back the input as a Certificate-shaped row.
    vi.mocked(repo.insertCertificate).mockImplementation(
      async (_c, input) =>
        makeExistingCert({
          id: input.id,
          credential_id: input.credential_id,
          signed_hash: input.signed_hash,
          issued_at: input.issued_at,
          tier: input.tier,
        }),
    );
    vi.mocked(auditInTx).mockResolvedValue({
      id: 'audit-1',
    } as Awaited<ReturnType<typeof auditInTx>>);

    const result = await issueCertificate(fakeClient, makeInput('completion'));

    // Shape checks.
    expect(result.credential_id).toMatch(CREDENTIAL_ID_REGEX);
    expect(result.signed_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tier).toBe('completion');

    // Insert was called exactly once.
    expect(repo.insertCertificate).toHaveBeenCalledTimes(1);
    expect(repo.upgradeCertificateTier).not.toHaveBeenCalled();

    // Exactly one audit, action + metadata as expected.
    expect(auditInTx).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(auditInTx).mock.calls[0]?.[1];
    expect(auditCall?.action).toBe('certification.cert.issue');
    expect(auditCall?.entityType).toBe('certificate');
    expect(auditCall?.entityId).toBe(result.id);
    expect(auditCall?.actorKind).toBe('user');
    expect(auditCall?.actorUserId).toBe(ACTOR_ID);
    expect(auditCall?.after).toEqual({
      credential_id: result.credential_id,
      tier: 'completion',
      candidate_id: CANDIDATE_ID,
      attempt_id: ATTEMPT_ID,
    });
    // Audit metadata MUST NOT include snapshot fields or signed_hash.
    expect(auditCall?.after).not.toHaveProperty('display_name');
    expect(auditCall?.after).not.toHaveProperty('signed_hash');
  });
});

// ---------------------------------------------------------------------------
// Idempotence: same-tier re-issue
// ---------------------------------------------------------------------------

describe('issueCertificate — idempotent same-tier', () => {
  it('returns the existing row without inserting or auditing', async () => {
    const existing = makeExistingCert({ tier: 'completion' });
    vi.mocked(repo.findByAttempt).mockResolvedValue(existing);

    const result = await issueCertificate(fakeClient, makeInput('completion'));

    expect(result).toBe(existing);
    expect(repo.insertCertificate).not.toHaveBeenCalled();
    expect(repo.upgradeCertificateTier).not.toHaveBeenCalled();
    expect(auditInTx).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tier upgrade
// ---------------------------------------------------------------------------

describe('issueCertificate — tier upgrade', () => {
  it('upgrades tier, preserves issued_at + credential_id, emits upgrade audit', async () => {
    const existing = makeExistingCert({
      tier: 'completion',
      issued_at: '2026-04-01T09:00:00Z',
      credential_id: 'AIQ-2026-04-OLDONE',
    });
    vi.mocked(repo.findByAttempt).mockResolvedValue(existing);
    vi.mocked(repo.upgradeCertificateTier).mockImplementation(
      async (_c, _id, _t, newTier, newHash) =>
        makeExistingCert({
          ...existing,
          tier: newTier as Tier,
          signed_hash: newHash,
        }),
    );
    vi.mocked(auditInTx).mockResolvedValue({
      id: 'audit-up',
    } as Awaited<ReturnType<typeof auditInTx>>);

    const result = await issueCertificate(fakeClient, makeInput('distinction'));

    expect(result.tier).toBe('distinction');
    // Invariant: tier upgrade preserves identity fields.
    expect(result.credential_id).toBe(existing.credential_id);
    expect(result.issued_at).toBe(existing.issued_at);

    expect(repo.upgradeCertificateTier).toHaveBeenCalledTimes(1);
    expect(repo.insertCertificate).not.toHaveBeenCalled();

    expect(auditInTx).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(auditInTx).mock.calls[0]?.[1];
    expect(auditCall?.action).toBe('certification.cert.upgrade');
    expect(auditCall?.before).toEqual({ tier: 'completion' });
    expect(auditCall?.after).toEqual({
      credential_id: existing.credential_id,
      tier: 'distinction',
      candidate_id: CANDIDATE_ID,
      attempt_id: ATTEMPT_ID,
    });
  });
});

// ---------------------------------------------------------------------------
// Tier downgrade (no-op)
// ---------------------------------------------------------------------------

describe('issueCertificate — downgrade is a no-op', () => {
  it('returns existing row unchanged when incoming tier is lower', async () => {
    const existing = makeExistingCert({ tier: 'distinction' });
    vi.mocked(repo.findByAttempt).mockResolvedValue(existing);

    const result = await issueCertificate(fakeClient, makeInput('completion'));

    expect(result).toBe(existing);
    expect(repo.insertCertificate).not.toHaveBeenCalled();
    expect(repo.upgradeCertificateTier).not.toHaveBeenCalled();
    expect(auditInTx).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Credential ID collision retry
// ---------------------------------------------------------------------------

describe('issueCertificate — credential_id collision retry', () => {
  it('retries on CredentialIdCollisionError twice then succeeds (3 distinct IDs)', async () => {
    vi.mocked(repo.findByAttempt).mockResolvedValue(null);

    const attemptedIds: string[] = [];
    vi.mocked(repo.insertCertificate)
      .mockImplementationOnce(async (_c, input) => {
        attemptedIds.push(input.credential_id);
        throw new repo.CredentialIdCollisionError(input.credential_id);
      })
      .mockImplementationOnce(async (_c, input) => {
        attemptedIds.push(input.credential_id);
        throw new repo.CredentialIdCollisionError(input.credential_id);
      })
      .mockImplementationOnce(async (_c, input) => {
        attemptedIds.push(input.credential_id);
        return makeExistingCert({
          id: input.id,
          credential_id: input.credential_id,
          tier: input.tier,
        });
      });
    vi.mocked(auditInTx).mockResolvedValue({
      id: 'audit-retry',
    } as Awaited<ReturnType<typeof auditInTx>>);

    const result = await issueCertificate(fakeClient, makeInput('completion'));

    expect(repo.insertCertificate).toHaveBeenCalledTimes(3);
    expect(attemptedIds).toHaveLength(3);
    // Each generated credential_id is distinct (CSPRNG draw per attempt).
    expect(new Set(attemptedIds).size).toBe(3);
    // The 3rd (successful) ID is the one that ended up on the returned row.
    expect(result.credential_id).toBe(attemptedIds[2]);
    // Audit fires once, only after the successful insert.
    expect(auditInTx).toHaveBeenCalledTimes(1);
  });

  it('throws after MAX_CREDENTIAL_ID_RETRIES collisions in a row', async () => {
    vi.mocked(repo.findByAttempt).mockResolvedValue(null);
    vi.mocked(repo.insertCertificate).mockImplementation(async (_c, input) => {
      throw new repo.CredentialIdCollisionError(input.credential_id);
    });

    await expect(
      issueCertificate(fakeClient, makeInput('completion')),
    ).rejects.toThrow(/collision exhausted/i);

    expect(repo.insertCertificate).toHaveBeenCalledTimes(MAX_CREDENTIAL_ID_RETRIES);
    // No audit row should be written for a never-inserted cert.
    expect(auditInTx).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Atomicity — auditInTx failure must surface (caller's withTenant rolls back)
// ---------------------------------------------------------------------------

describe('issueCertificate — atomicity', () => {
  it('propagates an audit-write failure so the outer transaction rolls back', async () => {
    vi.mocked(repo.findByAttempt).mockResolvedValue(null);
    vi.mocked(repo.insertCertificate).mockImplementation(
      async (_c, input) =>
        makeExistingCert({
          id: input.id,
          credential_id: input.credential_id,
          tier: input.tier,
        }),
    );
    vi.mocked(auditInTx).mockRejectedValue(new Error('audit_log INSERT failed'));

    await expect(
      issueCertificate(fakeClient, makeInput('completion')),
    ).rejects.toThrow(/audit_log INSERT failed/);

    // Insert ran exactly once; audit ran exactly once (and threw).
    // The caller's withTenant() ROLLBACKs the INSERT — we cannot observe the
    // ROLLBACK here (it's the caller's contract). What we CAN verify is that
    // the service did not swallow the error: the rejection above is the
    // proof that the cert insert is *not* claimed as successful when audit
    // failed.
    expect(repo.insertCertificate).toHaveBeenCalledTimes(1);
    expect(auditInTx).toHaveBeenCalledTimes(1);
  });

  it('propagates an audit-write failure on tier upgrade', async () => {
    const existing = makeExistingCert({ tier: 'completion' });
    vi.mocked(repo.findByAttempt).mockResolvedValue(existing);
    vi.mocked(repo.upgradeCertificateTier).mockResolvedValue(
      makeExistingCert({ ...existing, tier: 'distinction' }),
    );
    vi.mocked(auditInTx).mockRejectedValue(new Error('audit_log INSERT failed'));

    await expect(
      issueCertificate(fakeClient, makeInput('distinction')),
    ).rejects.toThrow(/audit_log INSERT failed/);

    expect(repo.upgradeCertificateTier).toHaveBeenCalledTimes(1);
    expect(auditInTx).toHaveBeenCalledTimes(1);
  });
});
