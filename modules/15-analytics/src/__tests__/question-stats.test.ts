/**
 * RW-60 / FU-C14 — question_stats_mv (migration 0189) + getQuestionStats + the super route.
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
import { computeMiscalibrated } from '../question-stats.js';

let container: StartedTestContainer;
let url: string;
async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const tenant = randomUUID();
const admin = randomUUID();
const platformTenant = randomUUID();
const tenant2 = randomUUID();

let T = ''; // tenant the seed helpers write into
interface Pack { packId: string; levels: string[]; assessment: string }
async function seedPack(c: Client, slug: string): Promise<Pack> {
  const packId = randomUUID();
  const levels = [randomUUID(), randomUUID(), randomUUID()];
  const assessment = randomUUID();
  await c.query(`INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by) VALUES ($1,$2,$3,$3,'x','published',$4)`, [packId, T, slug, admin]);
  for (let i = 0; i < 3; i++) {
    await c.query(`INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count) VALUES ($1,$2,$3,$4,60,3)`, [levels[i], packId, i + 1, `L${i + 1}`]);
  }
  await c.query(`INSERT INTO assessments (id,tenant_id,pack_id,level_id,name,status,pack_version,question_count,created_by) VALUES ($1,$2,$3,$4,'A','active',1,3,$5)`, [assessment, T, packId, levels[0], admin]);
  return { packId, levels, assessment };
}
async function seedQuestion(c: Client, p: Pack, levelIdx: number): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,created_by)
     VALUES ($1,$2,$3,'mcq','t',10,'active','{"question":"Q","options":["A","B"],"correct":0,"rationale":"R"}',$4)`,
    [id, p.packId, p.levels[levelIdx], admin]);
  return id;
}
/** One attempt for a fresh candidate; grades = [questionId, earned, max, status][] */
async function seedAttempt(
  c: Client, p: Pack, status: string, released: boolean,
  grades: Array<[string, number, number, string]>, exposed: string[] = [],
): Promise<string> {
  const user = randomUUID();
  const att = randomUUID();
  await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,$3,'C','candidate','active')`, [user, T, `${user}@t.test`]);
  await c.query(
    `INSERT INTO attempts (id,tenant_id,assessment_id,user_id,status,started_at,submitted_at,ends_at,duration_seconds,evaluation_released_at)
     VALUES ($1,$2,$3,$4,$5,now()-interval '2 hours',now()-interval '1 hour',now()+interval '1 hour',3600,$6)`,
    [att, T, p.assessment, user, status, released ? new Date() : null]);
  const qids = [...new Set([...grades.map((g) => g[0]), ...exposed])];
  let pos = 1;
  for (const q of qids) {
    await c.query(`INSERT INTO attempt_questions (attempt_id,question_id,position,question_version) VALUES ($1,$2,$3,1)`, [att, q, pos++]);
  }
  let total = 0; let max = 0;
  for (const [q, earned, mx, st] of grades) {
    await c.query(
      `INSERT INTO gradings (attempt_id,question_id,tenant_id,grader,score_earned,score_max,status,reasoning_band,prompt_version_sha,prompt_version_label,model)
       VALUES ($1,$2,$3,'deterministic',$4,$5,$6,$7,$8,'v1','deterministic')`,
      [att, q, T, earned, mx, st, st === 'correct' ? 4 : 0, `sha:${randomUUID()}`]);
    total += earned; max += mx;
  }
  await c.query(`INSERT INTO attempt_scores (attempt_id,tenant_id,total_earned,total_max,auto_pct,pending_review) VALUES ($1,$2,$3,$4,$5,false)`, [att, T, total, max, max ? (100 * total) / max : 0]);
  return att;
}

let p1: Pack; let q1 = ''; let q2 = ''; let q3 = '';
let p2: Pack; let qTop = '';
let platformQuestion = '';
let sourceQ = '';

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
    await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,'T',$3),($2,'Plat',$4)`, [tenant, platformTenant, `t-${tenant.slice(0, 8)}`, `p-${platformTenant.slice(0, 8)}`]);
    await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,'a@t.test','Admin','admin','active')`, [admin, tenant]);

    T = tenant;
    await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,'T2',$2)`, [tenant2, `t2-${tenant2.slice(0, 8)}`]);
    p1 = await seedPack(c, 'p1');
    q1 = await seedQuestion(c, p1, 0); q2 = await seedQuestion(c, p1, 1); q3 = await seedQuestion(c, p1, 2);
    // A1, A2 released; A3 graded + released_at; A4 submitted; A5 graded unreleased; A6 in_progress.
    const a1 = await seedAttempt(c, p1, 'released', true, [[q1, 10, 10, 'correct'], [q2, 0, 10, 'incorrect'], [q3, 5, 5, 'correct']]);
    await seedAttempt(c, p1, 'released', true, [[q1, 0, 10, 'incorrect'], [q2, 10, 10, 'correct'], [q3, 5, 5, 'correct']]);
    await seedAttempt(c, p1, 'graded', true, [[q1, 10, 10, 'correct'], [q2, 10, 10, 'correct'], [q3, 5, 5, 'correct']]);
    await seedAttempt(c, p1, 'submitted', false, [], [q1]);
    await seedAttempt(c, p1, 'graded', false, [[q1, 10, 10, 'correct']]);
    await seedAttempt(c, p1, 'in_progress', false, [], [q1]);
    // Older grading of A1/Q2 said correct; the newest row (incorrect, above) must win.
    await c.query(
      `INSERT INTO gradings (attempt_id,question_id,tenant_id,grader,score_earned,score_max,status,reasoning_band,prompt_version_sha,prompt_version_label,model,graded_at)
       VALUES ($1,$2,$3,'deterministic',10,10,'correct',4,'sha:old','v0','deterministic', now()-interval '1 day')`, [a1, q2, tenant]);

    // Pack 2: top-level item every candidate passes (32 attempts) -> miscalibrated.
    p2 = await seedPack(c, 'p2');
    qTop = await seedQuestion(c, p2, 2);
    const qLow = await seedQuestion(c, p2, 0);
    for (let i = 0; i < 32; i++) {
      await seedAttempt(c, p2, 'released', true, [[qTop, 10, 10, 'correct'], [qLow, i % 2 ? 10 : 0, 10, i % 2 ? 'correct' : 'incorrect']]);
    }

    // A question in the pack of the platform tenant (no attempts): exists, zero volume.
    const pp = randomUUID(); const pl = randomUUID(); const su = randomUUID(); platformQuestion = randomUUID();
    await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,'s@p.test','Super','super_admin','active')`, [su, platformTenant]);
    await c.query(`INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by) VALUES ($1,$2,'pp','pp','x','published',$3)`, [pp, platformTenant, su]);
    await c.query(`INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count) VALUES ($1,$2,1,'L1',60,1)`, [pl, pp]);
    await c.query(`INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,created_by) VALUES ($1,$2,$3,'mcq','t',10,'active','{"question":"Q","options":["A","B"],"correct":0,"rationale":"R"}',$4)`, [platformQuestion, pp, pl, su]);


    // Roll-up: platform source question, cloned into two tenants (migration 0084 provenance).
    T = platformTenant;
    const srcPack = await seedPack(c, 'src');
    sourceQ = await seedQuestion(c, srcPack, 0);
    const clone = async (t: string, slug: string, outcomes: boolean[]) => {
      T = t;
      const cp = await seedPack(c, slug);
      const cq = await seedQuestion(c, cp, 0);
      await c.query('UPDATE question_packs SET source_pack_id = $1 WHERE id = $2', [srcPack.packId, cp.packId]);
      await c.query('UPDATE questions SET source_question_id = $1 WHERE id = $2', [sourceQ, cq]);
      for (const ok of outcomes) {
        await seedAttempt(c, cp, 'released', true, [[cq, ok ? 10 : 0, 10, ok ? 'correct' : 'incorrect']]);
      }
    };
    await clone(tenant, 'clone1', [true, false]);
    await clone(tenant2, 'clone2', [true, true, true]);
    T = tenant;

    await c.query('REFRESH MATERIALIZED VIEW question_stats_mv');
  });
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

function buildApp() {
  const app = Fastify();
  app.setErrorHandler((err: Error, _req, reply) => {
    const e = err instanceof AppError ? err : null;
    void reply.status(e?.status ?? 500).send({ error: { code: e?.code, message: err.message } });
  });
  const gate = async (req: FastifyRequest & { session?: unknown }, reply: FastifyReply) => {
    if (req.headers['x-role'] !== 'super_admin') return reply.status(403).send({ error: 'forbidden' });
    req.session = { tenantId: platformTenant, userId: admin }; // platform tenant: must not be used
  };
  void registerAnalyticsRoutes(app, { adminOnly: gate, superAdminOnly: gate, candidateOnly: gate });
  return app;
}
const get = (id: string, role = 'super_admin') =>
  buildApp().inject({ method: 'GET', url: `/api/admin/super/questions/${id}/stats`, headers: { 'x-role': role } });

describe('question stats view (migration 0189)', () => {
  const row = (q: string) => sup(async (c) => {
    await c.query(`SELECT set_config('app.current_tenant', $1, false)`, [tenant]);
    return (await c.query(
      `SELECT * FROM question_stats_mv WHERE tenant_id = current_setting('app.current_tenant', true)::uuid AND question_id=$1`,
      [q],
    )).rows[0];
  });

  it('counts exposure over submitted+ attempts and attempts over tenant-visible ones only', async () => {
    const r = await row(q1);
    expect(Number(r.exposure_count)).toBe(5); // A1..A5; in_progress excluded
    expect(Number(r.attempts)).toBe(3); // A1, A2, A3; submitted + unreleased graded excluded
    expect(Number(r.correct_count)).toBe(2);
    expect(Number(r.correct_rate)).toBeCloseTo(0.6667, 4);
    expect(r.point_biserial).not.toBeNull();
  });

  it('newest grading per (attempt, question) wins', async () => {
    const r = await row(q2);
    expect(Number(r.attempts)).toBe(3);
    expect(Number(r.correct_count)).toBe(2); // A1/Q2 stays incorrect despite the older correct row
  });

  it('point_biserial is NULL on zero variance', async () => {
    const r = await row(q3);
    expect(Number(r.correct_rate)).toBe(1);
    expect(r.point_biserial).toBeNull();
  });
});

describe('GET /api/admin/super/questions/:id/stats', () => {
  it('returns stats, ordered gradient and no flag below 30 attempts', async () => {
    const res = await get(q1);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.question).toMatchObject({ id: q1, level_position: 1, level_label: 'L1' });
    expect(b.stats).toMatchObject({ attempts: 3, exposure_count: 5 });
    expect(b.gradient.map((g: { level_position: number }) => g.level_position)).toEqual([1, 2, 3]);
    expect(b.miscalibrated).toEqual({ flag: false, reason: null, min_attempts: 30 });
  });

  it('flags a top-level item that 30+ candidates all pass', async () => {
    const b = (await get(qTop)).json();
    expect(b.stats.attempts).toBe(32);
    expect(b.miscalibrated.flag).toBe(true);
    expect(b.miscalibrated.reason).toMatch(/too easy/);
  });

  it('rolls a platform source question up across its clones in all tenants', async () => {
    const b = (await get(sourceQ)).json();
    expect(b.scope).toBe('rollup');
    expect(b.clone_count).toBe(2);
    expect(b.stats).toMatchObject({ attempts: 5, exposure_count: 5 });
    expect(b.stats.correct_rate).toBeCloseTo(0.8, 4);
    expect(b.stats.mean_band).toBeCloseTo(0.8, 4); // (2 x 0.5 + 3 x 1) / 5
    expect(b.gradient.map((g: { attempts: number }) => g.attempts)).toEqual([5, 0, 0]);
    expect(b.gradient[0].mean_success).toBeCloseTo(0.8, 4);
    expect(b.gradient[1].mean_success).toBeNull();
  });

  it('keeps scope tenant for a question without clones', async () => {
    const b = (await get(q1)).json();
    expect(b.scope).toBe('tenant');
    expect(b.clone_count).toBe(0);
  });

  it('returns stats null for a question with no attempts', async () => {
    const b = (await get(platformQuestion)).json();
    expect(b.stats).toBeNull();
    expect(b.miscalibrated.flag).toBe(false);
  });

  it('404 QUESTION_NOT_FOUND, 400 bad id, 403 for non super admin', async () => {
    const nf = await get(randomUUID());
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('QUESTION_NOT_FOUND');
    expect((await get('nope')).statusCode).toBe(400);
    expect((await get(q1, 'admin')).statusCode).toBe(403);
  });
});

describe('computeMiscalibrated', () => {
  const g = (a: number | null, b: number | null, c: number | null) =>
    [a, b, c].map((m, i) => ({ level_position: i + 1, label: `L${i + 1}`, mean_success: m, attempts: 40 }));
  it('flags a lowest-level item nobody passes', () => {
    expect(computeMiscalibrated(0.2, 40, 1, g(0.2, 0.5, 0.3)).flag).toBe(true);
  });
  it('flags an inverted gradient beyond the 0.15 margin only', () => {
    expect(computeMiscalibrated(0.6, 40, 2, g(0.8, 0.6, 0.7)).flag).toBe(false);
    expect(computeMiscalibrated(0.6, 40, 2, g(0.4, 0.6, 0.3)).flag).toBe(true);
  });
  it('never flags under 30 attempts', () => {
    expect(computeMiscalibrated(1, 29, 3, g(0.9, 0.9, 1)).flag).toBe(false);
  });
});
