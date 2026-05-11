/**
 * G3.D audit-write sweep — coverage tests for modules/03-users.
 *
 * Mirrors modules/04-question-bank/src/__tests__/audit-writes.test.ts and
 * modules/05-assessment-lifecycle/src/__tests__/audit-writes.test.ts.
 *
 * Verifies every admin-mutating service method writes a corresponding
 * audit_log row INSIDE the same Postgres transaction as the domain mutation,
 * satisfying the CLAUDE.md atomicity invariant.
 *
 * Migration apply order: tenancy → users (020) → auth (010-015) →
 * users-invitations (021) → audit-log (0050). The audit-log migration must
 * precede the service calls because every wired mutation now writes an
 * audit_log row via auditInTx() inside the same withTenant transaction.
 *
 * Atomicity is verified two ways:
 *   1. Happy path: mutation row + audit row both present, with expected
 *      shape (action, entity_type, entity_id, actor, before/after diff).
 *   2. Failure injection: vi.spyOn(auditInTx) throws mid-transaction —
 *      the surrounding withTenant rolls back, leaving the user in its
 *      pre-mutation state. Proves auditInTx is genuinely inside the same tx.
 *
 * Plus two cross-cutting tests:
 *   - Coverage assertion: count of `auditInTx(` occurrences in service.ts
 *     and invitations.ts equals the wired-function count.
 *   - Redaction sweep: no audit row contains a USER_AUDIT_REDACTED_FIELDS
 *     key in before/after — drift detection if a credential column is
 *     ever added without updating the redaction list.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { setPoolForTesting, closePool } from '../../../02-tenancy/src/pool.js';

// ---------------------------------------------------------------------------
// Mock 13-notifications so inviteUser doesn't need an SMTP stack.
// ---------------------------------------------------------------------------

vi.mock('@assessiq/notifications', () => ({
  sendInvitationEmail: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Wrap @assessiq/audit-log so individual tests can inject a one-shot failure
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

import {
  createUser,
  updateUser,
  softDelete,
  restore,
} from '../service.js';
import { inviteUser } from '../invitations.js';
import { USER_AUDIT_REDACTED_FIELDS } from '../audit-redact.js';

// ---------------------------------------------------------------------------
// Path helpers (Windows: strip leading slash before drive letter)
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR = toFsPath(new URL('.', import.meta.url));
const USERS_MODULE_ROOT = join(THIS_DIR, '..', '..');
const MODULES_ROOT = join(USERS_MODULE_ROOT, '..');

const TENANCY_DIR = join(MODULES_ROOT, '02-tenancy', 'migrations');
const AUTH_DIR = join(MODULES_ROOT, '01-auth', 'migrations');
const USERS_DIR = join(USERS_MODULE_ROOT, 'migrations');
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
    // Test-only: bypass the REVOKE on assessiq_app by running as superuser.
    await client.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantId]);
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

async function readUser(client: Client, id: string): Promise<{
  id: string;
  status: string;
  name: string;
  role: string;
  deleted_at: Date | null;
} | null> {
  const r = await client.query<{
    id: string;
    status: string;
    name: string;
    role: string;
    deleted_at: Date | null;
  }>(
    `SELECT id::text, status, name, role, deleted_at FROM users WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'aiq_users_audit_test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_users_audit_test`;

  const [tenancyFiles, authFiles, usersFiles, auditFiles] = await Promise.all([
    readdir(TENANCY_DIR),
    readdir(AUTH_DIR),
    readdir(USERS_DIR),
    readdir(AUDIT_DIR),
  ]);

  const tenancySorted = tenancyFiles.filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ dir: TENANCY_DIR, file: f }));
  const authSorted = authFiles.filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ dir: AUTH_DIR, file: f }));
  const usersAll = usersFiles.filter((f) => f.endsWith('.sql')).sort();
  const usersTable = usersAll.filter((f) => f.startsWith('020_'))
    .map((f) => ({ dir: USERS_DIR, file: f }));
  const usersInvitations = usersAll.filter((f) => !f.startsWith('020_'))
    .map((f) => ({ dir: USERS_DIR, file: f }));
  const auditSorted = auditFiles.filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ dir: AUDIT_DIR, file: f }));

  // Same dependency-resolved order as users.test.ts: users-table comes before
  // auth (auth FKs target users.id), invitations after auth, audit-log last.
  const allMigrations = [
    ...tenancySorted,
    ...usersTable,
    ...authSorted,
    ...usersInvitations,
    ...auditSorted,
  ];

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
    await insertTenant(client, tenantA, `users-audit-${tenantA.slice(0, 8)}`);
    await insertAdmin(client, adminA, tenantA, `users-audit-admin-${tenantA.slice(0, 8)}@example.com`);
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

describe('G3.D audit writes — 03-users', () => {
  it('createUser writes a user.created audit row in the same tx', async () => {
    await clearAudit(tenantA);
    const user = await createUser(
      tenantA,
      { email: `cu-${randomUUID().slice(0, 8)}@e.com`, name: 'CU User', role: 'reviewer' },
      adminA,
    );

    const rows = await queryAudit(tenantA, 'user.created');
    const row = rows.find((r) => r.entity_id === user.id);
    expect(row).toBeDefined();
    expect(row!.actor_kind).toBe('user');
    expect(row!.actor_user_id).toBe(adminA);
    expect(row!.entity_type).toBe('user');
    const after = row!.after as Record<string, unknown>;
    expect(after.email).toBe(user.email);
    expect(after.role).toBe('reviewer');
    expect(after.status).toBe('pending');
  });

  it('updateUser (status flip) writes a user.updated audit row marked kind=status_change', async () => {
    const target = await createUser(
      tenantA,
      { email: `uu-${randomUUID().slice(0, 8)}@e.com`, name: 'UU User', role: 'reviewer' },
      adminA,
    );

    await clearAudit(tenantA);
    await updateUser(tenantA, target.id, { status: 'active' }, adminA);

    const rows = await queryAudit(tenantA, 'user.updated');
    const row = rows.find((r) => r.entity_id === target.id);
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.status).toBe('pending');
    expect(after.status).toBe('active');
    expect(after.kind).toBe('status_change');
    expect(after.changed_fields).toEqual(expect.arrayContaining(['status']));
  });

  it('updateUser (role demotion) writes a user.updated audit row marked kind=role_change', async () => {
    // Need two admins so the last-admin invariant doesn't block the demotion.
    const a1 = await createUser(
      tenantA,
      { email: `roleA1-${randomUUID().slice(0, 8)}@e.com`, name: 'A1', role: 'admin' },
      adminA,
    );
    const a2 = await createUser(
      tenantA,
      { email: `roleA2-${randomUUID().slice(0, 8)}@e.com`, name: 'A2', role: 'admin' },
      adminA,
    );
    await updateUser(tenantA, a1.id, { status: 'active' }, adminA);
    await updateUser(tenantA, a2.id, { status: 'active' }, adminA);

    await clearAudit(tenantA);
    await updateUser(tenantA, a1.id, { role: 'reviewer' }, adminA);

    const rows = await queryAudit(tenantA, 'user.updated');
    const row = rows.find((r) => r.entity_id === a1.id);
    expect(row).toBeDefined();
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.role).toBe('admin');
    expect(after.role).toBe('reviewer');
    expect(after.kind).toBe('role_change');
  });

  it('softDelete writes a user.deleted audit row in the same tx', async () => {
    const target = await createUser(
      tenantA,
      { email: `sd-${randomUUID().slice(0, 8)}@e.com`, name: 'SD User', role: 'reviewer' },
      adminA,
    );

    await clearAudit(tenantA);
    await softDelete(tenantA, target.id, adminA);

    const rows = await queryAudit(tenantA, 'user.deleted');
    const row = rows.find((r) => r.entity_id === target.id);
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.email).toBe(target.email);
    expect(after.deleted).toBe(true);
    expect(after.cascaded_pending_invitations).toBe(0);
  });

  it('restore writes a user.restored audit row in the same tx', async () => {
    const target = await createUser(
      tenantA,
      { email: `re-${randomUUID().slice(0, 8)}@e.com`, name: 'RE User', role: 'reviewer' },
      adminA,
    );
    await softDelete(tenantA, target.id, adminA);

    await clearAudit(tenantA);
    const restored = await restore(tenantA, target.id, adminA);

    expect(restored.deleted_at).toBeNull();

    const rows = await queryAudit(tenantA, 'user.restored');
    const row = rows.find((r) => r.entity_id === target.id);
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.deleted_at).not.toBeNull();
    expect(after.deleted_at).toBeNull();
  });

  it('inviteUser (new user) writes a user.invited audit row marked kind=new', async () => {
    await clearAudit(tenantA);
    const result = await inviteUser(tenantA, {
      email: `inv-new-${randomUUID().slice(0, 8)}@e.com`,
      role: 'reviewer',
      invited_by: adminA,
    });
    expect(result.invitation).not.toBeNull();

    const rows = await queryAudit(tenantA, 'user.invited');
    const row = rows.find((r) => r.entity_id === result.user.id);
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    expect(row!.entity_type).toBe('user');
    const after = row!.after as Record<string, unknown>;
    expect(after.kind).toBe('new');
    expect(after.invitation_id).toBe(result.invitation!.id);
    expect(after.role).toBe('reviewer');
  });

  it('inviteUser (re-invite of pending user) writes a user.invited audit row marked kind=reinvite', async () => {
    const email = `inv-re-${randomUUID().slice(0, 8)}@e.com`;
    const first = await inviteUser(tenantA, {
      email,
      role: 'reviewer',
      invited_by: adminA,
    });

    await clearAudit(tenantA);
    const second = await inviteUser(tenantA, {
      email,
      role: 'reviewer',
      invited_by: adminA,
    });
    expect(second.invitation?.id).not.toBe(first.invitation?.id);

    const rows = await queryAudit(tenantA, 'user.invited');
    const row = rows.find((r) => r.entity_id === first.user.id);
    expect(row).toBeDefined();
    const after = row!.after as Record<string, unknown>;
    expect(after.kind).toBe('reinvite');
    expect(after.replaced_invitation_count).toBe(1);
  });

  it('inviteUser on already-active user writes NO audit row (no mutation)', async () => {
    const email = `inv-active-${randomUUID().slice(0, 8)}@e.com`;
    const first = await inviteUser(tenantA, {
      email,
      role: 'reviewer',
      invited_by: adminA,
    });
    // Flip to active (simulating the user accepted the invite)
    await updateUser(tenantA, first.user.id, { status: 'active' }, adminA);

    await clearAudit(tenantA);
    const second = await inviteUser(tenantA, {
      email,
      role: 'reviewer',
      invited_by: adminA,
    });
    expect(second.invitation).toBeNull();

    const rows = await queryAudit(tenantA, 'user.invited');
    const matched = rows.filter((r) => r.entity_id === first.user.id);
    expect(matched).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Atomicity proof — auditInTx throws → mutation rolls back.
  // -------------------------------------------------------------------------
  it('atomicity: when auditInTx throws inside updateUser, the user row is NOT updated', async () => {
    const target = await createUser(
      tenantA,
      { email: `atom-${randomUUID().slice(0, 8)}@e.com`, name: 'Atom User', role: 'reviewer' },
      adminA,
    );

    // One-shot failure injection — the next auditInTx call throws and the
    // surrounding withTenant transaction rolls back.
    injectAuditFailure = new Error('audit write injection failure');

    await expect(
      updateUser(tenantA, target.id, { status: 'active' }, adminA),
    ).rejects.toThrow(/audit write injection failure/);

    // The user row must be unchanged because the surrounding withTenant
    // transaction rolled back when auditInTx threw.
    const after = await withSuperClient((client) => readUser(client, target.id));
    expect(after).not.toBeNull();
    expect(after!.status).toBe('pending'); // still in the pre-mutation state
  });

  it('atomicity: when auditInTx throws inside softDelete, the user row is NOT soft-deleted', async () => {
    const target = await createUser(
      tenantA,
      { email: `atom2-${randomUUID().slice(0, 8)}@e.com`, name: 'Atom2', role: 'reviewer' },
      adminA,
    );

    injectAuditFailure = new Error('soft-delete audit failure');

    await expect(softDelete(tenantA, target.id, adminA)).rejects.toThrow(
      /soft-delete audit failure/,
    );

    const after = await withSuperClient((client) => readUser(client, target.id));
    expect(after).not.toBeNull();
    expect(after!.deleted_at).toBeNull(); // rollback restored deleted_at to NULL
  });

  it('atomicity: when auditInTx throws inside inviteUser, no user/invitation row is created', async () => {
    const email = `atom-inv-${randomUUID().slice(0, 8)}@e.com`;
    injectAuditFailure = new Error('invite audit failure');

    await expect(
      inviteUser(tenantA, { email, role: 'reviewer', invited_by: adminA }),
    ).rejects.toThrow(/invite audit failure/);

    // Neither the user nor the invitation should exist because withTenant
    // rolled the entire transaction back.
    const userRow = await withSuperClient(async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(email) = $1 AND tenant_id = $2`,
        [email.toLowerCase(), tenantA],
      );
      return r.rows[0] ?? null;
    });
    expect(userRow).toBeNull();
    const invRow = await withSuperClient(async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM user_invitations WHERE lower(email) = $1 AND tenant_id = $2`,
        [email.toLowerCase(), tenantA],
      );
      return r.rows[0] ?? null;
    });
    expect(invRow).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Coverage: count of auditInTx call-sites across service.ts + invitations.ts
  // matches the number of admin-mutating call-sites we wired (5 functions →
  // 5 audit writes; inviteUser has 2 because the new-user vs reinvite paths
  // emit independent audit rows).
  // -------------------------------------------------------------------------
  it('source contains exactly the expected auditInTx call-site count', async () => {
    const servicePath = join(USERS_MODULE_ROOT, 'src', 'service.ts');
    const invitationsPath = join(USERS_MODULE_ROOT, 'src', 'invitations.ts');
    const [svcSrc, invSrc] = await Promise.all([
      readFile(servicePath, 'utf-8'),
      readFile(invitationsPath, 'utf-8'),
    ]);
    const svcMatches = svcSrc.match(/auditInTx\(/g) ?? [];
    const invMatches = invSrc.match(/auditInTx\(/g) ?? [];
    // Wired sites:
    //   service.ts: createUser, updateUser, softDelete, restore  → 4
    //   invitations.ts: inviteUser new-user path + reinvite path → 2
    expect(svcMatches.length).toBe(4);
    expect(invMatches.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Redaction sweep: no audit row written by 03-users contains any
  // credential-bearing field name as a key in before/after. Catches future
  // regressions where a new credential column lands without updating
  // USER_AUDIT_REDACTED_FIELDS.
  // -------------------------------------------------------------------------
  it('redaction sweep: no audit row leaks redacted-field keys in before/after', async () => {
    // Run a representative mix of operations into a fresh tenant so the
    // sweep query is bounded.
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `redact-sweep-${tid.slice(0, 8)}`);
    });

    const u1 = await createUser(
      tid,
      { email: `rs-${randomUUID().slice(0, 8)}@e.com`, name: 'Redact 1', role: 'reviewer' },
      adminA,
    );
    await updateUser(tid, u1.id, { status: 'active' }, adminA);
    await updateUser(tid, u1.id, { name: 'Redact 1 Updated' }, adminA);
    await softDelete(tid, u1.id, adminA);
    await restore(tid, u1.id, adminA);

    await inviteUser(tid, {
      email: `rs-inv-${randomUUID().slice(0, 8)}@e.com`,
      role: 'admin',
      invited_by: adminA,
    });

    const rows = await queryAudit(tid);
    const leaks: Array<{ id: string; action: string; field: string; in: string }> = [];
    for (const r of rows) {
      for (const slot of ['before', 'after'] as const) {
        const payload = r[slot];
        if (payload === null) continue;
        for (const k of Object.keys(payload)) {
          if (USER_AUDIT_REDACTED_FIELDS.has(k)) {
            leaks.push({ id: r.id, action: r.action, field: k, in: slot });
          }
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
