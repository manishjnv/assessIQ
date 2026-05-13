// AssessIQ — modules/15-analytics/src/activity/heatmap.ts
//
// GET /api/admin/activity/heatmap?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Data source: LIVE `attempts` table (NOT attempt_summary_mv).
// The MV is nightly-refreshed; same-day completions must appear immediately.
// RLS is enforced via withTenant GUC — no explicit tenant_id filter needed.
//
// Streak computation is done in TypeScript (O(365) iteration), NOT in SQL.
// Zero-fill uses UTC dates throughout — no local-timezone math.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// INVARIANT: NEVER query attempt_summary_mv from this file.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivityHeatmapDay {
  date: string; // YYYY-MM-DD
  count: number;
}

export interface ActivityHeatmapResponse {
  from: string;
  to: string;
  days: ActivityHeatmapDay[];
  totals: { total: number; avgPerDay: number; activeDays: number };
  streaks: { current: number; longest: number };
}

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

export const ActivityHeatmapQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD')
    .optional(),
});

export type ActivityHeatmapQuery = z.infer<typeof ActivityHeatmapQuerySchema>;

// ---------------------------------------------------------------------------
// Pure helpers (exported for test reuse)
// ---------------------------------------------------------------------------

/**
 * Zero-fill the date range [from, to] inclusive using UTC dates.
 * `counts` is a Map<YYYY-MM-DD, number> from the DB query.
 */
export function zeroFillRange(
  from: string,
  to: string,
  counts: Map<string, number>,
): ActivityHeatmapDay[] {
  const days: ActivityHeatmapDay[] = [];

  // Parse endpoints as UTC midnight to avoid any DST / local-tz drift.
  const fromMs = Date.UTC(
    parseInt(from.slice(0, 4), 10),
    parseInt(from.slice(5, 7), 10) - 1,
    parseInt(from.slice(8, 10), 10),
  );
  const toMs = Date.UTC(
    parseInt(to.slice(0, 4), 10),
    parseInt(to.slice(5, 7), 10) - 1,
    parseInt(to.slice(8, 10), 10),
  );

  const ONE_DAY_MS = 86_400_000;

  for (let ms = fromMs; ms <= toMs; ms += ONE_DAY_MS) {
    const date = new Date(ms).toISOString().slice(0, 10);
    days.push({ date, count: counts.get(date) ?? 0 });
  }

  return days;
}

/**
 * Compute current and longest streaks from a chronologically ordered day array.
 *
 * Edge cases:
 *   - Empty range  → { current: 0, longest: 0 }
 *   - All zeros    → { current: 0, longest: 0 }
 *   - All positive → { current: days.length, longest: days.length }
 *   - Single day   → { current: 1|0, longest: 1|0 } depending on count
 *
 * "current" = streak ending at the LAST day in the array (today). If the last
 * day has count = 0, current = 0 regardless of what precedes it.
 */
export function computeStreaks(days: ActivityHeatmapDay[]): {
  current: number;
  longest: number;
} {
  if (days.length === 0) return { current: 0, longest: 0 };

  let longestStreak = 0;
  let runningStreak = 0;

  for (const day of days) {
    if (day.count > 0) {
      runningStreak += 1;
      if (runningStreak > longestStreak) longestStreak = runningStreak;
    } else {
      runningStreak = 0;
    }
  }

  // "current" is the streak that includes the final day.
  // After the loop, runningStreak holds the streak ending at the last element
  // (it was reset to 0 if the last element had count = 0, or is the run length
  // if the last element had count > 0).
  const currentStreak = runningStreak;

  return { current: currentStreak, longest: longestStreak };
}

// ---------------------------------------------------------------------------
// Repository — live attempts table, RLS via withTenant GUC
// ---------------------------------------------------------------------------

export async function queryActivityHeatmapCounts(
  client: PoolClient,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  // $1 = start of range (inclusive), $2 = end of range date (the query adds
  // interval '1 day' to make the upper bound exclusive — i.e. < to+1day).
  const result = await client.query<{ date: string; count: string }>(
    `SELECT
       to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
       COUNT(*)::text AS count
     FROM attempts
     WHERE submitted_at IS NOT NULL
       AND submitted_at >= $1::timestamptz
       AND submitted_at <  $2::timestamptz + interval '1 day'
       AND status IN ('submitted', 'auto_submitted', 'graded', 'released', 'pending_admin_grading')
     GROUP BY 1
     ORDER BY 1`,
    [`${from}T00:00:00Z`, `${to}T00:00:00Z`],
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

export async function getActivityHeatmap(
  tenantId: string,
  query: ActivityHeatmapQuery,
): Promise<ActivityHeatmapResponse> {
  // Defaults: to = today (UTC), from = today - 365 days (full calendar year).
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
    queryActivityHeatmapCounts(client, from, to),
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

type SessionReq = { session: { tenantId: string; userId: string } };
function sess(req: unknown): SessionReq['session'] {
  return (req as unknown as SessionReq).session;
}

export function registerActivityHeatmapRoute(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[],
): void {
  // GET /api/admin/activity/heatmap
  app.get('/api/admin/activity/heatmap', { preHandler }, async (req, reply) => {
    const parsed = ActivityHeatmapQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters', {
        details: { validation: parsed.error.errors },
      });
    }
    const { tenantId } = sess(req);
    const result = await getActivityHeatmap(tenantId, parsed.data);
    return reply.send({ data: result });
  });
}
