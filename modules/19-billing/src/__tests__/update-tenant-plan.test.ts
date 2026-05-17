// AssessIQ — modules/19-billing/src/__tests__/update-tenant-plan.test.ts
//
// DB-backed integration tests for updateTenantPlan (Phase A2).
//
// Strategy: postgres:16-alpine testcontainer. If Docker is unavailable the
// entire suite is skipped gracefully via the dockerAvailable flag pattern —
// same as billing-events.test.ts.
//
// Migration apply order (FK chain):
//   1. 02-tenancy ALL migrations  (tenants table + RLS setup)
//   2. 03-users 020_users.sql     (users table)
//   3. 14-audit-log ALL           (audit_log table — auditInTx target)
//   4. 19-billing 0078            (tenant_plans)
//
// Cases:
//   (a) free → pro with credits → row updated + exactly one audit_log row
//       with action 'tenant.plan_updated' in the same tx
//   (b) tier → internal with includedCredits = null → ok
//   (c) tier → internal with includedCredits = 5 → ValidationError INTERNAL_REQUIRES_NULL_CREDITS,
//       NO row change, NO audit row
//   (d) tier → free with includedCredits = null → ValidationError FINITE_TIER_REQUIRES_CREDITS
//   (e) unknown tenant → NotFoundError

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { setPoolForTesting, closePool } from '@assessiq/tenancy';
import { ValidationError, NotFoundError } from '@assessiq/core';
import { updateTenantPlan } from '../service.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR = toFsPath(new URL('.', import.meta.url));
const BILLING_MODULE_ROOT = join(THIS_DIR, '..', '..');
const MODULES_ROOT = join(BILLING_MODULE_ROOT, '..');

const TENANCY_MIGRATIONS_DIR   = join(MODULES_ROOT, '02-tenancy', 'migrations');
const USERS_MIGRATIONS_DIR     = join(MODULES_ROOT, '03-users', 'migrations');
const AUDIT_MIGRATIONS_DIR     = join(MODULES_ROOT, '14-audit-log', 'migrations');
const BILLING_MIGRATIONS_DIR   = join(BILLING_MODULE_ROOT, 'migrations');

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let dockerAvailable = true;

let TENANT_ID: string;
let ACTOR_USER_ID: string;

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

    await setPoolForTesting(containerUrl);

    TENANT_ID     = randomUUID();
    ACTOR_USER_ID = randomUUID();

    await withSuperClient(async (client) => {
      // Apply migrations in FK-safe order
      await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ['020_users.sql']);
      await applyMigrationsFromDir(client, AUDIT_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, BILLING_MIGRATIONS_DIR, ['0078_tenant_plans.sql']);

      // Seed test tenant
      await client.query(
        `INSERT INTO tenants (id, slug, name, status)
         VALUES ($1, $2, 'Plan Test Tenant', 'active')`,
        [TENANT_ID, `tenant-plan-test-${randomUUID().slice(0, 6)}`],
      );

      // Seed actor user in the tenant
      await client.query(
        `INSERT INTO users (id, tenant_id, email, role)
         VALUES ($1, $2, $3, 'admin')`,
        [ACTOR_USER_ID, TENANT_ID, `super-admin-${randomUUID().slice(0, 6)}@test.com`],
      );

      // Provision a free plan with 25 credits
      await client.query(
        `INSERT INTO tenant_plans (tenant_id, tier, included_credits)
         VALUES ($1, 'free', 25)`,
        [TENANT_ID],
      );
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
// (a) free → pro with credits → row updated + exactly one audit_log row
// ---------------------------------------------------------------------------

describe('updateTenantPlan — (a) free → pro', () => {
  it(
    'updates tier + credits and inserts exactly one audit_log row with action tenant.plan_updated',
    async () => {
      if (!dockerAvailable) return;

      // Reset plan back to free/25 before this case (re-entrant)
      await withSuperClient(async (c) => {
        await c.query(
          `UPDATE tenant_plans SET tier = 'free', included_credits = 25 WHERE tenant_id = $1`,
          [TENANT_ID],
        );
        await c.query(`DELETE FROM audit_log WHERE entity_id = $1`, [TENANT_ID]);
      });

      const result = await updateTenantPlan(ACTOR_USER_ID, TENANT_ID, {
        tier: 'pro',
        includedCredits: 100,
      });

      expect(result.tier).toBe('pro');
      expect(result.included_credits).toBe(100);
      expect(result.previous.tier).toBe('free');
      expect(result.previous.included_credits).toBe(25);
      expect(typeof result.auditId).toBe('string');
      expect(result.auditId.length).toBeGreaterThan(0);

      // Verify the row was actually updated in the DB
      await withSuperClient(async (c) => {
        const { rows } = await c.query<{ tier: string; included_credits: number }>(
          `SELECT tier, included_credits FROM tenant_plans WHERE tenant_id = $1`,
          [TENANT_ID],
        );
        expect(rows[0]?.tier).toBe('pro');
        expect(rows[0]?.included_credits).toBe(100);

        // Exactly one audit row for this update
        const { rows: auditRows } = await c.query<{ id: string; action: string }>(
          `SELECT id, action FROM audit_log WHERE entity_id = $1 AND action = 'tenant.plan_updated'`,
          [TENANT_ID],
        );
        expect(auditRows).toHaveLength(1);
        expect(auditRows[0]?.id).toBe(result.auditId);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// (b) tier → internal with includedCredits = null → ok
// ---------------------------------------------------------------------------

describe('updateTenantPlan — (b) internal + null credits', () => {
  it(
    'accepts internal tier with null includedCredits and writes audit row',
    async () => {
      if (!dockerAvailable) return;

      // Reset
      await withSuperClient(async (c) => {
        await c.query(
          `UPDATE tenant_plans SET tier = 'free', included_credits = 25 WHERE tenant_id = $1`,
          [TENANT_ID],
        );
        await c.query(`DELETE FROM audit_log WHERE entity_id = $1`, [TENANT_ID]);
      });

      const result = await updateTenantPlan(ACTOR_USER_ID, TENANT_ID, {
        tier: 'internal',
        includedCredits: null,
      });

      expect(result.tier).toBe('internal');
      expect(result.included_credits).toBeNull();

      await withSuperClient(async (c) => {
        const { rows } = await c.query<{ tier: string; included_credits: number | null }>(
          `SELECT tier, included_credits FROM tenant_plans WHERE tenant_id = $1`,
          [TENANT_ID],
        );
        expect(rows[0]?.tier).toBe('internal');
        expect(rows[0]?.included_credits).toBeNull();
      });
    },
  );
});

// ---------------------------------------------------------------------------
// (c) tier → internal with includedCredits = 5 → ValidationError
//     NO row change, NO audit row
// ---------------------------------------------------------------------------

describe('updateTenantPlan — (c) internal + non-null credits = ValidationError', () => {
  it(
    'throws ValidationError INTERNAL_REQUIRES_NULL_CREDITS, no row change, no audit row',
    async () => {
      if (!dockerAvailable) return;

      // Reset to known state
      await withSuperClient(async (c) => {
        await c.query(
          `UPDATE tenant_plans SET tier = 'free', included_credits = 25 WHERE tenant_id = $1`,
          [TENANT_ID],
        );
        await c.query(`DELETE FROM audit_log WHERE entity_id = $1`, [TENANT_ID]);
      });

      await expect(
        updateTenantPlan(ACTOR_USER_ID, TENANT_ID, { tier: 'internal', includedCredits: 5 }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ValidationError &&
          (e.details as Record<string, unknown> | undefined)?.code ===
            'INTERNAL_REQUIRES_NULL_CREDITS',
      );

      // Row must be unchanged
      await withSuperClient(async (c) => {
        const { rows } = await c.query<{ tier: string; included_credits: number }>(
          `SELECT tier, included_credits FROM tenant_plans WHERE tenant_id = $1`,
          [TENANT_ID],
        );
        expect(rows[0]?.tier).toBe('free');
        expect(rows[0]?.included_credits).toBe(25);

        // No audit row
        const { rows: auditRows } = await c.query(
          `SELECT id FROM audit_log WHERE entity_id = $1 AND action = 'tenant.plan_updated'`,
          [TENANT_ID],
        );
        expect(auditRows).toHaveLength(0);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// (d) tier → free with includedCredits = null → ValidationError
// ---------------------------------------------------------------------------

describe('updateTenantPlan — (d) free + null credits = ValidationError', () => {
  it(
    'throws ValidationError FINITE_TIER_REQUIRES_CREDITS for free tier with null credits',
    async () => {
      if (!dockerAvailable) return;

      await expect(
        updateTenantPlan(ACTOR_USER_ID, TENANT_ID, { tier: 'free', includedCredits: null }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ValidationError &&
          (e.details as Record<string, unknown> | undefined)?.code ===
            'FINITE_TIER_REQUIRES_CREDITS',
      );
    },
  );
});

// ---------------------------------------------------------------------------
// (e) unknown tenant → NotFoundError
// ---------------------------------------------------------------------------

describe('updateTenantPlan — (e) unknown tenant → NotFoundError', () => {
  it(
    'throws NotFoundError for a tenantId with no plan row',
    async () => {
      if (!dockerAvailable) return;

      const ghostId = randomUUID();
      await expect(
        updateTenantPlan(ACTOR_USER_ID, ghostId, { tier: 'pro', includedCredits: 50 }),
      ).rejects.toBeInstanceOf(NotFoundError);
    },
  );
});
