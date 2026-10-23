/**
 * EXP-37 — the super-admin notice for a blocked invite.
 * Real Postgres for the in-app rows (written with withSystemRole under the platform tenant); an in-memory
 * stand-in for the Redis SET NX EX key; sendEmail mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { applyAllMigrations } from '../../../../tools/test-support/apply-all-migrations.js';

const { sendEmail, redisSet } = vi.hoisted(() => ({ sendEmail: vi.fn(), redisSet: vi.fn() }));
vi.mock('../email/index.js', () => ({ sendEmail }));
vi.mock('@assessiq/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRedis: () => ({ set: redisSet }),
}));

import { config } from '@assessiq/core';
import { setPoolForTesting, closePool } from '@assessiq/tenancy';
import { notifyInviteLimitBlocked, type InviteLimitBlockedInput } from '../invite-limit-notice.js';

let container: StartedTestContainer;
let url: string;
let activeSuperAdmins = 0;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const inAppRows = () =>
  sup((c) => c.query(`SELECT user_id::text, audience, kind, message FROM in_app_notifications WHERE kind = 'invite_limit_blocked'`)).then((r) => r.rows);

const tenantId = randomUUID();
const assessmentId = randomUUID();
const input = (over: Partial<InviteLimitBlockedInput> = {}): InviteLimitBlockedInput => ({
  tenantId,
  assessmentId,
  orgName: 'Org One',
  adminName: 'Ada Admin',
  adminEmail: 'ada@org.test',
  assessmentName: 'Big Exam',
  tried: 151,
  limit: 150,
  ...over,
});

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'aiq_invnotice' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_invnotice`;
  await sup(async (c) => {
    await applyAllMigrations(c);
    await c.query('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app');
    await c.query('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_system');
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES
         ($1, $3, 'sa-active@x.test', 'SA Active', 'super_admin', 'active'),
         ($2, $3, 'sa-off@x.test', 'SA Off', 'super_admin', 'disabled')`,
      [randomUUID(), randomUUID(), config.PLATFORM_TENANT_ID],
    );
    activeSuperAdmins = parseInt(
      (await c.query(`SELECT count(*) AS n FROM users WHERE tenant_id = $1 AND role = 'super_admin' AND status = 'active'`, [config.PLATFORM_TENANT_ID])).rows[0].n,
      10,
    );
  });
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue(undefined);
  redisSet.mockReset();
});

describe('notifyInviteLimitBlocked', () => {
  it('first call per (tenant, assessment, day): one in-app row per active super admin and one email per address', async () => {
    redisSet.mockResolvedValueOnce('OK');
    const before = (await inAppRows()).length;
    expect(await notifyInviteLimitBlocked(input())).toBe(true);

    const rows = (await inAppRows()).slice(before);
    expect(activeSuperAdmins).toBeGreaterThan(0);
    expect(rows).toHaveLength(activeSuperAdmins);
    expect(rows[0]!.audience).toBe('user');
    expect(rows[0]!.message).toContain('Org One');
    expect(rows[0]!.message).toContain('Ada Admin');
    expect(rows[0]!.message).toContain('Big Exam');
    expect(rows[0]!.message).toContain('151');
    expect(rows[0]!.message).toContain('150');

    const recipients = new Set(config.SUPER_ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
    expect(sendEmail).toHaveBeenCalledTimes(recipients.size);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({
      template: 'invite_limit_blocked',
      tenantId: config.PLATFORM_TENANT_ID,
      vars: { orgName: 'Org One', adminName: 'Ada Admin', adminEmail: 'ada@org.test', assessmentName: 'Big Exam', tried: 151, limit: 150 },
    });
    const [key, , mode, ttl, nx] = redisSet.mock.calls[0]!;
    expect(key).toBe(`aiq:invite_limit_notice:${tenantId}:${assessmentId}:${new Date().toISOString().slice(0, 10)}`);
    expect([mode, ttl, nx]).toEqual(['EX', 86400, 'NX']);
  });

  it('a second call the same day (key already set) sends nothing', async () => {
    redisSet.mockResolvedValueOnce(null);
    const before = (await inAppRows()).length;
    expect(await notifyInviteLimitBlocked(input())).toBe(false);
    expect((await inAppRows()).length).toBe(before);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never throws: Redis down, or an email failure, resolve without an error', async () => {
    redisSet.mockRejectedValueOnce(new Error('redis down'));
    await expect(notifyInviteLimitBlocked(input())).resolves.toBe(false);

    redisSet.mockResolvedValueOnce('OK');
    sendEmail.mockRejectedValue(new Error('smtp down'));
    await expect(notifyInviteLimitBlocked(input())).resolves.toBe(true);
  });
});
