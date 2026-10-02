/**
 * Integration tests for GET /api/admin/assessments/:id/results.csv
 * (buildAssessmentResultsCsv + route). postgres:16 testcontainer; gradings are
 * seeded directly (grader='deterministic' / 'admin_override').
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { applyAllMigrations } from '../../../../tools/test-support/apply-all-migrations.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '@assessiq/core';
import { setPoolForTesting, closePool } from '@assessiq/tenancy';

vi.mock('@assessiq/audit-log', () => ({ audit: vi.fn(async () => undefined) }));

import { registerAnalyticsRoutes } from '../routes.js';
import { csvCell } from '../results-export.js';


let container: StartedTestContainer;
let url: string;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const tenantA = randomUUID();
const tenantB = randomUUID();
const admin = randomUUID();
const assessmentId = randomUUID();
const assessmentB = randomUUID();
let candGraded = '';
let candSubmitted = '';
let candInvited = '';
let candTie = '';   // graded, same 75% as Aarav, branch ECE
let candLow = '';   // graded, 50%, branch CSE
let candHeld = ''; // graded, but the platform has not released the evaluation to the tenant

const EVIL = '=HYPERLINK("http://x","hi")';

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

    await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,'A',$3),($2,'B',$4)`,
      [tenantA, tenantB, `ta-${tenantA.slice(0, 8)}`, `tb-${tenantB.slice(0, 8)}`]);
    await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,'admin@a.test','Admin','admin','active')`, [admin, tenantA]);
    const mk = async (name: string, email: string, meta: Record<string, string> = {}) => {
      const id = randomUUID();
      await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status,metadata) VALUES ($1,$2,$3,$4,'candidate','active',$5::jsonb)`, [id, tenantA, email, name, JSON.stringify(meta)]);
      return id;
    };
    candGraded = await mk('Aarav Sharma', 'aarav@a.test', { roll_number: '21CS001', branch: 'CSE' });
    candTie = await mk('Bela Tie', 'bela@a.test', { roll_number: '21EC002', branch: 'ECE' });
    candLow = await mk('Chirag Low', 'chirag@a.test', { roll_number: '21CS003', branch: 'CSE' });
    candSubmitted = await mk(EVIL, 'sub@a.test');
    candInvited = await mk('Zoya, "Z" Khan', 'zoya@a.test');
    candHeld = await mk('Held Back', 'held@a.test');

    const pack = randomUUID(); const level = randomUUID();
    await c.query(`INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by) VALUES ($1,$2,'p','P','aptitude','published',$3)`, [pack, tenantA, admin]);
    await c.query(`INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count,passing_score_pct) VALUES ($1,$2,1,'L1',60,4,60)`, [level, pack]);
    const domain = randomUUID(); const catQ = randomUUID(); const catV = randomUUID();
    await c.query(`INSERT INTO domains (id,tenant_id,slug,name) VALUES ($1,$2,'d','D')`, [domain, tenantA]);
    await c.query(`INSERT INTO categories (id,tenant_id,domain_id,slug,name) VALUES ($1,$3,$4,'q','Quant'),($2,$3,$4,'v','Verbal')`, [catQ, catV, tenantA, domain]);
    const qs: string[] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const cats = [catQ, catQ, catV, catV];
    for (let i = 0; i < 4; i++) {
      await c.query(
        `INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,created_by,category_id)
         VALUES ($1,$2,$3,'mcq','t',10,'active','{"question":"Q","options":["A","B"],"correct":0}',$4,$5)`,
        [qs[i], pack, level, admin, cats[i]]);
    }
    await c.query(`INSERT INTO assessments (id,tenant_id,pack_id,level_id,name,status,pack_version,question_count,created_by) VALUES ($1,$2,$3,$4,'Placement Test','active',1,4,$5)`, [assessmentId, tenantA, pack, level, admin]);

    const inv = (u: string, s: string) => c.query(
      `INSERT INTO assessment_invitations (assessment_id,user_id,token_hash,expires_at,status,invited_by) VALUES ($1,$2,$3,now()+interval '7 day',$4,$5)`,
      [assessmentId, u, randomUUID(), s, admin]);
    await inv(candGraded, 'submitted'); await inv(candSubmitted, 'submitted'); await inv(candInvited, 'pending'); await inv(candHeld, 'submitted');
    await inv(candTie, 'submitted'); await inv(candLow, 'submitted');

    // Phase II: a 'graded' result is visible to the tenant only once the platform released
    // the evaluation (evaluation_released_at); `released = false` models "still with AssessIQ".
    const att = async (u: string, status: string, released = status === 'graded') => {
      const id = randomUUID();
      await c.query(`INSERT INTO attempts (id,tenant_id,assessment_id,user_id,status,started_at,submitted_at,evaluation_released_at) VALUES ($1,$2,$3,$4,$5,now()-interval '1 hour',now(),CASE WHEN $6::boolean THEN now() END)`, [id, tenantA, assessmentId, u, status, released]);
      for (let i = 0; i < 4; i++) await c.query(`INSERT INTO attempt_questions (attempt_id,question_id,position,question_version) VALUES ($1,$2,$3,1)`, [id, qs[i], i + 1]);
      return id;
    };
    const gradedAttempt = await att(candGraded, 'graded');
    await att(candSubmitted, 'submitted');
    const heldAttempt = await att(candHeld, 'graded', false);
    const tieAttempt = await att(candTie, 'graded');
    const lowAttempt = await att(candLow, 'graded');

    const grade = (a: string, q: string, earned: number, grader = 'deterministic', at = 'now()') => c.query(
      `INSERT INTO gradings (attempt_id,question_id,tenant_id,grader,score_earned,score_max,status,prompt_version_sha,prompt_version_label,model,graded_at,override_of)
       VALUES ($1,$2,$3,$4,$5,10,'correct','sha-'||$4,'v1','m',${at},
         CASE WHEN $4 = 'admin_override' THEN (SELECT id FROM gradings WHERE attempt_id=$1 AND question_id=$2 AND override_of IS NULL) END)`,
      [a, q, tenantA, grader, earned]);
    // Quant: 10 + 0 ; Verbal: 10 + 0 -> overall 20/40 until override.
    await grade(gradedAttempt, qs[0]!, 10);
    await grade(gradedAttempt, qs[1]!, 0);
    await grade(gradedAttempt, qs[2]!, 10);
    await grade(gradedAttempt, qs[3]!, 0);
    // Admin override on Q2 (Quant) 0 -> 10, newer than the deterministic row.
    await grade(gradedAttempt, qs[1]!, 10, 'admin_override', `now()+interval '1 minute'`);
    // Tie: 30/40 = 75% (same as Aarav). Low: 20/40 = 50%.
    for (let i = 0; i < 4; i++) await grade(tieAttempt, qs[i]!, i === 3 ? 0 : 10);
    for (let i = 0; i < 4; i++) await grade(lowAttempt, qs[i]!, i < 2 ? 10 : 0);
    // Integrity events: Aarav 2 tab blurs + 1 paste + 1 fullscreen_exit; held attempt 3 blurs
    // (shown even though its score is hidden).
    const ev = (a: string, t: string, n: number) => c.query(`INSERT INTO attempt_events (attempt_id,event_type) SELECT $1,$2 FROM generate_series(1,$3)`, [a, t, n]);
    await ev(gradedAttempt, 'tab_blur', 2); await ev(gradedAttempt, 'paste', 1); await ev(gradedAttempt, 'fullscreen_exit', 1);
    await ev(heldAttempt, 'tab_blur', 3);
    // The held-back attempt has grades too — they must NOT surface in the tenant's CSV.
    for (let i = 0; i < 4; i++) await grade(heldAttempt, qs[i]!, 10);

    // Tenant B assessment (cross-tenant target).
    const packB = randomUUID(); const levelB = randomUUID(); const adminB = randomUUID();
    await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,'admin@b.test','AdminB','admin','active')`, [adminB, tenantB]);
    await c.query(`INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by) VALUES ($1,$2,'pb','PB','x','published',$3)`, [packB, tenantB, adminB]);
    await c.query(`INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count) VALUES ($1,$2,1,'L1',60,1)`, [levelB, packB]);
    await c.query(`INSERT INTO assessments (id,tenant_id,pack_id,level_id,name,status,pack_version,question_count,created_by) VALUES ($1,$2,$3,$4,'B','active',1,1,$5)`, [assessmentB, tenantB, packB, levelB, adminB]);
  });
  await setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

function buildApp() {
  const app = Fastify();
  app.setErrorHandler((err: Error, _req, reply) => {
    const status = err instanceof AppError ? err.status : 500;
    void reply.status(status).send({ error: { message: err.message } });
  });
  const roleGate = (roles: string[]) => async (req: FastifyRequest & { session?: unknown }, reply: FastifyReply) => {
    const role = req.headers['x-role'] as string | undefined;
    if (!role || !roles.includes(role)) return reply.status(403).send({ error: 'forbidden' });
    req.session = { tenantId: (req.headers['x-tenant'] as string) ?? tenantA, userId: admin };
  };
  void registerAnalyticsRoutes(app, {
    adminOnly: roleGate(['admin']),
    superAdminOnly: roleGate(['super_admin']),
    candidateOnly: roleGate(['candidate']),
  });
  return app;
}

function parseCsv(body: string): string[][] {
  // Minimal RFC-4180 parser for assertions.
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  const s = body.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  return rows;
}

describe('assessment results.csv', () => {
  it('returns one row per invited candidate with statuses, scores, pass/fail and per-category %', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/admin/assessments/${assessmentId}/results.csv`, headers: { 'x-role': 'admin' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="${assessmentId}-results-\\d{4}-\\d{2}-\\d{2}\\.csv"$`));
    expect(res.body.startsWith('﻿')).toBe(true);

    const rows = parseCsv(res.body);
    expect(rows[0]).toEqual(['name', 'email', 'roll_number', 'branch', 'status', 'started_at', 'submitted_at', 'score', 'max_score', 'percent', 'result', 'rank', 'tab_switches', 'paste_count', 'fullscreen_exits', 'Quant (%)', 'Verbal (%)']);
    expect(rows.length).toBe(7);
    const by = Object.fromEntries(rows.slice(1).map((r) => [r[1]!, r]));

    // graded + evaluation released to the tenant: 10 + override(10) + 10 + 0 = 30/40 = 75%, level passing 60 -> Pass
    const g = by['aarav@a.test']!;
    expect(g.slice(2, 5)).toEqual(['21CS001', 'CSE', 'graded']);
    expect(g.slice(7)).toEqual(['30', '40', '75', 'Pass', '1', '2', '1', '1', '100', '50']); // override precedence: Quant 20/20

    // submitted-not-graded: attempt status, no score, result "Awaiting evaluation" (Phase II)
    const s = by['sub@a.test']!;
    expect(s[4]).toBe('submitted');
    expect(s.slice(7)).toEqual(['', '', '', 'Awaiting evaluation', '', '0', '0', '0', '', '']);

    // graded but NOT released to the tenant (still with AssessIQ / sent back): grades exist,
    // yet the CSV shows no score and "Awaiting evaluation" — nothing provisional leaks out.
    const h = by['held@a.test']!;
    expect(h[4]).toBe('graded');
    // rank blank, but integrity counts are shown regardless of release state
    expect(h.slice(7)).toEqual(['', '', '', 'Awaiting evaluation', '', '3', '0', '0', '', '']);

    // invited, never started
    const i = by['zoya@a.test']!;
    expect(i[0]).toBe('Zoya, "Z" Khan');
    expect(i.slice(4, 7)).toEqual(['invited', '', '']);
    expect(i.slice(11)).toEqual(['', '', '', '', '', '']); // no attempt: rank + integrity blank
    await app.close();
  });

  const col = (rows: string[][], name: string) => rows.slice(1).map((r) => r[rows[0]!.indexOf(name)]!);
  const get = async (q = '') => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/admin/assessments/${assessmentId}/results.csv${q}`, headers: { 'x-role': 'admin' } });
    await app.close();
    return res;
  };

  it('ranks with competition ties (1,2,2,4) and leaves awaiting/not-started rows blank', async () => {
    const rows = parseCsv((await get()).body);
    const byEmail = Object.fromEntries(rows.slice(1).map((r) => [r[1]!, r[rows[0]!.indexOf('rank')]!]));
    expect(byEmail).toEqual({
      'aarav@a.test': '1', 'bela@a.test': '1', 'chirag@a.test': '3',
      'sub@a.test': '', 'held@a.test': '', 'zoya@a.test': '',
    });
  });

  it('sort=rank orders by rank, unranked last; sort=branch is branch A-Z, then rank, then name', async () => {
    const r = parseCsv((await get('?sort=rank')).body);
    expect(col(r, 'rank')).toEqual(['1', '1', '3', '', '', '']);
    expect(col(r, 'name').slice(0, 2)).toEqual(['Aarav Sharma', 'Bela Tie']);

    const b = parseCsv((await get('?sort=branch')).body);
    // CSE (Aarav rank 1, Chirag rank 3), ECE (Bela), then no-branch rows by name
    expect(col(b, 'branch')).toEqual(['CSE', 'CSE', 'ECE', '', '', '']);
    expect(col(b, 'name').slice(0, 3)).toEqual(['Aarav Sharma', 'Chirag Low', 'Bela Tie']);

    const n = parseCsv((await get('?sort=name')).body);
    expect(n.length).toBe(7);
    expect(col(n, 'rank')).toContain('3');
  });

  it('unknown sort -> 400', async () => {
    expect((await get('?sort=bogus')).statusCode).toBe(400);
  });

  it('neutralises formula injection in names', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/admin/assessments/${assessmentId}/results.csv`, headers: { 'x-role': 'admin' } });
    expect(res.body).toContain(`"'${EVIL.replace(/"/g, '""')}"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    await app.close();
  });

  it('404 for another tenant\'s assessment', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/admin/assessments/${assessmentB}/results.csv`, headers: { 'x-role': 'admin' } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('reviewer and candidate get 403', async () => {
    const app = buildApp();
    const ok = await app.inject({ method: 'GET', url: `/api/admin/assessments/${assessmentId}/results.csv`, headers: { 'x-role': 'reviewer' } });
    expect(ok.statusCode).toBe(403);
    const no = await app.inject({ method: 'GET', url: `/api/admin/assessments/${assessmentId}/results.csv`, headers: { 'x-role': 'candidate' } });
    expect(no.statusCode).toBe(403);
    await app.close();
  });
});
