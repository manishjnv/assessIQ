// AssessIQ — modules/19-billing/src/__tests__/entitlements-backfill.test.ts
//
// DB-backed integration tests for 0082_entitlements_backfill.sql.
//
// Strategy: postgres:16-alpine testcontainer. If Docker is unavailable the
// entire suite is skipped gracefully via the dockerAvailable flag pattern.
//
// Migration apply order (FK chain):
//   1. 02-tenancy ALL migrations
//   2. 03-users 020_users.sql
//   3. 04-question-bank 0010, 0011, 0012, 0016 (question_packs, levels, questions + ai_draft)
//   4. 19-billing 0081 (tenant_entitlements)
//
// Scenarios:
//   (A) Tenant 1 has an active question in a published pack with domain 'soc'
//       → expects a domain entitlement 'soc' after running the backfill INSERT.
//
//   (B) Tenant 2 has only draft questions / an archived pack
//       → expects NO entitlement (no active question in published pack).
//
//   Idempotency: re-running the INSERT ... ON CONFLICT DO NOTHING must not
//   create duplicate rows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR = toFsPath(new URL('.', import.meta.url));
const BILLING_MODULE_ROOT = join(THIS_DIR, '..', '..');
const MODULES_ROOT = join(BILLING_MODULE_ROOT, '..');

const TENANCY_MIGRATIONS_DIR  = join(MODULES_ROOT, '02-tenancy', 'migrations');
const USERS_MIGRATIONS_DIR    = join(MODULES_ROOT, '03-users', 'migrations');
const QB_MIGRATIONS_DIR       = join(MODULES_ROOT, '04-question-bank', 'migrations');
const BILLING_MIGRATIONS_DIR  = join(BILLING_MODULE_ROOT, 'migrations');

// The backfill SQL — MUST stay byte-identical to the INSERT in
// 0082_entitlements_backfill.sql (incl. NULL::uuid — a bare NULL under
// SELECT DISTINCT resolves to text and fails uuid coercion on PG16).
// We run it as a superuser (no RLS needed for the backfill).
const BACKFILL_SQL = `
  INSERT INTO tenant_entitlements (tenant_id, scope_type, scope_id, granted_by, status)
  SELECT DISTINCT qp.tenant_id, 'domain', qp.domain, NULL::uuid, 'active'
  FROM question_packs qp
  JOIN questions q ON q.pack_id = qp.id AND q.status = 'active'
  WHERE qp.status = 'published'
    AND qp.domain IS NOT NULL
    AND qp.domain <> ''
  ON CONFLICT (tenant_id, scope_type, scope_id) DO NOTHING
`;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let dockerAvailable = true;

// Tenant 1: has live question → should get entitlement
let TENANT1_ID: string;
// Tenant 2: only draft questions / archived pack → should NOT get entitlement
let TENANT2_ID: string;
let ADMIN_USER_ID: string;

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

    TENANT1_ID    = randomUUID();
    TENANT2_ID    = randomUUID();
    ADMIN_USER_ID = randomUUID();

    await withSuperClient(async (client) => {
      // 1. Tenancy
      await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);

      // 2. Users
      await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ['020_users.sql']);

      // 3. Question bank tables needed for the backfill join
      //    0010: question_packs, 0011: levels, 0012: questions, 0016: ai_draft + kb column
      await applyMigrationsFromDir(client, QB_MIGRATIONS_DIR, [
        '0010_question_packs.sql',
        '0011_levels.sql',
        '0012_questions.sql',
        '0016_questions_ai_draft_kb.sql',
      ]);

      // 4. Billing entitlements table (no tenant_plans needed for this test — backfill
      //    runs as superuser / system role, doesn't touch withTenant or tenant_plans)
      await applyMigrationsFromDir(client, BILLING_MIGRATIONS_DIR, ['0081_tenant_entitlements.sql']);

      // Seed tenants
      await client.query(
        `INSERT INTO tenants (id, slug, name, status)
         VALUES ($1, 'bf-tenant1', 'Backfill Tenant 1', 'active'),
                ($2, 'bf-tenant2', 'Backfill Tenant 2', 'active')`,
        [TENANT1_ID, TENANT2_ID],
      );

      // Seed admin user (required for question_packs.created_by and questions.created_by FKs)
      await client.query(
        `INSERT INTO users (id, tenant_id, email, role)
         VALUES ($1, $2, 'admin@bf-test.com', 'admin')`,
        [ADMIN_USER_ID, TENANT1_ID],
      );
      // Tenant 2 needs its own user
      const ADMIN_USER2_ID = randomUUID();
      await client.query(
        `INSERT INTO users (id, tenant_id, email, role)
         VALUES ($1, $2, 'admin2@bf-test.com', 'admin')`,
        [ADMIN_USER2_ID, TENANT2_ID],
      );

      // ── Tenant 1: published pack, active question, domain='soc' ──────────────
      const PACK1_ID = randomUUID();
      const LEVEL1_ID = randomUUID();
      const QUESTION1_ID = randomUUID();

      await client.query(
        `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
         VALUES ($1, $2, 'soc-pack', 'SOC Pack', 'soc', 'published', $3)`,
        [PACK1_ID, TENANT1_ID, ADMIN_USER_ID],
      );
      await client.query(
        `INSERT INTO levels (id, pack_id, label, description, position, duration_minutes, default_question_count)
         VALUES ($1, $2, 'L1', 'Level 1', 1, 30, 5)`,
        [LEVEL1_ID, PACK1_ID],
      );
      await client.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
         VALUES ($1, $2, $3, 'mcq', 'SOC Question 1', 1, 'active',
                 '{"question":"q","options":[],"correct":0}'::jsonb, $4)`,
        [QUESTION1_ID, PACK1_ID, LEVEL1_ID, ADMIN_USER_ID],
      );

      // ── Tenant 2: archived pack + draft question → should NOT get entitlement ──
      const PACK2_ID = randomUUID();
      const LEVEL2_ID = randomUUID();
      const QUESTION2_ID = randomUUID();

      await client.query(
        `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
         VALUES ($1, $2, 'cloud-pack', 'Cloud Pack', 'cloud', 'archived', $3)`,
        [PACK2_ID, TENANT2_ID, ADMIN_USER2_ID],
      );
      await client.query(
        `INSERT INTO levels (id, pack_id, label, description, position, duration_minutes, default_question_count)
         VALUES ($1, $2, 'L1', 'Level 1', 1, 30, 5)`,
        [LEVEL2_ID, PACK2_ID],
      );
      await client.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
         VALUES ($1, $2, $3, 'mcq', 'Cloud Question 1', 1, 'draft',
                 '{"question":"q","options":[],"correct":0}'::jsonb, $4)`,
        [QUESTION2_ID, PACK2_ID, LEVEL2_ID, ADMIN_USER2_ID],
      );
    });
  },
  300_000,
);

afterAll(async () => {
  if (!dockerAvailable) return;
  if (container) await container.stop();
});

// ---------------------------------------------------------------------------
// Main scenarios
// ---------------------------------------------------------------------------

describe('0082_entitlements_backfill — scenario A: tenant with live content', () => {
  it(
    'inserts a domain entitlement for the tenant that has an active question in a published pack',
    async () => {
      if (!dockerAvailable) return;

      // Run the backfill
      await withSuperClient(async (c) => {
        await c.query('SET ROLE assessiq_system');
        await c.query(BACKFILL_SQL);
      });

      const rows = await withSuperClient(async (c) => {
        const { rows: r } = await c.query<{ tenant_id: string; scope_type: string; scope_id: string; status: string }>(
          `SELECT tenant_id, scope_type, scope_id, status
           FROM tenant_entitlements
           WHERE tenant_id = $1`,
          [TENANT1_ID],
        );
        return r;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.scope_type).toBe('domain');
      expect(rows[0]?.scope_id).toBe('soc');
      expect(rows[0]?.status).toBe('active');
    },
  );
});

describe('0082_entitlements_backfill — scenario B: tenant with only draft/archived content', () => {
  it(
    'does NOT insert any entitlement for the tenant with only draft questions or archived packs',
    async () => {
      if (!dockerAvailable) return;

      const rows = await withSuperClient(async (c) => {
        const { rows: r } = await c.query<{ id: string }>(
          `SELECT id FROM tenant_entitlements WHERE tenant_id = $1`,
          [TENANT2_ID],
        );
        return r;
      });

      expect(rows).toHaveLength(0);
    },
  );
});

describe('0082_entitlements_backfill — idempotency', () => {
  it(
    're-running the backfill INSERT does not create duplicate rows',
    async () => {
      if (!dockerAvailable) return;

      // Run again (backfill already ran in scenario A)
      await withSuperClient(async (c) => {
        await c.query('SET ROLE assessiq_system');
        await c.query(BACKFILL_SQL);
      });

      const rows = await withSuperClient(async (c) => {
        const { rows: r } = await c.query<{ id: string }>(
          `SELECT id FROM tenant_entitlements WHERE tenant_id = $1`,
          [TENANT1_ID],
        );
        return r;
      });

      // Still exactly one row — ON CONFLICT DO NOTHING prevents duplication
      expect(rows).toHaveLength(1);
    },
  );
});
