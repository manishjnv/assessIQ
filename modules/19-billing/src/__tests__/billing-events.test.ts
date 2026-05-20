// AssessIQ — modules/19-billing/src/__tests__/billing-events.test.ts
//
// DB-backed integration tests for the billing module.
//
// Strategy: postgres:16-alpine testcontainer. If Docker is unavailable the
// entire suite is skipped gracefully via the dockerAvailable flag pattern:
//   - beforeAll catches the Docker error and sets dockerAvailable = false
//   - each test uses it.skipIf(!dockerAvailable) for visible skip reporting
//   - in CI (CI=true or GITHUB_ACTIONS=true), missing Docker throws loudly
//
// Migration apply order (FK chain):
//   1. 02-tenancy ALL migrations  (tenants table + RLS setup)
//   2. 03-users 020_users.sql     (users table)
//   3. 04-question-bank ALL       (question_packs, levels for attempts FK chain)
//   4. 06-attempt-engine ALL      (attempts table — billing_events FK)
//   5. 19-billing 0078            (tenant_plans)
//   6. 19-billing 0079            (billing_events)
//
// Coverage:
//   (a) Idempotency: recordGradedAttempt × 2 for same (tenant, attempt) → 1 row
//   (b) Rollback: recordGradedAttempt inside ROLLBACK tx → 0 rows
//   (c) getUsage end-to-end: free/25 tenant with M events (remaining/overage/status)
//   (d) getUsage end-to-end: internal/null tenant (unlimited)
//   (e) Backfill idempotency: ON CONFLICT DO NOTHING safe to re-run

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

// Mocks — declared before SUT imports (Vitest hoists vi.mock).
vi.mock('@assessiq/audit-log', async () => {
  const actual = await vi.importActual<typeof import('@assessiq/audit-log')>(
    '@assessiq/audit-log',
  );
  return { ...actual, auditInTx: vi.fn(async () => undefined) };
});

import { setPoolForTesting, closePool, getPool } from '@assessiq/tenancy';
import { withTenant } from '@assessiq/tenancy';
import { recordGradedAttempt, getUsage } from '../service.js';

// ---------------------------------------------------------------------------
// Path helpers (mirror modules/07-ai-grading pattern)
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR = toFsPath(new URL('.', import.meta.url));
const BILLING_MODULE_ROOT = join(THIS_DIR, '..', '..');
const MODULES_ROOT = join(BILLING_MODULE_ROOT, '..');

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, '02-tenancy', 'migrations');
const USERS_MIGRATIONS_DIR   = join(MODULES_ROOT, '03-users', 'migrations');
const QB_MIGRATIONS_DIR      = join(MODULES_ROOT, '04-question-bank', 'migrations');
const ATTEMPT_MIGRATIONS_DIR = join(MODULES_ROOT, '06-attempt-engine', 'migrations');
const BILLING_MIGRATIONS_DIR = join(BILLING_MODULE_ROOT, 'migrations');

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;

// Synchronous Docker availability check — evaluated at module load time so
// it.skipIf(!dockerAvailable) correctly skips tests before beforeAll runs.
function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
const dockerAvailable = isDockerAvailable();

// CI fail-loud: throw at module load time so the suite is collected as FAILED
// (not silently skipped) when Docker is unavailable in CI.
if (!dockerAvailable && (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true')) {
  throw new Error(
    'Docker testcontainer required but unavailable in CI. ' +
    'Ensure the CI runner has Docker installed, or remove the Docker ' +
    'dependency from these tests.'
  );
}

let FREE_TENANT_ID: string;
let INTERNAL_TENANT_ID: string;
let ADMIN_ID: string;

// ---------------------------------------------------------------------------
// DB helpers
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
  const filtered =
    only !== undefined ? files.filter((f) => only.includes(f)) : files;
  for (const f of filtered) {
    const sql = await readFile(join(dir, f), 'utf8');
    await client.query(sql);
  }
}

/** Seed a question_pack + level row (required FK chain for assessments). */
async function seedPackAndLevel(
  client: Client,
  tenantId: string,
  adminId: string,
): Promise<{ packId: string; levelId: string }> {
  const packId = randomUUID();
  const levelId = randomUUID();
  const slug = `pack-billing-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO question_packs
       (id, tenant_id, slug, name, domain, status, version, created_by)
     VALUES ($1, $2, $3, $4, 'soc', 'published', 1, $5)`,
    [packId, tenantId, slug, 'Billing Test Pack', adminId],
  );
  await client.query(
    `INSERT INTO levels
       (id, pack_id, position, label, duration_minutes, default_question_count)
     VALUES ($1, $2, 1, 'L1', 30, 5)`,
    [levelId, packId],
  );
  return { packId, levelId };
}

/** Seed a minimal assessment row. */
async function seedAssessment(
  client: Client,
  tenantId: string,
  packId: string,
  levelId: string,
  createdBy: string,
): Promise<string> {
  const id = randomUUID();
  const slug = `asm-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO assessments
       (id, tenant_id, pack_id, level_id, slug, name, question_count, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'Test Asm', 5, 'published', $6)`,
    [id, tenantId, packId, levelId, slug, createdBy],
  );
  return id;
}

/** Seed a minimal attempt row (status=graded). */
async function seedAttempt(
  client: Client,
  tenantId: string,
  candidateId: string,
  assessmentId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO attempts
       (id, tenant_id, candidate_id, assessment_id, status)
     VALUES ($1, $2, $3, $4, 'graded')`,
    [id, tenantId, candidateId, assessmentId],
  );
  return id;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(
  async () => {
    // Docker availability is checked synchronously at module load time.
    // If Docker is unavailable, tests are skipped via it.skipIf(!dockerAvailable).
    if (!dockerAvailable) return;

    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'test',
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB: 'testdb',
      })
      .withWaitStrategy(Wait.forListeningPorts())
      .withExposedPorts(5432)
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    containerUrl = `postgresql://test:test@${host}:${port}/testdb`;

    await setPoolForTesting(containerUrl);

    FREE_TENANT_ID     = randomUUID();
    INTERNAL_TENANT_ID = randomUUID();
    ADMIN_ID           = randomUUID();

    await withSuperClient(async (client) => {
      // Apply migrations in FK-safe order
      await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ['020_users.sql']);
      await applyMigrationsFromDir(client, QB_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, ATTEMPT_MIGRATIONS_DIR);
      // Billing migrations (0078 + 0079 only; 0080 tested separately below)
      await applyMigrationsFromDir(client, BILLING_MIGRATIONS_DIR, [
        '0078_tenant_plans.sql',
        '0079_billing_events.sql',
      ]);

      // Seed test tenants
      await client.query(
        `INSERT INTO tenants (id, slug, name, status) VALUES
           ($1, $2, 'Free Test Tenant', 'active'),
           ($3, $4, 'Internal Test Tenant', 'active')`,
        [
          FREE_TENANT_ID,     `tenant-free-${randomUUID().slice(0, 6)}`,
          INTERNAL_TENANT_ID, `tenant-internal-${randomUUID().slice(0, 6)}`,
        ],
      );

      // Seed admin user
      await client.query(
        `INSERT INTO users (id, tenant_id, email, role)
         VALUES ($1, $2, $3, 'admin')`,
        [ADMIN_ID, FREE_TENANT_ID, `admin-billing-${randomUUID().slice(0, 6)}@test.com`],
      );

      // Provision plans directly as superuser (bypasses RLS)
      await client.query(
        `INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES
           ($1, 'free', 25),
           ($2, 'internal', NULL)`,
        [FREE_TENANT_ID, INTERNAL_TENANT_ID],
      );
    });
  },
  300_000,
);

afterAll(async () => {
  if (dockerAvailable) {
    await closePool();
    if (container) await container.stop();
  }
});

// ---------------------------------------------------------------------------
// (a) Idempotency — same (tenant, attempt) called twice → exactly 1 row
// ---------------------------------------------------------------------------

describe('recordGradedAttempt — idempotency', () => {
  it.skipIf(!dockerAvailable)(
    'calling twice for the same (tenant, attempt) → exactly 1 billing_events row',
    async () => {
      await withSuperClient(async (superClient) => {
        const { packId, levelId } = await seedPackAndLevel(
          superClient, FREE_TENANT_ID, ADMIN_ID,
        );
        const assessmentId = await seedAssessment(
          superClient, FREE_TENANT_ID, packId, levelId, ADMIN_ID,
        );
        const attemptId = await seedAttempt(
          superClient, FREE_TENANT_ID, ADMIN_ID, assessmentId,
        );

        // First call
        await withTenant(FREE_TENANT_ID, (c) =>
          recordGradedAttempt(c, FREE_TENANT_ID, attemptId),
        );
        // Second call — ON CONFLICT DO NOTHING
        await withTenant(FREE_TENANT_ID, (c) =>
          recordGradedAttempt(c, FREE_TENANT_ID, attemptId),
        );

        const { rows } = await superClient.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM billing_events
           WHERE tenant_id = $1 AND attempt_id = $2`,
          [FREE_TENANT_ID, attemptId],
        );
        expect(Number(rows[0]?.count)).toBe(1);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// (b) Same-transaction rollback — ROLLBACK reverts the billing row
// ---------------------------------------------------------------------------

describe('recordGradedAttempt — same-tx rollback', () => {
  it.skipIf(!dockerAvailable)(
    'billing event is rolled back when the enclosing transaction rolls back',
    async () => {
      await withSuperClient(async (superClient) => {
        const { packId, levelId } = await seedPackAndLevel(
          superClient, FREE_TENANT_ID, ADMIN_ID,
        );
        const assessmentId = await seedAssessment(
          superClient, FREE_TENANT_ID, packId, levelId, ADMIN_ID,
        );
        const attemptId = await seedAttempt(
          superClient, FREE_TENANT_ID, ADMIN_ID, assessmentId,
        );

        // Open a raw transaction, write the billing row, then ROLLBACK.
        // withTenant always commits — we bypass it here to test the rollback path.
        const pool = getPool();
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // Set the RLS context manually (mirrors what withTenant does)
          await client.query(
            `SET LOCAL ROLE assessiq_app;
             SELECT set_config('app.current_tenant', $1, true)`,
            [FREE_TENANT_ID],
          );
          await recordGradedAttempt(client, FREE_TENANT_ID, attemptId);
          // Deliberate ROLLBACK — simulates a grade-commit failure
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }

        // Row must NOT exist after rollback
        const { rows } = await superClient.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM billing_events
           WHERE tenant_id = $1 AND attempt_id = $2`,
          [FREE_TENANT_ID, attemptId],
        );
        expect(Number(rows[0]?.count)).toBe(0);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// (c) getUsage — free/25 tenant with 20 events → warn
// ---------------------------------------------------------------------------

describe('getUsage — free/25 tenant', () => {
  it.skipIf(!dockerAvailable)(
    'correct remaining / overage / status for 20 graded events out of 25',
    async () => {
      // Use a fresh tenant so prior test events don't pollute the count
      const tenantId = randomUUID();
      const candidateId = randomUUID();

      await withSuperClient(async (superClient) => {
        await superClient.query(
          `INSERT INTO tenants (id, slug, name, status)
           VALUES ($1, $2, 'Usage Test Tenant', 'active')`,
          [tenantId, `tenant-usage-${randomUUID().slice(0, 6)}`],
        );
        await superClient.query(
          `INSERT INTO tenant_plans (tenant_id, tier, included_credits)
           VALUES ($1, 'free', 25)`,
          [tenantId],
        );
        await superClient.query(
          `INSERT INTO users (id, tenant_id, email, role)
           VALUES ($1, $2, $3, 'candidate')`,
          [candidateId, tenantId, `cand-${randomUUID().slice(0, 6)}@test.com`],
        );

        const { packId, levelId } = await seedPackAndLevel(
          superClient, tenantId, ADMIN_ID,
        );
        const assessmentId = await seedAssessment(
          superClient, tenantId, packId, levelId, ADMIN_ID,
        );

        // Seed 20 graded events (80% of 25 → warn)
        for (let i = 0; i < 20; i++) {
          const attemptId = await seedAttempt(
            superClient, tenantId, candidateId, assessmentId,
          );
          await withTenant(tenantId, (c) =>
            recordGradedAttempt(c, tenantId, attemptId),
          );
        }
      });

      const usage = await getUsage(tenantId);

      expect(usage.tier).toBe('free');
      expect(usage.included_credits).toBe(25);
      expect(usage.used).toBe(20);
      expect(usage.remaining).toBe(5);
      expect(usage.overage).toBe(0);
      expect(usage.status).toBe('warn'); // 20/25 = 80% → warn
    },
  );
});

// ---------------------------------------------------------------------------
// (d) getUsage — internal/null tenant → unlimited
// ---------------------------------------------------------------------------

describe('getUsage — internal/unlimited tenant', () => {
  it.skipIf(!dockerAvailable)(
    'returns status unlimited and remaining null for a NULL-credits plan',
    async () => {
      const usage = await getUsage(INTERNAL_TENANT_ID);

      expect(usage.tier).toBe('internal');
      expect(usage.included_credits).toBeNull();
      expect(usage.remaining).toBeNull();
      expect(usage.overage).toBe(0);
      expect(usage.status).toBe('unlimited');
    },
  );
});

// ---------------------------------------------------------------------------
// (e) Backfill idempotency — ON CONFLICT DO NOTHING is safe to re-run
// ---------------------------------------------------------------------------

describe('0080 backfill — idempotency', () => {
  it.skipIf(!dockerAvailable)(
    'INSERT … ON CONFLICT DO NOTHING is safe to run twice without error or data change',
    async () => {
      const internalTenantId = randomUUID();
      const ordinaryTenantId = randomUUID();
      const internalSlug = `wipro-soc-test-${randomUUID().slice(0, 6)}`;
      const ordinarySlug = `ordinary-test-${randomUUID().slice(0, 6)}`;

      await withSuperClient(async (client) => {
        await client.query(
          `INSERT INTO tenants (id, slug, name, status) VALUES
             ($1, $2, 'Internal Backfill Test', 'active'),
             ($3, $4, 'Ordinary Backfill Test', 'active')`,
          [internalTenantId, internalSlug, ordinaryTenantId, ordinarySlug],
        );

        // First run — mirrors the 0080 INSERT … SELECT shape
        await client.query(
          `INSERT INTO tenant_plans (tenant_id, tier, included_credits)
           SELECT id, 'internal', NULL FROM tenants WHERE slug = $1
           ON CONFLICT (tenant_id) DO NOTHING`,
          [internalSlug],
        );
        await client.query(
          `INSERT INTO tenant_plans (tenant_id, tier, included_credits)
           SELECT id, 'free', 25 FROM tenants
           WHERE id = $1
           ON CONFLICT (tenant_id) DO NOTHING`,
          [ordinaryTenantId],
        );

        // Assert correct values after first run
        const { rows: int1 } = await client.query<{ tier: string; included_credits: number | null }>(
          `SELECT tier, included_credits FROM tenant_plans WHERE tenant_id = $1`,
          [internalTenantId],
        );
        expect(int1[0]?.tier).toBe('internal');
        expect(int1[0]?.included_credits).toBeNull();

        const { rows: ord1 } = await client.query<{ tier: string; included_credits: number | null }>(
          `SELECT tier, included_credits FROM tenant_plans WHERE tenant_id = $1`,
          [ordinaryTenantId],
        );
        expect(ord1[0]?.tier).toBe('free');
        expect(ord1[0]?.included_credits).toBe(25);

        // Second run — must be idempotent
        await client.query(
          `INSERT INTO tenant_plans (tenant_id, tier, included_credits)
           SELECT id, 'internal', NULL FROM tenants WHERE slug = $1
           ON CONFLICT (tenant_id) DO NOTHING`,
          [internalSlug],
        );
        await client.query(
          `INSERT INTO tenant_plans (tenant_id, tier, included_credits)
           SELECT id, 'free', 25 FROM tenants
           WHERE id = $1
           ON CONFLICT (tenant_id) DO NOTHING`,
          [ordinaryTenantId],
        );

        // Values unchanged after second run
        const { rows: int2 } = await client.query<{ tier: string; included_credits: number | null }>(
          `SELECT tier, included_credits FROM tenant_plans WHERE tenant_id = $1`,
          [internalTenantId],
        );
        expect(int2[0]?.tier).toBe('internal');
        expect(int2[0]?.included_credits).toBeNull();

        const { rows: ord2 } = await client.query<{ tier: string; included_credits: number | null }>(
          `SELECT tier, included_credits FROM tenant_plans WHERE tenant_id = $1`,
          [ordinaryTenantId],
        );
        expect(ord2[0]?.tier).toBe('free');
        expect(ord2[0]?.included_credits).toBe(25);
      });
    },
  );
});
