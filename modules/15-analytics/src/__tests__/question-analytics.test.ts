/**
 * X6b — getAssessmentQuestionAnalytics + GET /api/admin/assessments/:id/question-analytics.
 * postgres:16 testcontainer; every migration applied; rows seeded directly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { AppError } from '@assessiq/core';
import { setPoolForTesting, closePool } from '@assessiq/tenancy';
import { applyAllMigrations } from '../../../../tools/test-support/apply-all-migrations.js';

vi.mock('@assessiq/audit-log', () => ({ audit: vi.fn(async () => undefined) }));

import { registerAnalyticsRoutes } from '../routes.js';
import {
  getAssessmentQuestionAnalytics,
  flagQuestion,
  FLAG_MIN_ATTEMPTS,
  FLAG_LOW_SHARE,
  FLAG_HIGH_SHARE,
} from '../question-analytics.js';

let container: StartedTestContainer;
let url: string;
async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const tenantA = randomUUID();
const tenantB = randomUUID();
const adminA = randomUUID();
const adminB = randomUUID();

interface Pack { tenant: string; admin: string; packId: string; level: string; assessment: string }
async function seedPack(c: Client, tenant: string, admin: string, slug: string): Promise<Pack> {
  const packId = randomUUID(); const level = randomUUID(); const assessment = randomUUID();
  await c.query(`INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by) VALUES ($1,$2,$3,$3,'x','published',$4)`, [packId, tenant, slug, admin]);
  await c.query(`INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count) VALUES ($1,$2,1,'L1',60,3)`, [level, packId]);
  await c.query(`INSERT INTO assessments (id,tenant_id,pack_id,level_id,name,status,pack_version,question_count,created_by) VALUES ($1,$2,$3,$4,'A','active',1,3,$5)`, [assessment, tenant, packId, level, admin]);
  return { tenant, admin, packId, level, assessment };
}
async function seedQuestion(c: Client, p: Pack): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,created_by)
     VALUES ($1,$2,$3,'mcq','t',10,'active','{"question":"Stem text","options":["A","B","C"],"correct":0,"rationale":"R"}',$4)`,
    [id, p.packId, p.level, p.admin]);
  return id;
}
interface G { q: string; ok: boolean; answer: unknown; time: number }
/** assessmentOf = which assessment the attempt belongs to (its tenant is p.tenant). */
async function seedAttempt(c: Client, p: Pack, status: string, released: boolean, gs: G[]): Promise<void> {
  const user = randomUUID(); const att = randomUUID();
  await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,$3,'C','candidate','active')`, [user, p.tenant, `${user}@t.test`]);
  await c.query(
    `INSERT INTO attempts (id,tenant_id,assessment_id,user_id,status,started_at,submitted_at,ends_at,duration_seconds,evaluation_released_at)
     VALUES ($1,$2,$3,$4,$5,now()-interval '2 hours',now()-interval '1 hour',now()+interval '1 hour',3600,$6)`,
    [att, p.tenant, p.assessment, user, status, released ? new Date() : null]);
  let pos = 1; let total = 0; let max = 0;
  for (const g of gs) {
    await c.query(`INSERT INTO attempt_questions (attempt_id,question_id,position,question_version) VALUES ($1,$2,$3,1)`, [att, g.q, pos++]);
    await c.query(`INSERT INTO attempt_answers (attempt_id,question_id,answer,time_spent_seconds) VALUES ($1,$2,$3::jsonb,$4)`, [att, g.q, JSON.stringify(g.answer), g.time]);
    await c.query(
      `INSERT INTO gradings (attempt_id,question_id,tenant_id,grader,score_earned,score_max,status,reasoning_band,prompt_version_sha,prompt_version_label,model)
       VALUES ($1,$2,$3,'deterministic',$4,10,$5,0,$6,'v1','deterministic')`,
      [att, g.q, p.tenant, g.ok ? 10 : 0, g.ok ? 'correct' : 'incorrect', `sha:${randomUUID()}`]);
    total += g.ok ? 10 : 0; max += 10;
  }
  await c.query(`INSERT INTO attempt_scores (attempt_id,tenant_id,total_earned,total_max,auto_pct,pending_review) VALUES ($1,$2,$3,$4,$5,false)`, [att, p.tenant, total, max, max ? (100 * total) / max : 0]);
}

let pA: Pack; let pB: Pack;
let qA = ''; let qB = ''; let qC = '';

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .withEnvironment({ POSTGRES_USER: 'assessiq', POSTGRES_PASSWORD: 'assessiq', POSTGRES_DB: 'aiq_test' })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://assessiq:assessiq@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;
  await sup(async (c) => {
    await c.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await applyAllMigrations(c);
    await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,'A',$3),($2,'B',$4)`, [tenantA, tenantB, `a-${tenantA.slice(0, 8)}`, `b-${tenantB.slice(0, 8)}`]);
    await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,'a@a.test','AdminA','admin','active'),($3,$4,'b@b.test','AdminB','admin','active')`, [adminA, tenantA, adminB, tenantB]);

    pA = await seedPack(c, tenantA, adminA, 'pa');
    qA = await seedQuestion(c, pA); qB = await seedQuestion(c, pA); qC = await seedQuestion(c, pA);
    // 25 released attempts. qA: 3 correct (pick A, 20s), 12 pick B (10s), 10 pick C (10s) -> avg 11.2s.
    // qB: 12 correct ({selected:0}), 13 wrong (bare number 1), all 5s.
    // qC: first 10 attempts only, all wrong (pick C) -> below the 20 attempt floor.
    for (let i = 0; i < 25; i++) {
      const a: G = i < 3 ? { q: qA, ok: true, answer: 0, time: 20 } : i < 15 ? { q: qA, ok: false, answer: 1, time: 10 } : { q: qA, ok: false, answer: { selected: 2 }, time: 10 };
      const b: G = i < 12 ? { q: qB, ok: true, answer: { selected: 0 }, time: 5 } : { q: qB, ok: false, answer: 1, time: 5 };
      const gs = [a, b];
      if (i < 10) gs.push({ q: qC, ok: false, answer: 2, time: 8 });
      await seedAttempt(c, pA, i % 2 ? 'released' : 'graded', true, gs);
    }
    // Not tenant-visible: graded without release, submitted. Must not be counted.
    await seedAttempt(c, pA, 'graded', false, [{ q: qA, ok: true, answer: 0, time: 99 }]);

    // Tenant B: its own assessment, plus attempts that point at tenant A's question qA (hostile data).
    pB = await seedPack(c, tenantB, adminB, 'pb');
    for (let i = 0; i < 25; i++) {
      await seedAttempt(c, pB, 'released', true, [{ q: qA, ok: true, answer: 0, time: 1 }]);
    }
  });
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

describe('getAssessmentQuestionAnalytics (real DB)', () => {
  it('returns exact counts, share, average time, distractors and flags', async () => {
    const rows = await getAssessmentQuestionAnalytics({ tenantId: tenantA, assessmentId: pA.assessment });
    expect(rows).toHaveLength(3);
    const by = (q: string) => rows.find((r) => r.question_id === q)!;

    const a = by(qA);
    expect(a).toMatchObject({ pack_id: pA.packId, type: 'mcq', stem_preview: 'Stem text', attempts: 25, correct_count: 3, possibly_bad: true });
    expect(a.share_correct).toBeCloseTo(0.12, 10);
    expect(a.avg_time_seconds).toBe(11.2);
    expect(a.distractors).toEqual([{ option_index: 0, count: 3 }, { option_index: 1, count: 12 }, { option_index: 2, count: 10 }]);
    expect(a.flag_reason).toMatch(/12%/);

    const b = by(qB);
    expect(b).toMatchObject({ attempts: 25, correct_count: 12, avg_time_seconds: 5, possibly_bad: false, flag_reason: null });
    expect(b.share_correct).toBeCloseTo(0.48, 10);
    expect(b.distractors).toEqual([{ option_index: 0, count: 12 }, { option_index: 1, count: 13 }]);

    const c = by(qC);
    expect(c).toMatchObject({ attempts: 10, correct_count: 0, share_correct: 0, avg_time_seconds: 8, possibly_bad: false });
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3]);
  });
});

describe('tenant isolation (real DB)', () => {
  it('tenant B data never counts for tenant A, and B sees none of A\'s questions', async () => {
    const a = await getAssessmentQuestionAnalytics({ tenantId: tenantA, assessmentId: pA.assessment });
    expect(a.find((r) => r.question_id === qA)!.attempts).toBe(25); // 25 hostile B attempts on qA are ignored
    const b = await getAssessmentQuestionAnalytics({ tenantId: tenantB, assessmentId: pB.assessment });
    expect(b).toEqual([]); // qA belongs to a tenant A pack
  });

  it('404 for an assessment of another tenant, through the route too', async () => {
    await expect(getAssessmentQuestionAnalytics({ tenantId: tenantA, assessmentId: pB.assessment }))
      .rejects.toMatchObject({ status: 404 });

    const app = Fastify();
    app.setErrorHandler((err: Error, _req, reply) => {
      const e = err instanceof AppError ? err : null;
      void reply.status(e?.status ?? 500).send({ error: { code: e?.code, message: err.message } });
    });
    const gate = async (req: FastifyRequest & { session?: unknown }, _reply: FastifyReply) => {
      req.session = { tenantId: tenantA, userId: adminA };
    };
    void registerAnalyticsRoutes(app, { adminOnly: gate, superAdminOnly: gate, candidateOnly: gate });
    const own = await app.inject({ method: 'GET', url: `/api/admin/assessments/${pA.assessment}/question-analytics` });
    expect(own.statusCode).toBe(200);
    expect(own.json().items).toHaveLength(3);
    const foreign = await app.inject({ method: 'GET', url: `/api/admin/assessments/${pB.assessment}/question-analytics` });
    expect(foreign.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/admin/assessments/nope/question-analytics' })).statusCode).toBe(400);
  });
});

describe('flagQuestion boundaries', () => {
  it('uses the exported constants', () => {
    expect([FLAG_MIN_ATTEMPTS, FLAG_LOW_SHARE, FLAG_HIGH_SHARE]).toEqual([20, 0.2, 0.98]);
  });
  it('needs 20 attempts', () => {
    expect(flagQuestion(19, 0).possibly_bad).toBe(false);
    expect(flagQuestion(20, 0).possibly_bad).toBe(true);
  });
  it('0.2 exactly is not flagged, just below is', () => {
    expect(flagQuestion(50, 10 / 50).possibly_bad).toBe(false);
    expect(flagQuestion(50, 9 / 50).possibly_bad).toBe(true);
  });
  it('0.98 exactly is not flagged, just above is', () => {
    expect(flagQuestion(50, 49 / 50).possibly_bad).toBe(false);
    expect(flagQuestion(100, 99 / 100).possibly_bad).toBe(true);
  });
  it('no share, no flag', () => {
    expect(flagQuestion(0, null)).toEqual({ possibly_bad: false, flag_reason: null });
  });
});
