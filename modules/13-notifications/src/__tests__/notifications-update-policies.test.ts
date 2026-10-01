/**
 * Migration 0121 — UPDATE policies on email_log + webhook_deliveries, against a
 * real Postgres with RLS on and the app role (no BYPASSRLS).
 *
 * Before 0121 these UPDATEs matched ZERO rows (0055 / 0058 shipped SELECT and
 * INSERT policies only), so the worker's status writes — email_log queued ->
 * sent|failed, webhook_deliveries pending -> delivered|failed(+last_error such
 * as 'blocked_address') — never persisted. The policies keep tenant isolation:
 * another tenant cannot update the rows, and a row cannot be moved to another
 * tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setPoolForTesting, closePool, withTenant } from '@assessiq/tenancy';
import * as repo from '../repository.js';

const MODULES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIRS: Array<[string, string[] | undefined]> = [
  ['02-tenancy', undefined],
  ['03-users', ['020_users.sql']],
  ['13-notifications', undefined], // includes 0121
];

let container: StartedTestContainer;
let url: string;

const tenantA = randomUUID();
const tenantB = randomUUID();
const emailA = randomUUID();
const endpointA = randomUUID();
const endpointB = randomUUID();
const deliveryA = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
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
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'aiq_notif_update' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_notif_update`;

  await sup(async (c) => {
    await c.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    for (const r of ['assessiq_app', 'assessiq_system']) {
      const bypass = r === 'assessiq_system' ? ' BYPASSRLS' : '';
      await c.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN CREATE ROLE ${r}${bypass}; END IF; END $$;`,
      );
      await c.query(`GRANT ${r} TO test`);
    }
    for (const [mod, only] of DIRS) {
      const dir = join(MODULES_ROOT, mod, 'migrations');
      const files = (await readdir(dir))
        .filter((f) => f.endsWith('.sql') && (only === undefined || only.includes(f)))
        .sort();
      for (const f of files) await c.query(await readFile(join(dir, f), 'utf-8'));
    }
    await c.query('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app');

    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'a','A'),($2,'b','B')`, [tenantA, tenantB]);
    await c.query(
      `INSERT INTO email_log (id, tenant_id, to_address, subject, template_id, status)
       VALUES ($1,$2,'a@a.test','s','invitation_candidate','queued')`,
      [emailA, tenantA],
    );
    await c.query(
      `INSERT INTO webhook_endpoints (id, tenant_id, name, url, secret_enc, events)
       VALUES ($1,$2,'a','https://example.com/a','\\x00','{x}'),($3,$4,'b','https://example.com/b','\\x00','{x}')`,
      [endpointA, tenantA, endpointB, tenantB],
    );
    await c.query(`INSERT INTO webhook_deliveries (id, endpoint_id, event, payload) VALUES ($1,$2,'e','{}')`, [
      deliveryA,
      endpointA,
    ]);
  });
  await setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe('0121 UPDATE policies', () => {
  it("another tenant's context cannot update the rows (0 rows / unchanged)", async () => {
    const rows = await withTenant(tenantB, (c) =>
      repo.updateEmailLogStatus(c, emailA, { status: 'failed', lastError: 'x', attempts: 9 }),
    );
    expect(rows).toBe(0);
    await withTenant(tenantB, (c) =>
      repo.updateWebhookDeliveryStatus(c, deliveryA, { status: 'failed', lastError: 'x' }),
    );

    const [email, delivery] = await sup(async (c) => [
      (await c.query('SELECT status FROM email_log WHERE id=$1', [emailA])).rows[0],
      (await c.query('SELECT status, last_error FROM webhook_deliveries WHERE id=$1', [deliveryA])).rows[0],
    ]);
    expect(email).toEqual({ status: 'queued' });
    expect(delivery).toEqual({ status: 'pending', last_error: null });
  });

  it('a row cannot be moved to another tenant (WITH CHECK)', async () => {
    await expect(
      withTenant(tenantA, (c) => c.query('UPDATE email_log SET tenant_id=$1 WHERE id=$2', [tenantB, emailA])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(tenantA, (c) =>
        c.query('UPDATE webhook_deliveries SET endpoint_id=$1 WHERE id=$2', [endpointB, deliveryA]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('the owning tenant\'s status writes persist (what the worker does)', async () => {
    const rows = await withTenant(tenantA, (c) =>
      repo.updateEmailLogStatus(c, emailA, { status: 'failed', lastError: 'SMTP 550 5.1.1', attempts: 1 }),
    );
    expect(rows).toBe(1);
    await withTenant(tenantA, (c) =>
      repo.updateWebhookDeliveryStatus(c, deliveryA, { status: 'failed', lastError: 'blocked_address', attempts: 1 }),
    );

    const [email, delivery] = await sup(async (c) => [
      (await c.query('SELECT status, last_error, attempts FROM email_log WHERE id=$1', [emailA])).rows[0],
      (await c.query('SELECT status, last_error, attempts FROM webhook_deliveries WHERE id=$1', [deliveryA])).rows[0],
    ]);
    expect(email).toEqual({ status: 'failed', last_error: 'SMTP 550 5.1.1', attempts: 1 });
    expect(delivery).toEqual({ status: 'failed', last_error: 'blocked_address', attempts: 1 });
  });
});
