// AssessIQ — modules/18-certification/src/repository.ts
//
// Phase 5 Session 1 — raw SQL stubs for certificate persistence.
//
// All functions accept a PoolClient that has already had the tenant GUC set
// via withTenant() (from @assessiq/tenancy). RLS on the `certificates` table
// enforces tenant isolation automatically for SELECT/INSERT/UPDATE queries.
//
// Stubs only in this session — bodies will be implemented in Phase 5 Session 2
// (issuance engine). Return-type signatures are load-bearing contracts.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// INVARIANT: No business logic here — pure persistence stubs. CLAUDE.md rule #1.

import type { PoolClient } from 'pg';
import type {
  Certificate,
  IssueCertificateInput,
  ListCertificatesQuery,
} from './types.js';

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Find a certificate by its public credential_id slug.
 * Used by the verify endpoint (public, no auth) and the PDF download endpoint.
 * Returns null when not found.
 *
 * TODO(Phase5-S2): implement SQL query against `certificates` table.
 * Index: certificates_credential_id_key (UNIQUE) makes this O(1).
 */
export async function findByCredentialId(
  client: PoolClient,
  credentialId: string,
): Promise<Certificate | null> {
  void client;
  void credentialId;
  // TODO(Phase5-S2): SELECT * FROM certificates WHERE credential_id = $1
  throw new Error('findByCredentialId: not implemented (Phase 5 Session 2)');
}

/**
 * Find an existing certificate for a given (tenant, candidate, attempt) tuple.
 * Used for idempotence check before issuance.
 * Returns null when no cert exists yet.
 *
 * TODO(Phase5-S2): implement idempotence lookup.
 * Index: certificates_tenant_candidate_attempt_uniq enforces at DB level.
 */
export async function findByAttempt(
  client: PoolClient,
  tenantId: string,
  candidateId: string,
  attemptId: string,
): Promise<Certificate | null> {
  void client;
  void tenantId;
  void candidateId;
  void attemptId;
  // TODO(Phase5-S2): SELECT * FROM certificates
  //   WHERE tenant_id = $1 AND candidate_id = $2 AND attempt_id = $3
  throw new Error('findByAttempt: not implemented (Phase 5 Session 2)');
}

/**
 * List certificates for a tenant with optional filters.
 * Used by admin list endpoint (paginated).
 *
 * TODO(Phase5-S2): implement paginated query with filter clauses.
 */
export async function listCertificates(
  client: PoolClient,
  tenantId: string,
  query: ListCertificatesQuery,
): Promise<{ items: Certificate[]; total: number }> {
  void client;
  void tenantId;
  void query;
  // TODO(Phase5-S2): SELECT with WHERE tenant_id=… + optional filters + LIMIT/OFFSET
  throw new Error('listCertificates: not implemented (Phase 5 Session 2)');
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Insert a new certificate row.
 * credential_id uniqueness is enforced by DB constraint; caller retries on
 * conflict (max 3 attempts) with a newly-generated credential_id.
 *
 * TODO(Phase5-S2): implement INSERT with RETURNING *.
 * Caller (service.issueCertificate) handles IntegrityError on credential_id collision.
 */
export async function insertCertificate(
  client: PoolClient,
  input: IssueCertificateInput & {
    credential_id: string;
    signed_hash: string;
    issued_at: string;
  },
): Promise<Certificate> {
  void client;
  void input;
  // TODO(Phase5-S2): INSERT INTO certificates (...) VALUES (...) RETURNING *
  // Handle: UNIQUE(tenant_id, candidate_id, attempt_id) — idempotence guard
  // Handle: UNIQUE(credential_id) — slug collision (rare; retry in service)
  throw new Error('insertCertificate: not implemented (Phase 5 Session 2)');
}

/**
 * Upgrade an existing certificate's tier and re-snapshot counters.
 * MUST preserve credential_id and issued_at — rotating them breaks shared
 * LinkedIn URLs and invalidates the HMAC signature.
 *
 * TODO(Phase5-S2): implement UPDATE SET tier=$1, signed_hash=$2, …
 *   WHERE id=$3 AND tenant_id=$4 RETURNING *
 */
export async function upgradeCertificateTier(
  client: PoolClient,
  certId: string,
  tenantId: string,
  newTier: string,
  newSignedHash: string,
): Promise<Certificate> {
  void client;
  void certId;
  void tenantId;
  void newTier;
  void newSignedHash;
  // TODO(Phase5-S2): UPDATE certificates SET tier=$1, signed_hash=$2, updated_at=now()
  //   WHERE id=$3 AND tenant_id=$4 RETURNING *
  // NOTE: do NOT update credential_id or issued_at (would break HMAC + shared URLs)
  throw new Error('upgradeCertificateTier: not implemented (Phase 5 Session 2)');
}

/**
 * Revoke a certificate (set revoked_at + revoke_reason).
 * Revoked certs still render on the verify page — only the badge changes.
 * PDF download returns 410 for revoked certs.
 *
 * TODO(Phase5-S2): implement UPDATE SET revoked_at=now(), revoke_reason=$1 …
 */
export async function revokeCertificate(
  client: PoolClient,
  certId: string,
  tenantId: string,
  reason: string,
): Promise<Certificate> {
  void client;
  void certId;
  void tenantId;
  void reason;
  // TODO(Phase5-S2): UPDATE certificates
  //   SET revoked_at = now(), revoke_reason = $1, updated_at = now()
  //   WHERE id = $2 AND tenant_id = $3 RETURNING *
  throw new Error('revokeCertificate: not implemented (Phase 5 Session 2)');
}

/**
 * Increment a counter column atomically using server-side arithmetic.
 * Uses UPDATE … SET col = col + 1 to avoid read-modify-write race conditions.
 * Non-critical: a lost increment is acceptable (analytics, not business logic).
 *
 * TODO(Phase5-S2): implement UPDATE certificates SET <col> = <col> + 1 WHERE id=$1
 */
export async function incrementCounter(
  client: PoolClient,
  certId: string,
  column: 'pdf_downloads' | 'linkedin_shares' | 'verification_views',
): Promise<void> {
  void client;
  void certId;
  void column;
  // TODO(Phase5-S2): UPDATE certificates SET <col> = <col> + 1 WHERE id = $1
  // Intentionally fire-and-forget; do NOT await in hot paths.
  throw new Error('incrementCounter: not implemented (Phase 5 Session 2)');
}
