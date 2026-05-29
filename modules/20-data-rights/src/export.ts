// modules/20-data-rights/src/export.ts
//
// DPDP / GDPR right-of-access — assembles a full data-subject export bundle
// for a single candidate, scoped to the calling tenant via RLS.
//
// Read-only: no DB writes occur here. The calling route (admin-users.ts) emits
// the 'user.data.exported' audit event after the bundle is returned, keeping
// the audit write outside this function so the export can be retried without
// double-writing audit rows.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any
//   AI SDK. data-rights is not part of the AI pipeline (CLAUDE.md rule #1).

import { NotFoundError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import type { PoolClient } from 'pg';
import type { DataExportBundle } from './types.js';

interface ProfileRow {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  erasedAt: string | null;
}

/**
 * Assemble a full DSAR data-export bundle for a candidate.
 *
 * All queries run inside a single withTenant transaction (RLS scoped).
 * The bundle schema version is pinned at 1; bump only when the shape changes
 * in a breaking way (add a migration note when you do).
 */
export async function exportCandidateData(
  tenantId: string,
  userId: string,
): Promise<DataExportBundle> {
  return withTenant(tenantId, async (client: PoolClient) => {
    // ── Profile ─────────────────────────────────────────────────────────────
    const profileRes = await client.query<ProfileRow>(
      `SELECT id::text,
              name,
              email,
              role,
              created_at::text AS "createdAt",
              erased_at::text  AS "erasedAt"
         FROM users
        WHERE id = $1`,
      [userId],
    );
    const profile = profileRes.rows[0];
    if (profile === undefined) {
      throw new NotFoundError('user not found', {
        details: { code: 'USER_NOT_FOUND', userId },
      });
    }

    // ── Attempts (with scores via LEFT JOIN) ─────────────────────────────────
    const attemptsRes = await client.query(
      `SELECT a.id::text,
              a.assessment_id::text   AS "assessmentId",
              a.status,
              a.started_at::text      AS "startedAt",
              a.submitted_at::text    AS "submittedAt",
              s.total_earned,
              s.total_max,
              s.auto_pct
         FROM attempts a
         LEFT JOIN attempt_scores s ON s.attempt_id = a.id
        WHERE a.user_id = $1
        ORDER BY a.started_at`,
      [userId],
    );

    // ── Attempt answers ──────────────────────────────────────────────────────
    const answersRes = await client.query(
      `SELECT aa.question_id::text AS "questionId",
              q.type,
              aa.answer,
              aa.saved_at::text     AS "savedAt"
         FROM attempt_answers aa
         JOIN attempts a  ON a.id  = aa.attempt_id
         JOIN questions q ON q.id  = aa.question_id
        WHERE a.user_id = $1`,
      [userId],
    );

    // ── Certificates ─────────────────────────────────────────────────────────
    const certsRes = await client.query(
      `SELECT credential_id AS "credentialId",
              issued_at::text AS "issuedAt"
         FROM certificates
        WHERE candidate_id = $1`,
      [userId],
    );

    // ── Consent events ───────────────────────────────────────────────────────
    const consentsRes = await client.query(
      `SELECT purpose,
              policy_version   AS "policyVersion",
              granted_at::text AS "grantedAt",
              withdrawn_at::text AS "withdrawnAt",
              lawful_basis     AS "lawfulBasis",
              created_at::text AS "createdAt"
         FROM consent_events
        WHERE user_id = $1
        ORDER BY created_at`,
      [userId],
    );

    // ── Audit events touching this user entity ───────────────────────────────
    const auditRes = await client.query(
      `SELECT action,
              entity_type AS "entityType",
              at::text,
              before,
              after
         FROM audit_log
        WHERE entity_type = 'user' AND entity_id = $1
        ORDER BY at`,
      [userId],
    );

    return {
      manifest: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        userId,
      },
      profile: {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        role: profile.role,
        createdAt: profile.createdAt,
        erasedAt: profile.erasedAt ?? null,
      },
      attempts: attemptsRes.rows as Record<string, unknown>[],
      answers: answersRes.rows as Record<string, unknown>[],
      certificates: certsRes.rows as Record<string, unknown>[],
      consents: consentsRes.rows as Record<string, unknown>[],
      auditEvents: auditRes.rows as Record<string, unknown>[],
    };
  });
}
