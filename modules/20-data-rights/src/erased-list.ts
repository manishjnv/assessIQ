// modules/20-data-rights/src/erased-list.ts
//
// Read-only list of erased candidates in the caller's tenant. Powers the
// "Erased candidates" section in /admin/tenant-settings — the consolidated
// compliance view that admins need now that erased candidates are hidden
// from the main Users list (S3-display, 2026-05-30).
//
// Read-only. No mutations. RLS-confined to the caller's tenant via withTenant.

import { withTenant } from '@assessiq/tenancy';
import type { ErasedCandidateRow, ListErasedCandidatesOpts } from './types.js';

interface RawRow {
  user_id: string;
  erased_at: string;
  erased_by_id: string | null;
  erased_by_name: string | null;
  erased_by_email: string | null;
  reason: string | null;
  attempts_kept: number;
  certs_kept: number;
}

/**
 * List candidates in the caller's tenant whose PII has been tombstoned.
 * Joins to audit_log to surface who erased them, when, and why.
 *
 * Tenancy: withTenant sets app.current_tenant; users + audit_log + attempts +
 * certificates all carry tenant_id RLS policies, so the result is scoped.
 *
 * The actor name/email come from a SECOND `users` join (LEFT JOIN actor)
 * which is also tenant-scoped — the erasing admin and the erased candidate
 * are always in the same tenant under the current DPDP-data-fiduciary model.
 */
export async function listErasedCandidates(
  tenantId: string,
  opts: ListErasedCandidatesOpts = {},
): Promise<{ items: ErasedCandidateRow[]; total: number }> {
  const sinceIso = opts.since ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const adminId = opts.adminId ?? null;

  return withTenant(tenantId, async (client) => {
    const itemsRes = await client.query<RawRow>(
      `
      WITH erased AS (
        SELECT u.id, u.erased_at
        FROM users u
        WHERE u.role = 'candidate'
          AND u.erased_at IS NOT NULL
          AND u.erased_at >= $1::timestamptz
          AND (
            $3::uuid IS NULL
            OR EXISTS (
              SELECT 1 FROM audit_log al2
              WHERE al2.entity_type = 'user'
                AND al2.entity_id = u.id
                AND al2.action = 'user.pii.erased'
                AND al2.actor_user_id = $3::uuid
            )
          )
        ORDER BY u.erased_at DESC
        LIMIT $2
      ),
      audit AS (
        SELECT DISTINCT ON (al.entity_id)
          al.entity_id              AS user_id,
          al.actor_user_id,
          actor.name                AS actor_name,
          actor.email               AS actor_email,
          (al.after->>'reason')     AS reason
        FROM audit_log al
        LEFT JOIN users actor ON actor.id = al.actor_user_id
        WHERE al.action = 'user.pii.erased'
          AND al.entity_type = 'user'
          AND al.entity_id IN (SELECT id FROM erased)
        ORDER BY al.entity_id, al.at DESC
      )
      SELECT
        e.id::text                                                                 AS user_id,
        e.erased_at::text                                                          AS erased_at,
        a.actor_user_id::text                                                      AS erased_by_id,
        a.actor_name                                                               AS erased_by_name,
        a.actor_email                                                              AS erased_by_email,
        a.reason                                                                   AS reason,
        COALESCE((SELECT count(*) FROM attempts WHERE user_id = e.id), 0)::int     AS attempts_kept,
        COALESCE((SELECT count(*) FROM certificates WHERE candidate_id = e.id), 0)::int AS certs_kept
      FROM erased e
      LEFT JOIN audit a ON a.user_id = e.id
      ORDER BY e.erased_at DESC
      `,
      [sinceIso, limit, adminId],
    );

    const totalRes = await client.query<{ n: number }>(
      `
      SELECT count(*)::int AS n
      FROM users u
      WHERE u.role = 'candidate'
        AND u.erased_at IS NOT NULL
        AND u.erased_at >= $1::timestamptz
        AND (
          $2::uuid IS NULL
          OR EXISTS (
            SELECT 1 FROM audit_log al
            WHERE al.entity_type = 'user'
              AND al.entity_id = u.id
              AND al.action = 'user.pii.erased'
              AND al.actor_user_id = $2::uuid
          )
        )
      `,
      [sinceIso, adminId],
    );

    const items: ErasedCandidateRow[] = itemsRes.rows.map((r) => ({
      userId: r.user_id,
      erasedAt: r.erased_at,
      erasedById: r.erased_by_id,
      erasedByName: r.erased_by_name,
      erasedByEmail: r.erased_by_email,
      reason: r.reason,
      attemptsKept: r.attempts_kept,
      certsKept: r.certs_kept,
    }));

    return { items, total: totalRes.rows[0]?.n ?? 0 };
  });
}
