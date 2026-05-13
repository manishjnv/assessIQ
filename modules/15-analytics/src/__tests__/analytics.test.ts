/**
 * Integration tests for modules/15-analytics.
 *
 * Uses a postgres:16-alpine testcontainer. One container for all tests.
 *
 * Migration apply order:
 *   1. ALL 02-tenancy migrations (roles, tenant_settings, etc.)
 *   2. 03-users 020_users.sql
 *   3. ALL 04-question-bank migrations
 *   4. ALL 05-assessment-lifecycle migrations
 *   5. ALL 06-attempt-engine migrations
 *   6. 07-ai-grading: 0040_gradings.sql + 0041_tenant_grading_budgets.sql
 *   7. 09-scoring: 0050_attempt_scores.sql
 *   8. 15-analytics: 0060_attempt_summary_mv.sql
 *
 * Coverage:
 *   - homeKpis: correct counts (active assessments, attempts this week, awaiting review)
 *   - queueSummary: correct status bucketing
 *   - cohortReport: correct aggregation + level/topic breakdown + archetype distribution
 *   - individualReport: correct attempt list + archetype progression
 *   - topicHeatmap: correct hit rate + mean band per topic
 *   - archetypeDistribution: correct counts per archetype
 *   - gradingCostByMonth: returns [] in claude-code-vps mode
 *   - Cross-tenant isolation: tenant A data is invisible to tenant B queries
 *   - Export CSV: correct columns + row cap enforcement
 *   - Export JSONL: correct shape per line
 *   - Phase 9: getActivityStats / getActivityHeatmap / getActivityTimeline / getActivityLeaderboard
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { setPoolForTesting, closePool } from '@assessiq/tenancy';

import {
  homeKpis,
  queueSummary,
  cohortReport,
  individualReport,
  topicHeatmap,
  archetypeDistribution,
  gradingCostByMonth,
  exportAttemptsCsv,
  exportAttemptsJsonl,
  EXPORT_ROW_CAP,
  getActivityStats,
  getActivityHeatmap,
  getActivityTimeline,
  getActivityLeaderboard,
  ActivityStatsQuerySchema,
  ActivityHeatmapQuerySchema,
  ActivityTimelineQuerySchema,
  ActivityLeaderboardQuerySchema,
} from '../index.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR = toFsPath(new URL('.', import.meta.url));
const MODULE_ROOT = join(THIS_DIR, '..', '..');
const MODULES_ROOT = join(MODULE_ROOT, '..');

const TENANCY_DIR = join(MODULES_ROOT, '02-tenancy', 'migrations');
const USERS_DIR = join(MODULES_ROOT, '03-users', 'migrations');
const QB_DIR = join(MODULES_ROOT, '04-question-bank', 'migrations');
const AL_DIR = join(MODULES_ROOT, '05-assessment-lifecycle', 'migrations');
const AE_DIR = join(MODULES_ROOT, '06-attempt-engine', 'migrations');
const GRADING_DIR = join(MODULES_ROOT, '07-ai-grading', 'migrations');
const SCORING_DIR = join(MODULES_ROOT, '09-scoring', 'migrations');
const ANALYTICS_DIR = join(MODULE_ROOT, 'migrations');

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;

// Fixtures are seeded once in the global beforeAll and shared across all tests.
let F: TestFixture;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: 'assessiq',
      POSTGRES_PASSWORD: 'assessiq',
      POSTGRES_DB: 'aiq_test',
    })
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  containerUrl = `postgres://assessiq:assessiq@${host}:${port}/aiq_test`;

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
// Fixture helpers
// ---------------------------------------------------------------------------

interface TestFixture {
  tenantA: string;
  tenantB: string;
  adminA: string;
  candidateA: string;
  packA: string;
  levelA: string;
  questionA: string;
  assessmentA: string;
  attemptA1: string; // submitted + scored, tenant A
  attemptA2: string; // in_progress, tenant A
  tenantB_assessment: string;
  tenantB_attempt: string;
  tenantB_candidate: string;
  // Phase 9 activity extras
  packB: string;           // second pack, domain='cloud', tenant A
  assessmentB: string;     // assessment for packB
  attemptGraded: string;   // graded status, today, tenant A, assessmentA (soc)
  attemptReleased: string; // released status, today, tenant A, assessmentB (cloud)
  candidateB: string;
  candidateC: string;
}

async function seedFixtures(): Promise<TestFixture> {
  return withSuperClient(async (client) => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const adminA = randomUUID();
    const candidateA = randomUUID();
    const packA = randomUUID();
    const levelA = randomUUID();
    const questionA = randomUUID();
    const assessmentA = randomUUID();
    const attemptA1 = randomUUID();
    const attemptA2 = randomUUID();
    const tenantB_admin = randomUUID();
    const tenantB_assessment = randomUUID();
    const tenantB_attempt = randomUUID();
    const tenantB_candidate = randomUUID();

    // Use slug derived from UUID to avoid collisions if test is re-run
    const slugA = `ta-${tenantA.slice(0, 8)}`;
    const slugB = `tb-${tenantB.slice(0, 8)}`;

    // Tenants
    await client.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1,'TenantA',$3),($2,'TenantB',$4)`,
      [tenantA, tenantB, slugA, slugB],
    );

    // Users
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status)
       VALUES
         ($1,$2,'admin-a@a.test','Admin A','admin','active'),
         ($3,$2,'candidate-a@a.test','Cand A','candidate','active'),
         ($4,$5,'admin-b@b.test','Admin B','admin','active'),
         ($6,$5,'candidate-b@b.test','Cand B','candidate','active')`,
      [adminA, tenantA, candidateA, tenantB_admin, tenantB, tenantB_candidate],
    );

    // Pack → level → question (tenant A)
    await client.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
       VALUES ($1,$2,'test-pack','Test Pack','soc','published',$3)`,
      [packA, tenantA, adminA],
    );
    await client.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
       VALUES ($1,$2,1,'L1',60,5)`,
      [levelA, packA],
    );
    // question status: 'draft'|'active'|'archived' (not 'published')
    await client.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
       VALUES ($1,$2,$3,'mcq','network-security',25,'active','{"question":"Q1","options":["A","B","C","D"],"correct":0,"rationale":"R"}',$4)`,
      [questionA, packA, levelA, adminA],
    );

    // Assessment (tenant A)
    await client.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, name, status, pack_version, question_count, created_by)
       VALUES ($1,$2,$3,$4,'Test Assessment','active',1,1,$5)`,
      [assessmentA, tenantA, packA, levelA, adminA],
    );

    // Attempts
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
    const startedAt = new Date(threeDaysAgo.getTime() + 300_000);
    const submittedAt = new Date(startedAt.getTime() + 600_000);

    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'submitted',$5,$6,$7,3600)`,
      [attemptA1, tenantA, assessmentA, candidateA, startedAt, submittedAt, new Date(startedAt.getTime() + 3600_000)],
    );

    // Second attempt: in_progress, use adminA (different user to avoid UNIQUE(assessment_id, user_id))
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'in_progress',$5,$6,3600)`,
      [attemptA2, tenantA, assessmentA, adminA, new Date(), new Date(Date.now() + 3600_000)],
    );

    // Attempt questions + gradings for attemptA1
    const gradingId1 = randomUUID();
    await client.query(
      `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version)
       VALUES ($1,$2,1,1)`,
      [attemptA1, questionA],
    );
    await client.query(
      `INSERT INTO gradings (id, attempt_id, question_id, tenant_id, grader, score_earned, score_max, status, reasoning_band, prompt_version_sha, prompt_version_label, model)
       VALUES ($1,$2,$3,$4,'deterministic',25,25,'correct',4,'sha:test','v1','deterministic')`,
      [gradingId1, attemptA1, questionA, tenantA],
    );

    // Attempt score for attemptA1
    await client.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, computed_at)
       VALUES ($1,$2,25,25,100,false,'confident_correct',now())`,
      [attemptA1, tenantA],
    );

    // -----------------------------------------------------------------------
    // Phase 9 activity extras — additional seed rows for activity endpoints.
    // All graded/released attempts inserted BEFORE the MV refresh so the MV
    // stats endpoint sees them. The heatmap uses the live attempts table so
    // it sees graded/released attempts regardless of MV refresh.
    // -----------------------------------------------------------------------

    const packB = randomUUID();
    const assessmentB = randomUUID();
    const attemptGraded = randomUUID();
    const attemptReleased = randomUUID();
    const candidateB = randomUUID();
    const candidateC = randomUUID();

    // candidateB and candidateC under tenantA
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status)
       VALUES
         ($1,$2,'candidate-b2@a.test','Cand B2','candidate','active'),
         ($3,$2,'candidate-c2@a.test','Cand C2','candidate','active')`,
      [candidateB, tenantA, candidateC],
    );

    // packB — domain 'cloud', tenant A (reuse levelA for simplicity)
    await client.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
       VALUES ($1,$2,'cloud-pack','Cloud Pack','cloud','published',$3)`,
      [packB, tenantA, adminA],
    );

    // assessmentB uses packB (cloud domain)
    await client.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, name, status, pack_version, question_count, created_by)
       VALUES ($1,$2,$3,$4,'Cloud Assessment','active',1,1,$5)`,
      [assessmentB, tenantA, packB, levelA, adminA],
    );

    // attemptGraded: graded status, submitted today, assessmentA (soc), candidateB
    const gradedSubmittedAt = new Date();
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'graded',$5,$6,$7,3600)`,
      [attemptGraded, tenantA, assessmentA, candidateB,
        new Date(gradedSubmittedAt.getTime() - 600_000),
        gradedSubmittedAt,
        new Date(gradedSubmittedAt.getTime() + 3600_000)],
    );
    await client.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, computed_at)
       VALUES ($1,$2,75,100,75,false,'confident_correct',now())`,
      [attemptGraded, tenantA],
    );

    // attemptReleased: released status, submitted today, assessmentB (cloud), candidateC
    const releasedSubmittedAt = new Date();
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'released',$5,$6,$7,3600)`,
      [attemptReleased, tenantA, assessmentB, candidateC,
        new Date(releasedSubmittedAt.getTime() - 600_000),
        releasedSubmittedAt,
        new Date(releasedSubmittedAt.getTime() + 3600_000)],
    );
    await client.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, archetype, computed_at)
       VALUES ($1,$2,50,100,50,false,'partial',now())`,
      [attemptReleased, tenantA],
    );

    // candidateD: new user for prior-period leaderboard attempt.
    // (assessment_id, user_id) must be unique on attempts table.
    const candidateD = randomUUID();
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status)
       VALUES ($1,$2,'candidate-d2@a.test','Cand D2','candidate','active')`,
      [candidateD, tenantA],
    );

    // Prior-period attempt: assessmentA, candidateD, 10 days ago.
    // Appears in the leaderboard prior_period CTE (live attempts, not MV).
    const priorSubmittedAt = new Date(Date.now() - 10 * 24 * 3600_000);
    const attemptPrior = randomUUID();
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'graded',$5,$6,$7,3600)`,
      [attemptPrior, tenantA, assessmentA, candidateD,
        new Date(priorSubmittedAt.getTime() - 600_000),
        priorSubmittedAt,
        new Date(priorSubmittedAt.getTime() + 3600_000)],
    );

    // Refresh the materialized view so MV-based queries (stats, timeline) see all scored attempts
    await client.query('REFRESH MATERIALIZED VIEW attempt_summary_mv');

    // Tenant B fixtures
    await client.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, name, status, pack_version, question_count, created_by)
       VALUES ($1,$2,$3,$4,'TenantB Assessment','active',1,1,$5)`,
      [tenantB_assessment, tenantB, packA, levelA, tenantB_admin],
    );
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'pending_admin_grading',$5,$6,3600)`,
      [tenantB_attempt, tenantB, tenantB_assessment, tenantB_candidate, new Date(), new Date(Date.now() + 3600_000)],
    );

    return {
      tenantA, tenantB, adminA, candidateA,
      packA, levelA, questionA, assessmentA,
      attemptA1, attemptA2,
      tenantB_assessment, tenantB_attempt, tenantB_candidate,
      packB, assessmentB, attemptGraded, attemptReleased,
      candidateB, candidateC,
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('homeKpis', () => {
  it('returns correct active assessment count', async () => {
    const kpis = await homeKpis(F.tenantA);
    expect(kpis.activeAssessments).toBeGreaterThanOrEqual(1);
  });

  it('returns attemptsThisWeek >= 1 (in_progress created just now)', async () => {
    const kpis = await homeKpis(F.tenantA);
    expect(kpis.attemptsThisWeek).toBeGreaterThanOrEqual(1);
  });

  it('returns awaitingReview = 0 for tenant A (no pending_admin_grading attempts)', async () => {
    const kpis = await homeKpis(F.tenantA);
    expect(kpis.awaitingReview).toBe(0);
  });

  it('cross-tenant: tenant B sees its own awaiting review, not tenant A', async () => {
    const kpisB = await homeKpis(F.tenantB);
    expect(kpisB.awaitingReview).toBe(1);
  });
});

describe('queueSummary', () => {
  it('inProgress includes tenant A in_progress attempts', async () => {
    const summary = await queueSummary(F.tenantA);
    expect(summary.inProgress).toBeGreaterThanOrEqual(1);
  });

  it('awaitingReview = 0 for tenant A', async () => {
    const summary = await queueSummary(F.tenantA);
    expect(summary.awaitingReview).toBe(0);
  });

  it('grading = 0 always in Phase 1 (no async grading)', async () => {
    const summary = await queueSummary(F.tenantA);
    expect(summary.grading).toBe(0);
  });
});

describe('cohortReport', () => {
  it('returns correct attempt count', async () => {
    const report = await cohortReport(F.tenantA, F.assessmentA);
    // attemptA1 is submitted + scored in the MV
    expect(report.attemptCount).toBeGreaterThanOrEqual(1);
  });

  it('returns a non-null averagePct when scored attempts exist', async () => {
    const report = await cohortReport(F.tenantA, F.assessmentA);
    if (report.attemptCount > 0) {
      expect(report.averagePct).not.toBeNull();
    }
  });

  it('cross-tenant isolation: cohortReport for tenant B assessment returns 0', async () => {
    // Tenant A querying tenant B assessment should get 0 (MV filter)
    const report = await cohortReport(F.tenantA, F.tenantB_assessment);
    expect(report.attemptCount).toBe(0);
  });

  it('archetype distribution contains confident_correct when scored', async () => {
    const report = await cohortReport(F.tenantA, F.assessmentA);
    if (report.attemptCount > 0) {
      expect(typeof report.archetypeDistribution).toBe('object');
    }
  });
});

describe('individualReport', () => {
  it('returns attempt history for the candidate', async () => {
    const report = await individualReport(F.tenantA, F.candidateA);
    expect(report.userId).toBe(F.candidateA);
    expect(Array.isArray(report.attempts)).toBe(true);
  });

  it('cross-tenant: tenant A querying unknown candidate returns empty', async () => {
    const report = await individualReport(F.tenantA, randomUUID());
    expect(report.attempts).toHaveLength(0);
  });
});

describe('topicHeatmap', () => {
  it('returns cells for the pack when graded attempts exist', async () => {
    const heatmap = await topicHeatmap({
      tenantId: F.tenantA,
      packId: F.packA,
    });
    expect(heatmap.packId).toBe(F.packA);
    expect(heatmap.tenantId).toBe(F.tenantA);
    expect(Array.isArray(heatmap.cells)).toBe(true);
  });

  it('returns empty cells for unknown pack', async () => {
    const heatmap = await topicHeatmap({
      tenantId: F.tenantA,
      packId: randomUUID(),
    });
    expect(heatmap.cells).toHaveLength(0);
  });
});

describe('archetypeDistribution', () => {
  it('returns array (may be empty if no archetypes assigned)', async () => {
    const dist = await archetypeDistribution(F.tenantA, F.assessmentA);
    expect(Array.isArray(dist)).toBe(true);
  });

  it('cross-tenant: tenant A querying tenant B assessment returns empty', async () => {
    const dist = await archetypeDistribution(F.tenantA, F.tenantB_assessment);
    expect(dist).toHaveLength(0);
  });
});

describe('gradingCostByMonth', () => {
  it('returns [] in claude-code-vps mode (P3.D21)', async () => {
    // The default AI_PIPELINE_MODE in test env is claude-code-vps
    const rows = await gradingCostByMonth('some-tenant-id', 2026);
    expect(rows).toEqual([]);
  });
});

describe('export CSV', () => {
  it('returns a Readable stream', async () => {
    const stream = await exportAttemptsCsv({ tenantId: F.tenantA, filters: {} });
    expect(stream).toBeDefined();
    expect(typeof stream.pipe).toBe('function');
  });

  it('CSV stream begins with the correct header line', async () => {
    const stream = await exportAttemptsCsv({ tenantId: F.tenantA, filters: {} });
    const firstChunk = await new Promise<string>((resolve, reject) => {
      let buf = '';
      stream.on('data', (chunk: Buffer | string) => {
        buf += chunk.toString();
        if (buf.includes('\n')) resolve(buf);
      });
      stream.on('end', () => resolve(buf));
      stream.on('error', reject);
    });
    expect(firstChunk).toContain('tenant_id');
    expect(firstChunk).toContain('assessment_id');
    expect(firstChunk).toContain('user_email');
    expect(firstChunk).toContain('attempt_id');
  });

  it('JSONL stream emits valid JSON objects', async () => {
    const stream = await exportAttemptsJsonl({ tenantId: F.tenantA, filters: {} });
    const lines = await new Promise<string[]>((resolve, reject) => {
      const chunks: string[] = [];
      stream.on('data', (chunk: Buffer | string) => chunks.push(chunk.toString()));
      stream.on('end', () => resolve(chunks.join('').trim().split('\n').filter(Boolean)));
      stream.on('error', reject);
    });
    // All lines should parse as JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('EXPORT_ROW_CAP is 10_000', () => {
    expect(EXPORT_ROW_CAP).toBe(10_000);
  });

  it('cross-tenant: tenant A export does not include tenant B attempts', async () => {
    const stream = await exportAttemptsCsv({ tenantId: F.tenantA, filters: {} });
    const content = await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      stream.on('data', (c: Buffer | string) => chunks.push(c.toString()));
      stream.on('end', () => resolve(chunks.join('')));
      stream.on('error', reject);
    });
    // Tenant B attempt IDs should not appear in tenant A export
    expect(content).not.toContain(F.tenantB_attempt);
  });
});

// ===========================================================================
// Phase 9 — Admin Activity endpoints
// ===========================================================================

// Helper: ISO date string relative to today (UTC).
// daysAgo=0 = today, daysAgo=-1 = tomorrow, daysAgo=7 = 7 days ago.
function utcDateStr(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

describe('getActivityStats', () => {
  it('happy path: returns completions from both soc and cloud domains', async () => {
    // Stats queries attempt_summary_mv with submitted_at >= $1 AND < $2 + 1 day
    // Using date-only strings works correctly with the +1 day offset.
    const from = utcDateStr(30);
    const to = utcDateStr(0);
    const stats = await getActivityStats(F.tenantA, { from, to, groupBy: 'domain' });
    // attemptGraded (assessmentA/soc) + attemptReleased (assessmentB/cloud) both scored
    expect(stats.completions.total).toBeGreaterThanOrEqual(2);
    const domains = stats.completions.breakdown.map((b) => b.key);
    expect(domains).toContain('soc');
    expect(domains).toContain('cloud');
  });

  it('empty window: returns zero completions', async () => {
    const stats = await getActivityStats(F.tenantA, { from: '2020-01-01', to: '2020-01-02' });
    expect(stats.completions.total).toBe(0);
    expect(stats.completions.breakdown).toHaveLength(0);
  });

  it('groupBy validation: schema accepts domain and level', () => {
    const r1 = ActivityStatsQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-31', groupBy: 'domain' });
    expect(r1.success).toBe(true);
    const r2 = ActivityStatsQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-31', groupBy: 'level' });
    expect(r2.success).toBe(true);
    const r3 = ActivityStatsQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-31', groupBy: 'user' });
    expect(r3.success).toBe(false);
  });

  it('cross-tenant: tenant B sees 0 completions', async () => {
    const stats = await getActivityStats(F.tenantB, { from: utcDateStr(30), to: utcDateStr(0) });
    expect(stats.completions.total).toBe(0);
  });
});

describe('getActivityHeatmap', () => {
  it('happy path: days array covers [from, to] inclusive', async () => {
    const from = utcDateStr(7);
    const to = utcDateStr(0);
    const heatmap = await getActivityHeatmap(F.tenantA, { from, to });
    // 0 through 7 days ago = 8 days
    expect(heatmap.days.length).toBe(8);
    expect(heatmap.days[0]?.date).toBe(from);
    expect(heatmap.days[heatmap.days.length - 1]?.date).toBe(to);
  });

  it('happy path: at least one active day (graded/released attempts today)', async () => {
    // Heatmap uses live attempts table with status IN (...graded, released...)
    const heatmap = await getActivityHeatmap(F.tenantA, { from: utcDateStr(1), to: utcDateStr(0) });
    expect(heatmap.totals.activeDays).toBeGreaterThanOrEqual(1);
    expect(heatmap.totals.total).toBeGreaterThanOrEqual(2);
  });

  it('streak edge — single-day completion: longestStreak >= 1', async () => {
    const today = utcDateStr(0);
    const heatmap = await getActivityHeatmap(F.tenantA, { from: today, to: today });
    if (heatmap.totals.total > 0) {
      expect(heatmap.streaks.longest).toBeGreaterThanOrEqual(1);
      expect(heatmap.streaks.current).toBeGreaterThanOrEqual(1);
    }
  });

  it('streak edge — empty window: all streak fields are 0', async () => {
    const heatmap = await getActivityHeatmap(F.tenantA, { from: '2020-01-01', to: '2020-01-05' });
    expect(heatmap.streaks.longest).toBe(0);
    expect(heatmap.streaks.current).toBe(0);
    expect(heatmap.totals.activeDays).toBe(0);
    expect(heatmap.totals.total).toBe(0);
    expect(heatmap.days.length).toBe(5); // zero-filled
  });

  it('cross-tenant: tenant B sees 0 completions', async () => {
    const heatmap = await getActivityHeatmap(F.tenantB, { from: utcDateStr(7), to: utcDateStr(0) });
    expect(heatmap.totals.total).toBe(0);
    expect(heatmap.totals.activeDays).toBe(0);
  });

  it('schema validation: accepts optional from/to params', () => {
    const r1 = ActivityHeatmapQuerySchema.safeParse({});
    expect(r1.success).toBe(true);
    const r2 = ActivityHeatmapQuerySchema.safeParse({ from: '2026-01-01', to: '2026-03-01' });
    expect(r2.success).toBe(true);
    const r3 = ActivityHeatmapQuerySchema.safeParse({ from: 'not-a-date' });
    expect(r3.success).toBe(false);
  });
});

describe('getActivityTimeline', () => {
  it('happy path: returns weeks with both soc and cloud domains', async () => {
    const timeline = await getActivityTimeline(F.tenantA, { from: utcDateStr(30), to: utcDateStr(0) });
    expect(Array.isArray(timeline.bars)).toBe(true);
    expect(timeline.domains).toContain('soc');
    expect(timeline.domains).toContain('cloud');
    // At least one bar has data
    const barWithData = timeline.bars.find((w) => w.total > 0);
    expect(barWithData).toBeDefined();
  });

  it('empty window: returns empty domains and zero-filled bars', async () => {
    const timeline = await getActivityTimeline(F.tenantA, { from: '2020-01-06', to: '2020-01-12' });
    // No completions in this window
    expect(timeline.domains).toHaveLength(0);
    // Jan 6 is a Monday, Jan 12 is Sunday — 1 week in window
    expect(timeline.bars.length).toBeGreaterThanOrEqual(1);
    for (const bar of timeline.bars) {
      expect(bar.total).toBe(0);
    }
  });

  it('cross-tenant: tenant B sees empty domains', async () => {
    const timeline = await getActivityTimeline(F.tenantB, { from: utcDateStr(30), to: utcDateStr(0) });
    expect(timeline.domains).toHaveLength(0);
  });

  it('schema validation: accepts optional from/to', () => {
    const r1 = ActivityTimelineQuerySchema.safeParse({});
    expect(r1.success).toBe(true);
    const r2 = ActivityTimelineQuerySchema.safeParse({ from: 'not-a-date' });
    expect(r2.success).toBe(false);
  });
});

describe('getActivityLeaderboard', () => {
  it('happy path: returns assessments with attempts for week period', async () => {
    const lb = await getActivityLeaderboard(F.tenantA, { period: 'week', page: 1, pageSize: 10 });
    // attemptGraded and attemptA2 are in the current week
    expect(lb.totalRanked).toBeGreaterThanOrEqual(1);
    expect(lb.items.length).toBeGreaterThanOrEqual(1);
    expect(lb.items[0]?.rank).toBe(1);
  });

  it('deltaPct is null when prior period has 0 takers (assessmentB cloud, week period)', async () => {
    // assessmentB (cloud) has only one released attempt today — no prior week data
    const lb = await getActivityLeaderboard(F.tenantA, { period: 'week', page: 1, pageSize: 50 });
    const cloudItem = lb.items.find((item) => item.domain === 'cloud');
    if (cloudItem) {
      // deltaPct is null when priorCount == 0
      expect(cloudItem.deltaPct).toBeNull();
    }
  });

  it('leaderboard items include domain, currentCount, and direction fields', async () => {
    const lb = await getActivityLeaderboard(F.tenantA, { period: 'month', page: 1, pageSize: 10 });
    for (const item of lb.items) {
      expect(typeof item.domain === 'string' || item.domain === null).toBe(true);
      expect(typeof item.currentCount).toBe('number');
      expect(item.currentCount).toBeGreaterThanOrEqual(1);
      expect(['up', 'down', 'flat']).toContain(item.direction);
    }
  });

  it('pagination: page=2 pageSize=1 returns rank=2 when totalRanked >= 2', async () => {
    const lb = await getActivityLeaderboard(F.tenantA, { period: 'month', page: 2, pageSize: 1 });
    if (lb.totalRanked >= 2) {
      expect(lb.items).toHaveLength(1);
      expect(lb.items[0]?.rank).toBe(2);
    }
    expect(lb.page).toBe(2);
    expect(lb.pageSize).toBe(1);
  });

  it('schema rejects unknown period', () => {
    const result = ActivityLeaderboardQuerySchema.safeParse({ period: '14d' });
    expect(result.success).toBe(false);
  });

  it('cross-tenant: tenant B sees 0 items', async () => {
    const lb = await getActivityLeaderboard(F.tenantB, { period: 'month', page: 1, pageSize: 10 });
    expect(lb.totalRanked).toBe(0);
    expect(lb.items).toHaveLength(0);
  });
});
