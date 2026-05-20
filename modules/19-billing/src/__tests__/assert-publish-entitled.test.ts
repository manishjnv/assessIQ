// AssessIQ — modules/19-billing/src/__tests__/assert-publish-entitled.test.ts
//
// DB-backed integration tests for B2 assertPublishEntitled service function.
//
// Strategy: postgres:16-alpine testcontainer. If Docker is unavailable the
// entire suite is skipped gracefully via the dockerAvailable flag pattern —
// same as entitlements.test.ts and update-tenant-plan.test.ts.
//
// Migration apply order (FK chain):
//   1. 02-tenancy ALL migrations  (tenants table + RLS setup)
//   2. 03-users 020_users.sql     (users table — needed for question_packs.created_by FK)
//   3. 14-audit-log ALL           (audit_log — not directly needed here but keeps
//                                  withTenant healthy for future callers)
//   4. 04-question-bank 0010      (question_packs — needed for getPackDomain)
//   5. 19-billing 0078            (tenant_plans — needed for getTenantTier)
//   6. 19-billing 0081            (tenant_entitlements — needed for listActiveEntitlements)
//
// Cases:
//   (a) pack's domain has an active 'domain' entitlement → resolves (no throw)
//   (b) pack_id has an active 'pack' entitlement (domain NOT entitled) → resolves
//   (c) no matching entitlement (neither pack nor domain) → throws AppError 403 NOT_ENTITLED
//   (d) tier='internal' with NO entitlements at all → resolves (bypass)
//   (e) entitlement exists but status='revoked' → throws 403 (revoked ≠ active)
//   (f) no tenant_plans row at all + no entitlement → throws 403 (fail-closed)
//   (g) tier='free', domain entitlement present → resolves (non-internal with valid grant)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

import { setPoolForTesting, closePool, withTenant } from '@assessiq/tenancy';
import { AppError } from '@assessiq/core';
import { assertPublishEntitled } from '../service.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR = toFsPath(new URL('.', import.meta.url));
const BILLING_MODULE_ROOT = join(THIS_DIR, '..', '..');
const MODULES_ROOT = join(BILLING_MODULE_ROOT, '..');

const TENANCY_MIGRATIONS_DIR     = join(MODULES_ROOT, '02-tenancy', 'migrations');
const USERS_MIGRATIONS_DIR       = join(MODULES_ROOT, '03-users', 'migrations');
const AUDIT_MIGRATIONS_DIR       = join(MODULES_ROOT, '14-audit-log', 'migrations');
const QB_MIGRATIONS_DIR          = join(MODULES_ROOT, '04-question-bank', 'migrations');
const BILLING_MIGRATIONS_DIR     = join(BILLING_MODULE_ROOT, 'migrations');

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

let TENANT_ID: string;
let ACTOR_USER_ID: string;
let PACK_ID: string;
const PACK_DOMAIN = 'soc';

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

// Reset entitlements + plan for the test tenant before each case that needs it.
async function resetTenantEntitlements(tenantId: string): Promise<void> {
  await withSuperClient(async (c) => {
    await c.query(`DELETE FROM tenant_entitlements WHERE tenant_id = $1`, [tenantId]);
  });
}

async function setTenantPlan(tenantId: string, tier: string, credits: number | null): Promise<void> {
  await withSuperClient(async (c) => {
    await c.query(
      `INSERT INTO tenant_plans (tenant_id, tier, included_credits)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET tier = EXCLUDED.tier, included_credits = EXCLUDED.included_credits`,
      [tenantId, tier, credits],
    );
  });
}

async function deleteTenantPlan(tenantId: string): Promise<void> {
  await withSuperClient(async (c) => {
    await c.query(`DELETE FROM tenant_plans WHERE tenant_id = $1`, [tenantId]);
  });
}

async function insertEntitlement(
  tenantId: string,
  scopeType: string,
  scopeId: string,
  status: 'active' | 'revoked' = 'active',
): Promise<void> {
  await withSuperClient(async (c) => {
    await c.query(
      `INSERT INTO tenant_entitlements (tenant_id, scope_type, scope_id, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE SET status = EXCLUDED.status`,
      [tenantId, scopeType, scopeId, status],
    );
  });
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

    TENANT_ID     = randomUUID();
    ACTOR_USER_ID = randomUUID();
    PACK_ID       = randomUUID();

    await withSuperClient(async (client) => {
      // Apply migrations in FK-safe order
      await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ['020_users.sql']);
      await applyMigrationsFromDir(client, AUDIT_MIGRATIONS_DIR);
      // Only the packs table (no levels/questions needed for this test)
      await applyMigrationsFromDir(client, QB_MIGRATIONS_DIR, ['0010_question_packs.sql']);
      await applyMigrationsFromDir(client, BILLING_MIGRATIONS_DIR, [
        '0078_tenant_plans.sql',
        '0081_tenant_entitlements.sql',
      ]);

      // Seed tenant
      await client.query(
        `INSERT INTO tenants (id, slug, name, status)
         VALUES ($1, $2, 'B2 Entitlement Test Tenant', 'active')`,
        [TENANT_ID, `b2-test-${randomUUID().slice(0, 6)}`],
      );

      // Seed actor user (needed for question_packs.created_by FK)
      await client.query(
        `INSERT INTO users (id, tenant_id, email, role)
         VALUES ($1, $2, $3, 'admin')`,
        [ACTOR_USER_ID, TENANT_ID, `b2-actor-${randomUUID().slice(0, 6)}@test.com`],
      );

      // Seed question pack with domain='soc' under the tenant
      // Must run under the tenant's RLS context (assessiq_app + current_tenant)
      // to pass the WITH CHECK policy. We use assessiq_system (BYPASSRLS) here
      // since we're in a super-client test setup.
      await client.query('SET LOCAL ROLE assessiq_system');
      await client.query(
        `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
         VALUES ($1, $2, 'test-soc-pack', 'SOC Test Pack', $3, 'published', $4)`,
        [PACK_ID, TENANT_ID, PACK_DOMAIN, ACTOR_USER_ID],
      );
      await client.query('RESET ROLE');

      // Provision default free plan
      await client.query(
        `INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, 'free', 25)`,
        [TENANT_ID],
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
// Helper: run assertPublishEntitled inside a withTenant tx (mirrors the
// production call site — publishAssessment / reopenAssessment run in withTenant).
// ---------------------------------------------------------------------------

async function runCheck(tenantId: string, packId: string): Promise<void> {
  return withTenant(tenantId, async (client) => {
    await assertPublishEntitled(client, tenantId, packId);
  });
}

// ---------------------------------------------------------------------------
// (a) pack's domain has an active 'domain' entitlement → resolves
// ---------------------------------------------------------------------------

describe('assertPublishEntitled — (a) domain entitlement resolves', () => {
  it.skipIf(!dockerAvailable)('resolves when an active domain-scope entitlement matches the pack domain', async () => {
    await resetTenantEntitlements(TENANT_ID);
    await setTenantPlan(TENANT_ID, 'free', 25);
    await insertEntitlement(TENANT_ID, 'domain', PACK_DOMAIN);

    await expect(runCheck(TENANT_ID, PACK_ID)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (b) pack_id has an active 'pack' entitlement (domain NOT entitled) → resolves
// ---------------------------------------------------------------------------

describe('assertPublishEntitled — (b) pack_id entitlement resolves', () => {
  it.skipIf(!dockerAvailable)('resolves when an active pack-scope entitlement matches the pack_id (domain not entitled)', async () => {
    await resetTenantEntitlements(TENANT_ID);
    await setTenantPlan(TENANT_ID, 'free', 25);
    // Only pack-scope — no domain entitlement
    await insertEntitlement(TENANT_ID, 'pack', PACK_ID);

    await expect(runCheck(TENANT_ID, PACK_ID)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (c) no matching entitlement → throws AppError 403 NOT_ENTITLED
// ---------------------------------------------------------------------------

describe('assertPublishEntitled — (c) no entitlement throws 403', () => {
  it.skipIf(!dockerAvailable)('throws AppError with status 403 and code NOT_ENTITLED when no entitlement matches', async () => {
    await resetTenantEntitlements(TENANT_ID);
    await setTenantPlan(TENANT_ID, 'free', 25);
    // No entitlements at all

    const err = await runCheck(TENANT_ID, PACK_ID).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AppError);
    const appErr = err as AppError;
    expect(appErr.status).toBe(403);
    expect(appErr.code).toBe('NOT_ENTITLED');
    expect((appErr.details as Record<string, unknown> | undefined)?.code).toBe('NOT_ENTITLED');
    expect((appErr.details as Record<string, unknown> | undefined)?.pack_id).toBe(PACK_ID);
  });
});

// ---------------------------------------------------------------------------
// (d) tier='internal' with NO entitlements → resolves (bypass)
// ---------------------------------------------------------------------------

describe('assertPublishEntitled — (d) internal tier bypasses', () => {
  it.skipIf(!dockerAvailable)('resolves for internal tier even with zero entitlements', async () => {
    await resetTenantEntitlements(TENANT_ID);
    await setTenantPlan(TENANT_ID, 'internal', null);
    // No entitlements — internal bypass must fire before entitlement check

    await expect(runCheck(TENANT_ID, PACK_ID)).resolves.toBeUndefined();

    // Restore free plan for subsequent tests
    await setTenantPlan(TENANT_ID, 'free', 25);
  });
});

// ---------------------------------------------------------------------------
// (e) entitlement exists but status='revoked' → throws 403
// ---------------------------------------------------------------------------

describe('assertPublishEntitled — (e) revoked entitlement is not active', () => {
  it.skipIf(!dockerAvailable)('throws 403 when the only matching entitlement has status=revoked', async () => {
    await resetTenantEntitlements(TENANT_ID);
    await setTenantPlan(TENANT_ID, 'free', 25);
    // Insert a revoked domain entitlement — must NOT count as entitled
    await insertEntitlement(TENANT_ID, 'domain', PACK_DOMAIN, 'revoked');

    const err = await runCheck(TENANT_ID, PACK_ID).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AppError);
    const appErr = err as AppError;
    expect(appErr.status).toBe(403);
    expect(appErr.code).toBe('NOT_ENTITLED');
  });
});

// ---------------------------------------------------------------------------
// (f) no tenant_plans row + no entitlement → throws 403 (fail-closed)
// ---------------------------------------------------------------------------

describe('assertPublishEntitled — (f) missing plan is fail-closed', () => {
  it.skipIf(!dockerAvailable)('throws 403 when tenant has no plan row (missing plan does NOT bypass)', async () => {
    await resetTenantEntitlements(TENANT_ID);
    await deleteTenantPlan(TENANT_ID);
    // No plan row, no entitlements

    const err = await runCheck(TENANT_ID, PACK_ID).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AppError);
    const appErr = err as AppError;
    expect(appErr.status).toBe(403);
    expect(appErr.code).toBe('NOT_ENTITLED');

    // Restore plan for subsequent tests
    await setTenantPlan(TENANT_ID, 'free', 25);
  });
});

// ---------------------------------------------------------------------------
// (g) tier='free', domain entitlement present → resolves
// ---------------------------------------------------------------------------

describe('assertPublishEntitled — (g) non-internal tier with valid domain grant resolves', () => {
  it.skipIf(!dockerAvailable)('resolves for free tier when domain entitlement is active', async () => {
    await resetTenantEntitlements(TENANT_ID);
    await setTenantPlan(TENANT_ID, 'free', 25);
    await insertEntitlement(TENANT_ID, 'domain', PACK_DOMAIN);

    await expect(runCheck(TENANT_ID, PACK_ID)).resolves.toBeUndefined();
  });
});
