/**
 * Per-section scores: results CSV columns + the 09-scoring helper behind the admin
 * attempt detail. postgres:16 testcontainer; unreleased attempts must show no section score.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { setPoolForTesting, closePool, withTenant } from '@assessiq/tenancy';
import { applyAllMigrations } from '../../../../tools/test-support/apply-all-migrations.js';

vi.mock('@assessiq/audit-log', () => ({ audit: vi.fn(async () => undefined) }));

import { buildAssessmentResultsCsv } from '../results-export.js';
import { getSectionScoresForAttempt } from '../../../09-scoring/src/repository.js';

let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const admin = randomUUID();
const assessmentId = randomUUID();
let shownAttempt = '';

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
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
    await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,'A',$2)`, [tenant, `ta-${tenant.slice(0, 8)}`]);
    await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,'admin@a.test','Admin','admin','active')`, [admin, tenant]);
    const pack = randomUUID(); const level = randomUUID();
    await c.query(`INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by) VALUES ($1,$2,'p','P','aptitude','published',$3)`, [pack, tenant, admin]);
    await c.query(`INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count) VALUES ($1,$2,1,'L1',60,4)`, [level, pack]);
    const qs = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const q of qs) {
      await c.query(
        `INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,created_by)
         VALUES ($1,$2,$3,'mcq','t',10,'active','{"question":"Q","options":["A","B"],"correct":0}',$4)`,
        [q, pack, level, admin]);
    }
    const settings = JSON.stringify({ sections: [
      { name: 'Quant', question_count: 2, minutes: 10 },
      { name: 'Verbal', question_count: 2, minutes: 10 },
    ] });
    await c.query(
      `INSERT INTO assessments (id,tenant_id,pack_id,level_id,name,status,pack_version,question_count,created_by,settings)
       VALUES ($1,$2,$3,$4,'Sectioned','active',1,4,$5,$6::jsonb)`,
      [assessmentId, tenant, pack, level, admin, settings]);

    // One visible (graded + released) attempt and one still with AssessIQ (graded, NOT released).
    const mkAttempt = async (email: string, released: boolean) => {
      const u = randomUUID();
      await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,$3,$3,'candidate','active')`, [u, tenant, email]);
      await c.query(`INSERT INTO assessment_invitations (assessment_id,user_id,token_hash,expires_at,status,invited_by) VALUES ($1,$2,$3,now()+interval '7 day','submitted',$4)`, [assessmentId, u, randomUUID(), admin]);
      const a = randomUUID();
      await c.query(
        `INSERT INTO attempts (id,tenant_id,assessment_id,user_id,status,started_at,submitted_at,evaluation_released_at)
         VALUES ($1,$2,$3,$4,'graded',now()-interval '1 hour',now(),CASE WHEN $5::boolean THEN now() END)`,
        [a, tenant, assessmentId, u, released]);
      for (let i = 0; i < 4; i++) {
        await c.query(`INSERT INTO attempt_questions (attempt_id,question_id,position,question_version,section_index) VALUES ($1,$2,$3,1,$4)`, [a, qs[i], i + 1, i < 2 ? 0 : 1]);
        // Quant 20/20, Verbal 5/20 -> 100.0 / 25.0
        await c.query(
          `INSERT INTO gradings (attempt_id,question_id,tenant_id,grader,score_earned,score_max,status,prompt_version_sha,prompt_version_label,model)
           VALUES ($1,$2,$3,'deterministic',$4,10,'correct','sha','v1','m')`,
          [a, qs[i], tenant, [10, 10, 5, 0][i]]);
      }
      return a;
    };
    shownAttempt = await mkAttempt('shown@a.test', true);
    await mkAttempt('held@a.test', false);
  });
  await setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

describe('per-section scores', () => {
  it('CSV: one "Section: <name> (%)" column per section; blank while unreleased', async () => {
    const { csv } = await buildAssessmentResultsCsv(tenant, assessmentId);
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    const head = lines[0]!.split(',');
    const qi = head.indexOf('Section: Quant (%)');
    const vi_ = head.indexOf('Section: Verbal (%)');
    expect(qi).toBeGreaterThan(-1);
    expect(vi_).toBe(qi + 1);
    const shown = lines.find((l) => l.startsWith('shown@a.test,') || l.includes(',shown@a.test,'))!.split(',');
    expect(shown[qi]).toBe('100');
    expect(shown[vi_]).toBe('25');
    const held = lines.find((l) => l.includes(',held@a.test,'))!.split(',');
    expect(held[qi]).toBe('');
    expect(held[vi_]).toBe('');
  });

  it('getSectionScoresForAttempt returns earned/max per section with names', async () => {
    const rows = await withTenant(tenant, (c) => getSectionScoresForAttempt(c, shownAttempt));
    expect(rows).toEqual([
      { index: 0, name: 'Quant', earned: 20, max: 20 },
      { index: 1, name: 'Verbal', earned: 5, max: 20 },
    ]);
  });
});
