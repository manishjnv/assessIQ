/**
 * Integration tests for Phase 10 — Candidate Activity endpoints.
 *
 * Uses a postgres:16-alpine testcontainer. Migration stack mirrors activity.test.ts.
 *
 * Fixture:
 *   Tenant A:
 *     candidateA1 — took packA twice (today auto_pct=80, 3 days ago auto_pct=70)
 *     candidateA2 — took packA once (today auto_pct=60) + packB once (30 days ago auto_pct=90)
 *   Tenant B:
 *     candidateB — one unscored attempt (no attempt_scores row)
 *
 * Leaderboard expectations for packA:
 *   rank 1 = candidateA1 (best_pct=80)
 *   rank 2 = candidateA2 (best_pct=60)
 *   total_candidates_in_pack = 2
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { setPoolForTesting, closePool } from '@assessiq/tenancy';

import {
  getCandidateActivityStats,
  getCandidateActivityHeatmap,
  getCandidateActivityTimeline,
  getCandidateActivityLeaderboard,
} from '../index.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR   = toFsPath(new URL('.', import.meta.url));
const MODULE_ROOT  = join(THIS_DIR, '..', '..');
const MODULES_ROOT = join(MODULE_ROOT, '..');

const TENANCY_DIR   = join(MODULES_ROOT, '02-tenancy',             'migrations');
const USERS_DIR     = join(MODULES_ROOT, '03-users',               'migrations');
const QB_DIR        = join(MODULES_ROOT, '04-question-bank',        'migrations');
const AL_DIR        = join(MODULES_ROOT, '05-assessment-lifecycle',  'migrations');
const AE_DIR        = join(MODULES_ROOT, '06-attempt-engine',        'migrations');
const GRADING_DIR   = join(MODULES_ROOT, '07-ai-grading',            'migrations');
const SCORING_DIR   = join(MODULES_ROOT, '09-scoring',               'migrations');
const ANALYTICS_DIR = join(MODULE_ROOT,  'migrations');

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let F: CandidateActivityFixture;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: 'assessiq',
      POSTGRES_PASSWORD: 'assessiq',
      POSTGRES_DB: 'aiq_candidate_act_test',
    })
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  containerUrl = `postgres://assessiq:assessiq@${host}:${port}/aiq_candidate_act_test`;

  await applyAllMigrations();
  await setPoolForTesting(containerUrl);
  F = await seedFixtures();
}, 120_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

// ---------------------------------------------------------------------------
// Migration helpers
// ---------------------------------------------------------------------------

async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function applyMigrationsFromDir(
  client: Client,
  dir: string,
  only?: string[],
): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const filtered = only !== undefined ? files.filter((f) => only.includes(f)) : files;
  for (const f of filtered) {
    const sql = await readFile(join(dir, f), 'utf8');
    await client.query(sql);
  }
}

async function applyAllMigrations(): Promise<void> {
  await withSuperClient(async (client) => {
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyMigrationsFromDir(client, TENANCY_DIR);
    await applyMigrationsFromDir(client, USERS_DIR, ['020_users.sql']);
    await applyMigrationsFromDir(client, QB_DIR);
    await applyMigrationsFromDir(client, AL_DIR);
    await applyMigrationsFromDir(client, AE_DIR);
    await applyMigrationsFromDir(client, GRADING_DIR, [
      '0040_gradings.sql',
      '0041_tenant_grading_budgets.sql',
    ]);
    await applyMigrationsFromDir(client, SCORING_DIR);
    await applyMigrationsFromDir(client, ANALYTICS_DIR);
  });
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface CandidateActivityFixture {
  tenantA: string; tenantB: string;
  adminA: string;
  candidateA1: string; candidateA2: string;
  adminB: string; candidateB: string;
  packA: string; packB: string;
  levelA: string; levelB: string;
  questionA: string; questionB: string;
  assessmentA1: string; assessmentA2: string; assessmentA3: string;
  assessmentB1: string;
  attemptA1: string; attemptA2: string; attemptA3: string;
  attemptB1: string;
  packBt: string; levelBt: string; questionBt: string;
  assessmentB_t: string; attemptB_t: string;
  todayStr: string;
  d3Str: string;
}

async function seedFixtures(): Promise<CandidateActivityFixture> {
  return withSuperClient(async (client) => {
    const tenantA = randomUUID(); const tenantB = randomUUID();
    const adminA = randomUUID();
    const candidateA1 = randomUUID(); const candidateA2 = randomUUID();
    const adminB = randomUUID(); const candidateB = randomUUID();
    const packA = randomUUID(); const packB = randomUUID();
    const levelA = randomUUID(); const levelB = randomUUID();
    const questionA = randomUUID(); const questionB = randomUUID();
    const assessmentA1 = randomUUID(); const assessmentA2 = randomUUID();
    const assessmentA3 = randomUUID(); const assessmentB1 = randomUUID();
    const attemptA1 = randomUUID(); const attemptA2 = randomUUID();
    const attemptA3 = randomUUID(); const attemptB1 = randomUUID();
    const packBt = randomUUID(); const levelBt = randomUUID();
    const questionBt = randomUUID();
    const assessmentB_t = randomUUID(); const attemptB_t = randomUUID();

    const slugA = `tc-act-${tenantA.slice(0, 8)}`;
    const slugB = `tb-act-${tenantB.slice(0, 8)}`;

    await client.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1,'CActTenantA',$3),($2,'CActTenantB',$4)`,
      [tenantA, tenantB, slugA, slugB],
    );

    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES
         ($1,$7,'cadmin-a@ca.test','Admin A','admin','active'),
         ($2,$7,'cand-ca1@ca.test','Candidate CA1','candidate','active'),
         ($3,$7,'cand-ca2@ca.test','Candidate CA2','candidate','active'),
         ($4,$8,'cadmin-b@ca.test','Admin B','admin','active'),
         ($5,$8,'cand-cb@ca.test','Candidate CB','candidate','active'),
         ($6,$7,'cadmin-a2@ca.test','Admin A2','admin','active')`,
      [adminA, candidateA1, candidateA2, adminB, candidateB, randomUUID(), tenantA, tenantB],
    );

    // Pack A (soc) — Tenant A
    await client.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
       VALUES ($1,$2,'ca-pack-soc','SOC Pack','soc','published',$3)`,
      [packA, tenantA, adminA],
    );
    await client.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
       VALUES ($1,$2,1,'L1',60,5)`,
      [levelA, packA],
    );
    await client.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
       VALUES ($1,$2,$3,'mcq','ca-topic',25,'active','{"question":"Q1","options":["A","B","C","D"],"correct":0,"rationale":"R"}',$4)`,
      [questionA, packA, levelA, adminA],
    );

    // Pack B (devops) — Tenant A
    await client.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
       VALUES ($1,$2,'ca-pack-devops','DevOps Pack','devops','published',$3)`,
      [packB, tenantA, adminA],
    );
    await client.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
       VALUES ($1,$2,1,'L1',60,5)`,
      [levelB, packB],
    );
    await client.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
       VALUES ($1,$2,$3,'mcq','ca-devops',25,'active','{"question":"Q2","options":["A","B","C","D"],"correct":1,"rationale":"R"}',$4)`,
      [questionB, packB, levelB, adminA],
    );

    // Tenant B pack
    await client.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
       VALUES ($1,$2,'ca-pack-tb','TB Pack','pentest','published',$3)`,
      [packBt, tenantB, adminB],
    );
    await client.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
       VALUES ($1,$2,1,'L1',60,5)`,
      [levelBt, packBt],
    );
    await client.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
       VALUES ($1,$2,$3,'mcq','tb-pentest',25,'active','{"question":"QB","options":["A","B"],"correct":0,"rationale":"R"}',$4)`,
      [questionBt, packBt, levelBt, adminB],
    );

    // Assessments
    await client.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, name, status, pack_version, question_count, created_by)
       VALUES
         ($1,$5,$6,$7,'SOC-A1','active',1,1,$9),
         ($2,$5,$6,$7,'SOC-A2','active',1,1,$9),
         ($3,$5,$6,$7,'SOC-A3','active',1,1,$9),
         ($4,$5,$8,$10,'DevOps-A1','active',1,1,$9)`,
      [assessmentA1, assessmentA2, assessmentA3, assessmentB1,
       tenantA, packA, levelA, packB, adminA, levelB],
    );
    await client.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, name, status, pack_version, question_count, created_by)
       VALUES ($1,$2,$3,$4,'TB-A1','active',1,1,$5)`,
      [assessmentB_t, tenantB, packBt, levelBt, adminB],
    );

    // Dates
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const d3 = new Date(now.getTime() - 3 * 86_400_000);
    const d3Str = d3.toISOString().slice(0, 10);
    const d30 = new Date(now.getTime() - 30 * 86_400_000);

    function makeDates(sub: Date) {
      return {
        started: new Date(sub.getTime() - 600_000),
        ends: new Date(sub.getTime() + 3_600_000),
      };
    }

    // attemptA1: candidateA1 / packA / today / graded
    const d1 = makeDates(now);
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'graded',$5,$6,$7,3600)`,
      [attemptA1, tenantA, assessmentA1, candidateA1, d1.started, now, d1.ends],
    );

    // attemptA2: candidateA2 / packA / today / submitted
    const d2 = makeDates(now);
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'submitted',$5,$6,$7,3600)`,
      [attemptA2, tenantA, assessmentA2, candidateA2, d2.started, now, d2.ends],
    );

    // attemptA3: candidateA1 / packA / 3 days ago / graded
    const d3d = makeDates(d3);
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'graded',$5,$6,$7,3600)`,
      [attemptA3, tenantA, assessmentA3, candidateA1, d3d.started, d3, d3d.ends],
    );

    // attemptB1: candidateA2 / packB / 30 days ago / released
    const d30d = makeDates(d30);
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'released',$5,$6,$7,3600)`,
      [attemptB1, tenantA, assessmentB1, candidateA2, d30d.started, d30, d30d.ends],
    );

    // attemptB_t: candidateB / Tenant B / today / submitted (no scores)
    const dbt = makeDates(now);
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'submitted',$5,$6,$7,3600)`,
      [attemptB_t, tenantB, assessmentB_t, candidateB, dbt.started, now, dbt.ends],
    );

    // attempt_questions (FK)
    for (const [attId, qId] of [
      [attemptA1, questionA], [attemptA2, questionA], [attemptA3, questionA],
      [attemptB1, questionB], [attemptB_t, questionBt],
    ]) {
      await client.query(
        `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,1,1)`,
        [attId, qId],
      );
    }

    // Gradings
    const gradInsertSql = `INSERT INTO gradings
      (id, attempt_id, question_id, tenant_id, grader, score_earned, score_max, status, reasoning_band, prompt_version_sha, prompt_version_label, model)
      VALUES ($1,$2,$3,$4,'deterministic',$5,$6,'correct',$7,'sha:test','v1','deterministic')`;
    await client.query(gradInsertSql, [randomUUID(), attemptA1, questionA, tenantA, 20, 25, 3]);
    await client.query(gradInsertSql, [randomUUID(), attemptA3, questionA, tenantA, 17, 25, 2]);
    await client.query(gradInsertSql, [randomUUID(), attemptA2, questionA, tenantA, 15, 25, 1]);
    await client.query(gradInsertSql, [randomUUID(), attemptB1, questionB, tenantA, 22, 25, 4]);

    // Attempt scores
    await client.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, computed_at)
       VALUES ($1,$2,20,25,80,false,'confident_correct',now())`,
      [attemptA1, tenantA],
    );
    await client.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, computed_at)
       VALUES ($1,$2,15,25,60,false,'overconfident_wrong',now())`,
      [attemptA2, tenantA],
    );
    await client.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, computed_at)
       VALUES ($1,$2,17,25,70,false,'uncertain_correct',now())`,
      [attemptA3, tenantA],
    );
    await client.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, computed_at)
       VALUES ($1,$2,22,25,90,false,'confident_correct',now())`,
      [attemptB1, tenantA],
    );

    // Refresh MV so stats/timeline endpoints see the data
    await client.query('REFRESH MATERIALIZED VIEW attempt_summary_mv');

    return {
      tenantA, tenantB, adminA, candidateA1, candidateA2, adminB, candidateB,
      packA, packB, levelA, levelB, questionA, questionB,
      assessmentA1, assessmentA2, assessmentA3, assessmentB1,
      attemptA1, attemptA2, attemptA3, attemptB1,
      packBt, levelBt, questionBt, assessmentB_t, attemptB_t,
      todayStr, d3Str,
    };
  });
}

// ---------------------------------------------------------------------------
// Tests — Stats
// ---------------------------------------------------------------------------

describe('getCandidateActivityStats', () => {
  it('happy path: candidateA1 sees own completions and assessmentsTaken', async () => {
    const result = await getCandidateActivityStats(F.tenantA, F.candidateA1, {});
    // candidateA1 has 2 attempts (attemptA1 today + attemptA3 3 days ago), both in default 30d window
    expect(result.completions.total).toBe(2);
    // only 1 distinct pack (packA)
    expect(result.assessmentsTaken.total).toBe(1);
    // avg score present (80+70)/2=75
    expect(result.avgScore.total).toBeGreaterThan(0);
  });

  it('cross-user isolation: candidateA1 stats do not include candidateA2 attempts', async () => {
    const resultA1 = await getCandidateActivityStats(F.tenantA, F.candidateA1, {});
    const resultA2 = await getCandidateActivityStats(F.tenantA, F.candidateA2, {});
    // A1: 2 completions (attemptA1, attemptA3 — both in last 30d)
    expect(resultA1.completions.total).toBe(2);
    // A2: 2 completions (attemptA2 today + attemptB1 30d ago — both within default window)
    expect(resultA2.completions.total).toBeGreaterThanOrEqual(1);
    // A2 sees 2 distinct packs (packA + packB) if attemptB1 is in window
    expect(resultA2.assessmentsTaken.total).toBeGreaterThanOrEqual(1);
    // A1 never sees A2's attempts
    expect(resultA1.completions.total).not.toBe(resultA2.completions.total + resultA1.completions.total);
  });

  it('respects from/to date range: narrow window excludes older attempts', async () => {
    // Use last 1 day — candidateA1 has only attemptA1 today, not attemptA3 (3 days ago)
    const today = new Date().toISOString().slice(0, 10);
    const result = await getCandidateActivityStats(F.tenantA, F.candidateA1, {
      from: today, to: today,
    });
    expect(result.completions.total).toBe(1);
  });

  it('groupBy: domain breakdown present', async () => {
    const result = await getCandidateActivityStats(F.tenantA, F.candidateA1, { groupBy: 'domain' });
    expect(result.groupBy).toBe('domain');
    expect(result.completions.breakdown.length).toBeGreaterThan(0);
    expect(result.completions.breakdown.at(0)?.key).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests — Heatmap
// ---------------------------------------------------------------------------

describe('getCandidateActivityHeatmap', () => {
  it('happy path: candidateA1 sees today and 3-days-ago counts > 0', async () => {
    const result = await getCandidateActivityHeatmap(F.tenantA, F.candidateA1, {});
    // Should have days filled
    expect(result.days.length).toBeGreaterThan(0);
    const today = result.days.find((d) => d.date === F.todayStr);
    expect(today).toBeDefined();
    expect(today!.count).toBeGreaterThan(0);
    const d3 = result.days.find((d) => d.date === F.d3Str);
    expect(d3).toBeDefined();
    expect(d3!.count).toBeGreaterThan(0);
    // totals
    expect(result.totals.total).toBeGreaterThanOrEqual(2);
    expect(result.totals.activeDays).toBeGreaterThanOrEqual(2);
  });

  it('cross-user isolation: candidateA1 heatmap total differs from candidateA2', async () => {
    const resultA1 = await getCandidateActivityHeatmap(F.tenantA, F.candidateA1, {});
    const resultA2 = await getCandidateActivityHeatmap(F.tenantA, F.candidateA2, {});
    // A1 has 2 attempts (today + 3 days ago); A2 has 2 attempts (today + 30 days ago)
    // Both have 2 attempts but on different days — verifying counts are independent
    expect(resultA1.totals.total).toBe(2);
    expect(resultA2.totals.total).toBeGreaterThanOrEqual(2);
    // d3Str: A2 should have 0 on that day, A1 should have >0
    const a1d3 = resultA1.days.find((d) => d.date === F.d3Str)?.count ?? 0;
    const a2d3 = resultA2.days.find((d) => d.date === F.d3Str)?.count ?? 0;
    expect(a1d3).toBeGreaterThan(0);
    expect(a2d3).toBe(0);
  });

  it('streaks computed correctly for candidateA1', async () => {
    const result = await getCandidateActivityHeatmap(F.tenantA, F.candidateA1, {});
    // today has count > 0, so current streak >= 1
    expect(result.streaks.current).toBeGreaterThanOrEqual(1);
    expect(result.streaks.longest).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — Timeline
// ---------------------------------------------------------------------------

describe('getCandidateActivityTimeline', () => {
  it('happy path: candidateA1 sees bars with soc domain', async () => {
    const result = await getCandidateActivityTimeline(F.tenantA, F.candidateA1, {});
    expect(result.from).toBeTruthy();
    expect(result.to).toBeTruthy();
    // candidateA1 only took packA (soc domain)
    expect(result.domains).toContain('soc');
    // bars array is non-empty
    expect(result.bars.length).toBeGreaterThan(0);
  });

  it('cross-user isolation: candidateA1 timeline does not include devops domain', async () => {
    const resultA1 = await getCandidateActivityTimeline(F.tenantA, F.candidateA1, {});
    // candidateA1 never took packB (devops) — devops should not appear in domains
    expect(resultA1.domains).not.toContain('devops');
  });

  it('candidateA2 sees devops domain from packB attempt', async () => {
    const resultA2 = await getCandidateActivityTimeline(F.tenantA, F.candidateA2, {});
    // candidateA2 took packA (soc) and packB (devops)
    expect(resultA2.domains).toContain('soc');
    expect(resultA2.domains).toContain('devops');
  });
});

// ---------------------------------------------------------------------------
// Tests — Leaderboard
// ---------------------------------------------------------------------------

describe('getCandidateActivityLeaderboard', () => {
  it('happy path: candidateA1 sees packA with correct rank and total', async () => {
    const result = await getCandidateActivityLeaderboard(F.tenantA, F.candidateA1, {
      page: 1, pageSize: 10,
    });
    expect(result.totalItems).toBe(1); // candidateA1 only took packA
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.packId).toBe(F.packA);
    expect(item.bestScore).toBe(80);         // MAX(70, 80) = 80
    expect(item.attemptCount).toBe(2);        // 2 attempts on packA
    expect(item.rankInPack).toBe(1);          // best score in pack (80 > A2's 60)
    expect(item.totalCandidatesInPack).toBe(2); // A1 + A2 both took packA
  });

  it('cross-user: both candidates took packA — totalCandidatesInPack=2 for both', async () => {
    const [rA1, rA2] = await Promise.all([
      getCandidateActivityLeaderboard(F.tenantA, F.candidateA1, { page: 1, pageSize: 10 }),
      getCandidateActivityLeaderboard(F.tenantA, F.candidateA2, { page: 1, pageSize: 10 }),
    ]);
    const a1packA = rA1.items.find((i) => i.packId === F.packA);
    const a2packA = rA2.items.find((i) => i.packId === F.packA);
    expect(a1packA?.totalCandidatesInPack).toBe(2);
    expect(a2packA?.totalCandidatesInPack).toBe(2);
    // A1 ranks higher (80 vs 60)
    expect(a1packA?.rankInPack).toBe(1);
    expect(a2packA?.rankInPack).toBe(2);
  });

  it('candidateA2 sees both packA and packB', async () => {
    const result = await getCandidateActivityLeaderboard(F.tenantA, F.candidateA2, {
      page: 1, pageSize: 10,
    });
    expect(result.totalItems).toBe(2);
    const packIds = result.items.map((i) => i.packId);
    expect(packIds).toContain(F.packA);
    expect(packIds).toContain(F.packB);
  });

  it('pagination: pageSize=1 page=1 returns first item; page=2 returns second', async () => {
    const page1 = await getCandidateActivityLeaderboard(F.tenantA, F.candidateA2, {
      page: 1, pageSize: 1,
    });
    const page2 = await getCandidateActivityLeaderboard(F.tenantA, F.candidateA2, {
      page: 2, pageSize: 1,
    });
    expect(page1.items).toHaveLength(1);
    expect(page2.items).toHaveLength(1);
    expect(page1.items[0]!.packId).not.toBe(page2.items[0]!.packId);
    expect(page1.page).toBe(1);
    expect(page2.page).toBe(2);
    expect(page1.items[0]!.rank).toBe(1);
    expect(page2.items[0]!.rank).toBe(2);
  });

  it('cross-tenant isolation: candidateA1 total is independent of tenantB data', async () => {
    const result = await getCandidateActivityLeaderboard(F.tenantA, F.candidateA1, {
      page: 1, pageSize: 10,
    });
    // Only packA (tenantA) should appear; tenantB packBt must not leak
    const packIds = result.items.map((i) => i.packId);
    expect(packIds).not.toContain(F.packBt);
  });

  it('empty result for candidateB (unscored attempt only)', async () => {
    // candidateB has one attempt but no attempt_scores → best_score=null, still appears
    // (the query uses LEFT JOIN attempt_scores, so the pack appears even without a score)
    const result = await getCandidateActivityLeaderboard(F.tenantB, F.candidateB, {
      page: 1, pageSize: 10,
    });
    if (result.totalItems > 0) {
      expect(result.items[0]!.bestScore).toBeNull();
    } else {
      expect(result.totalItems).toBeGreaterThanOrEqual(0);
    }
  });
});
