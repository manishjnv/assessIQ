// modules/20-data-rights/src/erasure.ts
//
// DPDP / GDPR right-to-erasure for candidate PII.
//
// D1 — NO DELETE invariant: erasure is UPDATE-only tombstoning. The users row
//   is never physically deleted; name + email are replaced with deterministic
//   pseudonyms derived from sha256(id) so the UUID stays a valid FK target for
//   all child tables (attempts, attempt_answers, sessions, certificates).
//
// D5 — certificates are NEVER mutated. They carry an HMAC snapshot of the
//   candidate's details at issue time. Changing the user row does NOT alter
//   the certificate content. certificatesPreserved in the receipt is a
//   transparency count only.
//
// Idempotent: calling eraseCandidatePii on an already-erased user is a no-op
//   that returns alreadyErased:true without writing any new rows.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any
//   AI SDK. data-rights is not part of the AI pipeline (CLAUDE.md rule #1).

import { NotFoundError, ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import { auditInTx } from '@assessiq/audit-log';
import type { PoolClient } from 'pg';
import type { ErasureReceipt } from './types.js';

interface UserRow {
  id: string;
  role: string;
  name: string;
  email: string;
  erased_at: string | null;
}

interface TombstoneRow {
  name: string;
  email: string;
  erased_at: string;
}

/**
 * Tombstone a candidate's PII in a single atomic transaction.
 *
 * Steps (all inside one withTenant tx):
 *   1. Fetch user row — 404 if missing, 400 if not a candidate.
 *   2. Idempotent guard — return early if already erased (no audit write).
 *   3. UPDATE users: replace name + email with sha256-derived pseudonyms,
 *      set erased_at = now().
 *   4. UPDATE attempt_answers: set answer = '"[erased]"' for non-mcq rows.
 *   5. UPDATE sessions: NULL out ip + user_agent.
 *   6. SELECT count(*) from certificates (preserved, never mutated).
 *   7. auditInTx: action = 'user.pii.erased', after = counts only.
 */
export async function eraseCandidatePii(
  tenantId: string,
  userId: string,
  reason: string,
  actorUserId: string,
): Promise<ErasureReceipt> {
  return withTenant(tenantId, async (client: PoolClient) => {
    // ── 1. Fetch user ───────────────────────────────────────────────────────
    const userRes = await client.query<UserRow>(
      `SELECT id, role, name, email, erased_at::text FROM users WHERE id = $1`,
      [userId],
    );
    const user = userRes.rows[0];
    if (user === undefined) {
      throw new NotFoundError('user not found', {
        details: { code: 'USER_NOT_FOUND', userId },
      });
    }
    if (user.role !== 'candidate') {
      throw new ValidationError('only candidate PII may be erased via this endpoint', {
        details: { code: 'ERASE_NOT_CANDIDATE', role: user.role, userId },
      });
    }

    // ── 2. Idempotent guard ─────────────────────────────────────────────────
    if (user.erased_at !== null) {
      // Count certs even on no-op so the receipt is accurate.
      const certRes = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM certificates WHERE candidate_id = $1`,
        [userId],
      );
      return {
        userId,
        erasedAt: user.erased_at,
        alreadyErased: true,
        tombstone: { name: user.name, email: user.email },
        attemptAnswersErased: 0,
        sessionsRedacted: 0,
        certificatesPreserved: certRes.rows[0]?.n ?? 0,
      };
    }

    // ── 3. Tombstone user ───────────────────────────────────────────────────
    const tombRes = await client.query<TombstoneRow>(
      `UPDATE users
          SET name      = 'deleted_user_' || substr(encode(sha256(id::text::bytea),'hex'),1,12),
              email     = 'deleted+' || substr(encode(sha256(id::text::bytea),'hex'),1,12) || '@erased.assessiq.local',
              erased_at = now()
        WHERE id = $1 AND erased_at IS NULL
        RETURNING name, email, erased_at::text`,
      [userId],
    );
    const tombstone = tombRes.rows[0];
    // Guard: if another concurrent tx won the race, tombstone may be undefined.
    // Treat as already erased (idempotent).
    if (tombstone === undefined) {
      const certRes = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM certificates WHERE candidate_id = $1`,
        [userId],
      );
      return {
        userId,
        erasedAt: user.erased_at ?? new Date().toISOString(),
        alreadyErased: true,
        tombstone: { name: user.name, email: user.email },
        attemptAnswersErased: 0,
        sessionsRedacted: 0,
        certificatesPreserved: certRes.rows[0]?.n ?? 0,
      };
    }

    // ── 4. Erase free-text attempt answers ──────────────────────────────────
    // Conservative filter: erase every answer EXCEPT those positively confirmed
    // to be 'mcq' (numeric selections, not PII). We resolve the question type via
    // a correlated subquery and COALESCE a missing/RLS-invisible question to a
    // free-text type so its PII is still erased. A plain JOIN to `questions`
    // would be gated by questions-RLS (keyed on the tenant's cloned pack); any
    // answer whose question_id is not visible under that policy would be silently
    // skipped, leaving free-text PII un-erased — a right-to-erasure gap. Tenant
    // confinement is preserved by `attempts` RLS + the a.user_id = $1 pin.
    const answersRes = await client.query(
      `UPDATE attempt_answers aa
          SET answer = '"[erased]"'::jsonb
         FROM attempts a
        WHERE aa.attempt_id = a.id
          AND a.user_id = $1
          AND aa.answer IS NOT NULL
          AND COALESCE(
                (SELECT q.type FROM questions q WHERE q.id = aa.question_id),
                'subjective'
              ) <> 'mcq'`,
      [userId],
    );
    const attemptAnswersErased: number = answersRes.rowCount ?? 0;

    // ── 5. Redact sessions ──────────────────────────────────────────────────
    const sessionsRes = await client.query(
      `UPDATE sessions SET ip = NULL, user_agent = NULL
        WHERE user_id = $1 AND (ip IS NOT NULL OR user_agent IS NOT NULL)`,
      [userId],
    );
    const sessionsRedacted: number = sessionsRes.rowCount ?? 0;

    // ── 6. Count preserved certificates ────────────────────────────────────
    const certRes = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM certificates WHERE candidate_id = $1`,
      [userId],
    );
    const certificatesPreserved: number = certRes.rows[0]?.n ?? 0;

    // ── 7. Audit (inside tx) ────────────────────────────────────────────────
    await auditInTx(client, {
      tenantId,
      actorUserId,
      actorKind: 'user',
      action: 'user.pii.erased',
      entityType: 'user',
      entityId: userId,
      after: {
        reason,
        attemptAnswersErased,
        sessionsRedacted,
        certificatesPreserved,
        erased: true,
      },
    });

    return {
      userId,
      erasedAt: tombstone.erased_at,
      alreadyErased: false,
      tombstone: { name: tombstone.name, email: tombstone.email },
      attemptAnswersErased,
      sessionsRedacted,
      certificatesPreserved,
    };
  });
}
