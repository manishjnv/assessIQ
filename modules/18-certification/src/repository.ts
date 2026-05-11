// AssessIQ — modules/18-certification/src/repository.ts
//
// Phase 5 Session 2 — persistence layer for the certificates table.
//
// All functions accept a PoolClient that has already had the tenant GUC set
// via withTenant() (from @assessiq/tenancy). RLS on the `certificates` table
// enforces tenant isolation automatically for SELECT/INSERT/UPDATE queries.
//
// Stays thin: query functions only, no business logic. Service layer
// (service.ts) owns idempotence, signing, and audit emission.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// CLAUDE.md rule #1.

import type { PoolClient } from 'pg';

import type {
  Certificate,
  IssueCertificateInput,
  ListCertificatesQuery,
} from './types.js';

/**
 * Thrown by insertCertificate when the DB rejects the row because the chosen
 * credential_id collides with an existing row's globally-unique slug. The
 * service-layer caller is expected to catch this, generate a new slug, and
 * retry up to MAX_CREDENTIAL_ID_RETRIES times before surfacing the error.
 *
 * Distinguish from a UNIQUE(tenant_id, candidate_id, attempt_id) violation:
 * that one is the idempotence guard and should NOT be retried (it means the
 * cert already exists; the service layer should have detected this via
 * findByAttempt before calling insert).
 */
export class CredentialIdCollisionError extends Error {
  constructor(public readonly credentialId: string) {
    super(`credential_id collision: ${credentialId}`);
    this.name = 'CredentialIdCollisionError';
  }
}

// PG SQLSTATE for unique_violation (23505) — used to differentiate
// credential_id collisions from generic INSERT failures.
const SQLSTATE_UNIQUE_VIOLATION = '23505';
// Constraint name from migration 0046_certification_init.sql.
const CONSTRAINT_CREDENTIAL_ID_UNIQUE = 'certificates_credential_id_key';

/**
 * Type guard for the pg `DatabaseError` shape we care about (code + constraint).
 * Avoids depending on pg's internal types directly.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === SQLSTATE_UNIQUE_VIOLATION &&
    'constraint' in err &&
    (err as { constraint: unknown }).constraint === constraint
  );
}

// Reusable RETURNING clause — every read/write produces the same projection
// so the Certificate shape is consistent. Coerce TIMESTAMPTZ + UUID to text
// at the SQL boundary so the runtime row matches the interface (string-typed).
const CERTIFICATE_PROJECTION = `
  id::text,
  tenant_id::text,
  attempt_id::text,
  candidate_id::text,
  template_key,
  credential_id,
  tier,
  display_name,
  course_title,
  level,
  signed_hash,
  to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS issued_at,
  CASE WHEN revoked_at IS NULL THEN NULL
       ELSE to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  END AS revoked_at,
  revoke_reason,
  pdf_downloads,
  linkedin_shares,
  verification_views,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
`;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Find a certificate by its public credential_id slug.
 * Input is normalised to uppercase (credential_ids are stored uppercase).
 * Returns null when not found.
 */
export async function findByCredentialId(
  client: PoolClient,
  credentialId: string,
): Promise<Certificate | null> {
  const normalised = credentialId.toUpperCase();
  const result = await client.query<Certificate>(
    `SELECT ${CERTIFICATE_PROJECTION}
     FROM certificates
     WHERE credential_id = $1
     LIMIT 1`,
    [normalised],
  );
  return result.rows[0] ?? null;
}

/**
 * Find an existing certificate for a (tenant, candidate, attempt) tuple.
 * Used by service.issueCertificate as the idempotence fast path.
 * Returns null when no cert exists yet.
 */
export async function findByAttempt(
  client: PoolClient,
  tenantId: string,
  candidateId: string,
  attemptId: string,
): Promise<Certificate | null> {
  const result = await client.query<Certificate>(
    `SELECT ${CERTIFICATE_PROJECTION}
     FROM certificates
     WHERE tenant_id = $1
       AND candidate_id = $2
       AND attempt_id = $3
     LIMIT 1`,
    [tenantId, candidateId, attemptId],
  );
  return result.rows[0] ?? null;
}

/**
 * List certificates for a tenant with optional filters. Paginated.
 * Tenant scoping is enforced via RLS — no explicit tenant_id WHERE clause is
 * added (the migration's tenant_isolation policy fires automatically).
 */
export async function listCertificates(
  client: PoolClient,
  tenantId: string,
  query: ListCertificatesQuery,
): Promise<{ items: Certificate[]; total: number }> {
  void tenantId; // RLS scopes — kept on the signature for documentation.
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.candidate_id !== undefined) {
    params.push(query.candidate_id);
    conditions.push(`candidate_id = $${params.length}`);
  }
  if (query.tier !== undefined) {
    params.push(query.tier);
    conditions.push(`tier = $${params.length}`);
  }
  if (query.revoked !== undefined) {
    if (query.revoked === 'true') {
      conditions.push('revoked_at IS NOT NULL');
    } else {
      conditions.push('revoked_at IS NULL');
    }
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM certificates ${whereClause}`,
    params,
  );
  const total = Number(countResult.rows[0]?.total ?? '0');

  params.push(query.limit);
  const limitParam = `$${params.length}`;
  params.push(query.offset);
  const offsetParam = `$${params.length}`;

  const result = await client.query<Certificate>(
    `SELECT ${CERTIFICATE_PROJECTION}
     FROM certificates
     ${whereClause}
     ORDER BY issued_at DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );
  return { items: result.rows, total };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * INSERT a new certificate row.
 *
 * Caller responsibilities:
 *   - Supply a CSPRNG-generated `id` (UUID v4 from node:crypto.randomUUID) so
 *     the signed_hash, which depends on `id`, can be computed before the
 *     INSERT. Passing an explicit id overrides the DEFAULT gen_random_uuid().
 *   - Supply a freshly generated `credential_id`.
 *   - Supply the precomputed `signed_hash`.
 *   - Supply `issued_at` as an ISO 8601 UTC string.
 *
 * Errors:
 *   - UNIQUE(credential_id) → thrown as CredentialIdCollisionError so the
 *     service retries with a new slug.
 *   - UNIQUE(tenant_id, candidate_id, attempt_id) → re-thrown as-is; the
 *     service layer must check idempotence via findByAttempt before calling
 *     this function, so this constraint firing is a programmer error.
 *   - Anything else → re-thrown as-is.
 */
export async function insertCertificate(
  client: PoolClient,
  input: IssueCertificateInput & {
    id: string;
    credential_id: string;
    signed_hash: string;
    issued_at: string;
  },
): Promise<Certificate> {
  try {
    const result = await client.query<Certificate>(
      `INSERT INTO certificates
         (id, tenant_id, attempt_id, candidate_id, template_key, credential_id,
          tier, display_name, course_title, level, signed_hash, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${CERTIFICATE_PROJECTION}`,
      [
        input.id,
        input.tenant_id,
        input.attempt_id,
        input.candidate_id,
        input.template_key,
        input.credential_id,
        input.tier,
        input.display_name,
        input.course_title,
        input.level,
        input.signed_hash,
        input.issued_at,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('insertCertificate: INSERT returned no row');
    }
    return row;
  } catch (err) {
    if (isUniqueViolation(err, CONSTRAINT_CREDENTIAL_ID_UNIQUE)) {
      throw new CredentialIdCollisionError(input.credential_id);
    }
    throw err;
  }
}

/**
 * Upgrade a certificate's tier and re-sign. Preserves credential_id and
 * issued_at — those are stable identity fields baked into shared LinkedIn
 * URLs and the HMAC payload's notion of "this cert was issued at this time."
 *
 * The tenant_id parameter is for defense-in-depth: combined with RLS it
 * ensures the UPDATE cannot affect a row outside the active tenant context
 * even if a future bug surfaced one.
 */
export async function upgradeCertificateTier(
  client: PoolClient,
  certId: string,
  tenantId: string,
  newTier: string,
  newSignedHash: string,
): Promise<Certificate> {
  const result = await client.query<Certificate>(
    `UPDATE certificates
        SET tier = $1,
            signed_hash = $2,
            updated_at = now()
      WHERE id = $3
        AND tenant_id = $4
      RETURNING ${CERTIFICATE_PROJECTION}`,
    [newTier, newSignedHash, certId, tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `upgradeCertificateTier: no row updated for id=${certId} tenant=${tenantId}`,
    );
  }
  return row;
}

/**
 * Soft-revoke a certificate. Phase 5 Session 2+ stub — not exercised by the
 * Session 2 acceptance tests but kept implementation-complete for the
 * admin-revoke session (Phase 5 Session 7+).
 */
export async function revokeCertificate(
  client: PoolClient,
  certId: string,
  tenantId: string,
  reason: string,
): Promise<Certificate> {
  const result = await client.query<Certificate>(
    `UPDATE certificates
        SET revoked_at = now(),
            revoke_reason = $1,
            updated_at = now()
      WHERE id = $2
        AND tenant_id = $3
      RETURNING ${CERTIFICATE_PROJECTION}`,
    [reason, certId, tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `revokeCertificate: no row updated for id=${certId} tenant=${tenantId}`,
    );
  }
  return row;
}

/**
 * Increment a non-critical analytics counter using server-side arithmetic
 * (UPDATE … = col + 1) so two simultaneous increments don't lose one.
 * Caller treats lost increments as acceptable (analytics, not business logic).
 */
export async function incrementCounter(
  client: PoolClient,
  certId: string,
  column: 'pdf_downloads' | 'linkedin_shares' | 'verification_views',
): Promise<void> {
  // Column is a literal type constrained by the parameter union — safe to
  // interpolate (no user input reaches this site).
  await client.query(
    `UPDATE certificates
        SET ${column} = ${column} + 1,
            updated_at = now()
      WHERE id = $1`,
    [certId],
  );
}
