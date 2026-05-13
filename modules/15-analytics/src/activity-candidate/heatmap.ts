// AssessIQ — modules/15-analytics/src/activity-candidate/heatmap.ts
//
// Phase 10 — GET /api/me/activity/heatmap
//
// Returns the calling candidate's own daily activity heatmap. Mirrors the
// Phase 9 admin heatmap with an added user_id filter on the live attempts table.
//
// Data source: LIVE `attempts` table (NOT attempt_summary_mv).
// RLS is enforced via withTenant GUC — no explicit tenant_id filter needed.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// INVARIANT: NEVER query attempt_summary_mv from this file.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { PoolClient } from 'pg';
import { ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import {
  ActivityHeatmapQuerySchema,
  zeroFillRange,
  computeStreaks,
} from '../activity/heatmap.js';
import type {
  ActivityHeatmapQuery,
  ActivityHeatmapResponse,
} from '../activity/heatmap.js';

// Re-export types for consumers
export type { ActivityHeatmapQuery, ActivityHeatmapResponse };

// ---------------------------------------------------------------------------
// Session helper
// ---------------------------------------------------------------------------

type SessionReq = { session: { tenantId: string; userId: string } };
function sess(req: unknown): SessionReq['session'] {
  return (req as unknown as SessionReq).session;
}

// ---------------------------------------------------------------------------
// Repository — live attempts table, RLS via withTenant GUC + user_id filter
// ---------------------------------------------------------------------------

export async function queryCandidateHeatmapCounts(
  client: PoolClient,
  from: string,
  to: string,
  userId: string,
): Promise<Map<string, number>> {
  const result = await client.query<{ date: string; count: string }>(
    `SELECT
       to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
       COUNT(*)::text AS count
     FROM attempts
     WHERE submitted_at IS NOT NULL
       AND user_id = $3
       AND submitted_at >= $1::timestamptz
       AND submitted_at <  $2::timestamptz + interval '1 day'
       AND status IN ('submitted', 'auto_submitted', 'graded', 'released', 'pending_admin_grading')
     GROUP BY 1
     ORDER BY 1`,
    [`${from}T00:00:00Z`, `${to}T00:00:00Z`, userId],
  );

  const counts = new Map<string, number>();
  for (const row of result.rows) {
    counts.set(row.date, parseInt(row.count, 10));
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export async function getCandidateActivityHeatmap(
  tenantId: string,
  userId: string,
  query: ActivityHeatmapQuery,
): Promise<ActivityHeatmapResponse> {
  const today = new Date();
  const to = query.to ?? today.toISOString().slice(0, 10);

  let from: string;
  if (query.from !== undefined) {
    from = query.from;
  } else {
    const fromDate = new Date(`${to}T00:00:00Z`);
    fromDate.setUTCDate(fromDate.getUTCDate() - 365);
    from = fromDate.toISOString().slice(0, 10);
  }

  const counts = await withTenant(tenantId, (client) =>
    queryCandidateHeatmapCounts(client, from, to, userId),
  );

  const days = zeroFillRange(from, to, counts);

  const total = days.reduce((s, d) => s + d.count, 0);
  const activeDays = days.filter((d) => d.count > 0).length;
  const avgPerDay =
    days.length > 0 ? Math.round((total / days.length) * 10) / 10 : 0;
  const streaks = computeStreaks(days);

  return { from, to, days, totals: { total, avgPerDay, activeDays }, streaks };
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerCandidateActivityHeatmapRoute(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[],
): void {
  app.get('/api/me/activity/heatmap', { preHandler }, async (req, reply) => {
    const parsed = ActivityHeatmapQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters', {
        details: { validation: parsed.error.errors },
      });
    }
    const { tenantId, userId } = sess(req);
    const result = await getCandidateActivityHeatmap(tenantId, userId, parsed.data);
    return reply.send({ data: result });
  });
}
