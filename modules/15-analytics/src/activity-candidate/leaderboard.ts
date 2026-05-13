// AssessIQ — modules/15-analytics/src/activity-candidate/leaderboard.ts
//
// Phase 10 — GET /api/me/activity/leaderboard
//
// Returns the candidate's personal pack leaderboard: one row per pack the
// candidate has attempted, showing their best score and rank among all tenant
// candidates who took that same pack.
//
// Data source: live `attempts` table (NOT attempt_summary_mv).
// RLS is enforced via withTenant GUC; no explicit tenant_id filter needed on
// live tables.
//
// Uses RANK() OVER (PARTITION BY pack_id ORDER BY best_pct DESC NULLS LAST) to
// compute per-pack candidate rankings without exposing other users' raw scores.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CandidateLeaderboardItem {
  rank: number;
  packId: string | null;
  packName: string | null;
  domain: string | null;
  bestScore: number | null;       // auto_pct value (0–100 scale)
  attemptCount: number;
  rankInPack: number | null;      // candidate's rank among all tenant takers for this pack
  totalCandidatesInPack: number;
}

export interface CandidateActivityLeaderboardResponse {
  page: number;
  pageSize: number;
  totalItems: number;
  items: CandidateLeaderboardItem[];
}

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

export const CandidateLeaderboardQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 1))
    .pipe(z.number().int().min(1).max(1000)),
  pageSize: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 10))
    .pipe(z.number().int().min(1).max(50)),
});
export type CandidateLeaderboardQuery = z.infer<typeof CandidateLeaderboardQuerySchema>;

// ---------------------------------------------------------------------------
// Session helper
// ---------------------------------------------------------------------------

type SessionReq = { session: { tenantId: string; userId: string } };
function sess(req: unknown): SessionReq['session'] {
  return (req as unknown as SessionReq).session;
}

// ---------------------------------------------------------------------------
// Raw DB row types
// ---------------------------------------------------------------------------

interface LeaderboardRow {
  pack_id: string | null;
  pack_name: string | null;
  domain: string | null;
  best_score: number | null;
  attempt_count: number;
  rank_in_pack: number | null;
  total_candidates_in_pack: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export async function queryCandidateLeaderboardRows(
  client: PoolClient,
  userId: string,
  pageSize: number,
  offset: number,
): Promise<LeaderboardRow[]> {
  const result = await client.query<{
    pack_id: string | null;
    pack_name: string | null;
    domain: string | null;
    best_score: string | null;
    attempt_count: string;
    rank_in_pack: string | null;
    total_candidates_in_pack: string;
  }>(
    `WITH my_packs AS (
       SELECT
         ass.pack_id,
         MAX(ats.auto_pct)  AS best_pct,
         COUNT(*)::int      AS attempt_count
       FROM attempts a
       JOIN assessments ass ON ass.id = a.assessment_id
       LEFT JOIN attempt_scores ats ON ats.attempt_id = a.id
       WHERE a.user_id = $1
         AND a.submitted_at IS NOT NULL
         AND a.status IN ('submitted','auto_submitted','graded','released','pending_admin_grading')
       GROUP BY ass.pack_id
     ),
     all_best AS (
       SELECT
         ass.pack_id,
         a.user_id,
         MAX(ats.auto_pct) AS best_pct
       FROM attempts a
       JOIN assessments ass ON ass.id = a.assessment_id
       LEFT JOIN attempt_scores ats ON ats.attempt_id = a.id
       WHERE ass.pack_id IN (SELECT pack_id FROM my_packs)
         AND a.submitted_at IS NOT NULL
         AND a.status IN ('submitted','auto_submitted','graded','released','pending_admin_grading')
       GROUP BY ass.pack_id, a.user_id
     ),
     ranked AS (
       SELECT
         pack_id,
         user_id,
         best_pct,
         RANK() OVER (PARTITION BY pack_id ORDER BY best_pct DESC NULLS LAST)::int AS rank_in_pack,
         COUNT(*) OVER (PARTITION BY pack_id)::int                                 AS total_in_pack
       FROM all_best
     )
     SELECT
       mp.pack_id,
       qp.name                                       AS pack_name,
       qp.domain,
       mp.best_pct                                   AS best_score,
       mp.attempt_count,
       r.rank_in_pack,
       r.total_in_pack                               AS total_candidates_in_pack
     FROM my_packs mp
     LEFT JOIN ranked r ON r.pack_id = mp.pack_id AND r.user_id = $1
     LEFT JOIN question_packs qp ON qp.id = mp.pack_id
     ORDER BY mp.best_pct DESC NULLS LAST, qp.name ASC
     LIMIT $2 OFFSET $3`,
    [userId, pageSize, offset],
  );

  return result.rows.map((r) => ({
    pack_id: r.pack_id,
    pack_name: r.pack_name,
    domain: r.domain,
    best_score: r.best_score != null ? parseFloat(r.best_score as unknown as string) : null,
    attempt_count: parseInt(r.attempt_count as unknown as string, 10),
    rank_in_pack: r.rank_in_pack != null ? parseInt(r.rank_in_pack as unknown as string, 10) : null,
    total_candidates_in_pack: parseInt(r.total_candidates_in_pack as unknown as string, 10),
  }));
}

export async function queryCandidateLeaderboardTotal(
  client: PoolClient,
  userId: string,
): Promise<number> {
  const result = await client.query<{ total: string }>(
    `SELECT COUNT(DISTINCT ass.pack_id)::text AS total
     FROM attempts a
     JOIN assessments ass ON ass.id = a.assessment_id
     WHERE a.user_id = $1
       AND a.submitted_at IS NOT NULL
       AND a.status IN ('submitted','auto_submitted','graded','released','pending_admin_grading')`,
    [userId],
  );
  return parseInt(result.rows[0]?.total ?? '0', 10);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export async function getCandidateActivityLeaderboard(
  tenantId: string,
  userId: string,
  query: CandidateLeaderboardQuery,
): Promise<CandidateActivityLeaderboardResponse> {
  const page     = query.page;
  const pageSize = query.pageSize;
  const offset   = (page - 1) * pageSize;

  return withTenant(tenantId, async (client) => {
    const [rows, totalItems] = await Promise.all([
      queryCandidateLeaderboardRows(client, userId, pageSize, offset),
      queryCandidateLeaderboardTotal(client, userId),
    ]);

    return {
      page,
      pageSize,
      totalItems,
      items: rows.map((r, i) => ({
        rank: offset + i + 1,
        packId: r.pack_id,
        packName: r.pack_name,
        domain: r.domain,
        bestScore: r.best_score,
        attemptCount: r.attempt_count,
        rankInPack: r.rank_in_pack,
        totalCandidatesInPack: r.total_candidates_in_pack,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerCandidateActivityLeaderboardRoute(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[],
): void {
  app.get('/api/me/activity/leaderboard', { preHandler }, async (req, reply) => {
    const parsed = CandidateLeaderboardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters', {
        details: { validation: parsed.error.errors },
      });
    }
    const { tenantId, userId } = sess(req);
    const data = await getCandidateActivityLeaderboard(tenantId, userId, parsed.data);
    return reply.send({ data });
  });
}
