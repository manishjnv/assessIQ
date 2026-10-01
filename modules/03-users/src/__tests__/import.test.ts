/**
 * Bulk candidate CSV import — pure parser unit tests + Postgres integration
 * (tenant isolation, reuse, exactly one PII-free audit row).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { setPoolForTesting, closePool } from '../../../02-tenancy/src/pool.js';

vi.mock('@assessiq/notifications', () => ({
  sendInvitationEmail: vi.fn(async () => undefined),
}));

import { parseCandidateCsv, importCandidates, IMPORT_MAX_ROWS } from '../import.js';

// ---------------------------------------------------------------------------
// Parser unit tests
// ---------------------------------------------------------------------------

describe('parseCandidateCsv', () => {
  it('strips BOM, matches headers case-insensitively, ignores extra columns', () => {
    const r = parseCandidateCsv('﻿EMAIL, Name ,Phone\r\nA@X.com,Ann,123\r\n');
    expect(r.valid).toEqual([{ row: 2, name: 'Ann', email: 'a@x.com' }]);
    expect(r.skipped).toEqual([]);
  });

  it('maps roll_number / branch header aliases (case/space-insensitive) and trims to 64 chars', () => {
    const r = parseCandidateCsv(
      `Name,Email,Roll No,Department
A,a@x.com, 21CS001 ,CSE
B,b@x.com,,
C,c@x.com,${'9'.repeat(80)},x`,
    );
    expect(r.valid[0]).toEqual({ row: 2, name: 'A', email: 'a@x.com', rollNumber: '21CS001', branch: 'CSE' });
    expect(r.valid[1]).toEqual({ row: 3, name: 'B', email: 'b@x.com' });
    expect(r.valid[2]!.rollNumber).toHaveLength(64);
    for (const h of ['roll_number', 'roll', 'enrollment', 'ROLL NUMBER']) {
      expect(parseCandidateCsv(`name,email,${h}
A,a@x.com,7`).valid[0]!.rollNumber).toBe('7');
    }
    for (const h of ['branch', 'dept', 'Department']) {
      expect(parseCandidateCsv(`name,email,${h}
A,a@x.com,ECE`).valid[0]!.branch).toBe('ECE');
    }
  });

  it('handles quotes, commas, escaped quotes and newlines inside names', () => {
    const r = parseCandidateCsv('name,email\n"Doe, Jane ""JD""",jane@x.com\n"Multi\nLine",m@x.com');
    // Whitespace (incl. embedded newlines) collapses to one space.
    expect(r.valid.map((v) => v.name)).toEqual(['Doe, Jane "JD"', 'Multi Line']);
  });

  it('dedupes within the file (first wins) and reports bad rows with row numbers', () => {
    const r = parseCandidateCsv(
      'name,email\nA,a@x.com\nB,A@X.COM\nC,not-an-email\n,d@x.com\n\nE,e@x.com',
    );
    expect(r.valid.map((v) => v.email)).toEqual(['a@x.com', 'e@x.com']);
    expect(r.skipped).toEqual([
      { row: 3, email: 'a@x.com', reason: 'DUPLICATE_IN_FILE' },
      { row: 4, email: 'not-an-email', reason: 'INVALID_EMAIL' },
      { row: 5, email: 'd@x.com', reason: 'MISSING_NAME' },
    ]);
    expect(r.totalRows).toBe(5);
  });

  it('rejects a missing header column, too many rows, oversize input, unterminated quote', () => {
    expect(() => parseCandidateCsv('name,mail\na,b@x.com')).toThrow(/header/);
    const many =
      'name,email\n' +
      Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `n${i},u${i}@x.com`).join('\n');
    expect(() => parseCandidateCsv(many)).toThrow(/1000/);
    expect(() => parseCandidateCsv('name,email\n' + 'x'.repeat(600 * 1024))).toThrow(/KB/);
    expect(() => parseCandidateCsv('name,email\n"a,b@x.com')).toThrow(/unterminated/);
  });

  it('accepts exactly the row cap', () => {
    const csv =
      'name,email\n' +
      Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => `n${i},u${i}@x.com`).join('\n');
    expect(parseCandidateCsv(csv).valid).toHaveLength(IMPORT_MAX_ROWS);
  });
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}
const USERS_ROOT = join(toFsPath(new URL('.', import.meta.url)), '..', '..');
const MODULES_ROOT = join(USERS_ROOT, '..');

let container: StartedTestContainer;
let url: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;

async function su<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'aiq_import_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_import_test`;

  const sqls = async (mod: string, pick: (f: string) => boolean = () => true) => {
    const dir = join(MODULES_ROOT, mod, 'migrations');
    return (await readdir(dir))
      .filter((f) => f.endsWith('.sql') && pick(f))
      .sort()
      .map((f) => join(dir, f));
  };
  const files = [
    ...(await sqls('02-tenancy')),
    ...(await sqls('03-users', (f) => f.startsWith('020_'))),
    ...(await sqls('01-auth')),
    ...(await sqls('03-users', (f) => !f.startsWith('020_'))),
    ...(await sqls('14-audit-log')),
  ];

  await su(async (c) => {
    for (const r of ['assessiq_app', 'assessiq_system']) {
      await c.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN CREATE ROLE ${r}${r === 'assessiq_system' ? ' BYPASSRLS' : ''}; END IF; END $$;`,
      );
      await c.query(`GRANT ${r} TO test`);
    }
    for (const f of files) await c.query(await readFile(f, 'utf-8'));
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(url);

  tenantA = randomUUID();
  tenantB = randomUUID();
  adminA = randomUUID();
  adminB = randomUUID();
  await su(async (c) => {
    for (const [t, a, s] of [
      [tenantA, adminA, 'a'],
      [tenantB, adminB, 'b'],
    ] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)`, [t, `imp-${s}-${t.slice(0, 6)}`, `T ${s}`]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [t]);
      await c.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`,
        [a, t, `admin-${s}@example.com`],
      );
    }
    // Same email exists as a candidate in tenant B (must not leak into / block A).
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'shared@example.com','Other','candidate','active')`,
      [randomUUID(), tenantB],
    );
    // Existing candidate in A.
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'known@example.com','Known','candidate','active')`,
      [randomUUID(), tenantA],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe('importCandidates', () => {
  it('creates in the admin tenant only, reuses existing, skips non-candidates, one PII-free audit row', async () => {
    const csv = [
      'name,email',
      'Shared Person,shared@example.com',
      'Known Person,KNOWN@example.com',
      'Boss,admin-a@example.com',
      'Bad,nope',
      'New One,new1@example.com',
    ].join('\n');

    const r = await importCandidates(tenantA, csv, adminA);
    expect(r.created).toBe(2); // shared@ (new in A) + new1@
    expect(r.existing).toBe(1);
    expect(r.candidates).toHaveLength(3);
    expect(r.skipped).toEqual([
      { row: 4, email: 'admin-a@example.com', reason: 'EXISTING_USER_NOT_CANDIDATE' },
      { row: 5, email: 'nope', reason: 'INVALID_EMAIL' },
    ]);

    await su(async (c) => {
      const a = await c.query(
        `SELECT email FROM users WHERE tenant_id=$1 AND role='candidate' ORDER BY email`,
        [tenantA],
      );
      expect(a.rows.map((x) => x.email)).toEqual([
        'known@example.com',
        'new1@example.com',
        'shared@example.com',
      ]);
      const b = await c.query(`SELECT email FROM users WHERE tenant_id=$1 AND role='candidate'`, [tenantB]);
      expect(b.rows.map((x) => x.email)).toEqual(['shared@example.com']);

      const audit = await c.query(
        `SELECT action, actor_user_id::text AS actor, before, after FROM audit_log WHERE tenant_id=$1`,
        [tenantA],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor).toBe(adminA);
      expect(audit.rows[0].after).toEqual({
        kind: 'bulk_import',
        rows_total: 5,
        created: 2,
        existing: 1,
        skipped: 2,
      });
      expect(JSON.stringify(audit.rows[0])).not.toMatch(/@|Person|Boss/);
      const audB = await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1`, [tenantB]);
      expect(audB.rows[0].n).toBe(0);
    });
  });

  it('re-run is all-existing and still writes exactly one audit row per request', async () => {
    const count = () =>
      su((c) => c.query(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1`, [tenantA]));
    const before = (await count()).rows[0].n as number;
    const r = await importCandidates(tenantA, 'name,email\nNew One,new1@example.com', adminA);
    expect(r.created).toBe(0);
    expect(r.existing).toBe(1);
    expect((await count()).rows[0].n).toBe(before + 1);
  });
});

describe('importCandidates roll_number / branch', () => {
  it('persists on create and updates existing only for non-empty cells', async () => {
    const meta = async (email: string) =>
      su(async (c) => (await c.query(`SELECT metadata FROM users WHERE tenant_id=$1 AND email=$2`, [tenantA, email])).rows[0]!.metadata);

    await importCandidates(tenantA, `name,email,roll,dept
Roll One,roll1@example.com,21CS001,CSE
`, adminA);
    expect(await meta('roll1@example.com')).toEqual({ roll_number: '21CS001', branch: 'CSE' });

    // Re-import: empty branch cell keeps CSE; new roll overwrites.
    const r = await importCandidates(tenantA, `name,email,roll_number,branch
Roll One,roll1@example.com,21CS999,
`, adminA);
    expect(r.existing).toBe(1);
    expect(await meta('roll1@example.com')).toEqual({ roll_number: '21CS999', branch: 'CSE' });

    // Plain name,email import on an existing student changes nothing.
    await importCandidates(tenantA, `name,email
Roll One,roll1@example.com
`, adminA);
    expect(await meta('roll1@example.com')).toEqual({ roll_number: '21CS999', branch: 'CSE' });
  });
});
