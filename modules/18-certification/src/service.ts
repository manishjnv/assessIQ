// AssessIQ — modules/18-certification/src/service.ts
//
// Phase 5 Session 1 — service layer stubs for certificate operations.
//
// All public functions are stubs: signatures are load-bearing contracts;
// bodies throw "not implemented" until Phase 5 Session 2 (issuance engine).
//
// Orchestration pattern (same as 15-analytics):
//   Every function wraps repository calls in withTenant(tenantId, fn) so the
//   connection has SET LOCAL app.current_tenant and RLS fires automatically.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// Certificate issuance is deterministic HMAC + DB ops only. CLAUDE.md rule #1.
// INVARIANT: No ambient AI calls. No BullMQ processors, cron, or webhook
//   handlers may invoke these functions. CLAUDE.md rule #1.

import { withTenant } from '@assessiq/tenancy';
import type {
  Certificate,
  IssueCertificateInput,
  ListCertificatesQuery,
} from './types.js';
import type { RevokeCertificateInput } from './types.js';

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

/**
 * Issue or upgrade a certificate for a completed attempt.
 *
 * Behaviour table (plan §4):
 *   - No threshold crossed         → returns null
 *   - First crossing               → INSERT new row with credential_id + signature
 *   - Already exists, same/lower   → returns existing unchanged
 *   - Already exists, higher tier  → UPDATE tier + snapshot; keep credential_id + issued_at
 *
 * Wrapped in a "never-raise" safety net: certificate issuance failures must
 * NOT propagate to the caller (plan §4.1). The hot path (attempt grading,
 * repo link, eval completion) must not fail because of cert logic.
 *
 * TODO(Phase5-S2): implement tier determination, HMAC signing, idempotent
 *   INSERT-or-upgrade, and the safe-wrap error swallowing.
 */
export async function issueCertificate(
  input: IssueCertificateInput,
): Promise<Certificate | null> {
  void input;
  // TODO(Phase5-S2): withTenant(input.tenant_id, async (client) => {
  //   1. Compute tier via determineTier() (pure function, plan §2)
  //   2. If no tier → return null
  //   3. findByAttempt() for existing cert
  //   4a. No existing → generateCredentialId() (CSPRNG, retry on collision)
  //       + signCertificate() (HMAC-SHA256, plan §3)
  //       + repo.insertCertificate()
  //   4b. Existing, same/lower tier → return existing unchanged
  //   4c. Existing, higher tier → re-sign + repo.upgradeCertificateTier()
  //   5. Return Certificate row
  // })
  throw new Error('issueCertificate: not implemented (Phase 5 Session 2)');
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Look up a certificate by its public credential_id slug.
 * Used by the verify page (public) and PDF download endpoint (authed).
 * Returns null when not found.
 *
 * TODO(Phase5-S2): implement via repo.findByCredentialId.
 * Note: verify endpoint is NOT tenant-scoped (public); the repository query
 * must work without a tenant GUC. The cert row contains tenant_id for
 * display purposes only on the verify page.
 */
export async function getByCredentialId(
  credentialId: string,
): Promise<Certificate | null> {
  void credentialId;
  // TODO(Phase5-S3): repo.findByCredentialId (no withTenant — public lookup)
  throw new Error('getByCredentialId: not implemented (Phase 5 Session 3)');
}

/**
 * List certificates for a candidate (candidate-facing "My Certificates" view).
 * Scoped to the calling tenant via withTenant + RLS.
 *
 * TODO(Phase5-S5): implement via repo.listCertificates.
 */
export async function listForUser(
  tenantId: string,
  query: ListCertificatesQuery,
): Promise<{ items: Certificate[]; total: number }> {
  return withTenant(tenantId, async (client) => {
    void client;
    void query;
    // TODO(Phase5-S5): repo.listCertificates(client, tenantId, query)
    throw new Error('listForUser: not implemented (Phase 5 Session 5)');
  });
}

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

/**
 * List all certificates for a tenant (admin view — paginated, filterable).
 * Scoped to the calling tenant via withTenant + RLS.
 *
 * TODO(Phase5-S2): implement via repo.listCertificates.
 */
export async function adminListCertificates(
  tenantId: string,
  query: ListCertificatesQuery,
): Promise<{ items: Certificate[]; total: number }> {
  return withTenant(tenantId, async (client) => {
    void client;
    void query;
    // TODO(Phase5-S2): repo.listCertificates(client, tenantId, query)
    throw new Error('adminListCertificates: not implemented (Phase 5 Session 2)');
  });
}

/**
 * Revoke a certificate. Sets revoked_at + revoke_reason.
 * Revoked certs remain visible on the verify page (red badge) but return 410
 * for PDF downloads and disable LinkedIn share action.
 *
 * TODO(Phase5-S2): implement via repo.revokeCertificate.
 */
export async function revoke(
  tenantId: string,
  certId: string,
  input: RevokeCertificateInput,
): Promise<Certificate> {
  return withTenant(tenantId, async (client) => {
    void client;
    void certId;
    void input;
    // TODO(Phase5-S2): repo.revokeCertificate(client, certId, tenantId, input.revoke_reason)
    throw new Error('revoke: not implemented (Phase 5 Session 2)');
  });
}

/**
 * Re-snapshot a certificate (admin-initiated name correction).
 * Updates display_name + re-signs. MUST preserve credential_id + issued_at
 * so shared LinkedIn URLs remain valid (plan §9).
 *
 * TODO(Phase5-S6): implement re-snapshot logic.
 */
export async function reissue(
  tenantId: string,
  certId: string,
): Promise<Certificate> {
  return withTenant(tenantId, async (client) => {
    void client;
    void certId;
    // TODO(Phase5-S6): fetch cert → re-snapshot display_name from users table
    //   → re-sign → repo.upgradeCertificateTier (reuse for snapshot update)
    throw new Error('reissue: not implemented (Phase 5 Session 6)');
  });
}
