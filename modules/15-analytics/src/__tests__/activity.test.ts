/**
 * Integration tests for modules/15-analytics — Phase 9 Activity endpoints.
 *
 * Uses a postgres:16-alpine testcontainer. One container for all tests.
 *
 * Migration apply order mirrors analytics.test.ts exactly:
 *   1. ALL 02-tenancy migrations
 *   2. 03-users 020_users.sql
 *   3. ALL 04-question-bank migrations
 *   4. ALL 05-assessment-lifecycle migrations
 *   5. ALL 06-attempt-engine migrations
 *   6. 07-ai-grading: 0040_gradings.sql + 0041_tenant_grading_budgets.sql
 *   7. 09-scoring: 0050_attempt_scores.sql
 *   8. 15-analytics: 0060_attempt_summary_mv.sql
 *
 * Coverage:
 *   - computeStreaks: edge cases (empty, all-zero, all-positive, trailing-zero, gap)
 *   - zeroFillRange: fills missing dates; handles cross-month boundary
 *   - rankDomains: ≤7 / exactly 8 / >8 collapse rules
 *   - computePeriodBoundaries: week boundaries from a known today
 *   - computeDelta: prior=0, equal, +20%, -10%, small ±0.4
 *   - getActivityStats: happy path + cross-tenant isolation
 *   - getActivityHeatmap: happy path + cross-tenant isolation
 *   - getActivityTimeline: happy path + cross-tenant isolation
 *   - getActivityLeaderboard: happy path + cross-tenant isolation
 *   - RLS cross-tenant proof: each tenant sees only its own data
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { setPoolForTesting, closePool } from '@assessiq/tenancy';

import {
  getActivityStats,
  getActivityHeatmap,
  getActivityTimeline,
  getActivityLeaderboard,
  computeStreaks,
  zeroFillRange,
  rankDomains,
  computePeriodBoundaries,
  computeDelta,
} from '../index.js';

// ---------------------------------------------------------------------------
// Path helpers (identical to analytics.test.ts)
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR = toFsPath(new URL('.', import.meta.url));
const MODULE_ROOT = join(THIS_DIR, '..', '..');
const MODULES_ROOT = join(MODULE_ROOT, '..');

const TENANCY_DIR  = join(MODULES_ROOT, '02-tenancy', 'migrations');
const USERS_DIR    = join(MODULES_ROOT, '03-users', 'migrations');
const QB_DIR       = join(MODULES_ROOT, '04-question-bank', 'migrations');
const AL_DIR       = join(MODULES_ROOT, '05-assessment-lifecycle', 'migrations');
const AE_DIR       = join(MODULES_ROOT, '06-attempt-engine', 'migrations');
const GRADING_DIR  = join(MODULES_ROOT, '07-ai-grading', 'migrations');
const SCORING_DIR  = join(MODULES_ROOT, '09-scoring', 'migrations');
const ANALYTICS_DIR = join(MODULE_ROOT, 'migrations');

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;

let F: ActivityFixture;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: 'assessiq',
      POSTGRES_PASSWORD: 'assessiq',
      POSTGRES_DB: 'aiq_activity_test',
    })
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  containerUrl = `postgres://assessiq:assessiq@${host}:${port}/aiq_activity_test`;

  await applyAllMigrations();
  await setPoolForTesting(containerUrl);
  F = await seedFixtures();
}, 120_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

// ---------------------------------------------------------------------------
// Migration helpers (mirrors analytics.test.ts exactly)
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
// Fixture types + seed
// ---------------------------------------------------------------------------

interface ActivityFixture {
  // Tenant A
  tenantA: string;
  adminA: string;
  candidateA1: string;
  candidateA2: string;
  // Pack A (soc)
  packA: string;
  levelA: string;
  questionA: string;
  assessmentA1: string; // packA, candidateA1 — today, auto_pct=80
  assessmentA2: string; // packA, candidateA2 — today, auto_pct=60
  assessmentA3: string; // packA, candidateA1 — 3 days ago, auto_pct=70
  attemptA1: string;    // assessmentA1 + candidateA1, today, graded, auto_pct=80
  attemptA2: string;    // assessmentA2 + candidateA2, today, submitted, auto_pct=60
  attemptA3: string;    // assessmentA3 + candidateA1, 3 days ago, graded, auto_pct=70
  // Pack B (devops)
  packB: string;
  levelB: string;
  questionB: string;
  assessmentB1: string; // packB, candidateA2 — 30 days ago, auto_pct=90
  attemptB1: string;    // assessmentB1 + candidateA2, 30 days ago, released, auto_pct=90
  // Tenant B (cross-tenant proof)
  tenantB: string;
  adminB: string;
  candidateB: string;
  packBt: string;
  levelBt: string;
  questionBt: string;
  assessmentB_t: string;
  attemptB_t: string;  // today, submitted, NO attempt_scores row (not graded)
}

async function seedFixtures(): Promise<ActivityFixture> {
  return withSuperClient(async (client) => {
    // IDs
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const adminA = randomUUID();
    const candidateA1 = randomUUID();
    const candidateA2 = randomUUID();
    const adminB = randomUUID();
    const candidateB = randomUUID();

    // Pack A (soc)
    const packA = randomUUID();
    const levelA = randomUUID();
    const questionA = randomUUID();
    const assessmentA1 = randomUUID();
    const assessmentA2 = randomUUID();
    const assessmentA3 = randomUUID();
    const attemptA1 = randomUUID();
    const attemptA2 = randomUUID();
    const attemptA3 = randomUUID();

    // Pack B (devops, tenant A)
    const packB = randomUUID();
    const levelB = randomUUID();
    const questionB = randomUUID();
    const assessmentB1 = randomUUID();
    const attemptB1 = randomUUID();

    // Tenant B
    const packBt = randomUUID();
    const levelBt = randomUUID();
    const questionBt = randomUUID();
    const assessmentB_t = randomUUID();
    const attemptB_t = randomUUID();

    const slugA = `ta-act-${tenantA.slice(0, 8)}`;
    const slugB = `tb-act-${tenantB.slice(0, 8)}`;

    // --- Tenants ---
    await client.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1,'ActivityTenantA',$3),($2,'ActivityTenantB',$4)`,
      [tenantA, tenantB, slugA, slugB],
    );

    // --- Users ---
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES
         ($1, $7, 'admin-a@act.test',      'Admin A',    'admin',     'active'),
         ($2, $7, 'cand-a1@act.test',      'Candidate A1','candidate', 'active'),
         ($3, $7, 'cand-a2@act.test',      'Candidate A2','candidate', 'active'),
         ($4, $8, 'admin-b@act.test',      'Admin B',    'admin',     'active'),
         ($5, $8, 'cand-b@act.test',       'Candidate B','candidate', 'active'),
         ($6, $7, 'admin-a2@act.test',     'Admin A2',   'admin',     'active')`,
      [adminA, candidateA1, candidateA2, adminB, candidateB, randomUUID(), tenantA, tenantB],
    );

    // --- Tenant A Pack A (soc) ---
    await client.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
       VALUES ($1,$2,'act-pack-soc','SOC Pack','soc','published',$3)`,
      [packA, tenantA, adminA],
    );
    await client.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
       VALUES ($1,$2,1,'L1',60,5)`,
      [levelA, packA],
    );
    await client.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
       VALUES ($1,$2,$3,'mcq','network-sec',25,'active','{"question":"Q1","options":["A","B","C","D"],"correct":0,"rationale":"R"}',$4)`,
      [questionA, packA, levelA, adminA],
    );

    // --- Tenant A Pack B (devops) ---
    await client.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
       VALUES ($1,$2,'act-pack-devops','DevOps Pack','devops','published',$3)`,
      [packB, tenantA, adminA],
    );
    await client.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
       VALUES ($1,$2,1,'L1',60,5)`,
      [levelB, packB],
    );
    await client.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
       VALUES ($1,$2,$3,'mcq','ci-cd',25,'active','{"question":"Q2","options":["A","B","C","D"],"correct":1,"rationale":"R"}',$4)`,
      [questionB, packB, levelB, adminA],
    );

    // --- Tenant B pack ---
    await client.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
       VALUES ($1,$2,'act-pack-b','TenantB Pack','pentest','published',$3)`,
      [packBt, tenantB, adminB],
    );
    await client.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
       VALUES ($1,$2,1,'L1',60,5)`,
      [levelBt, packBt],
    );
    await client.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
       VALUES ($1,$2,$3,'mcq','pentest-basics',25,'active','{"question":"QB1","options":["A","B"],"correct":0,"rationale":"R"}',$4)`,
      [questionBt, packBt, levelBt, adminB],
    );

    // --- Assessments ---
    // Tenant A: 3 for pack A + 1 for pack B
    await client.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, name, status, pack_version, question_count, created_by)
       VALUES
         ($1,$5,$6,$7,'SOC-Assess-1','active',1,1,$9),
         ($2,$5,$6,$7,'SOC-Assess-2','active',1,1,$9),
         ($3,$5,$6,$7,'SOC-Assess-3','active',1,1,$9),
         ($4,$5,$8,$10,'DevOps-Assess-1','active',1,1,$9)`,
      [assessmentA1, assessmentA2, assessmentA3, assessmentB1,
       tenantA, packA, levelA, packB, adminA, levelB],
    );

    // Tenant B assessment
    await client.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, name, status, pack_version, question_count, created_by)
       VALUES ($1,$2,$3,$4,'TenantB-Assess-1','active',1,1,$5)`,
      [assessmentB_t, tenantB, packBt, levelBt, adminB],
    );

    // --- Date helpers ---
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    // 3 days ago
    const d3 = new Date(now.getTime() - 3 * 86_400_000);
    // 30 days ago
    const d30 = new Date(now.getTime() - 30 * 86_400_000);

    function makeAttemptDates(submittedAt: Date): { startedAt: Date; endsAt: Date } {
      const startedAt = new Date(submittedAt.getTime() - 600_000); // 10 min before
      const endsAt    = new Date(submittedAt.getTime() + 3600_000);
      return { startedAt, endsAt };
    }

    const a1dates  = makeAttemptDates(now);
    const a2dates  = makeAttemptDates(now);
    const a3dates  = makeAttemptDates(d3);
    const b1dates  = makeAttemptDates(d30);
    const btDates  = makeAttemptDates(now);

    // --- Attempts (Tenant A) ---
    // attemptA1: assessmentA1 + candidateA1, today, status=graded
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'graded',$5,$6,$7,3600)`,
      [attemptA1, tenantA, assessmentA1, candidateA1, a1dates.startedAt, now, a1dates.endsAt],
    );
    // attemptA2: assessmentA2 + candidateA2, today, status=submitted
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'submitted',$5,$6,$7,3600)`,
      [attemptA2, tenantA, assessmentA2, candidateA2, a2dates.startedAt, now, a2dates.endsAt],
    );
    // attemptA3: assessmentA3 + candidateA1, 3 days ago, status=graded
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'graded',$5,$6,$7,3600)`,
      [attemptA3, tenantA, assessmentA3, candidateA1, a3dates.startedAt, d3, a3dates.endsAt],
    );
    // attemptB1 (Tenant A pack B): assessmentB1 + candidateA2, 30 days ago, status=released
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'released',$5,$6,$7,3600)`,
      [attemptB1, tenantA, assessmentB1, candidateA2, b1dates.startedAt, d30, b1dates.endsAt],
    );

    // --- Attempt questions (needed to satisfy FK for gradings) ---
    for (const [attemptId, questionId] of [
      [attemptA1, questionA],
      [attemptA2, questionA],
      [attemptA3, questionA],
      [attemptB1, questionB],
    ]) {
      await client.query(
        `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version)
         VALUES ($1,$2,1,1)`,
        [attemptId, questionId],
      );
    }

    // --- Gradings (for scored attempts) — one row per insert to avoid param confusion ---
    const gradingA1 = randomUUID();
    const gradingA3 = randomUUID();
    const gradingB1 = randomUUID();
    const gradingInsertSql = `INSERT INTO gradings
      (id, attempt_id, question_id, tenant_id, grader, score_earned, score_max, status, reasoning_band, prompt_version_sha, prompt_version_label, model)
      VALUES ($1,$2,$3,$4,'deterministic',$5,$6,'correct',$7,'sha:test','v1','deterministic')`;
    await client.query(gradingInsertSql, [gradingA1, attemptA1, questionA, tenantA, 20, 25, 3]);
    await client.query(gradingInsertSql, [gradingA3, attemptA3, questionA, tenantA, 17, 25, 2]);
    await client.query(gradingInsertSql, [gradingB1, attemptB1, questionB, tenantA, 22, 25, 4]);

    // --- Attempt scores ---
    // attemptA1: auto_pct=80
    await client.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, computed_at)
       VALUES ($1,$2,20,25,80,false,'confident_correct',now())`,
      [attemptA1, tenantA],
    );
    // attemptA2: auto_pct=60
    await client.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, computed_at)
       VALUES ($1,$2,15,25,60,false,'overconfident_wrong',now())`,
      [attemptA2, tenantA],
    );
    // attemptA3: auto_pct=70
    await client.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, computed_at)
       VALUES ($1,$2,17,25,70,false,'uncertain_correct',now())`,
      [attemptA3, tenantA],
    );
    // attemptB1: auto_pct=90
    await client.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, computed_at)
       VALUES ($1,$2,22,25,90,false,'confident_correct',now())`,
      [attemptB1, tenantA],
    );

    // --- Refresh MV so stats endpoint sees the data ---
    await client.query('REFRESH MATERIALIZED VIEW attempt_summary_mv');

    // --- Tenant B attempt (no attempt_scores, unscored) ---
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'submitted',$5,$6,$7,3600)`,
      [attemptB_t, tenantB, assessmentB_t, candidateB, btDates.startedAt, now, btDates.endsAt],
    );
    // No attempt_scores for tenantB — it has a submitted attempt but no score row
    // Refresh again so the MV reflects the tenant B attempt too (it has no score so
    // it won't appear in MV stats, but the heatmap uses live `attempts` table)
    await client.query('REFRESH MATERIALIZED VIEW attempt_summary_mv');

    return {
      tenantA, adminA, candidateA1, candidateA2,
      packA, levelA, questionA, assessmentA1, assessmentA2, assessmentA3,
      attemptA1, attemptA2, attemptA3,
      packB, levelB, questionB, assessmentB1, attemptB1,
      tenantB, adminB, candidateB,
      packBt, levelBt, questionBt, assessmentB_t, attemptB_t,
    };
  });
}

// ---------------------------------------------------------------------------
// Pure helper unit tests — no DB needed
// ---------------------------------------------------------------------------

describe('activity helpers', () => {
  // -------------------------------------------------------------------------
  // computeStreaks
  // -------------------------------------------------------------------------
  describe('computeStreaks', () => {
    it('empty range → { current: 0, longest: 0 }', () => {
      expect(computeStreaks([])).toEqual({ current: 0, longest: 0 });
    });

    it('all-zero days → { current: 0, longest: 0 }', () => {
      const days = [
        { date: '2026-01-01', count: 0 },
        { date: '2026-01-02', count: 0 },
        { date: '2026-01-03', count: 0 },
      ];
      expect(computeStreaks(days)).toEqual({ current: 0, longest: 0 });
    });

    it('all-positive days → current === longest === days.length', () => {
      const days = [
        { date: '2026-01-01', count: 3 },
        { date: '2026-01-02', count: 1 },
        { date: '2026-01-03', count: 5 },
      ];
      expect(computeStreaks(days)).toEqual({ current: 3, longest: 3 });
    });

    it('trailing zero → current=0, longest>0', () => {
      const days = [
        { date: '2026-01-01', count: 2 },
        { date: '2026-01-02', count: 4 },
        { date: '2026-01-03', count: 0 }, // last day is zero → current streak broken
      ];
      const result = computeStreaks(days);
      expect(result.current).toBe(0);
      expect(result.longest).toBe(2);
    });

    it('intermediate gap splits streaks correctly', () => {
      const days = [
        { date: '2026-01-01', count: 1 },
        { date: '2026-01-02', count: 1 },
        { date: '2026-01-03', count: 0 }, // gap
        { date: '2026-01-04', count: 1 },
        { date: '2026-01-05', count: 1 },
        { date: '2026-01-06', count: 1 }, // current streak = 3
      ];
      const result = computeStreaks(days);
      expect(result.current).toBe(3);
      expect(result.longest).toBe(3);
    });

    it('longer streak before gap → longest reflects earlier run', () => {
      const days = [
        { date: '2026-01-01', count: 1 },
        { date: '2026-01-02', count: 1 },
        { date: '2026-01-03', count: 1 },
        { date: '2026-01-04', count: 1 }, // run of 4
        { date: '2026-01-05', count: 0 }, // gap
        { date: '2026-01-06', count: 1 }, // current = 1, longest = 4
      ];
      const result = computeStreaks(days);
      expect(result.current).toBe(1);
      expect(result.longest).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // zeroFillRange
  // -------------------------------------------------------------------------
  describe('zeroFillRange', () => {
    it('fills all dates in range with 0 when counts is empty', () => {
      const counts = new Map<string, number>();
      const days = zeroFillRange('2026-01-01', '2026-01-05', counts);
      expect(days).toHaveLength(5);
      expect(days.every((d) => d.count === 0)).toBe(true);
      expect(days.at(0)!.date).toBe('2026-01-01');
      expect(days.at(4)!.date).toBe('2026-01-05');
    });

    it('populates count from the Map for matching dates', () => {
      const counts = new Map([
        ['2026-01-02', 3],
        ['2026-01-04', 7],
      ]);
      const days = zeroFillRange('2026-01-01', '2026-01-05', counts);
      expect(days).toHaveLength(5);
      expect(days.at(0)!.count).toBe(0); // 01
      expect(days.at(1)!.count).toBe(3); // 02
      expect(days.at(2)!.count).toBe(0); // 03
      expect(days.at(3)!.count).toBe(7); // 04
      expect(days.at(4)!.count).toBe(0); // 05
    });

    it('handles cross-month UTC boundary correctly', () => {
      const counts = new Map([['2026-01-31', 2], ['2026-02-01', 5]]);
      const days = zeroFillRange('2026-01-31', '2026-02-02', counts);
      expect(days).toHaveLength(3);
      expect(days[0]).toEqual({ date: '2026-01-31', count: 2 });
      expect(days[1]).toEqual({ date: '2026-02-01', count: 5 });
      expect(days[2]).toEqual({ date: '2026-02-02', count: 0 });
    });

    it('single-day range returns exactly one entry', () => {
      const counts = new Map([['2026-03-15', 9]]);
      const days = zeroFillRange('2026-03-15', '2026-03-15', counts);
      expect(days).toHaveLength(1);
      expect(days[0]).toEqual({ date: '2026-03-15', count: 9 });
    });
  });

  // -------------------------------------------------------------------------
  // rankDomains
  // -------------------------------------------------------------------------
  describe('rankDomains', () => {
    it('≤7 distinct domains → all returned, no "other"', () => {
      const rows = [
        { domain: 'soc', cnt: 5 },
        { domain: 'devops', cnt: 3 },
        { domain: 'cloud', cnt: 1 },
      ];
      const result = rankDomains(rows);
      expect(result).toHaveLength(3);
      expect(result).not.toContain('other');
      expect(result[0]).toBe('soc'); // sorted desc
    });

    it('exactly 8 distinct domains → all 8 returned, no "other"', () => {
      const rows = Array.from({ length: 8 }, (_, i) => ({
        domain: `domain${i + 1}`,
        cnt: 8 - i, // decreasing counts so domain1 is top
      }));
      const result = rankDomains(rows);
      expect(result).toHaveLength(8);
      expect(result).not.toContain('other');
      expect(result[0]).toBe('domain1');
    });

    it('>8 distinct domains → top 7 + "other" (length === 8)', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        domain: `d${i + 1}`,
        cnt: 10 - i,
      }));
      const result = rankDomains(rows);
      expect(result).toHaveLength(8); // 7 explicit + "other"
      expect(result[7]).toBe('other');
      expect(result[0]).toBe('d1'); // top domain
      expect(result).not.toContain('d8');  // collapsed into "other"
      expect(result).not.toContain('d9');
      expect(result).not.toContain('d10');
    });

    it('empty rows → empty array', () => {
      expect(rankDomains([])).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // computePeriodBoundaries
  // -------------------------------------------------------------------------
  describe('computePeriodBoundaries', () => {
    it('period=week from a known today produces correct 7-day windows', () => {
      // Use a fixed Monday (2026-05-11) as "today" for deterministic math
      const today = new Date('2026-05-11T00:00:00Z');
      const { from, to, priorFrom, priorTo } = computePeriodBoundaries('week', today);

      // current window: 7 days ending today (2026-05-05 to 2026-05-11)
      expect(to).toBe('2026-05-11');
      expect(from).toBe('2026-05-05'); // today - 6 days

      // prior window: 7 days ending the day before from (2026-04-28 to 2026-05-04)
      expect(priorTo).toBe('2026-05-04');   // from - 1 day
      expect(priorFrom).toBe('2026-04-28'); // priorTo - 6 days
    });

    it('period=month produces 30-day windows', () => {
      const today = new Date('2026-05-13T00:00:00Z');
      const { from, to, priorFrom, priorTo } = computePeriodBoundaries('month', today);

      expect(to).toBe('2026-05-13');
      // from = today - 29 days = 2026-04-14
      expect(from).toBe('2026-04-14');
      // priorTo = from - 1 = 2026-04-13
      expect(priorTo).toBe('2026-04-13');
      // priorFrom = priorTo - 29 = 2026-03-15
      expect(priorFrom).toBe('2026-03-15');
    });

    it('period=quarter produces 90-day windows', () => {
      const today = new Date('2026-05-13T00:00:00Z');
      const { from, to, priorFrom, priorTo } = computePeriodBoundaries('quarter', today);

      expect(to).toBe('2026-05-13');
      // from = today - 89 days
      const expectedFrom = new Date(Date.UTC(2026, 4, 13) - 89 * 86_400_000);
      expect(from).toBe(expectedFrom.toISOString().slice(0, 10));
      // Window spans 90 days each (inclusive boundaries)
      const currentDays = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 + 1;
      const priorDays   = (new Date(priorTo).getTime() - new Date(priorFrom).getTime()) / 86_400_000 + 1;
      expect(currentDays).toBe(90);
      expect(priorDays).toBe(90);
    });
  });

  // -------------------------------------------------------------------------
  // computeDelta
  // -------------------------------------------------------------------------
  describe('computeDelta', () => {
    it('prior=0, current>0 → deltaPct=null, direction=up (new entry)', () => {
      const result = computeDelta(5, 0);
      expect(result.deltaPct).toBeNull();
      expect(result.direction).toBe('up');
    });

    it('prior=0, current=0 → deltaPct=0, direction=flat', () => {
      const result = computeDelta(0, 0);
      expect(result.deltaPct).toBe(0);
      expect(result.direction).toBe('flat');
    });

    it('equal counts → deltaPct=0, direction=flat', () => {
      const result = computeDelta(10, 10);
      expect(result.deltaPct).toBe(0);
      expect(result.direction).toBe('flat');
    });

    it('+20% increase → deltaPct=20, direction=up', () => {
      const result = computeDelta(12, 10);
      expect(result.deltaPct).toBe(20);
      expect(result.direction).toBe('up');
    });

    it('-10% decrease → deltaPct=-10, direction=down', () => {
      const result = computeDelta(9, 10);
      expect(result.deltaPct).toBe(-10);
      expect(result.direction).toBe('down');
    });

    it('small ±0.4% within flat band → direction=flat', () => {
      // +0.4%: (10.04 - 10) / 10 * 100 = 0.4
      const up = computeDelta(1004, 1000); // +0.4%
      expect(up.direction).toBe('flat');

      // -0.4%
      const down = computeDelta(996, 1000);
      expect(down.direction).toBe('flat');
    });

    it('exactly 0.5% threshold: 0.5 → flat, 0.6 → up', () => {
      // +0.5%: below the >0.5 threshold → flat
      const at = computeDelta(1005, 1000);
      expect(at.direction).toBe('flat');

      // +1%: clearly above → up
      const above = computeDelta(101, 100);
      expect(above.direction).toBe('up');
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require the test container
// ---------------------------------------------------------------------------

describe('activity endpoints', () => {
  // -------------------------------------------------------------------------
  // getActivityStats
  // -------------------------------------------------------------------------
  describe('getActivityStats', () => {
    it('happy path — tenantA has correct completions, candidates, and avg score', async () => {
      const today = new Date();
      const toStr = today.toISOString().slice(0, 10);
      // Use a 35-day window to capture the 30-day-old attempt
      const fromDate = new Date(today.getTime() - 35 * 86_400_000);
      const fromStr = fromDate.toISOString().slice(0, 10);

      const stats = await getActivityStats(F.tenantA, { from: fromStr, to: toStr, groupBy: 'domain' });

      // 4 scored attempts in MV (all within 35 days): attemptA1, A2, A3, B1
      expect(stats.completions.total).toBe(4);

      // breakdown by domain should have 'soc' and 'devops'
      const domainKeys = stats.completions.breakdown.map((b) => b.key);
      expect(domainKeys).toContain('soc');
      expect(domainKeys).toContain('devops');

      // 2 distinct candidates with scored attempts: candidateA1, candidateA2
      expect(stats.activeCandidates.total).toBe(2);

      // avgScore across 4 scored attempts: (80+60+70+90)/4 = 75
      expect(stats.avgScore.total).toBeCloseTo(75, 0);

      // avgScore breakdown always has all 4 quartile keys
      const scoreKeys = stats.avgScore.breakdown.map((b) => b.key);
      expect(scoreKeys).toContain('top_quartile');
      expect(scoreKeys).toContain('above_median');
      expect(scoreKeys).toContain('below_median');
      expect(scoreKeys).toContain('bottom_quartile');
    });

    it('default 30-day window captures 3 of 4 attempts (30-day one is on the boundary)', async () => {
      // Default window: to=today, from=today-30. The 30-day-old attempt is ON
      // the boundary and may or may not be included depending on exact timestamp.
      // Attempt B1 submitted at d30 (30 days ago exactly), which may fall outside
      // a 30-day window (from = today-30 = same day as d30, inclusive).
      // We just verify the total is >= 3 (A1, A2, A3 are definitely within 30d).
      const stats = await getActivityStats(F.tenantA, {});
      expect(stats.completions.total).toBeGreaterThanOrEqual(3);
    });

    it('cross-tenant RLS — tenantB completions=0 (no scored attempts seeded)', async () => {
      // TenantB has one submitted attempt but NO attempt_scores row → not in MV
      const statsB = await getActivityStats(F.tenantB, {});
      expect(statsB.completions.total).toBe(0);
      expect(statsB.activeCandidates.total).toBe(0);
    });

    it('groupBy=level returns level labels in breakdown', async () => {
      const stats = await getActivityStats(F.tenantA, { groupBy: 'level' });
      expect(stats.groupBy).toBe('level');
      // All attempts use level with label 'L1'
      if (stats.completions.breakdown.length > 0) {
        expect(stats.completions.breakdown.at(0)!.key).toBe('L1');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getActivityHeatmap
  // -------------------------------------------------------------------------
  describe('getActivityHeatmap', () => {
    it('happy path — 91-day window has correct length and counts', async () => {
      const today = new Date();
      const toStr = today.toISOString().slice(0, 10);
      const fromDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 90));
      const fromStr = fromDate.toISOString().slice(0, 10);

      const heatmap = await getActivityHeatmap(F.tenantA, { from: fromStr, to: toStr });

      // 90 days + today = 91 entries
      expect(heatmap.days).toHaveLength(91);
      expect(heatmap.from).toBe(fromStr);
      expect(heatmap.to).toBe(toStr);

      // totals.total = all submitted attempts within 91 days for tenantA
      // A1 (today), A2 (today), A3 (3d ago), B1 (30d ago) — all within 90d
      expect(heatmap.totals.total).toBeGreaterThanOrEqual(4);

      // Active days: at least today (A1+A2) and 3-days-ago (A3)
      expect(heatmap.totals.activeDays).toBeGreaterThanOrEqual(2);

      // Streak: today has submissions so current streak >= 1
      expect(heatmap.streaks.current).toBeGreaterThanOrEqual(1);
      expect(heatmap.streaks.longest).toBeGreaterThanOrEqual(heatmap.streaks.current);
    });

    it('today only window returns exactly 1 day', async () => {
      const toStr = new Date().toISOString().slice(0, 10);
      const heatmap = await getActivityHeatmap(F.tenantA, { from: toStr, to: toStr });
      expect(heatmap.days).toHaveLength(1);
      // Today has 2 submissions (A1, A2)
      expect(heatmap.days.at(0)!.count).toBeGreaterThanOrEqual(2);
    });

    it('cross-tenant RLS — tenantB heatmap sees only tenantB attempts', async () => {
      const today = new Date();
      const toStr = today.toISOString().slice(0, 10);
      const fromDate = new Date(today.getTime() - 7 * 86_400_000);
      const fromStr = fromDate.toISOString().slice(0, 10);

      const heatmapB = await getActivityHeatmap(F.tenantB, { from: fromStr, to: toStr });

      // Tenant B has 1 submitted attempt today
      expect(heatmapB.totals.total).toBe(1);

      // The day entry for today should have count >= 1
      const todayEntry = heatmapB.days.find((d) => d.date === toStr);
      expect(todayEntry).toBeDefined();
      expect(todayEntry!.count).toBeGreaterThanOrEqual(1);

      // Total is strictly less than tenantA's total in the same window
      const heatmapA = await getActivityHeatmap(F.tenantA, { from: fromStr, to: toStr });
      expect(heatmapA.totals.total).toBeGreaterThan(heatmapB.totals.total);
    });
  });

  // -------------------------------------------------------------------------
  // getActivityTimeline
  // -------------------------------------------------------------------------
  describe('getActivityTimeline', () => {
    it('happy path — tenantA timeline contains soc and devops domains', async () => {
      const today = new Date();
      const toStr = today.toISOString().slice(0, 10);
      const fromDate = new Date(today.getTime() - 35 * 86_400_000);
      const fromStr = fromDate.toISOString().slice(0, 10);

      const timeline = await getActivityTimeline(F.tenantA, { from: fromStr, to: toStr });

      // domains array should contain 'soc' and 'devops'
      expect(timeline.domains).toContain('soc');
      expect(timeline.domains).toContain('devops');

      // bars array should be non-empty (at least 1 week in the range)
      expect(timeline.bars.length).toBeGreaterThanOrEqual(1);

      // Sum of all segments across all bars should equal total scored completions
      const totalSegments = timeline.bars.reduce((sum, bar) => sum + bar.total, 0);
      // We have 4 scored attempts in the MV within 35 days
      expect(totalSegments).toBeGreaterThanOrEqual(4);

      // Each bar's total === sum of its segments
      for (const bar of timeline.bars) {
        const segSum = bar.segments.reduce((s, n) => s + n, 0);
        expect(bar.total).toBe(segSum);
      }

      // segments array length matches domains array length
      for (const bar of timeline.bars) {
        expect(bar.segments).toHaveLength(timeline.domains.length);
      }
    });

    it('cross-tenant RLS — tenantB timeline has <= 1 total submission', async () => {
      const today = new Date();
      const toStr = today.toISOString().slice(0, 10);
      const fromDate = new Date(today.getTime() - 7 * 86_400_000);
      const fromStr = fromDate.toISOString().slice(0, 10);

      const timelineB = await getActivityTimeline(F.tenantB, { from: fromStr, to: toStr });

      // TenantB's submitted attempt has no score so is not in the MV —
      // timeline uses attempt_summary_mv. TenantB's total should be 0.
      const totalB = timelineB.bars.reduce((sum, bar) => sum + bar.total, 0);
      expect(totalB).toBe(0);
    });

    it('from/to returned match the query dates', async () => {
      const from = '2026-01-01';
      const to = '2026-01-31';
      const timeline = await getActivityTimeline(F.tenantA, { from, to });
      expect(timeline.from).toBe(from);
      expect(timeline.to).toBe(to);
    });
  });

  // -------------------------------------------------------------------------
  // getActivityLeaderboard
  // -------------------------------------------------------------------------
  describe('getActivityLeaderboard', () => {
    it('happy path — tenantA leaderboard month period has entries', async () => {
      const lb = await getActivityLeaderboard(F.tenantA, { period: 'month', page: 1, pageSize: 10 });

      expect(lb.period).toBe('month');
      expect(lb.totalRanked).toBeGreaterThanOrEqual(1);
      expect(lb.items.length).toBeGreaterThanOrEqual(1);

      // Each item should have a packId and packName populated
      for (const item of lb.items) {
        expect(item.packId).not.toBeNull();
        expect(item.packName).not.toBeNull();
        expect(item.currentCount).toBeGreaterThanOrEqual(1);
        expect(item.rank).toBeGreaterThanOrEqual(1);
      }

      // Ranks are sequential starting from 1
      lb.items.forEach((item, idx) => {
        expect(item.rank).toBe(idx + 1);
      });
    });

    it('leaderboard week period — assessments with today submissions appear', async () => {
      const lb = await getActivityLeaderboard(F.tenantA, { period: 'week', page: 1, pageSize: 10 });

      // Attempts A1, A2, A3 all fall within the last 7 days
      expect(lb.totalRanked).toBeGreaterThanOrEqual(1);

      // Domain values should be the raw slugs ('soc', 'devops')
      const domains = lb.items.map((i) => i.domain).filter(Boolean);
      expect(domains.some((d) => d === 'soc' || d === 'devops')).toBe(true);
    });

    it('pagination — page 2 returns empty when totalRanked <= pageSize', async () => {
      const lb1 = await getActivityLeaderboard(F.tenantA, { period: 'month', page: 1, pageSize: 50 });
      if (lb1.totalRanked <= 50) {
        const lb2 = await getActivityLeaderboard(F.tenantA, { period: 'month', page: 2, pageSize: 50 });
        expect(lb2.items).toHaveLength(0);
        expect(lb2.page).toBe(2);
      }
    });

    it('cross-tenant RLS — tenantB leaderboard sees only tenantB assessments', async () => {
      const lbB = await getActivityLeaderboard(F.tenantB, { period: 'month', page: 1, pageSize: 10 });

      // TenantB has 1 submitted attempt (no score, but leaderboard uses live attempts table)
      // so its assessment_B_t should appear if within the month window
      // totalRanked could be 0 or 1 depending on the submitted_at filter
      // The attempt IS submitted today, so it IS within the month window
      expect(lbB.totalRanked).toBeLessThanOrEqual(1);

      // TenantA assessments must NOT appear in TenantB results
      if (lbB.items.length > 0) {
        const itemPackIds = lbB.items.map((i) => i.packId);
        expect(itemPackIds).not.toContain(F.packA);
        expect(itemPackIds).not.toContain(F.packB);
      }
    });

    it('quarter period returns priorFrom/priorTo that are each 90 days', async () => {
      const lb = await getActivityLeaderboard(F.tenantA, { period: 'quarter', page: 1, pageSize: 1 });

      const currentDays =
        (new Date(lb.to).getTime() - new Date(lb.from).getTime()) / 86_400_000 + 1;
      const priorDays =
        (new Date(lb.priorTo).getTime() - new Date(lb.priorFrom).getTime()) / 86_400_000 + 1;

      expect(currentDays).toBe(90);
      expect(priorDays).toBe(90);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-tenant RLS proof (explicit side-by-side comparison)
  // -------------------------------------------------------------------------
  describe('RLS cross-tenant proof', () => {
    it('getActivityStats — tenantA and tenantB return disjoint data', async () => {
      const [statsA, statsB] = await Promise.all([
        getActivityStats(F.tenantA, {}),
        getActivityStats(F.tenantB, {}),
      ]);

      // TenantA has scored attempts; TenantB has none
      expect(statsA.completions.total).toBeGreaterThan(0);
      expect(statsB.completions.total).toBe(0);

      // TenantA has active candidates; TenantB has none (no scored attempts)
      expect(statsA.activeCandidates.total).toBeGreaterThan(0);
      expect(statsB.activeCandidates.total).toBe(0);
    });

    it('getActivityHeatmap — tenantA total strictly greater than tenantB', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const [heatmapA, heatmapB] = await Promise.all([
        getActivityHeatmap(F.tenantA, { to: today }),
        getActivityHeatmap(F.tenantB, { to: today }),
      ]);

      expect(heatmapA.totals.total).toBeGreaterThan(heatmapB.totals.total);
    });

    it('getActivityLeaderboard — tenantA results exclude tenantB pack IDs', async () => {
      const [lbA, lbB] = await Promise.all([
        getActivityLeaderboard(F.tenantA, { period: 'month', page: 1, pageSize: 50 }),
        getActivityLeaderboard(F.tenantB, { period: 'month', page: 1, pageSize: 50 }),
      ]);

      // TenantA results should not contain tenantB packs
      const packIdsA = lbA.items.map((i) => i.packId);
      expect(packIdsA).not.toContain(F.packBt);

      // TenantB results should not contain tenantA packs
      const packIdsB = lbB.items.map((i) => i.packId);
      expect(packIdsB).not.toContain(F.packA);
      expect(packIdsB).not.toContain(F.packB);
    });
  });
});
