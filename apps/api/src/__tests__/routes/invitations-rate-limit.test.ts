/**
 * POST /api/invitations/accept — per-IP brake on FAILED redemptions (D5b).
 * Real Redis testcontainer; acceptInvitation is mocked (route-level test).
 *
 * Proves: failures from one IP hit 429 scope=ip after INVITE_FAIL_MAX; another IP is
 * unaffected; SUCCESSFUL accepts are never counted (a campus behind one NAT IP).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { AppError, NotFoundError } from '@assessiq/core';

const mockAccept = vi.fn();
vi.mock('@assessiq/users', () => ({
  inviteUser: vi.fn(),
  acceptInvitation: (...a: unknown[]) => mockAccept(...a),
}));
vi.mock('../../middleware/auth-chain.js', () => ({ authChain: () => [] }));

import { setRedisForTesting, closeRedis } from '@assessiq/auth';
import { registerInvitationRoutes, INVITE_FAIL_MAX } from '../../routes/invitations.js';

const TOKEN = 'a'.repeat(43);
let container: StartedTestContainer;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/, 1))
    .withStartupTimeout(60_000)
    .start();
  await setRedisForTesting(`redis://${container.getHost()}:${container.getMappedPort(6379)}`);
  app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Partial<AppError> & { statusCode?: number };
    void reply.code(e.status ?? e.statusCode ?? 500).send({ error: { code: e.code, details: e.details } });
  });
  await registerInvitationRoutes(app);
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await closeRedis();
  if (container !== undefined) await container.stop();
});

const accept = (ip: string) =>
  app.inject({
    method: 'POST',
    url: '/api/invitations/accept',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    payload: { token: TOKEN },
  });

describe('invitation accept per-IP failure limit', () => {
  it('429 scope=ip after INVITE_FAIL_MAX failures; other IPs unaffected', async () => {
    mockAccept.mockRejectedValue(new NotFoundError('nope'));
    for (let i = 0; i < INVITE_FAIL_MAX; i++) {
      expect((await accept('60.0.0.1')).statusCode).toBe(404);
    }
    const blocked = await accept('60.0.0.1');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED', details: { scope: 'ip' } } });
    expect(mockAccept).toHaveBeenCalledTimes(INVITE_FAIL_MAX); // blocked call never reached the lookup
    expect((await accept('60.0.0.2')).statusCode).toBe(404);
  });

  it('successful accepts from one IP are never counted (campus NAT)', async () => {
    mockAccept.mockResolvedValue({ user: { id: 'u' }, sessionToken: 't', expiresAt: new Date().toISOString() });
    for (let i = 0; i < INVITE_FAIL_MAX * 3; i++) {
      expect((await accept('60.0.0.3')).statusCode).toBe(200);
    }
  });
});
