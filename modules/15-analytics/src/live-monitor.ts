// AssessIQ — modules/15-analytics/src/live-monitor.ts
//
// X6a — admin live monitor for ONE assessment. Read-only SQL, no new table, no AI.
// Counts: invited / not started / in progress / submitted. Plus the last-seen time of every
// in-progress attempt = GREATEST(max(attempt_answers.saved_at), max(attempt_events.at), started_at).
// Never returns answers, scores or camera data. Names and email are the same fields the
// invitations table already shows to the admin.
//
// Tenancy: withTenant (RLS) AND an explicit tenant_id filter on every query.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { AppError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';

/** Attempt statuses that count as "submitted" (draft and cancelled count as neither started nor submitted). */
const SUBMITTED = ['submitted', 'auto_submitted', 'pending_admin_grading', 'graded', 'released'];
const LIST_CAP = 500; // ponytail: the list is capped, the counts are not; page it if one sitting passes 500.

export interface LiveMonitorResult {
  counts: { invited: number; not_started: number; in_progress: number; submitted: number };
  in_progress: Array<{
    attempt_id: string;
    user_id: string;
    name: string | null;
    email: string | null;
    started_at: string;
    last_seen_at: string;
  }>;
  server_time: string;
}

interface CountRow { invited: string; not_started: string; in_progress: string; submitted: string }
interface ListRow {
  attempt_id: string; user_id: string; name: string | null; email: string | null;
  started_at: Date; last_seen_at: Date;
}

export async function getLiveMonitor(args: { tenantId: string; assessmentId: string }): Promise<LiveMonitorResult> {
  const { tenantId, assessmentId } = args;
  return withTenant(tenantId, async (client) => {
    const own = await client.query(
      'SELECT 1 FROM assessments WHERE id = $1 AND tenant_id = $2',
      [assessmentId, tenantId],
    );
    if (own.rows.length === 0) throw new AppError('assessment not found', 'ASSESSMENT_NOT_FOUND', 404);

    const c = await client.query<CountRow>(
      `SELECT
         (SELECT count(*) FROM assessment_invitations i
           WHERE i.assessment_id = $2 AND i.status <> 'expired')::text AS invited,
         (SELECT count(*) FROM assessment_invitations i
           WHERE i.assessment_id = $2 AND i.status <> 'expired'
             AND NOT EXISTS (SELECT 1 FROM attempts a
                              WHERE a.tenant_id = $1 AND a.assessment_id = $2 AND a.user_id = i.user_id
                                AND a.status = ANY($3::text[])))::text AS not_started,
         (SELECT count(*) FROM attempts a
           WHERE a.tenant_id = $1 AND a.assessment_id = $2 AND a.status = 'in_progress')::text AS in_progress,
         (SELECT count(*) FROM attempts a
           WHERE a.tenant_id = $1 AND a.assessment_id = $2 AND a.status = ANY($4::text[]))::text AS submitted`,
      [tenantId, assessmentId, ['in_progress', ...SUBMITTED], SUBMITTED],
    );
    const r = c.rows[0]!;

    const l = await client.query<ListRow>(
      `SELECT a.id AS attempt_id, a.user_id, u.name, u.email,
              COALESCE(a.started_at, a.created_at) AS started_at,
              GREATEST(
                COALESCE(a.started_at, a.created_at),
                (SELECT max(x.saved_at) FROM attempt_answers x WHERE x.attempt_id = a.id),
                (SELECT max(e.at) FROM attempt_events e WHERE e.attempt_id = a.id)
              ) AS last_seen_at
         FROM attempts a
         JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
        WHERE a.tenant_id = $1 AND a.assessment_id = $2 AND a.status = 'in_progress'
        ORDER BY last_seen_at DESC, a.id
        LIMIT ${LIST_CAP}`,
      [tenantId, assessmentId],
    );

    return {
      counts: {
        invited: Number(r.invited),
        not_started: Number(r.not_started),
        in_progress: Number(r.in_progress),
        submitted: Number(r.submitted),
      },
      in_progress: l.rows.map((x) => ({
        attempt_id: x.attempt_id,
        user_id: x.user_id,
        name: x.name,
        email: x.email,
        started_at: x.started_at.toISOString(),
        last_seen_at: x.last_seen_at.toISOString(),
      })),
      server_time: new Date().toISOString(),
    };
  });
}
