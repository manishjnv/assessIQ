/**
 * X6a — getLiveMonitor + GET /api/admin/assessments/:id/live-monitor.
 * postgres:16 testcontainer; every migration applied; two tenants seeded directly.
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
import { getLiveMonitor } from '../live-monitor.js';

let container: StartedTestContainer;
let url: string;
async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const tA = randomUUID();
const tB = randomUUID();
const adminA = randomUUID();
const adminB = randomUUID();
let asmA = '';
let asmB = '';
let inProgressUserA = '';
const MIN = 60_000;

async function seedTenant(c: Client, t: string, admin: string, slug: string): Promise<{ asm: string; mk: (status: string | null, invite?: string) => Promise<{ user: string; attempt: string | null }>; question: string }> {
  await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)`, [t, slug, `${slug}-${t.slice(0, 8)}`]);
  await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,$3,'Admin','admin','active')`, [admin, t, `${admin}@t.test`]);
  const packId = randomUUID(); const levelId = randomUUID(); const asm = randomUUID(); const question = randomUUID();
  await c.query(`INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by) VALUES ($1,$2,'p','p','x','published',$3)`, [packId, t, admin]);
  await c.query(`INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count) VALUES ($1,$2,1,'L1',60,1)`, [levelId, packId]);
  await c.query(`INSERT INTO assessments (id,tenant_id,pack_id,level_id,name,status,pack_version,question_count,created_by) VALUES ($1,$2,$3,$4,'A','active',1,1,$5)`, [asm, t, packId, levelId, admin]);
  await c.query(
    `INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,created_by)
     VALUES ($1,$2,$3,'mcq','t',10,'active','{"question":"Q","options":["A","B"],"correct":0,"rationale":"R"}',$4)`,
    [question, packId, levelId, admin]);
  // status null = invited only; invite 'expired' = revoked invitation
  const mk = async (status: string | null, invite = 'pending') => {
    const user = randomUUID();
    await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,$3,$4,'candidate','active')`, [user, t, `${user}@t.test`, `Cand ${user.slice(0, 4)}`]);
    await c.query(
      `INSERT INTO assessment_invitations (assessment_id,user_id,token_hash,expires_at,status,invited_by) VALUES ($1,$2,$3,now()+interval '7 days',$4,$5)`,
      [asm, user, randomUUID(), invite, admin]);
    if (status === null) return { user, attempt: null };
    const attempt = randomUUID();
    await c.query(
      `INSERT INTO attempts (id,tenant_id,assessment_id,user_id,status,started_at,ends_at,duration_seconds)
       VALUES ($1,$2,$3,$4,$5,now()-interval '2 hours',now()+interval '1 hour',3600)`,
      [attempt, t, asm, user, status]);
    return { user, attempt };
  };
  return { asm, mk, question };
}

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

    // Tenant A: 6 invitations. 1 in progress (answer 5 min ago, event 1 min ago), 2 submitted-group,
    // 1 draft attempt, 1 never opened, 1 revoked (expired) invitation.
    const A = await seedTenant(c, tA, adminA, 'a');
    asmA = A.asm;
    const ip = await A.mk('in_progress');
    inProgressUserA = ip.user;
    await c.query(`INSERT INTO attempt_answers (attempt_id,question_id,answer,saved_at) VALUES ($1,$2,'{"x":1}',now()-interval '5 minutes')`, [ip.attempt, A.question]);
    await c.query(`INSERT INTO attempt_events (attempt_id,event_type,at) VALUES ($1,'heartbeat',now()-interval '1 minute')`, [ip.attempt]);
    await A.mk('submitted', 'submitted');
    await A.mk('released', 'submitted');
    await A.mk('draft');
    await A.mk(null);
    await A.mk(null, 'expired');

    // Tenant B: 3 in progress, 1 submitted. Must never reach tenant A.
    const B = await seedTenant(c, tB, adminB, 'b');
    asmB = B.asm;
    await B.mk('in_progress'); await B.mk('in_progress'); await B.mk('in_progress'); await B.mk('submitted', 'submitted');
  });
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

describe('getLiveMonitor', () => {
  it('counts a known seed and gives the last seen time of the in-progress attempt', async () => {
    const r = await getLiveMonitor({ tenantId: tA, assessmentId: asmA });
    expect(r.counts).toEqual({ invited: 5, not_started: 2, in_progress: 1, submitted: 2 });
    expect(r.in_progress).toHaveLength(1);
    const row = r.in_progress[0]!;
    expect(row.user_id).toBe(inProgressUserA);
    expect(row.name).toMatch(/^Cand /);
    // the newest of started_at (2h), answer (5 min) and event (1 min) wins
    const ageMs = new Date(r.server_time).getTime() - new Date(row.last_seen_at).getTime();
    expect(ageMs).toBeGreaterThan(0.5 * MIN);
    expect(ageMs).toBeLessThan(3 * MIN);
    expect(Object.keys(row).sort()).toEqual(['attempt_id', 'email', 'last_seen_at', 'name', 'started_at', 'user_id']);
  });

  it('never shows tenant B data to tenant A, and the reverse', async () => {
    const a = await getLiveMonitor({ tenantId: tA, assessmentId: asmA });
    expect(a.in_progress.map((x) => x.user_id)).toEqual([inProgressUserA]);
    const b = await getLiveMonitor({ tenantId: tB, assessmentId: asmB });
    expect(b.counts).toEqual({ invited: 4, not_started: 0, in_progress: 3, submitted: 1 });
    expect(b.in_progress.some((x) => x.user_id === inProgressUserA)).toBe(false);
  });

  it('404 when the assessment belongs to another tenant', async () => {
    await expect(getLiveMonitor({ tenantId: tA, assessmentId: asmB })).rejects.toMatchObject({ status: 404 });
  });
});

describe('GET /api/admin/assessments/:id/live-monitor', () => {
  function buildApp(tenantId: string) {
    const app = Fastify();
    app.setErrorHandler((err: Error, _req, reply) => {
      const e = err instanceof AppError ? err : null;
      void reply.status(e?.status ?? (err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: e?.code, message: err.message } });
    });
    const gate = async (req: FastifyRequest & { session?: unknown }, reply: FastifyReply) => {
      if (req.headers['x-role'] !== 'admin') return reply.status(403).send({ error: 'forbidden' });
      req.session = { tenantId, userId: adminA };
    };
    void registerAnalyticsRoutes(app, { adminOnly: gate, superAdminOnly: gate, candidateOnly: gate });
    return app;
  }
  const get = (tenantId: string, id: string, role = 'admin') =>
    buildApp(tenantId).inject({ method: 'GET', url: `/api/admin/assessments/${id}/live-monitor`, headers: { 'x-role': role } });

  it('returns 200 for the own assessment, 404 for another tenant, 400 bad id, 403 non admin', async () => {
    const ok = await get(tA, asmA);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().counts.in_progress).toBe(1);
    expect((await get(tA, asmB)).statusCode).toBe(404);
    expect((await get(tA, 'nope')).statusCode).toBe(400);
    expect((await get(tA, asmA, 'candidate')).statusCode).toBe(403);
  });
});
