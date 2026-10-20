/**
 * Z-71 / Z-81: the three PUBLIC sign-up routes, end to end with the real modules
 * (auth chain, rate limit, billing plan step, taxonomy seed). Live Postgres + Redis.
 * Only the mailer and the Turnstile HTTP call are mocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { AppError, config } from '@assessiq/core';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const { sent } = vi.hoisted(() => ({ sent: [] as Array<{ to: string; template: string; vars: Record<string, unknown> }> }));
vi.mock('@assessiq/notifications', async (orig) => ({
  ...(await orig<typeof import('@assessiq/notifications')>()),
  sendEmail: vi.fn(async (i: (typeof sent)[number]) => {
    sent.push(i);
  }),
  handleAuditFanout: vi.fn(async () => undefined),
}));

import { setPoolForTesting, closePool } from '@assessiq/tenancy';
import { setRedisForTesting, closeRedis, sessions } from '@assessiq/auth';
import { registerPublicSignupRoutes } from '../../routes/public-signup.js';

const cfg = config as unknown as Record<string, unknown>;
const ORIGINAL = { ...cfg };
const HOST = 'signup.assessiq.test';
const PLATFORM = '00000000-0000-7000-0000-000000000001';


// apps/api cannot import tools/test-support (tsconfig rootDir), so the apply-all logic is repeated:
// roles first, then every modules/*/migrations/*.sql in fresh-DB dependency order (same sort key
// as tools/test-support/apply-all-migrations.ts), then the seeds.
const MODULES = resolve(__dirname, '../../../../../modules');
const sortKey = (f: string): [number, number, string] => {
  const name = basename(f);
  const prefix = name.split('_')[0]!;
  const n = parseInt(prefix, 10);
  return [n <= 4 ? 0 : prefix.length === 3 ? (n >= 20 ? 1 : 2) : 3, n, name];
};
async function sqlFiles(dirName: string): Promise<string[]> {
  const out: string[] = [];
  for (const m of await readdir(MODULES, { withFileTypes: true })) {
    if (!m.isDirectory() || m.name === 'node_modules') continue;
    const dir = join(MODULES, m.name, dirName);
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const e of entries) if (e.endsWith('.sql')) out.push(join(dir, e));
  }
  return out;
}
async function applyAllMigrations(client: Client): Promise<void> {
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_app') THEN CREATE ROLE assessiq_app; END IF; END $$;`);
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_system') THEN CREATE ROLE assessiq_system BYPASSRLS; END IF; END $$;`);
  await client.query(`GRANT assessiq_app TO CURRENT_USER`);
  await client.query(`GRANT assessiq_system TO CURRENT_USER`);
  const migrations = (await sqlFiles('migrations')).sort((a, b) => {
    const [ga, na, sa] = sortKey(a);
    const [gb, nb, sb] = sortKey(b);
    return ga - gb || na - nb || sa.localeCompare(sb);
  });
  for (const f of migrations) await client.query(await readFile(f, 'utf8'));
  for (const f of (await sqlFiles('seeds')).sort((a, b) => basename(a).localeCompare(basename(b)))) {
    await client.query(await readFile(f, 'utf8'));
  }
}

let pg: StartedTestContainer;
let rd: StartedTestContainer;
let db: Client;
let app: FastifyInstance;
let ipN = 0;
let tokN = 0;
let packId: string;
let contentUser: string;

vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, action: 'signup-request', hostname: HOST }) })));

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  orgName: 'Route Test Academy',
  adminName: 'Ravi Kumar',
  email: `route-${randomUUID().slice(0, 8)}@school.test`,
  turnstileToken: `tok-${++tokN}`,
  dpaAccepted: true,
  dpaVersion: '1.0',
  termsAccepted: true,
  termsVersion: '1.0',
  ...over,
});
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${(++ipN % 250) + 1}`, ...headers },
    payload: payload as Record<string, unknown>,
  });
const codeFor = (email: string): string => {
  const m = [...sent].reverse().find((s) => s.to === email && s.template === 'signup_code');
  if (!m) throw new Error('no code mail');
  return m.vars['code'] as string;
};
const count = async (sql: string, args: unknown[] = []): Promise<number> => Number((await db.query(sql, args)).rows[0].n);

beforeAll(async () => {
  [pg, rd] = await Promise.all([
    new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'aiq_test' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(60_000)
      .start(),
    new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(60_000)
      .start(),
  ]);
  const url = `postgres://test:test@${pg.getHost()}:${pg.getMappedPort(5432)}/aiq_test`;
  db = new Client({ connectionString: url });
  await db.connect();
  await applyAllMigrations(db);
  await db.query(`INSERT INTO tenants (id, slug, name, status) VALUES ($1,'platform','AssessIQ Platform','active') ON CONFLICT DO NOTHING`, [PLATFORM]);
  await db.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [PLATFORM]);
  const u = randomUUID();
  await db.query(`INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1,$2,'content@platform.test','C','admin')`, [u, PLATFORM]);
  contentUser = u;
  packId = randomUUID();
  await db.query(
    `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, version, created_by)
     VALUES ($1,$2,'campus-placement-aptitude','Aptitude','aptitude','published',1,$3)`,
    [packId, PLATFORM, u],
  );
  await setPoolForTesting(url);
  await setRedisForTesting(`redis://${rd.getHost()}:${rd.getMappedPort(6379)}`);

  app = Fastify();
  await app.register(cookie);
  // The real server's request-id hook creates this per-request context (syncCtx writes into it).
  app.addHook('onRequest', async (req) => {
    (req as unknown as { assessiqCtx: Record<string, unknown> }).assessiqCtx = {};
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      void reply.code(err.status).send({ error: err.toJson() });
      return;
    }
    void reply.code(500).send({ error: { code: 'INTERNAL', message: String((err as Error).message) } });
  });
  await registerPublicSignupRoutes(app);
  await app.ready();
}, 150_000);

afterAll(async () => {
  Object.assign(cfg, ORIGINAL);
  await app?.close();
  await closePool();
  await closeRedis();
  await db?.end();
  await Promise.all([pg?.stop(), rd?.stop()]);
});

beforeEach(() => {
  Object.assign(cfg, ORIGINAL, {
    PLAN_TIERS_ENFORCED: true,
    SIGNUP_ENABLED: true,
    TURNSTILE_SECRET: 'secret',
    TURNSTILE_SITE_KEY: 'site-key',
    SIGNUP_TURNSTILE_HOSTNAMES: [HOST],
    MFA_REQUIRED: false,
    PLATFORM_TENANT_ID: PLATFORM,
    SUPER_ADMIN_EMAILS: 'boss@platform.test',
  });
  sent.length = 0;
});

describe('gating: 404 unless every precondition holds', () => {
  it('config answers open:false; request and verify answer 404 NOT_FOUND (flags off, keys missing)', async () => {
    for (const patch of [
      { PLAN_TIERS_ENFORCED: false },
      { SIGNUP_ENABLED: false },
      { TURNSTILE_SECRET: undefined },
      { TURNSTILE_SITE_KEY: undefined },
    ]) {
      Object.assign(cfg, patch);
      const c = await app.inject({ method: 'GET', url: '/api/public/signup/config' });
      expect(c.statusCode).toBe(200);
      expect(c.json()).toEqual({ open: false, turnstileSiteKey: null, dpaVersion: '1.0' });
      const r = await post('/api/public/signup/request', body());
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('NOT_FOUND');
      const v = await post('/api/public/signup/verify', { email: 'a@b.test', code: '123456' });
      expect(v.statusCode).toBe(404);
      expect(sent).toHaveLength(0);
      Object.assign(cfg, { PLAN_TIERS_ENFORCED: true, SIGNUP_ENABLED: true, TURNSTILE_SECRET: 'secret', TURNSTILE_SITE_KEY: 'site-key' });
    }
  });

  it('config when open', async () => {
    const c = await app.inject({ method: 'GET', url: '/api/public/signup/config' });
    expect(c.json()).toEqual({ open: true, turnstileSiteKey: 'site-key', dpaVersion: '1.0' });
  });
});

describe('request validation (400, nothing sent)', () => {
  it.each([
    ['dpaAccepted missing', { dpaAccepted: undefined }, 'DPA_NOT_ACCEPTED'],
    ['dpaAccepted false', { dpaAccepted: false }, 'DPA_NOT_ACCEPTED'],
    ['dpaAccepted a string', { dpaAccepted: 'true' }, 'DPA_NOT_ACCEPTED'],
    ['dpaVersion missing', { dpaVersion: undefined }, 'DPA_VERSION_MISMATCH'],
    ['dpaVersion wrong', { dpaVersion: '0.9' }, 'DPA_VERSION_MISMATCH'],
    ['org name too short', { orgName: 'ab' }, 'INVALID_ORG_NAME'],
    ['org name with markup', { orgName: '<script>alert(1)</script>' }, 'INVALID_ORG_NAME'],
    ['termsAccepted missing', { termsAccepted: undefined }, 'TERMS_NOT_ACCEPTED'],
    ['termsAccepted false', { termsAccepted: false }, 'TERMS_NOT_ACCEPTED'],
    ['termsVersion wrong', { termsVersion: '0.9' }, 'TERMS_VERSION_MISMATCH'],
    ['mixed-script org name', { orgName: 'G\u043E\u043Egle Latin\u0430' }, 'INVALID_ORG_NAME'],
    ['bad email', { email: 'nope' }, 'INVALID_EMAIL'],
  ])('%s', async (_n, over, code) => {
    const res = await post('/api/public/signup/request', body(over));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.code).toBe(code);
    expect(sent).toHaveLength(0);
  });

  it('unknown fields are refused', async () => {
    expect((await post('/api/public/signup/request', body({ role: 'super_admin' }))).statusCode).toBe(400);
  });
});

describe('bot check and limits', () => {
  it('Turnstile failure: 403 TURNSTILE_FAILED, no mail', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: false }) });
    const res = await post('/api/public/signup/request', body());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TURNSTILE_FAILED');
    expect(sent).toHaveLength(0);
  });

  it('IP limit: 429 with scope signup_ip on the 6th request from one source', async () => {
    const headers = { 'cf-connecting-ip': '192.0.2.200' };
    for (let i = 0; i < 5; i++) expect((await post('/api/public/signup/request', body(), headers)).statusCode).toBe(200);
    const sixth = await post('/api/public/signup/request', body(), headers);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.details.scope).toBe('signup_ip');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('full flow', () => {
  it('request -> verify: organisation, admin, Free plan, credit grant, sample set, taxonomy, acceptance, audit, cookie', async () => {
    const payload = body({ orgName: 'Route Flow Academy' });
    const email = payload['email'] as string;
    const r = await post('/api/public/signup/request', payload);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });

    // A stale pre-login session in the browser must not survive.
    const stale = await sessions.create({ userId: contentUser, tenantId: PLATFORM, role: 'admin', totpVerified: true, ip: '1.1.1.1', ua: 'x' });
    expect(await sessions.get(stale.token)).not.toBeNull();

    const v = await post('/api/public/signup/verify', { email, code: codeFor(email) }, { cookie: `aiq_sess=${stale.token}` });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json()).toEqual({ ok: true, redirect: '/admin' });
    expect(v.headers['cache-control']).toBe('no-store');

    const setCookie = String(v.headers['set-cookie']);
    expect(setCookie).toMatch(/^aiq_sess=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    const token = /^aiq_sess=([^;]+)/.exec(setCookie)![1]!;
    const s = await sessions.get(token);
    expect(s).toMatchObject({ role: 'admin', totpVerified: true });
    expect(await sessions.get(stale.token)).toBeNull();

    const t = (await db.query(`SELECT id, slug, status, self_registered FROM tenants WHERE name='Route Flow Academy'`)).rows[0];
    expect(t).toMatchObject({ slug: 'route-flow-academy', status: 'active', self_registered: true });
    expect(s!.tenantId).toBe(t.id);
    expect(await count(`SELECT count(*) n FROM tenant_plans WHERE tenant_id=$1 AND tier='free'`, [t.id])).toBe(1);
    expect(await count(`SELECT count(*) n FROM credit_grants WHERE tenant_id=$1 AND source='free_monthly'`, [t.id])).toBe(1);
    expect((await db.query(`SELECT scope_type, scope_id FROM tenant_entitlements WHERE tenant_id=$1`, [t.id])).rows).toEqual([{ scope_type: 'pack', scope_id: packId }]);
    expect(await count(`SELECT count(*) n FROM tenant_legal_acceptances WHERE tenant_id=$1`, [t.id])).toBe(2);
    expect((await db.query(`SELECT action FROM audit_log WHERE tenant_id=$1 AND action LIKE 'signup.%'`, [t.id])).rows).toEqual([{ action: 'signup.completed' }]);
    expect(await count(`SELECT count(*) n FROM users WHERE tenant_id=$1 AND role='admin'`, [t.id])).toBe(1);
    expect(await count(`SELECT count(*) n FROM users WHERE tenant_id=$1 AND role <> 'admin'`, [t.id])).toBe(0);

    // Taxonomy is copied from the platform tenant right after commit.
    const platformDomains = await count(`SELECT count(*) n FROM domains WHERE tenant_id=$1`, [PLATFORM]);
    expect(await count(`SELECT count(*) n FROM domains WHERE tenant_id=$1`, [t.id])).toBe(platformDomains);
  });

  it('a wrong code and a replayed code answer 400 SIGNUP_INVALID with the same body', async () => {
    const payload = body({ orgName: 'Invalid Body School' });
    const email = payload['email'] as string;
    await post('/api/public/signup/request', payload);
    const wrong = await post('/api/public/signup/verify', { email, code: '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: { code: 'SIGNUP_INVALID', message: 'The code is not valid. Request a new one.' } });
    const ok = await post('/api/public/signup/verify', { email, code: codeFor(email) });
    expect(ok.statusCode).toBe(200);
    const replay = await post('/api/public/signup/verify', { email, code: codeFor(email) });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual(wrong.json());
    const malformed = await post('/api/public/signup/verify', { email: 'x', code: 'abc' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual(wrong.json());
  });

  it('request bodies are identical for a new and an existing address', async () => {
    const existing = `has-account-${randomUUID().slice(0, 6)}@school.test`;
    const first = body({ orgName: 'Existing Account School', email: existing });
    await post('/api/public/signup/request', first);
    await post('/api/public/signup/verify', { email: existing, code: codeFor(existing) });
    sent.length = 0;

    const fresh = await post('/api/public/signup/request', body());
    const old = await post('/api/public/signup/request', body({ email: existing }));
    expect(fresh.statusCode).toBe(200);
    expect(old.statusCode).toBe(200);
    expect(old.body).toBe(fresh.body);
    expect(old.headers['content-length']).toBe(fresh.headers['content-length']);
    expect(sent.map((s) => s.template).sort()).toEqual(['signup_code', 'signup_existing_account']);
  });

  it('an existing admin address gets no new organisation and no session', async () => {
    const adminEmail = `admin-${randomUUID().slice(0, 6)}@school.test`;
    await post('/api/public/signup/request', body({ orgName: 'Takeover Target School', email: adminEmail }));
    await post('/api/public/signup/verify', { email: adminEmail, code: codeFor(adminEmail) });
    const tenants = await count(`SELECT count(*) n FROM tenants`);
    sent.length = 0;
    await post('/api/public/signup/request', body({ orgName: 'Second Org Attempt', email: adminEmail }));
    expect(sent.map((s) => s.template)).toEqual(['signup_existing_account']);
    const v = await post('/api/public/signup/verify', { email: adminEmail, code: '123456' });
    expect(v.statusCode).toBe(400);
    expect(v.headers['set-cookie']).toBeUndefined();
    expect(await count(`SELECT count(*) n FROM tenants`)).toBe(tenants);
  });
});
