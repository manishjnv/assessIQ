/* eslint-disable @typescript-eslint/no-explicit-any */
// AssessIQ — modules/18-certification/src/__tests__/admin-revoke-integration.test.ts
//
// PII rule test for revoke().
//
// All existing tests in this module use the unit-mock pattern (no testcontainer)
// so this test follows the same approach. The PII rule is enforced in the service
// layer (not a DB constraint), so a unit test with mocks is the correct vehicle.
//
// Rule:
//   • revoke_reason IS persisted — passed through to repo.revokeCertificate
//     so the DB row carries the reason for display on the verify page.
//   • revoke_reason MUST NOT appear in audit_log.after — it may contain PII
//     (e.g. "candidate is under investigation", "issued to wrong person — Jane Doe").
//     Only revoked_at is audited in the after column.

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACTOR = 'eeeeeeee-0000-0000-0000-000000000005';
const CRED_ID = 'AIQ-2026-05-PIIRUL';
const REVOKED_AT = '2026-05-14T10:00:00Z';

// A reason string that could plausibly contain PII — used to confirm it never
// leaks into the audit_log.after column.
const REVOKE_REASON = 'Issued to wrong candidate — Jane Doe should not have this cert';

function fakeCert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cccccccc-0000-0000-0000-000000000003',
    tenant_id: TENANT,
    attempt_id: 'dddddddd-0000-0000-0000-000000000004',
    candidate_id: 'bbbbbbbb-0000-0000-0000-000000000002',
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
  process.env[CERT_SIGNING_SECRET_ENV] = 'test-hmac-secret-pii-rule';
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// PII rule
// ---------------------------------------------------------------------------

describe('revoke — PII rule', () => {
  it('PII rule: revoke_reason in cert row but NOT in audit_log.after', async () => {
    const cert = fakeCert();
    const revokedCert = {
      ...cert,
      revoked_at: REVOKED_AT,
      revoke_reason: REVOKE_REASON,
    };

    vi.mocked(repo.findByCredentialId).mockResolvedValue(cert);
    vi.mocked(repo.revokeCertificate).mockResolvedValue(revokedCert);
    vi.mocked(auditInTx as any).mockResolvedValue(undefined);

    const mockClient = { query: vi.fn() };
    vi.mocked(withTenant).mockImplementation(async (_t, fn) => fn(mockClient as any));

    const result = await revoke(TENANT, CRED_ID, REVOKE_REASON, ACTOR);

    // 1. repo.revokeCertificate received the reason string — it IS persisted.
    expect(repo.revokeCertificate).toHaveBeenCalledWith(
      mockClient,
      cert.id,
      TENANT,
      REVOKE_REASON,
    );

    // 2. The returned certificate row carries revoke_reason (DB column is populated).
    expect(result.revoke_reason).toBe(REVOKE_REASON);

    // 3. auditInTx was called exactly once.
    expect(auditInTx).toHaveBeenCalledTimes(1);

    const auditArg = vi.mocked(auditInTx).mock.calls[0]?.[1];

    // 4. PII rule: revoke_reason MUST NOT appear in audit_log.after.
    expect(auditArg?.after).not.toHaveProperty('revoke_reason');

    // 5. audit_log.after DOES record revoked_at (the only audited after-field).
    expect(auditArg?.after).toHaveProperty('revoked_at', REVOKED_AT);
  });
});
