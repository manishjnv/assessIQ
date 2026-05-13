/**
 * G3.D audit-write sweep — coverage tests for modules/16-help-system.
 *
 * Mirrors modules/03-users/src/__tests__/audit-writes.test.ts pattern.
 *
 * Verifies every admin-mutating service method writes a corresponding
 * audit_log row INSIDE the same Postgres transaction as the domain mutation,
 * satisfying the CLAUDE.md atomicity invariant.
 *
 * Migration apply order: tenancy → help-system → audit-log.
 * The audit-log migration must precede the service calls because every wired
 * mutation now writes an audit_log row via auditInTx() inside the same
 * withTenant transaction.
 *
 * Atomicity is verified two ways:
 *   1. Happy path: mutation row + audit row both present, with expected shape.
 *   2. Failure injection: vi.mock'd auditInTx throws mid-transaction — the
 *      surrounding withTenant rolls back, leaving help_content in its
 *      pre-mutation state.
 *
 * Coverage assertion at bottom counts auditInTx( occurrences in service.ts
 * and expects exactly 2.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { setPoolForTesting, closePool } from '@assessiq/tenancy';

// ---------------------------------------------------------------------------
// Mock @assessiq/audit-log so individual tests can inject a one-shot failure
// into auditInTx without rewriting service.ts to use a deferred binding.
// vi.spyOn doesn't work on static-import bindings in ESM, so we mock the
// module and forward to the real implementation by default.
// ---------------------------------------------------------------------------

let injectAuditFailure: Error | null = null;

vi.mock('@assessiq/audit-log', async () => {
  const actual =
    await vi.importActual<typeof import('@assessiq/audit-log')>('@assessiq/audit-log');
  return {
    ...actual,
    auditInTx: vi.fn(async (...args: Parameters<typeof actual.auditInTx>) => {
      if (injectAuditFailure !== null) {
        const err = injectAuditFailure;
        injectAuditFailure = null; // one-shot
        throw err;
      }
      return actual.auditInTx(...args);
    }),
  };
});

import { upsertHelpForTenant, importHelp } from '../service.js';

// ---------------------------------------------------------------------------
// Path helpers (Windows: strip leading slash before drive letter)
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR = toFsPath(new URL('.', import.meta.url));
const HELP_MODULE_ROOT = join(THIS_DIR, '..', '..');
const MODULES_ROOT = join(HELP_MODULE_ROOT, '..');

const TENANCY_DIR = join(MODULES_ROOT, '02-tenancy', 'migrations');
const USERS_DIR = join(MODULES_ROOT, '03-users', 'migrations');
const HELP_DIR = join(HELP_MODULE_ROOT, 'migrations');
const AUDIT_DIR = join(MODULES_ROOT, '14-audit-log', 'migrations');

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let adminA: string;

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

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

async function queryAudit(tenantId: string, action?: string): Promise<AuditRow[]> {
  return withSuperClient(async (client) => {
    const params: unknown[] = [tenantId];
    let where = `tenant_id = $1`;
    if (action !== undefined) {
      params.push(action);
      where += ` AND action = $2`;
    }
    const result = await client.query<AuditRow>(
      `SELECT id::text, actor_user_id::text, actor_kind, action,
              entity_type, entity_id::text, before, after
         FROM audit_log
        WHERE ${where}
        ORDER BY at DESC`,
      params,
    );
    return result.rows;
  });
}

async function clearAudit(tenantId: string): Promise<void> {
  await withSuperClient(async (client) => {
    await client.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantId]);
  });
}

async function readHelpContent(
  tenantId: string,
  key: string,
  locale: string,
): Promise<{ id: string; short_text: string; version: number } | null> {
  return withSuperClient(async (client) => {
    const r = await client.query<{ id: string; short_text: string; version: number }>(
      `SELECT id::text, short_text, version
         FROM help_content
        WHERE tenant_id = $1 AND key = $2 AND locale = $3 AND status = 'active'
        ORDER BY version DESC
        LIMIT 1`,
      [tenantId, key, locale],
    );
    return r.rows[0] ?? null;
  });
}

async function insertTenant(client: Client, id: string, slug: string): Promise<void> {
  await client.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
    [id, slug, `Tenant ${slug}`],
  );
  await client.query(
    `INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [id],
  );
}

async function insertAdmin(
  client: Client,
  id: string,
  tenantId: string,
  email: string,
): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
    [id, tenantId, email],
  );
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'aiq_help_audit_test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_help_audit_test`;

  const [tenancyFiles, usersFiles, helpFiles, auditFiles] = await Promise.all([
    readdir(TENANCY_DIR),
    readdir(USERS_DIR),
    readdir(HELP_DIR),
    readdir(AUDIT_DIR),
  ]);

  const tenancySorted = tenancyFiles.filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ dir: TENANCY_DIR, file: f }));
  // audit_log has `actor_user_id UUID REFERENCES users(id)` — apply users table only (020_).
  const usersTable = usersFiles.filter((f) => f.endsWith('.sql') && f.startsWith('020_')).sort()
    .map((f) => ({ dir: USERS_DIR, file: f }));
  const helpSorted = helpFiles.filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ dir: HELP_DIR, file: f }));
  const auditSorted = auditFiles.filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ dir: AUDIT_DIR, file: f }));

  // Migration order: tenancy → users-table (audit FK) → help-system → audit-log.
  const allMigrations = [...tenancySorted, ...usersTable, ...helpSorted, ...auditSorted];

  await withSuperClient(async (client) => {
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
    await client.query(`GRANT assessiq_app TO test`);
    await client.query(`GRANT assessiq_system TO test`);

    for (const { dir, file } of allMigrations) {
      const sql = await readFile(join(dir, file), 'utf-8');
      await client.query(sql);
    }

    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });

  await setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  adminA = randomUUID();

  await withSuperClient(async (client) => {
    await insertTenant(client, tenantA, `help-audit-${tenantA.slice(0, 8)}`);
    await insertAdmin(client, adminA, tenantA, `help-audit-admin-${tenantA.slice(0, 8)}@example.com`);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(() => {
  injectAuditFailure = null;
});

// ===========================================================================
// Tests
// ===========================================================================

describe('audit writes for 16-help-system service', () => {
  it('upsertHelpForTenant writes help.content.updated with before=null on first insert', async () => {
    await clearAudit(tenantA);
    const key = `audit.test.insert.${randomUUID().slice(0, 8)}`;

    const result = await upsertHelpForTenant(
      tenantA,
      key,
      { audience: 'admin', shortText: 'First insert', locale: 'en' },
      adminA,
    );

    const rows = await queryAudit(tenantA, 'help.content.updated');
    const row = rows.find((r) => r.entity_id === result.id);
    expect(row).toBeDefined();
    expect(row!.actor_kind).toBe('user');
    expect(row!.actor_user_id).toBe(adminA);
    expect(row!.entity_type).toBe('help_content');
    expect(row!.before).toBeNull();
    const after = row!.after as Record<string, unknown>;
    expect(after['help_id']).toBe(key);
    expect(after['short_text']).toBe('First insert');
    expect(after['version']).toBe(1);
  });

  it('upsertHelpForTenant writes help.content.updated with before snapshot on update', async () => {
    const key = `audit.test.update.${randomUUID().slice(0, 8)}`;

    // First insert
    await upsertHelpForTenant(
      tenantA,
      key,
      { audience: 'admin', shortText: 'Original text', locale: 'en' },
      adminA,
    );

    await clearAudit(tenantA);

    // Second upsert — should see before snapshot
    const result = await upsertHelpForTenant(
      tenantA,
      key,
      { audience: 'admin', shortText: 'Updated text', locale: 'en' },
      adminA,
    );

    const rows = await queryAudit(tenantA, 'help.content.updated');
    const row = rows.find((r) => r.entity_id === result.id);
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before).not.toBeNull();
    expect(before['help_id']).toBe(key);
    expect(before['short_text']).toBe('Original text');
    expect(before['version']).toBe(1);
    expect(after['short_text']).toBe('Updated text');
    expect(after['version']).toBe(2);
  });

  it('importHelp writes one help.content.imported summary row with inserted/skipped/total/keys', async () => {
    await clearAudit(tenantA);
    const locale = 'fr';
    const importRows = [
      { key: `import.test.${randomUUID().slice(0, 8)}`, input: { audience: 'admin' as const, shortText: 'Bonjour', locale } },
      { key: `import.test.${randomUUID().slice(0, 8)}`, input: { audience: 'admin' as const, shortText: 'Monde', locale } },
    ];

    const result = await importHelp(tenantA, locale, importRows, adminA);

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);

    const rows = await queryAudit(tenantA, 'help.content.imported');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actor_kind).toBe('user');
    expect(row.actor_user_id).toBe(adminA);
    expect(row.entity_type).toBe('help_content');
    expect(row.entity_id).toBeNull();
    expect(row.before).toBeNull();
    const after = row.after as Record<string, unknown>;
    expect(after['inserted']).toBe(2);
    expect(after['skipped']).toBe(0);
    expect(after['locale']).toBe(locale);
    expect(after['total']).toBe(2);
    expect(Array.isArray(after['keys'])).toBe(true);
    expect((after['keys'] as string[]).length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Atomicity proof — auditInTx throws → mutation rolls back.
  // -------------------------------------------------------------------------
  it('when auditInTx throws inside upsertHelpForTenant, the help_content row is NOT mutated', async () => {
    const key = `audit.atom.${randomUUID().slice(0, 8)}`;

    // One-shot failure injection
    injectAuditFailure = new Error('audit write injection failure');

    await expect(
      upsertHelpForTenant(
        tenantA,
        key,
        { audience: 'admin', shortText: 'Should not persist', locale: 'en' },
        adminA,
      ),
    ).rejects.toThrow(/audit write injection failure/);

    // The help_content row must not exist because withTenant rolled back.
    const row = await readHelpContent(tenantA, key, 'en');
    expect(row).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Coverage: count of auditInTx call-sites in service.ts must equal 2.
  // Adding a new admin-mutating method without wiring audit will fail this.
  // -------------------------------------------------------------------------
  it('source contains exactly 2 auditInTx call-sites in service.ts', async () => {
    const servicePath = join(HELP_MODULE_ROOT, 'src', 'service.ts');
    const content = await readFile(servicePath, 'utf-8');
    expect((content.match(/auditInTx\(/g) ?? []).length).toBe(2);
  });
});
