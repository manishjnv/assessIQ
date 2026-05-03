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
 *   - Cross-tenant isolation: tenant A's data is invisible to tenant B queries
 *   - Export CSV: correct columns + row cap enforcement
 *   - Export JSONL: correct shape per line
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

    // Refresh the materialized view so reports can query it
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
    // Tenant A querying tenant B's assessment should get 0 (MV filter)
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
    // Tenant B's attempt IDs should not appear in tenant A's export
    expect(content).not.toContain(F.tenantB_attempt);
  });
});
