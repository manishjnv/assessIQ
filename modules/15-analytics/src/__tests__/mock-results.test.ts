/* eslint-disable @typescript-eslint/no-explicit-any -- test reads untyped JSON bodies */
/**
 * Z-90 — mock results endpoints (modules/15-analytics/src/mock) and the mock leak guard on the
 * admin activity leaderboard.
 * Happy path: summary / topics / students / trend / not-taken return only the caller's mock attempts.
 * Failure path: non-admin gets 403; a second tenant, real attempts and in-progress attempts never appear;
 * an empty tenant returns zeros and empty arrays.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { AppError } from '@assessiq/core';
import { setPoolForTesting, closePool } from '@assessiq/tenancy';
import { registerAnalyticsRoutes } from '../routes.js';
import { getActivityLeaderboard } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url)) + sep;
const MODULE_ROOT = join(HERE, '..', '..');
const MODULES_ROOT = join(MODULE_ROOT, '..');
const dir = (n: string) => join(MODULES_ROOT, n, 'migrations');

let container: StartedTestContainer;
let url: string;
const id = () => randomUUID();
const tenantA = id(), tenantB = id(), tenantC = id();
const adminA = id(), s1 = id(), s2 = id(), s3 = id(), s4 = id(), adminB = id(), sB = id(), adminC = id();
const mockAssessment = id(), realAssessment = id(), mockAssessmentB = id();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function apply(c: Client, d: string, only?: string[]) {
  const files = (await readdir(d)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of only ? files.filter((x) => only.includes(x)) : files) await c.query(await readFile(join(d, f), 'utf8'));
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .withEnvironment({ POSTGRES_USER: 'assessiq', POSTGRES_PASSWORD: 'assessiq', POSTGRES_DB: 'aiq_mock_test' })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://assessiq:assessiq@${container.getHost()}:${container.getMappedPort(5432)}/aiq_mock_test`;

  await sup(async (c) => {
    await c.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await apply(c, dir('02-tenancy'));
    await apply(c, dir('03-users'), ['020_users.sql']);
    await apply(c, dir('20-data-rights'), ['0102_users_erased_at.sql']);
    await apply(c, dir('04-question-bank'));
    await apply(c, dir('05-assessment-lifecycle'));
    await apply(c, dir('06-attempt-engine'));
    await apply(c, dir('07-ai-grading'), ['0040_gradings.sql', '0041_tenant_grading_budgets.sql']);
    await apply(c, dir('09-scoring'));
    await apply(c, join(MODULE_ROOT, 'migrations'));

    await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,'A',$4),($2,'B',$5),($3,'C',$6)`,
      [tenantA, tenantB, tenantC, `a-${tenantA.slice(0, 8)}`, `b-${tenantB.slice(0, 8)}`, `c-${tenantC.slice(0, 8)}`]);
    const u = (uid: string, t: string, name: string, role: string) =>
      c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,$3,$4,$5,'active')`,
        [uid, t, `${name.replace(/\s/g, '')}@m.test`, name, role]);
    await u(adminA, tenantA, 'Admin A', 'admin'); await u(s1, tenantA, 'Student One', 'candidate');
    await u(s2, tenantA, 'Student Two', 'candidate'); await u(s3, tenantA, 'Student Three', 'candidate');
    await u(s4, tenantA, 'Student Four', 'candidate');
    await u(adminB, tenantB, 'Admin B', 'admin'); await u(sB, tenantB, 'Student B', 'candidate');
    await u(adminC, tenantC, 'Admin C', 'admin');

    // pack + level + questions per tenant (q1 topic 'Networking', q2 blank topic -> falls back to General)
    const mk = async (t: string, admin: string, slug: string) => {
      const pack = id(), level = id(), q1 = id(), q2 = id();
      await c.query(`INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by) VALUES ($1,$2,$3,$3,'soc','published',$4)`, [pack, t, slug, admin]);
      await c.query(`INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count) VALUES ($1,$2,1,'L1',60,2)`, [level, pack]);
      for (const [q, topic] of [[q1, 'Networking'], [q2, '']] as const) {
        await c.query(`INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,created_by)
          VALUES ($1,$2,$3,'mcq',$4,10,'active','{"question":"Q","options":["A","B"],"correct":0,"rationale":"R"}',$5)`, [q, pack, level, topic, admin]);
      }
      return { pack, level, q1, q2 };
    };
    const A1 = await mk(tenantA, adminA, 'pa1'), A2 = await mk(tenantA, adminA, 'pa2'), B1 = await mk(tenantB, adminB, 'pb1');
    const asm = (aid: string, t: string, p: typeof A1, name: string, mode: string, admin: string) =>
      c.query(`INSERT INTO assessments (id,tenant_id,pack_id,level_id,name,status,pack_version,question_count,created_by,delivery_mode)
        VALUES ($1,$2,$3,$4,$5,'active',1,2,$6,$7)`, [aid, t, p.pack, p.level, name, admin, mode]);
    await asm(mockAssessment, tenantA, A1, 'Mock One', 'mock', adminA);
    await asm(realAssessment, tenantA, A2, 'Real One', 'real', adminA);
    await asm(mockAssessmentB, tenantB, B1, 'Mock B', 'mock', adminB);

    const attempt = async (t: string, a: string, user: string, status: string, mode: string, qs: Array<[string, number]>, daysAgo: number) => {
      const aid = id();
      const sub = new Date(Date.now() - daysAgo * 86_400_000);
      await c.query(`INSERT INTO attempts (id,tenant_id,assessment_id,user_id,status,started_at,submitted_at,ends_at,duration_seconds,delivery_mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,3600,$9)`,
        [aid, t, a, user, status, new Date(sub.getTime() - 600_000), status === 'in_progress' ? null : sub, new Date(sub.getTime() + 3_600_000), mode]);
      let earned = 0;
      for (const [q, score] of qs) {
        await c.query(`INSERT INTO attempt_questions (attempt_id,question_id,position,question_version) VALUES ($1,$2,1,1)`, [aid, q]);
        await c.query(`INSERT INTO gradings (id,attempt_id,question_id,tenant_id,grader,score_earned,score_max,status,prompt_version_sha,prompt_version_label,model)
          VALUES ($1,$2,$3,$4,'deterministic',$5,10,$6,'sha:test','v1','deterministic')`, [id(), aid, q, t, score, score === 10 ? 'correct' : 'incorrect']);
        earned += score;
      }
      if (status !== 'in_progress') {
        await c.query(`INSERT INTO attempt_scores (attempt_id,tenant_id,total_earned,total_max,auto_pct,pending_review) VALUES ($1,$2,$3,20,$4,false)`,
          [aid, t, earned, earned * 5]);
      }
      return aid;
    };
    await attempt(tenantA, mockAssessment, s1, 'graded', 'mock', [[A1.q1, 10], [A1.q2, 0]], 2);    // 50 %
    await attempt(tenantA, mockAssessment, s2, 'submitted', 'mock', [[A1.q1, 10], [A1.q2, 10]], 1); // 100 %
    await attempt(tenantA, mockAssessment, s3, 'in_progress', 'mock', [], 0);                       // excluded
    await attempt(tenantA, realAssessment, s1, 'graded', 'real', [[A2.q1, 0], [A2.q2, 0]], 1);      // real: excluded
    await attempt(tenantB, mockAssessmentB, sB, 'graded', 'mock', [[B1.q1, 0], [B1.q2, 0]], 1);     // other tenant

    // s4 was invited to the mock and has no attempt; s1 was invited and submitted.
    await c.query(`INSERT INTO assessment_invitations (id,assessment_id,user_id,token_hash,expires_at,invited_by,delivery_mode)
      VALUES ($1,$2,$3,$4,now()+interval '7 days',$5,'mock')`, [id(), mockAssessment, s4, id(), adminA]);
    await c.query(`INSERT INTO assessment_invitations (id,assessment_id,user_id,token_hash,expires_at,invited_by,delivery_mode,status)
      VALUES ($1,$2,$3,$4,now()+interval '7 days',$5,'mock','submitted')`, [id(), mockAssessment, s1, id(), adminA]);
  });
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

function app(tenant: string, role = 'admin') {
  const f = Fastify();
  f.setErrorHandler((err: Error, _req, reply) => {
    const e = err instanceof AppError ? err : null;
    void reply.status(e?.status ?? 500).send({ error: { code: e?.code, message: err.message } });
  });
  const gate = async (req: FastifyRequest & { session?: unknown }, reply: FastifyReply) => {
    if (role !== 'admin') return reply.status(403).send({ error: 'forbidden' });
    req.session = { tenantId: tenant, userId: adminA };
  };
  void registerAnalyticsRoutes(f, { adminOnly: gate, superAdminOnly: gate, candidateOnly: gate });
  return f;
}
const get = async (path: string, tenant = tenantA, role = 'admin') => {
  const r = await app(tenant, role).inject({ method: 'GET', url: path });
  return { status: r.statusCode, body: r.json() as { data: any } };
};

describe('mock results (Z-90)', () => {
  it('summary counts only this tenant\'s submitted mock attempts', async () => {
    const { status, body } = await get('/api/admin/mock/summary');
    expect(status).toBe(200);
    expect(body.data.mock_attempts).toBe(2);
    expect(body.data.students).toBe(2);
    expect(body.data.avg_score_pct).toBe(75);
    expect(body.data.completed_pct).toBe(50); // 1 of 2 mock invitations submitted
    expect(body.data.by_assessment).toHaveLength(1);
    expect(body.data.by_assessment[0].name).toBe('Mock One');
  });

  it('topics: correct share per topic, blank topic falls back to General', async () => {
    const { body } = await get(`/api/admin/mock/topics?assessmentId=${mockAssessment}`);
    const by = Object.fromEntries(body.data.topics.map((t: any) => [t.topic, t.correct_pct]));
    expect(by).toEqual({ Networking: 100, General: 50 });
    expect(body.data.weakest[0].topic).toBe('General');
    expect(body.data.strongest[0].topic).toBe('Networking');
  });

  it('students: mock rows only, with averages', async () => {
    const { body } = await get('/api/admin/mock/students');
    const names = body.data.map((s: any) => s.name).sort();
    expect(names).toEqual(['Student One', 'Student Two']); // s1 real attempt and s3 in_progress add no rows
    const one = body.data.find((s: any) => s.name === 'Student One');
    expect(one.mock_attempts).toBe(1);
    expect(one.avg_score_pct).toBe(50);
  });

  it('trend: average by date; not-taken lists invited users with no attempt', async () => {
    const t = await get('/api/admin/mock/trend');
    expect(t.body.data).toHaveLength(2);
    const one = await get(`/api/admin/mock/trend?userId=${s1}`);
    expect(one.body.data.map((p: any) => p.score_pct)).toEqual([50]);
    const n = await get(`/api/admin/mock/not-taken?assessmentId=${mockAssessment}`);
    expect(n.body.data.map((x: any) => x.name)).toEqual(['Student Four']);
    expect((await get('/api/admin/mock/not-taken')).status).toBe(400);
  });

  it('a second tenant sees only its own mock data', async () => {
    const { body } = await get('/api/admin/mock/summary', tenantB);
    expect(body.data.mock_attempts).toBe(1);
    expect(body.data.by_assessment[0].name).toBe('Mock B');
  });

  it('non-admin gets 403', async () => {
    for (const p of ['summary', 'topics', 'students', 'trend']) {
      expect((await get(`/api/admin/mock/${p}`, tenantA, 'candidate')).status).toBe(403);
    }
  });

  it('empty tenant returns zeros and empty arrays', async () => {
    const s = await get('/api/admin/mock/summary', tenantC);
    expect(s.body.data).toEqual({ mock_attempts: 0, students: 0, completed_pct: 0, avg_score_pct: null, by_assessment: [] });
    expect((await get('/api/admin/mock/topics', tenantC)).body.data).toEqual({ topics: [], strongest: [], weakest: [] });
    expect((await get('/api/admin/mock/students', tenantC)).body.data).toEqual([]);
    expect((await get('/api/admin/mock/trend', tenantC)).body.data).toEqual([]);
  });

  it('admin activity leaderboard leaves mock attempts out', async () => {
    const lb = await getActivityLeaderboard(tenantA, { period: 'month', page: 1, pageSize: 10 });
    expect(lb.items.map((i) => i.packName)).toEqual(['pa2']); // the real pack only; the mock pack pa1 is absent
  });
});
