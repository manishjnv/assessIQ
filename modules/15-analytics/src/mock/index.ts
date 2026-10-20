// AssessIQ — modules/15-analytics/src/mock/index.ts
//
// Z-90 — read-only "Mock results" dashboard for school / company admins.
//   GET /api/admin/mock/summary?assessmentId=
//   GET /api/admin/mock/topics?assessmentId=
//   GET /api/admin/mock/students?assessmentId=
//   GET /api/admin/mock/trend?userId=&assessmentId=
//   GET /api/admin/mock/not-taken?assessmentId=   (required)
//
// Reads LIVE tables only (attempts.delivery_mode = 'mock'). attempt_summary_mv and
// question_stats_mv are real-only since migration 0219 and are never read here.
// No export, no scoring change, no answer keys. Every query runs inside withTenant
// (RLS) and also filters attempts.tenant_id explicitly.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';

const Q = z.object({
  assessmentId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});
const QNotTaken = z.object({ assessmentId: z.string().uuid() });

// Submitted or later; never draft / in_progress.
const DONE = `('submitted','auto_submitted','pending_admin_grading','graded','released')`;

// Mock attempts of the caller's tenant, optional assessment ($1) and user ($2) filter, with score %.
const MOCK_CTE = `m AS (
  SELECT a.id, a.user_id, a.assessment_id, a.submitted_at,
         CASE WHEN s.total_max > 0 THEN s.total_earned / s.total_max * 100 END AS pct
    FROM attempts a
    LEFT JOIN attempt_scores s ON s.attempt_id = a.id
   WHERE a.tenant_id = current_setting('app.current_tenant', true)::uuid
     AND a.delivery_mode = 'mock'
     AND a.status IN ${DONE}
     AND ($1::uuid IS NULL OR a.assessment_id = $1::uuid)
     AND ($2::uuid IS NULL OR a.user_id = $2::uuid)
)`;

const n1 = (v: string | number | null): number | null => (v === null ? null : Math.round(Number(v) * 10) / 10);

export interface MockSummary {
  mock_attempts: number;
  students: number;
  completed_pct: number;
  avg_score_pct: number | null;
  by_assessment: Array<{
    assessment_id: string; name: string; attempts: number;
    avg_score_pct: number | null; last_taken_at: string | null;
  }>;
}

export async function queryMockSummary(client: PoolClient, assessmentId: string | null): Promise<MockSummary> {
  const tot = await client.query<{ attempts: string; students: string; avg: string | null }>(
    `WITH ${MOCK_CTE}
     SELECT COUNT(*)::text AS attempts, COUNT(DISTINCT user_id)::text AS students, AVG(pct)::text AS avg FROM m`,
    [assessmentId, null],
  );
  // "Completed" = share of mock invitations that ended in a submitted attempt.
  const inv = await client.query<{ total: string; done: string }>(
    `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE status = 'submitted')::text AS done
       FROM assessment_invitations
      WHERE delivery_mode = 'mock' AND ($1::uuid IS NULL OR assessment_id = $1::uuid)`,
    [assessmentId],
  );
  const by = await client.query<{
    assessment_id: string; name: string; attempts: string; avg: string | null; last: Date | null;
  }>(
    `WITH ${MOCK_CTE}
     SELECT m.assessment_id, ass.name, COUNT(*)::text AS attempts, AVG(m.pct)::text AS avg, MAX(m.submitted_at) AS last
       FROM m JOIN assessments ass ON ass.id = m.assessment_id
      GROUP BY m.assessment_id, ass.name
      ORDER BY MAX(m.submitted_at) DESC NULLS LAST, ass.name`,
    [assessmentId, null],
  );
  const t = tot.rows[0];
  const total = Number(inv.rows[0]?.total ?? 0);
  return {
    mock_attempts: Number(t?.attempts ?? 0),
    students: Number(t?.students ?? 0),
    completed_pct: total > 0 ? Math.round((Number(inv.rows[0]?.done ?? 0) / total) * 100) : 0,
    avg_score_pct: n1(t?.avg ?? null),
    by_assessment: by.rows.map((r) => ({
      assessment_id: r.assessment_id, name: r.name, attempts: Number(r.attempts),
      avg_score_pct: n1(r.avg), last_taken_at: r.last ? r.last.toISOString() : null,
    })),
  };
}

export interface MockTopic { topic: string; attempts_graded: number; correct_pct: number }
export interface MockTopics { topics: MockTopic[]; strongest: MockTopic[]; weakest: MockTopic[] }

export async function queryMockTopics(client: PoolClient, assessmentId: string | null): Promise<MockTopics> {
  // Effective grading = newest graded_at, admin_override wins a tie (same rule as 09-scoring).
  // review_needed rows are not final, so they are not counted.
  const res = await client.query<{ topic: string; graded: string; correct: string }>(
    `WITH ${MOCK_CTE},
     eff AS (
       SELECT DISTINCT ON (g.attempt_id, g.question_id)
              g.attempt_id, g.question_id, g.score_earned, g.score_max, g.status
         FROM gradings g
        WHERE g.attempt_id IN (SELECT id FROM m)
        ORDER BY g.attempt_id, g.question_id, g.graded_at DESC, (g.grader = 'admin_override') DESC)
     SELECT COALESCE(NULLIF(btrim(q.topic), ''),
                     NULLIF(ass.settings->'sections'->aq.section_index->>'name', ''),
                     'General') AS topic,
            COUNT(*)::text AS graded,
            COUNT(*) FILTER (WHERE eff.score_max > 0 AND eff.score_earned = eff.score_max)::text AS correct
       FROM eff
       JOIN m ON m.id = eff.attempt_id
       JOIN assessments ass ON ass.id = m.assessment_id
       JOIN attempt_questions aq ON aq.attempt_id = eff.attempt_id AND aq.question_id = eff.question_id
       JOIN questions q ON q.id = eff.question_id
      WHERE eff.status <> 'review_needed'
      GROUP BY 1`,
    [assessmentId, null],
  );
  const topics = res.rows
    .map((r) => ({
      topic: r.topic,
      attempts_graded: Number(r.graded),
      correct_pct: Math.round((Number(r.correct) / Number(r.graded)) * 1000) / 10,
    }))
    .sort((a, b) => b.correct_pct - a.correct_pct || a.topic.localeCompare(b.topic));
  return { topics, strongest: topics.slice(0, 5), weakest: [...topics].reverse().slice(0, 5) };
}

export interface MockStudent {
  user_id: string; name: string; mock_attempts: number;
  avg_score_pct: number | null; last_score_pct: number | null; last_taken_at: string | null;
}

export async function queryMockStudents(client: PoolClient, assessmentId: string | null): Promise<MockStudent[]> {
  const res = await client.query<{
    user_id: string; name: string; attempts: string; avg: string | null; last_pct: string | null; last: Date | null;
  }>(
    `WITH ${MOCK_CTE}
     SELECT m.user_id, u.name, COUNT(*)::text AS attempts, AVG(m.pct)::text AS avg,
            (ARRAY_AGG(m.pct ORDER BY m.submitted_at DESC NULLS LAST))[1]::text AS last_pct,
            MAX(m.submitted_at) AS last
       FROM m JOIN users u ON u.id = m.user_id
      GROUP BY m.user_id, u.name
      ORDER BY AVG(m.pct) DESC NULLS LAST, u.name`,
    [assessmentId, null],
  );
  return res.rows.map((r) => ({
    user_id: r.user_id, name: r.name, mock_attempts: Number(r.attempts),
    avg_score_pct: n1(r.avg), last_score_pct: n1(r.last_pct), last_taken_at: r.last ? r.last.toISOString() : null,
  }));
}

export interface MockTrendPoint { date: string; score_pct: number; attempts: number }

export async function queryMockTrend(
  client: PoolClient, assessmentId: string | null, userId: string | null,
): Promise<MockTrendPoint[]> {
  const res = await client.query<{ date: string; avg: string; attempts: string }>(
    `WITH ${MOCK_CTE}
     SELECT to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
            AVG(pct)::text AS avg, COUNT(*)::text AS attempts
       FROM m WHERE pct IS NOT NULL AND submitted_at IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    [assessmentId, userId],
  );
  return res.rows.map((r) => ({ date: r.date, score_pct: n1(r.avg) ?? 0, attempts: Number(r.attempts) }));
}

export interface MockNotTaken { user_id: string; name: string; email: string; invited_at: string }

export async function queryMockNotTaken(client: PoolClient, assessmentId: string): Promise<MockNotTaken[]> {
  const res = await client.query<{ user_id: string; name: string; email: string; created_at: Date }>(
    `SELECT i.user_id, u.name, u.email, i.created_at
       FROM assessment_invitations i
       JOIN assessments ass ON ass.id = i.assessment_id
                           AND ass.tenant_id = current_setting('app.current_tenant', true)::uuid
       JOIN users u ON u.id = i.user_id AND u.erased_at IS NULL
      WHERE i.assessment_id = $1::uuid AND i.delivery_mode = 'mock'
        AND NOT EXISTS (SELECT 1 FROM attempts a
                         WHERE a.assessment_id = i.assessment_id AND a.user_id = i.user_id
                           AND a.delivery_mode = 'mock')
      ORDER BY u.name`,
    [assessmentId],
  );
  return res.rows.map((r) => ({
    user_id: r.user_id, name: r.name, email: r.email, invited_at: r.created_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Routes (admin only; tenant from the session)
// ---------------------------------------------------------------------------

function parse<T extends z.ZodTypeAny>(schema: T, query: unknown): z.infer<T> {
  const p = schema.safeParse(query);
  if (!p.success) {
    throw new ValidationError('invalid query parameters', { details: { validation: p.error.errors } });
  }
  return p.data;
}
const tenantOf = (req: unknown): string => (req as { session: { tenantId: string } }).session.tenantId;

export function registerMockRoutes(app: FastifyInstance, preHandler: preHandlerHookHandler[]): void {
  app.get('/api/admin/mock/summary', { preHandler }, async (req, reply) => {
    const q = parse(Q, req.query);
    const data = await withTenant(tenantOf(req), (c) => queryMockSummary(c, q.assessmentId ?? null));
    return reply.send({ data });
  });
  app.get('/api/admin/mock/topics', { preHandler }, async (req, reply) => {
    const q = parse(Q, req.query);
    const data = await withTenant(tenantOf(req), (c) => queryMockTopics(c, q.assessmentId ?? null));
    return reply.send({ data });
  });
  app.get('/api/admin/mock/students', { preHandler }, async (req, reply) => {
    const q = parse(Q, req.query);
    const data = await withTenant(tenantOf(req), (c) => queryMockStudents(c, q.assessmentId ?? null));
    return reply.send({ data });
  });
  app.get('/api/admin/mock/trend', { preHandler }, async (req, reply) => {
    const q = parse(Q, req.query);
    const data = await withTenant(tenantOf(req), (c) => queryMockTrend(c, q.assessmentId ?? null, q.userId ?? null));
    return reply.send({ data });
  });
  app.get('/api/admin/mock/not-taken', { preHandler }, async (req, reply) => {
    const q = parse(QNotTaken, req.query);
    const data = await withTenant(tenantOf(req), (c) => queryMockNotTaken(c, q.assessmentId));
    return reply.send({ data });
  });
}
