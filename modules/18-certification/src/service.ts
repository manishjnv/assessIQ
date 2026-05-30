// AssessIQ — modules/18-certification/src/service.ts
//
// Phase 5 Session 2 — issuance engine + read paths for the certification
// module.
//
// Public surface for this session:
//   - issueCertificate(client, input)   → idempotent + tier-upgrade aware
//   - getByCredentialId(client, credId) → public-slug lookup (RLS applies)
//
// Stubs (Session 3+ scope):
//   - listForUser, adminListCertificates, revoke, reissue
//
// CONTRACT: every caller passes an RLS-scoped PoolClient that is already
// inside a withTenant() transaction. This service does NOT call withTenant
// itself — the caller (route handler / hook) is responsible for tenant
// context, and the audit_log INSERT lives in the same transaction so the
// domain mutation + audit row commit or roll back together.
//
// PRECONDITION: the PoolClient MUST be inside an open transaction (i.e. the
// caller has already called withTenant / BEGIN). issueCertificate enforces
// this at runtime via a pg_current_xact_id_if_assigned() sentinel. Passing
// a raw pool connection without an open transaction will throw immediately.
//
// AUDIT ATOMICITY (CLAUDE.md hard rule): auditInTx runs on the same client
// as the cert INSERT / UPDATE. If the audit write fails, the outer
// withTenant() rolls back the cert mutation. There is never a cert row
// without its audit entry, and never an audit entry pointing at a
// half-written cert.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// CLAUDE.md rule #1.

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { auditInTx } from '@assessiq/audit-log';
import { withTenant } from '@assessiq/tenancy';

import {
  DEFAULT_CREDENTIAL_PREFIX,
  generateCredentialId,
} from './credential-id.js';
import {
  type CertificateSignaturePayload,
  getCertSigningSecret,
  signCertificate,
  verifyCertificateSignature,
} from './crypto.js';
import * as repo from './repository.js';

// Re-export TierUpgradeConflictError so callers can catch it by type.
export { TierUpgradeConflictError } from './repository.js';
import {
  TIER_ORDER,
  type Certificate,
  CertificateAccessDeniedError,
  CertificateAlreadyRevokedError,
  CertificateNotFoundError,
  CertificateRevokedException,
  type IssueCertificateInput,
  type ListCertificatesQuery,
  type MyCertificateView,
  type Tier,
} from './types.js';

/**
 * Maximum credential_id collisions tolerated before issueCertificate gives
 * up. 32^6 ≈ 1.07B suffixes per (prefix, year-month) with the Crockford
 * alphabet; hitting three in a row indicates a degraded CSPRNG, not normal
 * birthday-paradox math.
 */
export const MAX_CREDENTIAL_ID_RETRIES = 3;

/**
 * Maximum tier-upgrade CAS retries. A tier upgrade uses an optimistic
 * concurrency check (AND tier = $current_tier). If two concurrent callers
 * race, one will get rowCount=0 (TierUpgradeConflictError) and retry from
 * a fresh read. After MAX_TIER_UPGRADE_RETRIES failures the caller receives
 * the error directly.
 */
export const MAX_TIER_UPGRADE_RETRIES = 3;

/**
 * Optional extras the caller can pass alongside IssueCertificateInput.
 * Kept as a second argument so the IssueCertificateInputSchema (which
 * matches the wire schema for any future REST handler) stays focused on
 * the credential payload.
 */
export interface IssueCertificateOptions {
  /** Override the credential_id prefix. Defaults to "AIQ". */
  credential_prefix?: string;
}

function toSignaturePayload(args: {
  id: string;
  tenant_id: string;
  candidate_id: string;
  attempt_id: string;
  template_key: string;
  credential_id: string;
  tier: Certificate['tier'];
  display_name: string;
  course_title: string;
  level: string;
  issued_at: string;
}): CertificateSignaturePayload {
  return {
    id: args.id,
    tenant_id: args.tenant_id,
    candidate_id: args.candidate_id,
    attempt_id: args.attempt_id,
    template_key: args.template_key,
    credential_id: args.credential_id,
    tier: args.tier,
    display_name: args.display_name,
    course_title: args.course_title,
    level: args.level,
    issued_at: args.issued_at,
  };
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

/**
 * Issue or upgrade a certificate for a graded attempt.
 *
 * Behaviour (single transaction; `client` is already RLS-scoped via withTenant):
 *   - existing row, incoming tier <= existing tier → idempotent return; NO audit.
 *   - existing row, incoming tier >  existing tier → UPDATE tier + re-sign;
 *       preserve credential_id and issued_at; emit certification.cert.upgrade.
 *   - no existing row → INSERT new row with CSPRNG id + credential_id +
 *       signed_hash; emit certification.cert.issue. On credential_id
 *       collision, regenerate the slug (and signature) up to
 *       MAX_CREDENTIAL_ID_RETRIES times; throw when exhausted.
 *
 * Audit metadata (after-state) intentionally carries only identity fields:
 *   { credential_id, tier, candidate_id, attempt_id }
 * It excludes snapshot fields (size-cap on audit_log) and signed_hash
 * (the cert row IS the source of truth — don't duplicate).
 *
 * Returns the resulting Certificate row regardless of insert vs upgrade.
 * The caller can distinguish via { previousTier?: Tier } in a future
 * IssueResult shape if needed; not required by Session 2 acceptance tests.
 */
export async function issueCertificate(
  client: PoolClient,
  input: IssueCertificateInput,
  options: IssueCertificateOptions = {},
): Promise<Certificate> {
  // R2: runtime sentinel — require an open transaction. A raw pool connection
  // without BEGIN will have pg_current_xact_id_if_assigned() return NULL.
  // This catches future callers that forget to wrap in withTenant().
  const txCheck = await client.query<{ xid: string | null }>(
    'SELECT pg_current_xact_id_if_assigned() AS xid',
  );
  if (txCheck.rows[0]?.xid === null) {
    throw new Error(
      'issueCertificate requires an open transaction — call inside withTenant() ' +
        '(see modules/18-certification/SKILL.md § Open-transaction precondition)',
    );
  }

  // R3: tier upgrade is done in a CAS loop to prevent TOCTOU races.
  // We resolve the "existing" check once up front; the upgrade branch may
  // retry if a concurrent upgrade wins the optimistic lock.
  let existing = await repo.findByAttempt(
    client,
    input.tenant_id,
    input.candidate_id,
    input.attempt_id,
  );

  if (existing !== null) {
    // Upgrade / idempotent path — wrapped in a CAS retry loop.
    let upgradeAttempt = 0;
    while (true) {
      const existingOrdinal = TIER_ORDER[existing.tier];
      const incomingOrdinal = TIER_ORDER[input.tier];

      // Idempotent: same-tier re-issue, or attempted downgrade. Plan §1.3:
      // never take a credential away from someone who already earned it.
      // No audit row — this is a no-op from the audit trail's perspective.
      if (incomingOrdinal <= existingOrdinal) {
        return existing;
      }

      // Tier upgrade. Preserve credential_id + issued_at; re-sign with new
      // tier. issued_at is already second-precision from this service (for
      // first-time issues) or from the DB projection (already truncated
      // via to_char). Either way the signing payload uses the stored value.
      const secret = getCertSigningSecret();
      const newSignedHash = signCertificate(
        toSignaturePayload({
          id: existing.id,
          tenant_id: existing.tenant_id,
          candidate_id: existing.candidate_id,
          attempt_id: existing.attempt_id,
          template_key: existing.template_key,
          credential_id: existing.credential_id,
          tier: input.tier,
          display_name: existing.display_name,
          course_title: existing.course_title,
          level: existing.level,
          issued_at: existing.issued_at,
        }),
        secret,
      );

      // R3: pass current_tier to upgradeCertificateTier; the SQL checks
      // AND tier = $current_tier so concurrent races get TierUpgradeConflictError
      // instead of silently overwriting each other's state.
      let upgraded: Certificate;
      try {
        upgraded = await repo.upgradeCertificateTier(
          client,
          existing.id,
          existing.tenant_id,
          input.tier,
          newSignedHash,
          existing.tier, // current_tier for optimistic concurrency
        );
      } catch (err) {
        if (err instanceof repo.TierUpgradeConflictError) {
          upgradeAttempt++;
          if (upgradeAttempt >= MAX_TIER_UPGRADE_RETRIES) {
            throw err;
          }
          // Re-fetch fresh state and retry the ordinal comparison.
          const refreshed = await repo.findByAttempt(
            client,
            input.tenant_id,
            input.candidate_id,
            input.attempt_id,
          );
          if (refreshed === null) {
            // Cert was deleted between retries — extremely unlikely; treat
            // as a programmer error and surface the original conflict.
            throw err;
          }
          existing = refreshed;
          continue;
        }
        throw err;
      }

      await auditInTx(client, {
        tenantId: input.tenant_id,
        actorKind: 'user',
        actorUserId: input.actor_user_id,
        action: 'certification.cert.upgrade',
        entityType: 'certificate',
        entityId: upgraded.id,
        before: { tier: existing.tier },
        after: {
          credential_id: upgraded.credential_id,
          tier: upgraded.tier,
          candidate_id: upgraded.candidate_id,
          attempt_id: upgraded.attempt_id,
        },
      });

      return upgraded;
    }
  }

  // First crossing — INSERT a new row. Generate id + credential_id +
  // signed_hash client-side so the HMAC can sign across the row's identity.
  const secret = getCertSigningSecret();
  const id = randomUUID();
  // R1: truncate to second precision BEFORE signing AND before INSERT.
  // The DB projection uses to_char(... 'YYYY-MM-DD"T"HH24:MI:SS"Z"') which
  // strips milliseconds. If we HMAC over '2026-05-11T17:46:23.456Z' but
  // store/project '2026-05-11T17:46:23Z', Session 3's verify path will
  // recompute the HMAC from the projected value and never match.
  // toISOString() always emits 3 fractional digits; slice(0,19)+'Z' forces
  // 'YYYY-MM-DDTHH:MM:SSZ' with no dot, matching the to_char projection exactly.
  const issuedAt = new Date().toISOString().slice(0, 19) + 'Z';
  const prefix = options.credential_prefix ?? DEFAULT_CREDENTIAL_PREFIX;

  let inserted: Certificate | undefined;
  let lastCollision: repo.CredentialIdCollisionError | undefined;

  for (let attempt = 0; attempt < MAX_CREDENTIAL_ID_RETRIES; attempt++) {
    const credentialId = generateCredentialId(prefix, new Date(issuedAt));
    const signedHash = signCertificate(
      toSignaturePayload({
        id,
        tenant_id: input.tenant_id,
        candidate_id: input.candidate_id,
        attempt_id: input.attempt_id,
        template_key: input.template_key,
        credential_id: credentialId,
        tier: input.tier,
        display_name: input.display_name,
        course_title: input.course_title,
        level: input.level,
        issued_at: issuedAt,
      }),
      secret,
    );

    try {
      inserted = await repo.insertCertificate(client, {
        tenant_id: input.tenant_id,
        attempt_id: input.attempt_id,
        candidate_id: input.candidate_id,
        template_key: input.template_key,
        display_name: input.display_name,
        course_title: input.course_title,
        level: input.level,
        tier: input.tier,
        actor_user_id: input.actor_user_id,
        id,
        credential_id: credentialId,
        signed_hash: signedHash,
        issued_at: issuedAt,
      });
      break;
    } catch (err) {
      if (err instanceof repo.CredentialIdCollisionError) {
        lastCollision = err;
        continue;
      }
      throw err;
    }
  }

  if (inserted === undefined) {
    throw new Error(
      `issueCertificate: credential_id collision exhausted after ${MAX_CREDENTIAL_ID_RETRIES} attempts` +
        (lastCollision !== undefined ? ` (last: ${lastCollision.credentialId})` : ''),
    );
  }

  await auditInTx(client, {
    tenantId: input.tenant_id,
    actorKind: 'user',
    actorUserId: input.actor_user_id,
    action: 'certification.cert.issue',
    entityType: 'certificate',
    entityId: inserted.id,
    after: {
      credential_id: inserted.credential_id,
      tier: inserted.tier,
      candidate_id: inserted.candidate_id,
      attempt_id: inserted.attempt_id,
    },
  });

  return inserted;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Look up a certificate by its public credential_id slug within a tenant.
 * Input is normalised to uppercase (slugs are stored uppercase).
 *
 * RLS applies: this call only finds rows belonging to the active tenant
 * context. An explicit tenant_id predicate is added as defense-in-depth
 * (see repository.findByCredentialId). The public verify-page lookup
 * (Phase 5 Session 3) uses repository.findByCredentialIdPublic — a
 * separate non-RLS code path documented in SKILL.md decision D7.
 */
export async function getByCredentialId(
  client: PoolClient,
  credentialId: string,
  tenantId: string,
): Promise<Certificate | null> {
  return repo.findByCredentialId(client, credentialId, tenantId);
}

// ---------------------------------------------------------------------------
// Stubs (later sessions)
// ---------------------------------------------------------------------------

/**
 * List certificates for a candidate (candidate-facing "My Certificates" view).
 * Scoped to the calling tenant via withTenant + RLS.
 *
 * Each row is enriched with:
 *   - signed_hash_valid: HMAC integrity check performed here so the UI can
 *     display a tamper-evidence indicator without a separate verify call.
 *   - verify_url: canonical public URL for sharing / QR codes.
 *   - pdf_url:    relative URL for the PDF download endpoint.
 */
export async function listForUser(
  tenantId: string,
  candidateId: string,
): Promise<{ certificates: MyCertificateView[] }> {
  return withTenant(tenantId, async (client) => {
    const { items } = await repo.listCertificates(client, tenantId, {
      candidate_id: candidateId,
      limit: 100,
      offset: 0,
    });
    const secret = getCertSigningSecret();
    const baseUrl = process.env['PUBLIC_BASE_URL'] ?? '';
    const views: MyCertificateView[] = items.map((cert) => {
      const signed_hash_valid = verifyCertificateSignature(
        {
          id: cert.id,
          tenant_id: cert.tenant_id,
          attempt_id: cert.attempt_id,
          candidate_id: cert.candidate_id,
          template_key: cert.template_key,
          credential_id: cert.credential_id,
          tier: cert.tier,
          display_name: cert.display_name,
          course_title: cert.course_title,
          level: cert.level,
          issued_at: cert.issued_at,
        },
        cert.signed_hash,
        secret,
      );
      return {
        ...cert,
        signed_hash_valid,
        verify_url: `${baseUrl}/verify/${cert.credential_id}`,
        pdf_url: `/api/certificates/${cert.credential_id}/pdf`,
      };
    });
    return { certificates: views };
  });
}

/**
 * List all certificates for a tenant (admin view — paginated, filterable).
 * Includes user_email via a LEFT JOIN on the users table.
 */
export async function adminListCertificates(
  tenantId: string,
  query: ListCertificatesQuery,
): Promise<{ items: Array<Certificate & { user_email: string | null; isErased: boolean }>; total: number }> {
  return withTenant(tenantId, async (client) => {
    return repo.listCertificatesAdmin(client, tenantId, query);
  });
}

/**
 * Soft-revoke a certificate. Looks up by credential_id (public slug) within
 * the tenant, guards against double-revoke, persists revoked_at + revoke_reason,
 * and emits a certificates.revoked audit row atomically in the same transaction.
 *
 * Throws:
 *   CertificateNotFoundError     — credential_id not found in this tenant.
 *   CertificateAlreadyRevokedError — revoked_at is already set.
 */
export async function revoke(
  tenantId: string,
  credentialId: string,
  revokeReason: string,
  actorUserId: string,
): Promise<Certificate> {
  return withTenant(tenantId, async (client) => {
    const cert = await repo.findByCredentialId(client, credentialId.toUpperCase(), tenantId);
    if (cert === null) {
      throw new CertificateNotFoundError(credentialId);
    }
    if (cert.revoked_at !== null) {
      throw new CertificateAlreadyRevokedError(credentialId, cert.revoke_reason);
    }
    const updated = await repo.revokeCertificate(client, cert.id, tenantId, revokeReason);
    await auditInTx(client, {
      tenantId,
      actorKind: 'user',
      actorUserId,
      action: 'certificates.revoked',
      entityType: 'certificate',
      entityId: cert.id,
      before: { revoked_at: null },
      after: { revoked_at: updated.revoked_at },
    });
    return updated;
  });
}

/**
 * Re-snapshot a certificate — admin-initiated name correction.
 *
 * display_name IS part of the CANONICAL_FIELDS for signing, so updating it
 * produces a different but valid signed_hash. credential_id and issued_at
 * are preserved (those are stable identity fields baked into public URLs).
 *
 * If displayName is undefined the existing display_name is preserved and only
 * the signature is refreshed (useful after a secret rotation in the future).
 *
 * Throws:
 *   CertificateNotFoundError  — credential_id not found in this tenant.
 *   CertificateRevokedException — cert is revoked; issue a new one instead.
 */
export async function reissue(
  tenantId: string,
  credentialId: string,
  displayName: string | undefined,
  actorUserId: string,
): Promise<Certificate> {
  return withTenant(tenantId, async (client) => {
    const cert = await repo.findByCredentialId(client, credentialId.toUpperCase(), tenantId);
    if (cert === null) {
      throw new CertificateNotFoundError(credentialId);
    }
    if (cert.revoked_at !== null) {
      throw new CertificateRevokedException(credentialId);
    }
    const newDisplayName = displayName ?? cert.display_name;
    // Re-sign with potentially updated display_name.
    // display_name IS in CANONICAL_FIELDS — changing it produces a different
    // but valid hash. This is correct/expected behaviour (see SKILL.md D8).
    const secret = getCertSigningSecret();
    const newSignedHash = signCertificate(
      toSignaturePayload({
        id: cert.id,
        tenant_id: cert.tenant_id,
        candidate_id: cert.candidate_id,
        attempt_id: cert.attempt_id,
        template_key: cert.template_key,
        credential_id: cert.credential_id,
        tier: cert.tier,
        display_name: newDisplayName,
        course_title: cert.course_title,
        level: cert.level,
        issued_at: cert.issued_at,
      }),
      secret,
    );
    const updated = await repo.reissueCertificate(
      client,
      cert.id,
      tenantId,
      newDisplayName,
      newSignedHash,
    );
    await auditInTx(client, {
      tenantId,
      actorKind: 'user',
      actorUserId,
      action: 'certificates.reissued',
      entityType: 'certificate',
      entityId: cert.id,
      before: { display_name: cert.display_name },
      after: { display_name: newDisplayName },
    });
    return updated;
  });
}

/**
 * Increment the linkedin_shares counter for a certificate.
 *
 * Only the certificate's owner (candidate_id === candidateId) may call this
 * endpoint — throws CertificateAccessDeniedError for any other caller so an
 * authenticated user cannot bump another candidate's share count.
 *
 * Throws CertificateRevokedException if the cert has been revoked (revoked_at
 * is set) — sharing a revoked credential would be misleading.
 *
 * No audit_log entry — share counters are non-critical analytics and
 * intentionally not audited (CLAUDE.md: "counters are non-critical,
 * intentionally not audited").
 */
export async function incrementShareCount(
  tenantId: string,
  credentialId: string,
  candidateId: string,
): Promise<void> {
  return withTenant(tenantId, async (client) => {
    const cert = await repo.findByCredentialId(client, credentialId.toUpperCase(), tenantId);
    if (cert === null) throw new CertificateNotFoundError(credentialId);
    if (cert.candidate_id !== candidateId) throw new CertificateAccessDeniedError(credentialId);
    if (cert.revoked_at !== null) throw new CertificateRevokedException(credentialId);
    await repo.incrementCounter(client, cert.id, 'linkedin_shares');
  });
}

// ---------------------------------------------------------------------------
// Release-trigger helper (called by 07-ai-grading on graded → released)
// ---------------------------------------------------------------------------

/**
 * Issue a certificate for a newly-released attempt. Called by the grading
 * module's release handler on the same open PoolClient/transaction.
 *
 * Precondition: `client` MUST be inside an open withTenant() transaction
 * (enforced by issueCertificate's R2 sentinel).
 *
 * Returns the Certificate if one was issued/upgraded, or null when:
 *   - attempt not found (RLS filtered)
 *   - attempt_scores row absent (scores not yet computed)
 *   - score below the 70% completion threshold
 *
 * NEVER throws — the caller (07-ai-grading release handler) wraps this in
 * a catch so cert failure cannot block grade release (SKILL.md §4.1).
 */
export async function issueCertificateOnRelease(
  client: PoolClient,
  args: { tenantId: string; attemptId: string; actorUserId: string },
): Promise<Certificate | null> {
  const { tenantId, attemptId, actorUserId } = args;

  // One-pass JOIN: fetch everything needed for issuance.
  // attempt_scores is LEFT JOIN — a graded attempt may not have scores yet
  // if the admin releases before the scoring run completes.
  const result = await client.query<{
    candidate_id: string;
    display_name: string;
    course_title: string;
    level: string;
    auto_pct: string | null; // NUMERIC returns as string from node-postgres
  }>(
    `SELECT
       a.user_id               AS candidate_id,
       u.name              AS display_name,
       ass.name            AS course_title,
       l.label             AS level,
       ats.auto_pct
     FROM attempts      a
     JOIN users         u   ON u.id   = a.user_id
     JOIN assessments   ass ON ass.id = a.assessment_id
     JOIN levels        l   ON l.id   = ass.level_id
     LEFT JOIN attempt_scores ats ON ats.attempt_id = a.id
     WHERE a.id = $1`,
    [attemptId],
  );

  const row = result.rows[0];
  if (row === undefined) return null;
  if (row.auto_pct === null) return null; // scores not yet computed

  const pct = parseFloat(row.auto_pct);
  if (!isFinite(pct)) return null; // guard against PostgreSQL NaN literal
  if (pct < 70) return null; // below completion threshold — no cert

  // AssessIQ tier thresholds (2026-05-25): 70–<90% = completion, ≥90% = distinction.
  // (Lowered from the original 90% floor / 100%-only distinction.) Honors is
  // deferred pending an AI-evaluation pipeline for certs.
  const tier: Tier = pct >= 90 ? 'distinction' : 'completion';

  return issueCertificate(client, {
    tenant_id: tenantId,
    attempt_id: attemptId,
    candidate_id: row.candidate_id,
    template_key: 'standard',
    display_name: row.display_name,
    course_title: row.course_title,
    level: row.level,
    tier,
    actor_user_id: actorUserId,
  });
}
