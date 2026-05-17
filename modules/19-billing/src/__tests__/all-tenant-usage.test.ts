// AssessIQ — modules/19-billing/src/__tests__/all-tenant-usage.test.ts
//
// DB-backed integration tests for getAllTenantUsage (Phase A2).
//
// Strategy: postgres:16-alpine testcontainer. If Docker is unavailable the
// entire suite is skipped gracefully (same dockerAvailable flag pattern).
//
// Migration apply order:
//   1. 02-tenancy ALL migrations
//   2. 03-users 020_users.sql
//   3. 04-question-bank ALL        (for attempts FK chain)
//   4. 06-attempt-engine ALL       (attempts table)
//   5. 19-billing 0078             (tenant_plans)
//   6. 19-billing 0079             (billing_events)
//
// Seed:
//   - free/25 tenant with 30 billing events → overage 5, status 'over'
//   - internal/null tenant → unlimited, 0 events
//
// Assertions: getAllTenantUsage() returns correct mapped rows for both.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { setPoolForTesting, closePool, withTenant } from '@assessiq/tenancy';
import { getAllTenantUsage } from '../service.js';
import { insertBillingEvent } from '../repository.js';

// ---------------------------------------------------------------------------
// Path helpers
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
let dockerAvailable = true;

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
  const filtered = only !== undefined ? files.filter((f) => only.includes(f)) : files;
  for (const f of filtered) {
    const sql = await readFile(join(dir, f), 'utf8');
    await client.query(sql);
  }
}

async function seedPackAndLevel(
  client: Client,
  tenantId: string,
  adminId: string,
): Promise<{ packId: string; levelId: string }> {
  const packId = randomUUID();
  const levelId = randomUUID();
  const slug = `pack-usage-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO question_packs
       (id, tenant_id, slug, name, domain, status, version, created_by)
     VALUES ($1, $2, $3, $4, 'soc', 'published', 1, $5)`,
    [packId, tenantId, slug, 'Usage Test Pack', adminId],
  );
  await client.query(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
     VALUES ($1, $2, 1, 'L1', 30, 5)`,
    [levelId, packId],
  );
  return { packId, levelId };
}

async function seedAssessment(
  client: Client,
  tenantId: string,
  packId: string,
  levelId: string,
  createdBy: string,
): Promise<string> {
  const id = randomUUID();
  const slug = `asm-usage-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO assessments
       (id, tenant_id, pack_id, level_id, slug, name, question_count, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'Usage Asm', 5, 'published', $6)`,
    [id, tenantId, packId, levelId, slug, createdBy],
  );
  return id;
}

async function seedAttempt(
  client: Client,
  tenantId: string,
  candidateId: string,
  assessmentId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO attempts (id, tenant_id, candidate_id, assessment_id, status)
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
    try {
      container = await new GenericContainer('postgres:16-alpine')
        .withEnvironment({
          POSTGRES_USER: 'test',
          POSTGRES_PASSWORD: 'test',
          POSTGRES_DB: 'testdb',
        })
        .withWaitStrategy(Wait.forListeningPorts())
        .withExposedPorts(5432)
        .start();
    } catch {
      dockerAvailable = false;
      return;
    }

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    containerUrl = `postgresql://test:test@${host}:${port}/testdb`;

    await setPoolForTesting(containerUrl);

    FREE_TENANT_ID     = randomUUID();
    INTERNAL_TENANT_ID = randomUUID();
    ADMIN_ID           = randomUUID();

    await withSuperClient(async (client) => {
      await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ['020_users.sql']);
      await applyMigrationsFromDir(client, QB_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, ATTEMPT_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, BILLING_MIGRATIONS_DIR, [
        '0078_tenant_plans.sql',
        '0079_billing_events.sql',
      ]);

      // Seed tenants
      await client.query(
        `INSERT INTO tenants (id, slug, name, status) VALUES
           ($1, $2, 'Free Usage Test Tenant', 'active'),
           ($3, $4, 'Internal Usage Test Tenant', 'active')`,
        [
          FREE_TENANT_ID,     `tenant-free-usage-${randomUUID().slice(0, 6)}`,
          INTERNAL_TENANT_ID, `tenant-internal-usage-${randomUUID().slice(0, 6)}`,
        ],
      );

      // Seed admin user
      await client.query(
        `INSERT INTO users (id, tenant_id, email, role)
         VALUES ($1, $2, $3, 'admin')`,
        [ADMIN_ID, FREE_TENANT_ID, `admin-all-usage-${randomUUID().slice(0, 6)}@test.com`],
      );

      // Provision plans
      await client.query(
        `INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES
           ($1, 'free', 25),
           ($2, 'internal', NULL)`,
        [FREE_TENANT_ID, INTERNAL_TENANT_ID],
      );

      // Seed 30 billing events for the free tenant (30 > 25 → overage 5)
      const candidateId = randomUUID();
      await client.query(
        `INSERT INTO users (id, tenant_id, email, role)
         VALUES ($1, $2, $3, 'candidate')`,
        [candidateId, FREE_TENANT_ID, `cand-all-usage-${randomUUID().slice(0, 6)}@test.com`],
      );
      const { packId, levelId } = await seedPackAndLevel(client, FREE_TENANT_ID, ADMIN_ID);
      const assessmentId = await seedAssessment(client, FREE_TENANT_ID, packId, levelId, ADMIN_ID);

      for (let i = 0; i < 30; i++) {
        const attemptId = await seedAttempt(client, FREE_TENANT_ID, candidateId, assessmentId);
        await withTenant(FREE_TENANT_ID, (c) =>
          insertBillingEvent(c, FREE_TENANT_ID, attemptId),
        );
      }
    });
  },
  300_000,
);

afterAll(async () => {
  if (!dockerAvailable) return;
  await closePool();
  if (container) await container.stop();
});

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

describe('getAllTenantUsage', () => {
  it(
    'returns correct mapped rows for free/over and internal/unlimited tenants',
    async () => {
      if (!dockerAvailable) return;

      const rows = await getAllTenantUsage();

      // Find the two rows we seeded (there may be others from the migration backfill)
      const freeRow = rows.find((r) => r.tenant_id === FREE_TENANT_ID);
      const internalRow = rows.find((r) => r.tenant_id === INTERNAL_TENANT_ID);

      expect(freeRow).toBeDefined();
      expect(freeRow?.tier).toBe('free');
      expect(freeRow?.included_credits).toBe(25);
      expect(freeRow?.used).toBe(30);
      expect(freeRow?.overage).toBe(5);
      expect(freeRow?.status).toBe('over');
      expect(freeRow?.remaining).toBe(-5); // 25 - 30 = -5

      expect(internalRow).toBeDefined();
      expect(internalRow?.tier).toBe('internal');
      expect(internalRow?.included_credits).toBeNull();
      expect(internalRow?.used).toBe(0);
      expect(internalRow?.overage).toBe(0);
      expect(internalRow?.status).toBe('unlimited');
      expect(internalRow?.remaining).toBeNull();
    },
  );
});
