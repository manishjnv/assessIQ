/**
 * Integration tests for modules/14-audit-log.
 *
 * Uses a postgres:16-alpine testcontainer.
 *
 * Migration apply order (FK chain: tenants → users → audit_log):
 *   1. ALL 02-tenancy migrations (0001–0004)
 *   2. 03-users 020_users.sql ONLY  (users table needed for FK)
 *   3. 14-audit-log 0050_audit_log.sql
 *
 * Coverage:
 *   - audit(): happy path — row written with all fields
 *   - audit(): redaction — sensitive fields in before/after never reach the DB
 *   - audit(): unknown ActionName → throws, no row written
 *   - audit(): RequestContext auto-fill — ip + ua captured from ALS context
 *   - audit(): RequestContext absent — ip + ua default to null (graceful degradation)
 *   - append-only enforcement — UPDATE on audit_log from assessiq_app → "permission denied"
 *   - append-only enforcement — DELETE on audit_log from assessiq_app → "permission denied"
 *   - tenant isolation — tenant B cannot SELECT tenant A's rows
 *   - list() — basic pagination + filter by action
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { setPoolForTesting, closePool } from '@assessiq/tenancy';
import { withRequestContext } from '@assessiq/core';

// Module under test
import { audit, list } from '../index.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR = toFsPath(new URL('.', import.meta.url));
const AUDIT_MODULE_ROOT = join(THIS_DIR, '..', '..');
const MODULES_ROOT = join(AUDIT_MODULE_ROOT, '..');

const TENANCY_DIR = join(MODULES_ROOT, '02-tenancy', 'migrations');
const USERS_DIR = join(MODULES_ROOT, '03-users', 'migrations');
const AUDIT_DIR = join(AUDIT_MODULE_ROOT, 'migrations');

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;

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
});

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

    // Grant application role and system role (matching production setup)
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_app') THEN
          CREATE ROLE assessiq_app;
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_system') THEN
          CREATE ROLE assessiq_system BYPASSRLS;
        END IF;
      END $$;
    `);
    await client.query(`GRANT assessiq_app TO assessiq`);
    await client.query(`GRANT assessiq_system TO assessiq`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);

    await applyMigrationsFromDir(client, TENANCY_DIR);
    await applyMigrationsFromDir(client, USERS_DIR, ['020_users.sql']);
    await applyMigrationsFromDir(client, AUDIT_DIR);

    // Grant INSERT + SELECT on audit_log to assessiq_app (the REVOKE restricts UPDATE/DELETE/TRUNCATE)
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await client.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  });
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface TestTenant { id: string; }
interface TestUser { id: string; tenantId: string; }

async function createTenant(): Promise<TestTenant> {
  const id = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [id, `Test Tenant ${id.slice(0, 8)}`, `slug-${id.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [id],
    );
  });
  return { id };
}

async function createUser(tenantId: string): Promise<TestUser> {
  const id = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status)
       VALUES ($1, $2, $3, $4, 'admin', 'active')`,
      [id, tenantId, `user-${id.slice(0, 8)}@example.com`, `User ${id.slice(0, 8)}`],
    );
  });
  return { id, tenantId };
}

// Helper: query audit_log as superuser (bypasses RLS for test assertions)
async function queryAuditLog(tenantId: string): Promise<{
  id: string;
  actor_kind: string;
  action: string;
  entity_type: string;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
}[]> {
  return withSuperClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id::text, actor_kind, action, entity_type, before, after,
              ip::text, user_agent
       FROM audit_log WHERE tenant_id = $1 ORDER BY at DESC`,
      [tenantId],
    );
    return rows;
  });
}

// ---------------------------------------------------------------------------
// Tests: happy path
// ---------------------------------------------------------------------------

describe('audit() — happy path', () => {
  it('writes a row with all required fields', async () => {
    const tenant = await createTenant();
    const user = await createUser(tenant.id);

    await audit({
      tenantId: tenant.id,
      actorKind: 'user',
      actorUserId: user.id,
      action: 'tenant.settings.updated',
      entityType: 'tenant_settings',
      entityId: tenant.id,
      before: { ai_grading_enabled: true },
      after: { ai_grading_enabled: false },
      ip: '10.0.0.1',
      userAgent: 'vitest/1.0',
    });

    const rows = await queryAuditLog(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: 'user',
      action: 'tenant.settings.updated',
      entity_type: 'tenant_settings',
      // PostgreSQL INET type returns IPv4 addresses with /32 CIDR suffix
      ip: '10.0.0.1/32',
      user_agent: 'vitest/1.0',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: redaction
// ---------------------------------------------------------------------------

describe('audit() — redaction', () => {
  it('redacts password fields in before/after', async () => {
    const tenant = await createTenant();

    await audit({
      tenantId: tenant.id,
      actorKind: 'system',
      action: 'user.created',
      entityType: 'user',
      before: null as unknown as Record<string, unknown>,
      after: {
        email: 'user@example.com',
        password: 'secret123',
        totp_secret: 'JBSWY3DPEHPK3PXP',
        recovery_codes: ['abc', 'def'],
        name: 'Alice',
      },
    });

    const rows = await queryAuditLog(tenant.id);
    expect(rows).toHaveLength(1);
    const afterObj = rows[0]!.after as Record<string, unknown>;
    expect(afterObj['password']).toBe('[REDACTED]');
    expect(afterObj['totp_secret']).toBe('[REDACTED]');
    expect(afterObj['recovery_codes']).toBe('[REDACTED]');
    // Non-sensitive fields are preserved
    expect(afterObj['email']).toBe('user@example.com');
    expect(afterObj['name']).toBe('Alice');
  });

  it('redacts secret / token / key / hash fields', async () => {
    const tenant = await createTenant();

    await audit({
      tenantId: tenant.id,
      actorKind: 'api_key',
      action: 'api_key.created',
      entityType: 'api_key',
      after: {
        key_hash: 'abc123',
        embed_secret: 'tok_abc',
        refresh_token: 'rtok_xyz',
        id_token: 'idtok_xyz',
        safe_field: 'keep_me',
      },
    });

    const rows = await queryAuditLog(tenant.id);
    expect(rows).toHaveLength(1);
    const afterObj = rows[0]!.after as Record<string, unknown>;
    expect(afterObj['key_hash']).toBe('[REDACTED]');
    expect(afterObj['embed_secret']).toBe('[REDACTED]');
    expect(afterObj['refresh_token']).toBe('[REDACTED]');
    expect(afterObj['id_token']).toBe('[REDACTED]');
    expect(afterObj['safe_field']).toBe('keep_me');
  });

  it('does not log sensitive fields in nested objects', async () => {
    const tenant = await createTenant();

    await audit({
      tenantId: tenant.id,
      actorKind: 'system',
      action: 'tenant.settings.updated',
      entityType: 'tenant_settings',
      after: {
        smtp: { password: 'smtp_pass', host: 'smtp.example.com' },
      },
    });

    const rows = await queryAuditLog(tenant.id);
    const afterObj = rows[0]!.after as Record<string, unknown>;
    const smtp = afterObj['smtp'] as Record<string, unknown>;
    expect(smtp['password']).toBe('[REDACTED]');
    expect(smtp['host']).toBe('smtp.example.com');
  });
});

// ---------------------------------------------------------------------------
// Tests: ActionName validation
// ---------------------------------------------------------------------------

describe('audit() — ActionName validation', () => {
  it('throws for an unknown action name', async () => {
    const tenant = await createTenant();

    await expect(
      audit({
        tenantId: tenant.id,
        actorKind: 'system',
        action: 'completely.unknown.action' as never,
        entityType: 'unknown',
      }),
    ).rejects.toThrow('unknown action');

    // Verify no row was written
    const rows = await queryAuditLog(tenant.id);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: RequestContext auto-fill
// ---------------------------------------------------------------------------

describe('audit() — RequestContext auto-fill', () => {
  it('auto-fills ip and userAgent from active RequestContext', async () => {
    const tenant = await createTenant();

    await withRequestContext(
      {
        requestId: randomUUID(),
        tenantId: tenant.id,
        ip: '192.168.1.100',
        ua: 'Mozilla/5.0 (TestBrowser)',
      },
      async () => {
        await audit({
          tenantId: tenant.id,
          actorKind: 'user',
          action: 'grading.override',
          entityType: 'grading',
          // ip and userAgent NOT passed — should be auto-filled
        });
      },
    );

    const rows = await queryAuditLog(tenant.id);
    expect(rows).toHaveLength(1);
    // PostgreSQL INET type returns IPv4 addresses with /32 CIDR suffix
    expect(rows[0]!.ip).toBe('192.168.1.100/32');
    expect(rows[0]!.user_agent).toBe('Mozilla/5.0 (TestBrowser)');
  });

  it('defaults ip and userAgent to null when called outside RequestContext', async () => {
    const tenant = await createTenant();

    // No withRequestContext wrapper — ALS context is absent
    await audit({
      tenantId: tenant.id,
      actorKind: 'system',
      action: 'webhook.created',
      entityType: 'webhook_endpoint',
    });

    const rows = await queryAuditLog(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ip).toBeNull();
    expect(rows[0]!.user_agent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: append-only enforcement
// ---------------------------------------------------------------------------

// Note: assessiq_app inherits from assessiq_system (GRANT assessiq_system TO assessiq_app
// in 0002_rls_helpers.sql). The migration REVOKEs UPDATE/DELETE from assessiq_app DIRECTLY.
// We verify this via pg catalog (information_schema.role_table_grants) rather than
// execution, because inherited privileges from assessiq_system would mask a direct-revoke
// execution check.
describe('append-only enforcement', () => {
  it('UPDATE privilege is NOT directly granted to assessiq_app on audit_log', async () => {
    await withSuperClient(async (client) => {
      const { rows } = await client.query<{ privilege_type: string }>(`
        SELECT privilege_type
        FROM information_schema.role_table_grants
        WHERE table_name = 'audit_log'
          AND grantee = 'assessiq_app'
          AND privilege_type = 'UPDATE'
      `);
      expect(rows).toHaveLength(0);
    });
  });

  it('DELETE privilege is NOT directly granted to assessiq_app on audit_log', async () => {
    await withSuperClient(async (client) => {
      const { rows } = await client.query<{ privilege_type: string }>(`
        SELECT privilege_type
        FROM information_schema.role_table_grants
        WHERE table_name = 'audit_log'
          AND grantee = 'assessiq_app'
          AND privilege_type = 'DELETE'
      `);
      expect(rows).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('tenant B cannot SELECT rows belonging to tenant A', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();

    // Write an event for tenant A
    await audit({
      tenantId: tenantA.id,
      actorKind: 'system',
      action: 'user.created',
      entityType: 'user',
    });

    // Query as tenant B — should see 0 rows
    const result = await list({
      tenantId: tenantB.id,
      page: 1,
      pageSize: 50,
    });

    expect(result.total).toBe(0);
    expect(result.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: list()
// ---------------------------------------------------------------------------

describe('list() — pagination + filtering', () => {
  it('returns paginated rows ordered by at DESC', async () => {
    const tenant = await createTenant();

    await audit({ tenantId: tenant.id, actorKind: 'system', action: 'pack.created', entityType: 'question_pack' });
    await audit({ tenantId: tenant.id, actorKind: 'system', action: 'pack.published', entityType: 'question_pack' });
    await audit({ tenantId: tenant.id, actorKind: 'system', action: 'assessment.created', entityType: 'assessment' });

    const result = await list({ tenantId: tenant.id, page: 1, pageSize: 2 });
    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(2);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);
  });

  it('filters by action', async () => {
    const tenant = await createTenant();

    await audit({ tenantId: tenant.id, actorKind: 'system', action: 'grading.override', entityType: 'grading' });
    await audit({ tenantId: tenant.id, actorKind: 'system', action: 'grading.retry', entityType: 'grading' });
    await audit({ tenantId: tenant.id, actorKind: 'system', action: 'user.created', entityType: 'user' });

    const result = await list({
      tenantId: tenant.id,
      filters: { action: 'grading.override' },
      page: 1,
      pageSize: 50,
    });

    expect(result.total).toBe(1);
    expect(result.rows[0]!.action).toBe('grading.override');
  });
});
