// X3a / X3b — certificate valid_until: display logic, real-DB select, and the issue-email guard.
// Real-DB block uses a postgres:16-alpine testcontainer with stub parent tables
// (tenants, users, attempts) and the module's own migrations 0046, 0074, 0075, 0272.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import type { PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- mocks for the issue-email guard test (must precede SUT import) -------
const sendMock = vi.fn();
vi.mock('@assessiq/notifications', () => ({ sendCredentialIssuedEmail: (a: unknown) => sendMock(a) }));
vi.mock('@assessiq/tenancy', () => ({
  // Run the after-commit hook immediately so the test sees the enqueue attempt.
  onCommit: (_c: unknown, hook: () => Promise<void>) => { void hook(); return true; },
  withTenant: vi.fn(),
  getCertificateShowDistinction: vi.fn(),
}));
vi.mock('@assessiq/audit-log', () => ({ auditInTx: vi.fn() }));
vi.mock('../repository.js', async () => {
  const actual = await vi.importActual<typeof import('../repository.js')>('../repository.js');
  return { ...actual, findByAttempt: vi.fn(), insertCertificate: vi.fn() };
});

import { expiryState } from '../display.js';
import * as repo from '../repository.js';
import { issueCertificate } from '../service.js';
import { CERT_SIGNING_SECRET_ENV } from '../crypto.js';

const NOW = new Date('2026-10-28T00:00:00Z');

describe('expiryState (pure)', () => {
  it('NULL shows nothing', () => {
    expect(expiryState(null, NOW)).toEqual({ kind: 'none' });
    expect(expiryState(undefined, NOW)).toEqual({ kind: 'none' });
  });
  it('future date is "until"', () => {
    expect(expiryState('2027-01-02T10:00:00Z', NOW)).toEqual({ kind: 'until', date: '2027-01-02' });
  });
  it('past date is "expired"', () => {
    expect(expiryState('2026-10-01T00:00:00Z', NOW)).toEqual({ kind: 'expired', date: '2026-10-01' });
  });
  it('unreadable date shows nothing', () => {
    expect(expiryState('not a date', NOW)).toEqual({ kind: 'none' });
  });
});

describe('issueCertificate - credential email', () => {
  const input = {
    tenant_id: '00000000-0000-0000-0000-0000000000a1',
    attempt_id: '00000000-0000-0000-0000-0000000000a2',
    candidate_id: '00000000-0000-0000-0000-0000000000a3',
    template_key: 'standard', display_name: 'Asha', course_title: 'SOC L1', level: 'L1',
    tier: 'completion' as const, actor_user_id: null,
  };
  const row = { ...input, id: 'x', credential_id: 'AIQ-2026-10-ABC123', tier: 'completion', valid_until: null };
  const client = { query: vi.fn(async () => ({ rows: [{ xid: '1' }] })) } as unknown as PoolClient;

  beforeAll(() => { process.env[CERT_SIGNING_SECRET_ENV] = 'test-secret-test-secret-test-secret'; });

  it('issuance still succeeds when the email enqueue throws', async () => {
    sendMock.mockReset().mockRejectedValue(new Error('redis down'));
    vi.mocked(repo.findByAttempt).mockResolvedValue(null);
    vi.mocked(repo.insertCertificate).mockResolvedValue(row as never);
    const cert = await issueCertificate(client, input);
    expect(cert.credential_id).toBe('AIQ-2026-10-ABC123');
    await new Promise((r) => setTimeout(r, 0));
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('idempotent re-hit sends no email', async () => {
    sendMock.mockReset();
    vi.mocked(repo.findByAttempt).mockResolvedValue(row as never);
    await issueCertificate(client, input);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('certificates.valid_until (real Postgres)', () => {
  let container: StartedTestContainer | undefined;
  let db: Client;
  const T = '00000000-0000-0000-0000-0000000000b1';
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'aiq_test' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(60_000)
      .start();
    db = new Client({ connectionString: `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test` });
    await db.connect();
    await db.query(`CREATE TABLE tenants (id uuid PRIMARY KEY);
                    CREATE TABLE users (id uuid PRIMARY KEY);
                    CREATE TABLE attempts (id uuid PRIMARY KEY);`);
    for (const f of ['0046_certification_init.sql', '0074_public_verify_policy.sql', '0075_tenant_isolation_null_safe_cast.sql', '0272_certificate_valid_until.sql']) {
      await db.query(await readFile(join(dir, f), 'utf8'));
    }
    await db.query('INSERT INTO tenants VALUES ($1)', [T]);
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  async function insert(credId: string, validUntil: string | null): Promise<void> {
    const a = (await db.query('INSERT INTO attempts VALUES (gen_random_uuid()) RETURNING id')).rows[0].id;
    await db.query(
      `INSERT INTO certificates (tenant_id, attempt_id, template_key, credential_id, tier, display_name, course_title, level, signed_hash, valid_until)
       VALUES ($1,$2,'standard',$3,'completion','A','C','L1','h',$4)`,
      [T, a, credId, validUntil],
    );
  }

  it('migration adds a nullable timestamptz column and is re-runnable', async () => {
    const col = await db.query(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name='certificates' AND column_name='valid_until'",
    );
    expect(col.rows[0]).toEqual({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
    await db.query(await readFile(join(dir, '0272_certificate_valid_until.sql'), 'utf8'));
  });

  it('repository select returns valid_until when set and null when not', async () => {
    await insert('AIQ-2026-10-SET111', '2027-03-04T05:06:07Z');
    await insert('AIQ-2026-10-NUL111', null);
    const set = await repo.findByCredentialId(db as unknown as PoolClient, 'AIQ-2026-10-SET111', T);
    const nul = await repo.findByCredentialId(db as unknown as PoolClient, 'AIQ-2026-10-NUL111', T);
    expect(set?.valid_until).toBe('2027-03-04T05:06:07Z');
    expect(nul?.valid_until).toBeNull();
  });
});
