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

import { getPool } from '@assessiq/tenancy';

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

/**
 * Thrown by upgradeCertificateTier when the UPDATE matches zero rows because
 * a concurrent caller has already modified the tier since this caller's last
 * findByAttempt read (TOCTOU race). The service layer catches this, re-fetches
 * the current state, and retries the ordinal comparison up to
 * MAX_TIER_UPGRADE_RETRIES times.
 */
export class TierUpgradeConflictError extends Error {
  constructor(
    public readonly certId: string,
    public readonly expectedTier: string,
  ) {
    super(
      `tier upgrade conflict: cert ${certId} no longer has tier=${expectedTier} — ` +
        'concurrent upgrade detected; caller should re-fetch and retry',
    );
    this.name = 'TierUpgradeConflictError';
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
 * Find a certificate by its public credential_id slug within a tenant context.
 *
 * Includes an explicit `AND tenant_id = $2` predicate as defense-in-depth
 * against callers that accidentally bypass RLS (e.g. data-migration scripts
 * using a service-role connection). RLS is still the primary guard; this is
 * belt-and-suspenders.
 *
 * Input is normalised to uppercase (credential_ids are stored uppercase).
 * Returns null when not found.
 *
 * For the public verify-page lookup (no tenant context, cross-tenant) see
 * findByCredentialIdPublic below.
 */
export async function findByCredentialId(
  client: PoolClient,
  credentialId: string,
  tenantId: string,
): Promise<Certificate | null> {
  const normalised = credentialId.toUpperCase();
  const result = await client.query<Certificate>(
    `SELECT ${CERTIFICATE_PROJECTION}
     FROM certificates
     WHERE credential_id = $1
       AND tenant_id = $2
     LIMIT 1`,
    [normalised, tenantId],
  );
  return result.rows[0] ?? null;
}

/**
 * Public credential lookup for the verify-page (Phase 5 Session 3).
 *
 * Intentionally NOT scoped to a tenant — the verify page is unauthenticated
 * and credential_id is globally unique. The caller MUST pass a client that is
 * inside a withPublicVerifyContext() transaction so the GUC-based RLS policy
 * (public_verify_lookup) allows the SELECT.
 *
 * No tenant_id predicate is added here — that is by design. Adding one would
 * break the cross-tenant lookup that is the entire point of the public page.
 * The GUC policy is the authorization gate.
 *
 * Input is normalised to uppercase (credential_ids are stored uppercase).
 * Returns null when not found.
 */
export async function findByCredentialIdPublic(
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
 * Open a transaction with the GUC-based public verify context set, execute
 * the callback, then commit. The connection is returned to the pool afterward.
 *
 * The GUC set_config('app.public_verify', 'true', true) is transaction-local
 * (is_local=true) — it reverts automatically on COMMIT/ROLLBACK and cannot
 * leak to the next caller that acquires this pool connection.
 *
 * SET LOCAL ROLE assessiq_app ensures RLS is enforced even in environments
 * where the pool connects as a superuser (e.g. dev). In production the pool
 * connects as assessiq_app already, so this is a no-op.
 *
 * Callers MUST NOT set app.current_tenant inside this context — the
 * tenant_isolation_update policy requires it, and the public verify path
 * must not trigger UPDATE operations (counter increments use a separate
 * withTenant() transaction).
 */
export async function withPublicVerifyContext<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE assessiq_app');
    await client.query("SELECT set_config('app.public_verify', 'true', true)");
    // The tenant_isolation RLS policy casts current_setting('app.current_tenant')
    // to UUID on every SELECT. Without this sentinel the cast on '' throws before
    // Postgres can OR-evaluate the public_verify_lookup policy that actually
    // grants access. The sentinel makes the cast succeed; the equality is false,
    // so tenant_isolation denies, and access falls through to public_verify_lookup.
    // The sentinel is reserved (UUID_NIL); no real tenant ever uses it.
    await client.query(
      "SELECT set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true)",
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
 *
 * Tenant scoping is enforced by BOTH RLS (primary) AND an explicit
 * `WHERE tenant_id = $1` predicate (defense-in-depth). The explicit
 * predicate guards against callers that accidentally bypass RLS, e.g.
 * data-migration scripts using a service-role connection.
 */
export async function listCertificates(
  client: PoolClient,
  tenantId: string,
  query: ListCertificatesQuery,
): Promise<{ items: Certificate[]; total: number }> {
  // $1 is always tenant_id (defense-in-depth; RLS is the primary guard).
  const params: unknown[] = [tenantId];
  const conditions: string[] = ['tenant_id = $1'];

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
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

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
 *
 * R3 — TOCTOU guard: the `AND tier = $5` predicate implements an optimistic
 * concurrency check. If a concurrent caller has already upgraded the tier
 * since the service layer's last findByAttempt read, the UPDATE matches zero
 * rows and this function throws TierUpgradeConflictError. The service layer
 * catches that error, re-fetches, and retries up to MAX_TIER_UPGRADE_RETRIES
 * times. This prevents two concurrent upgrades from both reading stale
 * `existing.tier` and recording incorrect before/after audit entries.
 */
export async function upgradeCertificateTier(
  client: PoolClient,
  certId: string,
  tenantId: string,
  newTier: string,
  newSignedHash: string,
  currentTier: string,
): Promise<Certificate> {
  const result = await client.query<Certificate>(
    `UPDATE certificates
        SET tier = $1,
            signed_hash = $2,
            updated_at = now()
      WHERE id = $3
        AND tenant_id = $4
        AND tier = $5
      RETURNING ${CERTIFICATE_PROJECTION}`,
    [newTier, newSignedHash, certId, tenantId, currentTier],
  );
  if (result.rowCount === 0) {
    throw new TierUpgradeConflictError(certId, currentTier);
  }
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `upgradeCertificateTier: UPDATE returned no row for id=${certId} tenant=${tenantId}`,
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
 * Admin certificate list — same as listCertificates but LEFT JOINs the users
 * table to surface user_email alongside each certificate row.
 *
 * Tenant scoping uses the `c.tenant_id = $1` predicate on the aliased table
 * rather than the unqualified column used in listCertificates (which has no JOIN
 * and needs no alias). RLS is still the primary guard; the explicit predicate is
 * defense-in-depth for service-role / migration callers.
 */
export async function listCertificatesAdmin(
  client: PoolClient,
  tenantId: string,
  query: ListCertificatesQuery,
): Promise<{ items: Array<Certificate & { user_email: string | null }>; total: number }> {
  const params: unknown[] = [tenantId];
  const conditions: string[] = ['c.tenant_id = $1'];

  if (query.candidate_id !== undefined) {
    params.push(query.candidate_id);
    conditions.push(`c.candidate_id = $${params.length}`);
  }
  if (query.tier !== undefined) {
    params.push(query.tier);
    conditions.push(`c.tier = $${params.length}`);
  }
  if (query.revoked !== undefined) {
    if (query.revoked === 'true') {
      conditions.push('c.revoked_at IS NOT NULL');
    } else {
      conditions.push('c.revoked_at IS NULL');
    }
  }
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const countResult = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM certificates c ${whereClause}`,
    params,
  );
  const total = Number(countResult.rows[0]?.total ?? '0');

  params.push(query.limit);
  const limitParam = `$${params.length}`;
  params.push(query.offset);
  const offsetParam = `$${params.length}`;

  const result = await client.query<Certificate & { user_email: string | null }>(
    `SELECT
       c.id::text,
       c.tenant_id::text,
       c.attempt_id::text,
       c.candidate_id::text,
       c.template_key,
       c.credential_id,
       c.tier,
       c.display_name,
       c.course_title,
       c.level,
       c.signed_hash,
       to_char(c.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS issued_at,
       CASE WHEN c.revoked_at IS NULL THEN NULL
            ELSE to_char(c.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
       END AS revoked_at,
       c.revoke_reason,
       c.pdf_downloads,
       c.linkedin_shares,
       c.verification_views,
       to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
       to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
       u.email AS user_email
     FROM certificates c
     LEFT JOIN users u ON u.id = c.candidate_id
     ${whereClause}
     ORDER BY c.issued_at DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );
  return { items: result.rows, total };
}

/**
 * Update display_name and signed_hash on a certificate (admin-initiated
 * name correction / reissue). Preserves credential_id and issued_at — those
 * are stable identity fields baked into shared LinkedIn URLs and the HMAC payload.
 *
 * Throws a plain Error when no row is matched (wrong certId or tenantId),
 * which the service layer converts to CertificateNotFoundError before calling
 * this function (findByCredentialId is called first, so a miss here is a
 * programmer error / TOCTOU race — not a normal user-facing 404).
 */
export async function reissueCertificate(
  client: PoolClient,
  certId: string,
  tenantId: string,
  newDisplayName: string,
  newSignedHash: string,
): Promise<Certificate> {
  const result = await client.query<Certificate>(
    `UPDATE certificates
        SET display_name = $1,
            signed_hash = $2,
            updated_at = now()
      WHERE id = $3
        AND tenant_id = $4
      RETURNING ${CERTIFICATE_PROJECTION}`,
    [newDisplayName, newSignedHash, certId, tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`reissueCertificate: no row updated for id=${certId} tenant=${tenantId}`);
  }
  return row;
}

/**
 * Allowlist of counter column names accepted by incrementCounter.
 * Used as a runtime guard against SQL injection if this function is ever
 * called from a dynamic/deserialized context that bypasses TypeScript types.
 */
const ALLOWED_COUNTERS = [
  'pdf_downloads',
  'linkedin_shares',
  'verification_views',
] as const;

/**
 * Increment a non-critical analytics counter using server-side arithmetic
 * (UPDATE … = col + 1) so two simultaneous increments don't lose one.
 * Caller treats lost increments as acceptable (analytics, not business logic).
 *
 * R7 — SQL injection guard: even though the parameter type is a TS union,
 * TypeScript types are compile-only. A runtime allowlist check prevents
 * arbitrary column-name injection from dynamic/deserialized callers.
 */
export async function incrementCounter(
  client: PoolClient,
  certId: string,
  column: 'pdf_downloads' | 'linkedin_shares' | 'verification_views',
): Promise<void> {
  // Runtime allowlist — TypeScript union is compile-only; any runtime caller
  // bypassing TS (dynamic import, webhook handler, deserialized payload)
  // could inject an arbitrary column name without this guard.
  if (!ALLOWED_COUNTERS.includes(column as (typeof ALLOWED_COUNTERS)[number])) {
    throw new Error(
      `incrementCounter: invalid counter column "${column}". ` +
        `Allowed: ${ALLOWED_COUNTERS.join(', ')}`,
    );
  }
  await client.query(
    `UPDATE certificates
        SET ${column} = ${column} + 1,
            updated_at = now()
      WHERE id = $1`,
    [certId],
  );
}
