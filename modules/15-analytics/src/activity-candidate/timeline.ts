// AssessIQ — modules/15-analytics/src/activity-candidate/timeline.ts
//
// Phase 10 — GET /api/me/activity/timeline
//
// Returns the calling candidate's weekly activity timeline. Mirrors the Phase 9
// admin timeline with an added user_id filter on the attempt_summary_mv query.
//
// Data source: attempt_summary_mv JOIN question_packs.
// CRITICAL: every query against attempt_summary_mv MUST include the literal
//   current_setting('app.current_tenant'
// The CI lint at tools/lint-mv-tenant-filter.ts enforces this invariant.
// User_id filter is also required to scope to the calling candidate.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { PoolClient } from 'pg';
import { ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import {
  ActivityTimelineQuerySchema,
  rankDomains,
  zeroFillWeeks,
} from '../activity/timeline.js';
import type {
  ActivityTimelineQuery,
  ActivityTimelineResponse,
} from '../activity/timeline.js';

// Re-export types for consumers
export type { ActivityTimelineQuery, ActivityTimelineResponse };

// ---------------------------------------------------------------------------
// Session helper
// ---------------------------------------------------------------------------

type SessionReq = { session: { tenantId: string; userId: string } };
function sess(req: unknown): SessionReq['session'] {
  return (req as unknown as SessionReq).session;
}

// ---------------------------------------------------------------------------
// Repository — runs inside a withTenant callback (GUC already set)
// ---------------------------------------------------------------------------

export async function queryCandidateTimelineRows(
  client: PoolClient,
  from: string,
  to: string,
  userId: string,
): Promise<Array<{ week_start: string; domain: string; cnt: number }>> {
  const result = await client.query<{
    week_start: string;
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
         AND asm.user_id = $3
         AND asm.submitted_at >= $1::timestamptz
         AND asm.submitted_at <  $2::timestamptz + interval '1 day'
       GROUP BY 1, 2
     )
     SELECT week_start, domain, cnt FROM bucketed ORDER BY week_start, domain`,
    [from, to, userId],
  );

  return result.rows.map((r) => ({
    week_start: r.week_start,
    domain: r.domain,
    cnt: typeof r.cnt === 'number' ? r.cnt : parseInt(r.cnt as unknown as string, 10),
  }));
}

// ---------------------------------------------------------------------------
// Service — resolves defaults then delegates to withTenant
// ---------------------------------------------------------------------------

export async function getCandidateActivityTimeline(
  tenantId: string,
  userId: string,
  query: ActivityTimelineQuery,
): Promise<ActivityTimelineResponse> {
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
  const from = query.from ?? toYMD(todayMs - 364 * 86_400_000);

  return withTenant(tenantId, async (client) => {
    const rows = await queryCandidateTimelineRows(client, from, to, userId);

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

export function registerCandidateActivityTimelineRoute(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[],
): void {
  app.get('/api/me/activity/timeline', { preHandler }, async (req, reply) => {
    const parsed = ActivityTimelineQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters', {
        details: { validation: parsed.error.errors },
      });
    }
    const { tenantId, userId } = sess(req);
    const data = await getCandidateActivityTimeline(tenantId, userId, parsed.data);
    return reply.send({ data });
  });
}
