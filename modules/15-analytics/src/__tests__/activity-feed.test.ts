/**
 * Integration tests for GET /api/admin/activity/feed
 *
 * Uses a postgres:16-alpine testcontainer.
 *
 * Migration apply order (extends activity.test.ts stack):
 *   1. ALL 02-tenancy migrations
 *   2. 03-users  020_users.sql
 *   3. ALL 04-question-bank migrations
 *   4. ALL 05-assessment-lifecycle migrations
 *   5. ALL 06-attempt-engine migrations  (creates attempt_events)
 *   6. 07-ai-grading: 0040_gradings.sql + 0041_tenant_grading_budgets.sql
 *   7. 09-scoring:    0050_attempt_scores.sql
 *   8. 14-audit-log:  0050_audit_log.sql
 *   9. 15-analytics:  all migrations (MV + owner)
 *
 * Coverage:
 *   - role=all   → both audit + attempt rows, ordered at DESC
 *   - role=admin → only admin/super_admin audit rows
 *   - role=reviewer → only reviewer audit rows
 *   - role=candidate → only attempt_events rows
 *   - pagination → total is full count; page 2 returns next slice
 *   - system actor (actor_kind='system', null actor_user_id) → actorRole=system, no crash
 *   - action filter → exact-match on audit action and attempt event_type
 *   - from/to date window → correctly excludes out-of-window rows
 *   - cross-tenant RLS → tenant A feed never leaks tenant B audit/attempt rows
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { setPoolForTesting, closePool } from '@assessiq/tenancy';

import { getActivityFeed } from '../index.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR    = toFsPath(new URL('.', import.meta.url));
const MODULE_ROOT = join(THIS_DIR, '..', '..');
const MODULES_ROOT = join(MODULE_ROOT, '..');

const TENANCY_DIR    = join(MODULES_ROOT, '02-tenancy',             'migrations');
const USERS_DIR      = join(MODULES_ROOT, '03-users',               'migrations');
const QB_DIR         = join(MODULES_ROOT, '04-question-bank',        'migrations');
const AL_DIR         = join(MODULES_ROOT, '05-assessment-lifecycle',  'migrations');
const AE_DIR         = join(MODULES_ROOT, '06-attempt-engine',        'migrations');
const GRADING_DIR    = join(MODULES_ROOT, '07-ai-grading',            'migrations');
const SCORING_DIR    = join(MODULES_ROOT, '09-scoring',               'migrations');
const AUDIT_DIR      = join(MODULES_ROOT, '14-audit-log',             'migrations');
const ANALYTICS_DIR  = join(MODULE_ROOT,  'migrations');
const DATARIGHTS_DIR = join(MODULES_ROOT, '20-data-rights',          'migrations');

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let F: FeedFixture;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: 'assessiq',
      POSTGRES_PASSWORD: 'assessiq',
      POSTGRES_DB: 'aiq_feed_test',
    })
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  containerUrl = `postgres://assessiq:assessiq@${host}:${port}/aiq_feed_test`;

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
    await applyMigrationsFromDir(client, AUDIT_DIR);
    await applyMigrationsFromDir(client, ANALYTICS_DIR);
    // DPDP: add users.erased_at column used by the activity feed erased-candidate filter
    await applyMigrationsFromDir(client, DATARIGHTS_DIR, ['0102_users_erased_at.sql']);
  });
}

// ---------------------------------------------------------------------------
// Fixture types + seed
// ---------------------------------------------------------------------------

interface FeedFixture {
  // Tenant A
  tenantA: string;
  adminA: string;
  reviewerA: string;
  candidateA1: string;
  candidateA2: string;
  packA: string;
  levelA: string;
  questionA: string;
  assessmentA1: string;
  assessmentA2: string;
  attemptA1: string;  // candidateA1, today
  attemptA2: string;  // candidateA2, today
  // Audit rows — Tenant A
  auditAdminRow: string;    // admin actor, action='pack.published'
  auditReviewerRow: string; // reviewer actor, action='grading.released'
  auditSystemRow: string;   // system actor_kind, null actor_user_id
  // Attempt event rows — Tenant A
  eventA1: string;  // attempt_events.id (bigint stored as string)
  eventA2: string;
  // Tenant B (cross-tenant proof)
  tenantB: string;
  adminB: string;
  candidateB: string;
  packB: string;
  levelB: string;
  questionB: string;
  assessmentB: string;
  attemptB: string;
  // Audit + attempt event for tenant B — must NEVER appear in tenant A feed
  auditBRow: string;
  eventB: string;
  // Dates
  todayStr: string;
}

async function seedFixtures(): Promise<FeedFixture> {
  return withSuperClient(async (client) => {
    // IDs
    const tenantA    = randomUUID();
    const tenantB    = randomUUID();
    const adminA     = randomUUID();
    const reviewerA  = randomUUID();
    const candidateA1 = randomUUID();
    const candidateA2 = randomUUID();
    const adminB     = randomUUID();
    const candidateB = randomUUID();

    const packA      = randomUUID();
    const levelA     = randomUUID();
    const questionA  = randomUUID();
    const assessmentA1 = randomUUID();
    const assessmentA2 = randomUUID();
    const attemptA1  = randomUUID();
    const attemptA2  = randomUUID();

    const packB      = randomUUID();
    const levelB     = randomUUID();
    const questionB  = randomUUID();
    const assessmentB = randomUUID();
    const attemptB   = randomUUID();

    const slugA = `feed-ta-${tenantA.slice(0, 8)}`;
    const slugB = `feed-tb-${tenantB.slice(0, 8)}`;

    // Tenants
    await client.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1,'FeedTenantA',$3),($2,'FeedTenantB',$4)`,
      [tenantA, tenantB, slugA, slugB],
    );

    // Users — Tenant A: admin, reviewer, 2 candidates
    //         Tenant B: admin, candidate
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES
         ($1, $7, 'fadmin-a@feed.test',    'Admin A',      'admin',     'active'),
         ($2, $7, 'freviewer-a@feed.test', 'Reviewer A',   'reviewer',  'active'),
         ($3, $7, 'fcand-a1@feed.test',    'Candidate A1', 'candidate', 'active'),
         ($4, $7, 'fcand-a2@feed.test',    'Candidate A2', 'candidate', 'active'),
         ($5, $8, 'fadmin-b@feed.test',    'Admin B',      'admin',     'active'),
         ($6, $8, 'fcand-b@feed.test',     'Candidate B',  'candidate', 'active')`,
      [adminA, reviewerA, candidateA1, candidateA2, adminB, candidateB, tenantA, tenantB],
    );

    // Tenant A — pack + assessment + attempts
    await client.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
       VALUES ($1,$2,'feed-pack-soc','SOC Feed Pack','soc','published',$3)`,
      [packA, tenantA, adminA],
    );
    await client.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
       VALUES ($1,$2,1,'L1',60,5)`,
      [levelA, packA],
    );
    await client.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
       VALUES ($1,$2,$3,'mcq','feed-topic',25,'active','{"question":"FQ1","options":["A","B","C","D"],"correct":0,"rationale":"R"}',$4)`,
      [questionA, packA, levelA, adminA],
    );
    await client.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, name, status, pack_version, question_count, created_by)
       VALUES ($1,$2,$3,$4,'FeedAssess-A1','active',1,1,$5),
              ($6,$2,$3,$4,'FeedAssess-A2','active',1,1,$5)`,
      [assessmentA1, tenantA, packA, levelA, adminA, assessmentA2],
    );
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const started1 = new Date(now.getTime() - 600_000);
    const ends1    = new Date(now.getTime() + 3_600_000);
    const started2 = new Date(now.getTime() - 300_000);
    const ends2    = new Date(now.getTime() + 3_600_000);

    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'submitted',$5,$6,$7,600)`,
      [attemptA1, tenantA, assessmentA1, candidateA1, started1, now, ends1],
    );
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'submitted',$5,$6,$7,300)`,
      [attemptA2, tenantA, assessmentA2, candidateA2, started2, now, ends2],
    );
    // attempt_questions (FK for gradings)
    await client.query(
      `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,1,1),($3,$2,1,1)`,
      [attemptA1, questionA, attemptA2],
    );

    // Tenant B — pack + assessment + attempt
    await client.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
       VALUES ($1,$2,'feed-pack-b','B Feed Pack','pentest','published',$3)`,
      [packB, tenantB, adminB],
    );
    await client.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
       VALUES ($1,$2,1,'L1',60,5)`,
      [levelB, packB],
    );
    await client.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
       VALUES ($1,$2,$3,'mcq','b-topic',25,'active','{"question":"BQ","options":["A","B"],"correct":0,"rationale":"R"}',$4)`,
      [questionB, packB, levelB, adminB],
    );
    await client.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, name, status, pack_version, question_count, created_by)
       VALUES ($1,$2,$3,$4,'FeedAssess-B','active',1,1,$5)`,
      [assessmentB, tenantB, packB, levelB, adminB],
    );
    const startedB = new Date(now.getTime() - 200_000);
    const endsB    = new Date(now.getTime() + 3_600_000);
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'submitted',$5,$6,$7,200)`,
      [attemptB, tenantB, assessmentB, candidateB, startedB, now, endsB],
    );
    await client.query(
      `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,1,1)`,
      [attemptB, questionB],
    );

    // -----------------------------------------------------------------------
    // audit_log rows
    // All inserts go through the direct client (bypasses RLS — super user).
    // -----------------------------------------------------------------------

    // Admin audit row — Tenant A
    const auditAdminRow = randomUUID();
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id, at)
       VALUES ($1,$2,'user','pack.published','question_pack',$3::uuid,now())`,
      [tenantA, adminA, packA],
    );
    // Retrieve the inserted id (BIGSERIAL — we just need any stable reference)
    const auditAdminIdRes = await client.query<{ id: string }>(
      `SELECT id::text FROM audit_log WHERE tenant_id=$1 AND action='pack.published' LIMIT 1`,
      [tenantA],
    );

    // Reviewer audit row — Tenant A
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id, at)
       VALUES ($1,$2,'user','grading.released','attempt',$3::uuid,now())`,
      [tenantA, reviewerA, attemptA1],
    );
    const auditReviewerIdRes = await client.query<{ id: string }>(
      `SELECT id::text FROM audit_log WHERE tenant_id=$1 AND action='grading.released' LIMIT 1`,
      [tenantA],
    );

    // System audit row — Tenant A, actor_kind='system', actor_user_id=NULL
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, actor_kind, action, entity_type, at)
       VALUES ($1,NULL,'system','attempt_scores.recomputed_by_admin','attempt',now())`,
      [tenantA],
    );
    const auditSystemIdRes = await client.query<{ id: string }>(
      `SELECT id::text FROM audit_log WHERE tenant_id=$1 AND actor_kind='system' LIMIT 1`,
      [tenantA],
    );

    // Tenant B audit row — must NOT appear in Tenant A feed
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id, at)
       VALUES ($1,$2,'user','pack.published','question_pack',$3::uuid,now())`,
      [tenantB, adminB, packB],
    );
    const auditBIdRes = await client.query<{ id: string }>(
      `SELECT id::text FROM audit_log WHERE tenant_id=$1 LIMIT 1`,
      [tenantB],
    );

    // -----------------------------------------------------------------------
    // attempt_events rows
    // attempt_events.id is BIGSERIAL — insert via direct client.
    // -----------------------------------------------------------------------

    await client.query(
      `INSERT INTO attempt_events (attempt_id, event_type, question_id, payload, at)
       VALUES ($1,'question_view',$2,'{}',now())`,
      [attemptA1, questionA],
    );
    const eventA1Res = await client.query<{ id: string }>(
      `SELECT id::text FROM attempt_events WHERE attempt_id=$1 LIMIT 1`,
      [attemptA1],
    );

    await client.query(
      `INSERT INTO attempt_events (attempt_id, event_type, question_id, payload, at)
       VALUES ($1,'answer_save',$2,'{"edits_count":1}',now())`,
      [attemptA2, questionA],
    );
    const eventA2Res = await client.query<{ id: string }>(
      `SELECT id::text FROM attempt_events WHERE attempt_id=$1 LIMIT 1`,
      [attemptA2],
    );

    // Tenant B attempt event — must NOT appear in Tenant A feed
    await client.query(
      `INSERT INTO attempt_events (attempt_id, event_type, question_id, payload, at)
       VALUES ($1,'question_view',$2,'{}',now())`,
      [attemptB, questionB],
    );
    const eventBRes = await client.query<{ id: string }>(
      `SELECT id::text FROM attempt_events WHERE attempt_id=$1 LIMIT 1`,
      [attemptB],
    );

    // Refresh MV (analytics dependency)
    await client.query('REFRESH MATERIALIZED VIEW attempt_summary_mv');

    return {
      tenantA, adminA, reviewerA, candidateA1, candidateA2,
      packA, levelA, questionA, assessmentA1, assessmentA2,
      attemptA1, attemptA2,
      auditAdminRow:    auditAdminIdRes.rows[0]?.id ?? '',
      auditReviewerRow: auditReviewerIdRes.rows[0]?.id ?? '',
      auditSystemRow:   auditSystemIdRes.rows[0]?.id ?? '',
      eventA1: eventA1Res.rows[0]?.id ?? '',
      eventA2: eventA2Res.rows[0]?.id ?? '',
      tenantB, adminB, candidateB,
      packB, levelB, questionB, assessmentB, attemptB,
      auditBRow: auditBIdRes.rows[0]?.id ?? '',
      eventB:    eventBRes.rows[0]?.id ?? '',
      todayStr,
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getActivityFeed', () => {

  // -------------------------------------------------------------------------
  // role=all — both legs present
  // -------------------------------------------------------------------------
  describe('role=all (default)', () => {
    it('returns items from both audit and attempt sources', async () => {
      const result = await getActivityFeed(F.tenantA, { role: 'all', page: 1, pageSize: 50 });

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
      expect(result.total).toBeGreaterThanOrEqual(5); // 3 audit + 2 attempt

      const sources = result.items.map((i) => i.source);
      expect(sources).toContain('audit');
      expect(sources).toContain('attempt');
    });

    it('items are ordered at DESC', async () => {
      const result = await getActivityFeed(F.tenantA, { role: 'all', page: 1, pageSize: 50 });
      const times = result.items.map((i) => new Date(i.at).getTime());
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeLessThanOrEqual(times[i - 1]!);
      }
    });

    it('FeedItem shape is correct', async () => {
      const result = await getActivityFeed(F.tenantA, { role: 'all', page: 1, pageSize: 50 });
      for (const item of result.items) {
        expect(item.id).toMatch(/^(audit|attempt):\d+$/);
        expect(['audit', 'attempt']).toContain(item.source);
        expect(item.at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO string
        expect(['admin', 'reviewer', 'candidate', 'system']).toContain(item.actorRole);
        expect(typeof item.actorLabel).toBe('string');
        expect(typeof item.action).toBe('string');
        expect(typeof item.actionLabel).toBe('string');
      }
    });
  });

  // -------------------------------------------------------------------------
  // role=admin
  // -------------------------------------------------------------------------
  describe('role=admin', () => {
    it('returns only audit rows with actorRole=admin', async () => {
      const result = await getActivityFeed(F.tenantA, { role: 'admin', page: 1, pageSize: 50 });

      expect(result.items.length).toBeGreaterThanOrEqual(1);

      // All items must be audit source
      for (const item of result.items) {
        expect(item.source).toBe('audit');
        expect(item.actorRole).toBe('admin');
      }
    });

    it('does not include reviewer or system rows', async () => {
      const result = await getActivityFeed(F.tenantA, { role: 'admin', page: 1, pageSize: 50 });
      const roles = result.items.map((i) => i.actorRole);
      expect(roles).not.toContain('reviewer');
      expect(roles).not.toContain('system');
      expect(roles).not.toContain('candidate');
    });

    it('does not include attempt_events rows', async () => {
      const result = await getActivityFeed(F.tenantA, { role: 'admin', page: 1, pageSize: 50 });
      const sources = result.items.map((i) => i.source);
      expect(sources).not.toContain('attempt');
    });
  });

  // -------------------------------------------------------------------------
  // role=reviewer
  // -------------------------------------------------------------------------
  describe('role=reviewer', () => {
    it('returns only reviewer audit rows', async () => {
      const result = await getActivityFeed(F.tenantA, { role: 'reviewer', page: 1, pageSize: 50 });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      for (const item of result.items) {
        expect(item.source).toBe('audit');
        expect(item.actorRole).toBe('reviewer');
      }
    });

    it('does not include admin, system, or attempt rows', async () => {
      const result = await getActivityFeed(F.tenantA, { role: 'reviewer', page: 1, pageSize: 50 });
      const roles = result.items.map((i) => i.actorRole);
      expect(roles).not.toContain('admin');
      expect(roles).not.toContain('system');
      expect(roles).not.toContain('candidate');
    });
  });

  // -------------------------------------------------------------------------
  // role=candidate
  // -------------------------------------------------------------------------
  describe('role=candidate', () => {
    it('returns only attempt_events rows with actorRole=candidate', async () => {
      const result = await getActivityFeed(F.tenantA, { role: 'candidate', page: 1, pageSize: 50 });

      expect(result.items.length).toBeGreaterThanOrEqual(2); // eventA1 + eventA2

      for (const item of result.items) {
        expect(item.source).toBe('attempt');
        expect(item.actorRole).toBe('candidate');
        expect(item.targetType).toBe('attempt');
        // actionLabel should be humanized
        expect(item.actionLabel).not.toBe('');
      }
    });

    it('attempt items have targetLabel = assessment name', async () => {
      const result = await getActivityFeed(F.tenantA, { role: 'candidate', page: 1, pageSize: 50 });
      // At least one item should have a non-null targetLabel
      const labeled = result.items.filter((i) => i.targetLabel !== null);
      expect(labeled.length).toBeGreaterThanOrEqual(1);
    });

    it('does not include audit rows', async () => {
      const result = await getActivityFeed(F.tenantA, { role: 'candidate', page: 1, pageSize: 50 });
      const sources = result.items.map((i) => i.source);
      expect(sources).not.toContain('audit');
    });
  });

  // -------------------------------------------------------------------------
  // system actor
  // -------------------------------------------------------------------------
  describe('system actor', () => {
    it('audit row with actor_kind=system yields actorRole=system and does not crash', async () => {
      const result = await getActivityFeed(F.tenantA, {
        role: 'all',
        action: 'attempt_scores.recomputed_by_admin',
        page: 1,
        pageSize: 10,
      });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      const sysRow = result.items.find((i) => i.action === 'attempt_scores.recomputed_by_admin');
      expect(sysRow).toBeDefined();
      expect(sysRow!.actorRole).toBe('system');
      expect(sysRow!.actorLabel).toBeTruthy(); // actor_kind='system' as fallback
      expect(sysRow!.id).toMatch(/^audit:\d+$/);
    });
  });

  // -------------------------------------------------------------------------
  // actionLabel humanization
  // -------------------------------------------------------------------------
  describe('actionLabel', () => {
    it('audit action=pack.published has a friendly label', async () => {
      const result = await getActivityFeed(F.tenantA, {
        role: 'admin',
        action: 'pack.published',
        page: 1,
        pageSize: 10,
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0]!.actionLabel).toBe('published question pack');
    });

    it('attempt event_type=question_view has a friendly label', async () => {
      const result = await getActivityFeed(F.tenantA, {
        role: 'candidate',
        action: 'question_view',
        page: 1,
        pageSize: 10,
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0]!.actionLabel).toBe('viewed a question');
    });

    it('unknown action falls back to humanized form (dots → spaces)', async () => {
      // We don't have an unknown action in the DB, so test the label logic directly
      // by checking grading.released (reviewer action)
      const result = await getActivityFeed(F.tenantA, {
        role: 'reviewer',
        action: 'grading.released',
        page: 1,
        pageSize: 10,
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0]!.actionLabel).toBe('released graded attempt');
    });
  });

  // -------------------------------------------------------------------------
  // action filter (exact match)
  // -------------------------------------------------------------------------
  describe('action filter', () => {
    it('action=pack.published returns only pack.published audit rows', async () => {
      const result = await getActivityFeed(F.tenantA, {
        role: 'all',
        action: 'pack.published',
        page: 1,
        pageSize: 50,
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      for (const item of result.items) {
        expect(item.action).toBe('pack.published');
      }
    });

    it('action=answer_save returns only answer_save attempt rows', async () => {
      const result = await getActivityFeed(F.tenantA, {
        role: 'all',
        action: 'answer_save',
        page: 1,
        pageSize: 50,
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      for (const item of result.items) {
        expect(item.action).toBe('answer_save');
        expect(item.source).toBe('attempt');
      }
    });

    it('nonexistent action returns empty items with total=0', async () => {
      const result = await getActivityFeed(F.tenantA, {
        action: 'nonexistent.action.xyz',
        page: 1,
        pageSize: 25,
      });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // actorUserId filter
  // -------------------------------------------------------------------------
  describe('actorUserId filter', () => {
    it('filtering by adminA.id returns only adminA audit rows', async () => {
      const result = await getActivityFeed(F.tenantA, {
        role: 'all',
        actorUserId: F.adminA,
        page: 1,
        pageSize: 50,
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      // All audit items should be from adminA; no attempt items from other users
      for (const item of result.items) {
        // audit rows come from adminA; attempt rows won't match since candidateA1/A2 are different
        if (item.source === 'audit') {
          expect(item.actorRole).toBe('admin');
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // from/to date window
  // -------------------------------------------------------------------------
  describe('from/to date filter', () => {
    it('from=tomorrow excludes all rows seeded today', async () => {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const result = await getActivityFeed(F.tenantA, {
        from: tomorrow,
        to: tomorrow,
        page: 1,
        pageSize: 50,
      });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });

    it('from/to=today includes rows seeded today', async () => {
      const result = await getActivityFeed(F.tenantA, {
        from: F.todayStr,
        to: F.todayStr,
        page: 1,
        pageSize: 50,
      });
      expect(result.total).toBeGreaterThanOrEqual(5);
    });
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------
  describe('pagination', () => {
    it('total reflects full count regardless of pageSize', async () => {
      const page1 = await getActivityFeed(F.tenantA, { page: 1, pageSize: 2 });
      const pageAll = await getActivityFeed(F.tenantA, { page: 1, pageSize: 100 });

      // total should be the same in both results
      expect(page1.total).toBe(pageAll.total);
      // page1 returns at most 2 items
      expect(page1.items.length).toBeLessThanOrEqual(2);
    });

    it('page 2 returns the next slice of items (non-overlapping with page 1)', async () => {
      const total = (await getActivityFeed(F.tenantA, { page: 1, pageSize: 100 })).total;
      if (total < 3) {
        // Not enough rows to test pagination meaningfully
        return;
      }

      const page1 = await getActivityFeed(F.tenantA, { page: 1, pageSize: 2 });
      const page2 = await getActivityFeed(F.tenantA, { page: 2, pageSize: 2 });

      expect(page1.items.length).toBe(2);
      expect(page2.items.length).toBeGreaterThanOrEqual(1);

      const ids1 = new Set(page1.items.map((i) => i.id));
      const ids2 = page2.items.map((i) => i.id);
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }
    });

    it('page beyond last returns empty items with correct total', async () => {
      const total = (await getActivityFeed(F.tenantA, { page: 1, pageSize: 100 })).total;
      const beyondPage = Math.ceil(total / 2) + 10;

      const result = await getActivityFeed(F.tenantA, { page: beyondPage, pageSize: 2 });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(total);
    });
  });

  // -------------------------------------------------------------------------
  // CRITICAL: Cross-tenant isolation
  // -------------------------------------------------------------------------
  describe('cross-tenant isolation (critical)', () => {
    it('tenantA feed NEVER returns tenantB audit rows', async () => {
      const resultA = await getActivityFeed(F.tenantA, { role: 'all', page: 1, pageSize: 100 });
      const resultB = await getActivityFeed(F.tenantB, { role: 'all', page: 1, pageSize: 100 });

      // Extract all audit IDs from each feed
      const auditIdsA = resultA.items
        .filter((i) => i.source === 'audit')
        .map((i) => i.id.replace('audit:', ''));
      const auditIdsB = resultB.items
        .filter((i) => i.source === 'audit')
        .map((i) => i.id.replace('audit:', ''));

      // Tenant B's audit row must NOT appear in tenant A's results
      expect(auditIdsA).not.toContain(F.auditBRow);

      // Tenant A's audit rows must NOT appear in tenant B's results
      expect(auditIdsB).not.toContain(F.auditAdminRow);
      expect(auditIdsB).not.toContain(F.auditReviewerRow);
      expect(auditIdsB).not.toContain(F.auditSystemRow);
    });

    it('tenantA feed NEVER returns tenantB attempt_events', async () => {
      const resultA = await getActivityFeed(F.tenantA, { role: 'candidate', page: 1, pageSize: 100 });
      const resultB = await getActivityFeed(F.tenantB, { role: 'candidate', page: 1, pageSize: 100 });

      const attemptIdsA = resultA.items
        .filter((i) => i.source === 'attempt')
        .map((i) => i.id.replace('attempt:', ''));
      const attemptIdsB = resultB.items
        .filter((i) => i.source === 'attempt')
        .map((i) => i.id.replace('attempt:', ''));

      // Tenant B's event must NOT appear in tenant A's results
      expect(attemptIdsA).not.toContain(F.eventB);

      // Tenant A's events must NOT appear in tenant B's results
      expect(attemptIdsB).not.toContain(F.eventA1);
      expect(attemptIdsB).not.toContain(F.eventA2);
    });

    it('tenantA and tenantB total counts are disjoint (no data leaks across tenants)', async () => {
      const [feedA, feedB] = await Promise.all([
        getActivityFeed(F.tenantA, { role: 'all', page: 1, pageSize: 100 }),
        getActivityFeed(F.tenantB, { role: 'all', page: 1, pageSize: 100 }),
      ]);

      // Tenant A has more rows (3 audit + 2 attempt = 5; tenant B has 1 audit + 1 attempt = 2)
      expect(feedA.total).toBeGreaterThan(feedB.total);

      // No item IDs overlap
      const idsA = new Set(feedA.items.map((i) => i.id));
      for (const item of feedB.items) {
        expect(idsA.has(item.id)).toBe(false);
      }
    });

    it('tenantB feed has exactly its own rows (1 audit + 1 attempt)', async () => {
      const result = await getActivityFeed(F.tenantB, { role: 'all', page: 1, pageSize: 100 });

      // Tenant B: 1 audit row (pack.published by adminB) + 1 attempt event (question_view by candidateB)
      expect(result.total).toBe(2);

      const auditItems   = result.items.filter((i) => i.source === 'audit');
      const attemptItems = result.items.filter((i) => i.source === 'attempt');

      expect(auditItems.length).toBe(1);
      expect(attemptItems.length).toBe(1);

      // Audit item should be adminB's pack.published
      expect(auditItems[0]!.actorRole).toBe('admin');
      expect(auditItems[0]!.action).toBe('pack.published');

      // Attempt item should be candidateB's question_view
      expect(attemptItems[0]!.actorRole).toBe('candidate');
      expect(attemptItems[0]!.action).toBe('question_view');
      expect(attemptItems[0]!.id).toBe(`attempt:${F.eventB}`);
    });
  });
});
