// AssessIQ — modules/15-analytics/src/activity/timeline.ts
//
// Phase 9 — GET /api/admin/activity/timeline?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns a 52-week stacked-bar dataset showing attempt volume per ISO week,
// broken down by question-pack domain (raw slugs, no mapping per db020d1).
//
// Data source: attempt_summary_mv JOIN question_packs.
// CRITICAL: every query against attempt_summary_mv MUST include the literal
//   current_setting('app.current_tenant'
// The CI lint at tools/lint-mv-tenant-filter.ts enforces this invariant.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// CLAUDE.md rule #1.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivityTimelineBar {
  weekStart: string;   // YYYY-MM-DD (Monday)
  weekEnd: string;     // YYYY-MM-DD (Sunday)
  segments: number[];  // length === domains.length; segments[i] counts domains[i]
  total: number;
}

export interface ActivityTimelineResponse {
  from: string;        // YYYY-MM-DD (resolved after defaults)
  to: string;          // YYYY-MM-DD (resolved after defaults)
  domains: string[];   // raw slugs ordered by total DESC; tail collapsed to "other" if >8
  bars: ActivityTimelineBar[];
}

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

export const ActivityTimelineQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type ActivityTimelineQuery = z.infer<typeof ActivityTimelineQuerySchema>;

// ---------------------------------------------------------------------------
// Helpers — exported for consolidated test reuse
// ---------------------------------------------------------------------------

/**
 * Given an array of { domain, cnt } rows (one per domain, summed across the
 * whole range), return the ordered domain list to use as bar segments.
 *
 * Rules:
 *  - Sort by cnt DESC.
 *  - Keep top `maxKept` (≤ 7) explicitly. If there are more than maxKept + 1
 *    distinct domains, collapse the remainder into a single "other" slot so
 *    the total list length ≤ maxKept + 1 = 8.
 *  - If there are exactly maxKept + 1 domains, all 8 appear without "other".
 *  - If there are ≤ maxKept domains, no "other" slot is added.
 *
 * @param rows      Aggregated { domain, cnt } — one row per distinct domain.
 * @param maxKept   Max domains to show individually before collapsing (default 7).
 */
export function rankDomains(
  rows: Array<{ domain: string; cnt: number }>,
  maxKept: number = 7,
): string[] {
  // Sort descending by count
  const sorted = [...rows].sort((a, b) => b.cnt - a.cnt);

  if (sorted.length <= maxKept) {
    // ≤7 distinct domains — return all, no "other"
    return sorted.map((r) => r.domain);
  }

  if (sorted.length === maxKept + 1) {
    // Exactly 8 — return all 8, no collapsing needed
    return sorted.map((r) => r.domain);
  }

  // >8 — keep top maxKept, add "other" as the last slot
  const kept = sorted.slice(0, maxKept).map((r) => r.domain);
  return [...kept, 'other'];
}

/**
 * Zero-fill weeks across the [from, to] range.
 *
 * Iteration starts from the Monday on or before `from` and steps +7 days
 * until weekStart > to. Each bar gets a segments array parallel to `domains`.
 * Counts from `rows` are accumulated into the matching week+domain slot;
 * weeks or domains absent in `rows` remain 0.
 *
 * UTC throughout — no local-timezone math.
 *
 * @param from    Resolved from-date (YYYY-MM-DD, inclusive).
 * @param to      Resolved to-date  (YYYY-MM-DD, inclusive).
 * @param domains Ordered domain list from rankDomains().
 * @param rows    Raw grouped rows from queryActivityTimelineRows().
 */
export function zeroFillWeeks(
  from: string,
  to: string,
  domains: string[],
  rows: Array<{ week_start: string; domain: string; cnt: number }>,
): ActivityTimelineBar[] {
  // Build lookup: weekStart (YYYY-MM-DD) → domain → count
  // For "other" domains (those not in the kept list), aggregate into "other".
  const domainSet = new Set(domains);
  const lookup = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const slot = domainSet.has(row.domain) ? row.domain : 'other';
    // Only accumulate "other" if "other" is actually in the domain list
    if (slot === 'other' && !domainSet.has('other')) continue;

    let weekMap = lookup.get(row.week_start);
    if (!weekMap) {
      weekMap = new Map<string, number>();
      lookup.set(row.week_start, weekMap);
    }
    weekMap.set(slot, (weekMap.get(slot) ?? 0) + row.cnt);
  }

  // Find the Monday on or before `from`
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

  // ISO week starts Monday (day-of-week: Mon=1 … Sun=0 in JS, Mon=0 after mod)
  const fromDate = new Date(fromMs);
  const dayOfWeek = fromDate.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  // Days since Monday: Sun→6, Mon→0, Tue→1, …
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const firstMondayMs = fromMs - daysSinceMonday * 86_400_000;

  const bars: ActivityTimelineBar[] = [];
  const MS_PER_DAY = 86_400_000;
  const MS_PER_WEEK = 7 * MS_PER_DAY;

  let weekStartMs = firstMondayMs;
  while (weekStartMs <= toMs) {
    const weekEndMs = weekStartMs + 6 * MS_PER_DAY;

    const toYMD = (ms: number): string => {
      const d = new Date(ms);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dy = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${dy}`;
    };

    const weekStartStr = toYMD(weekStartMs);
    const weekMap = lookup.get(weekStartStr);

    const segments = domains.map((d) => weekMap?.get(d) ?? 0);
    const total = segments.reduce((acc, n) => acc + n, 0);

    bars.push({
      weekStart: weekStartStr,
      weekEnd:   toYMD(weekEndMs),
      segments,
      total,
    });

    weekStartMs += MS_PER_WEEK;
  }

  return bars;
}

// ---------------------------------------------------------------------------
// Repository — runs inside a withTenant callback (GUC already set)
// ---------------------------------------------------------------------------

export async function queryActivityTimelineRows(
  client: PoolClient,
  tenantId: string,
  from: string,
  to: string,
): Promise<Array<{ week_start: string; domain: string; cnt: number }>> {
  void tenantId; // tenantId used via withTenant GUC; explicit filter in SQL below

  const result = await client.query<{
    week_start: string; // text from Postgres (::text cast avoids pg-types Date parsing)
    domain: string;
    cnt: string;
  }>(
    `WITH bucketed AS (
       SELECT
         date_trunc('week', asm.submitted_at AT TIME ZONE 'UTC')::date::text AS week_start,
         COALESCE(qp.domain, 'unknown') AS domain,
         COUNT(*)::int AS cnt
       FROM attempt_summary_mv asm
       LEFT JOIN question_packs qp ON qp.id = asm.pack_id
       WHERE asm.tenant_id = current_setting('app.current_tenant', true)::uuid
         AND asm.submitted_at >= $1::timestamptz
         AND asm.submitted_at <  $2::timestamptz + interval '1 day'
       GROUP BY 1, 2
     )
     SELECT week_start, domain, cnt FROM bucketed ORDER BY week_start, domain`,
    [from, to],
  );

  return result.rows.map((r) => ({
    week_start: r.week_start,   // already a YYYY-MM-DD string (::text cast above)
    domain: r.domain,
    cnt: typeof r.cnt === 'number' ? r.cnt : parseInt(r.cnt as unknown as string, 10),
  }));
}

// ---------------------------------------------------------------------------
// Service — resolves defaults then delegates to withTenant
// ---------------------------------------------------------------------------

export async function getActivityTimeline(
  tenantId: string,
  query: ActivityTimelineQuery,
): Promise<ActivityTimelineResponse> {
  // Resolve defaults BEFORE entering withTenant (pure JS, no DB needed)
  const todayMs = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  const toYMD = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };

  const to   = query.to   ?? toYMD(todayMs);
  const from = query.from ?? toYMD(todayMs - 364 * 86_400_000); // today - 364 days = 52 weeks ago

  return withTenant(tenantId, async (client) => {
    const rows = await queryActivityTimelineRows(client, tenantId, from, to);

    // Compute per-domain totals for ranking
    const domainTotals = new Map<string, number>();
    for (const row of rows) {
      domainTotals.set(row.domain, (domainTotals.get(row.domain) ?? 0) + row.cnt);
    }
    const domainRows = Array.from(domainTotals.entries()).map(([domain, cnt]) => ({ domain, cnt }));

    const domains = rankDomains(domainRows, 7);
    const bars    = zeroFillWeeks(from, to, domains, rows);

    return { from, to, domains, bars };
  });
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerActivityTimelineRoute(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[],
): void {
  app.get('/api/admin/activity/timeline', { preHandler }, async (req, reply) => {
    const parsed = ActivityTimelineQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters', {
        details: { validation: parsed.error.errors },
      });
    }
    const tenantId = (req as unknown as { session: { tenantId: string } }).session.tenantId;
    const data = await getActivityTimeline(tenantId, parsed.data);
    return reply.send({ data });
  });
}
