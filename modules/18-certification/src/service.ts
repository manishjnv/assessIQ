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
} from './crypto.js';
import * as repo from './repository.js';
import {
  TIER_ORDER,
  type Certificate,
  type IssueCertificateInput,
  type ListCertificatesQuery,
  type RevokeCertificateInput,
} from './types.js';

/**
 * Maximum credential_id collisions tolerated before issueCertificate gives
 * up. 36^6 ≈ 2.18B suffixes per (prefix, year-month); hitting three in a
 * row indicates a degraded CSPRNG, not normal birthday-paradox math.
 */
export const MAX_CREDENTIAL_ID_RETRIES = 3;

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
  const existing = await repo.findByAttempt(
    client,
    input.tenant_id,
    input.candidate_id,
    input.attempt_id,
  );

  if (existing !== null) {
    const existingOrdinal = TIER_ORDER[existing.tier];
    const incomingOrdinal = TIER_ORDER[input.tier];

    // Idempotent: same-tier re-issue, or attempted downgrade. Plan §1.3:
    // never take a credential away from someone who already earned it.
    // No audit row — this is a no-op from the audit trail's perspective.
    if (incomingOrdinal <= existingOrdinal) {
      return existing;
    }

    // Tier upgrade. Preserve credential_id + issued_at; re-sign with new tier.
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

    const upgraded = await repo.upgradeCertificateTier(
      client,
      existing.id,
      existing.tenant_id,
      input.tier,
      newSignedHash,
    );

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

  // First crossing — INSERT a new row. Generate id + credential_id +
  // signed_hash client-side so the HMAC can sign across the row's identity.
  const secret = getCertSigningSecret();
  const id = randomUUID();
  const issuedAt = new Date().toISOString();
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
 * Look up a certificate by its public credential_id slug. Input is
 * normalised to uppercase (slugs are stored uppercase).
 *
 * RLS applies: this call only finds rows belonging to the active tenant
 * context. The public verify-page lookup (Phase 5 Session 3) will use a
 * separate non-RLS code path documented in SKILL.md decision D7.
 */
export async function getByCredentialId(
  client: PoolClient,
  credentialId: string,
): Promise<Certificate | null> {
  return repo.findByCredentialId(client, credentialId);
}

// ---------------------------------------------------------------------------
// Stubs (later sessions)
// ---------------------------------------------------------------------------

/**
 * List certificates for a candidate (candidate-facing "My Certificates" view).
 * Scoped to the calling tenant via withTenant + RLS.
 *
 * TODO(Phase5-S5): wire to repo.listCertificates with a candidate_id filter
 *   derived from req.session.userId.
 */
export async function listForUser(
  tenantId: string,
  query: ListCertificatesQuery,
): Promise<{ items: Certificate[]; total: number }> {
  return withTenant(tenantId, async (client) => {
    void client;
    void query;
    throw new Error('listForUser: not implemented (Phase 5 Session 5)');
  });
}

/**
 * List all certificates for a tenant (admin view — paginated, filterable).
 *
 * TODO(Phase5-S2 follow-up / S7): not in the Session 2 contract; the
 * Session 2 scope is the issuance engine. This will be wired alongside
 * the admin dashboard panel.
 */
export async function adminListCertificates(
  tenantId: string,
  query: ListCertificatesQuery,
): Promise<{ items: Certificate[]; total: number }> {
  return withTenant(tenantId, async (client) => {
    return repo.listCertificates(client, tenantId, query);
  });
}

/**
 * Revoke a certificate. Stub — Phase 5 Session 7.
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
    throw new Error('revoke: not implemented (Phase 5 Session 7)');
  });
}

/**
 * Re-snapshot a certificate (admin-initiated name correction). Stub —
 * Phase 5 Session 6.
 */
export async function reissue(
  tenantId: string,
  certId: string,
): Promise<Certificate> {
  return withTenant(tenantId, async (client) => {
    void client;
    void certId;
    throw new Error('reissue: not implemented (Phase 5 Session 6)');
  });
}
