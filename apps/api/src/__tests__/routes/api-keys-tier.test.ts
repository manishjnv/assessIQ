/**
 * GET /api/admin/api-keys — plan-tier gate wiring (PT1). The tier decision is
 * covered by modules/19-billing tier-gates.test.ts; this proves the route is gated.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({ enforced: false, tier: 'free' }));

vi.mock('../../middleware/auth-chain.js', () => ({
  authChain: () => [
    async (req: { session?: unknown }) => {
      req.session = { tenantId: 't1', userId: 'u1', role: 'admin' };
    },
  ],
}));
vi.mock('@assessiq/auth', () => ({
  apiKeys: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), revoke: vi.fn() },
}));
vi.mock('@assessiq/assessment-lifecycle', () => ({ listInvitations: vi.fn() }));
vi.mock('@assessiq/billing', async () => {
  const { AppError } = await import('@assessiq/core');
  return {
    assertTierLimit: vi.fn(),
    assertCreditsUnderHardCap: vi.fn(),
    assertTierAllows: async (_t: string, feature: string) => {
      if (state.enforced && state.tier === 'free') {
        throw new AppError('not included', 'TIER_NOT_INCLUDED', 403, {
          details: { code: 'TIER_NOT_INCLUDED', tier: 'free', feature },
        });
      }
    },
  };
});

import { registerApiKeysRoutes } from '../../routes/auth/api-keys.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { status?: number; code?: string };
    void reply.code(e.status ?? 500).send({ error: { code: e.code } });
  });
  await registerApiKeysRoutes(app);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  state.enforced = false;
});

describe('GET /api/admin/api-keys plan gate', () => {
  it('returns 200 while tiers are not enforced', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/api-keys' });
    expect(res.statusCode).toBe(200);
  });
  it('returns 403 TIER_NOT_INCLUDED when enforced and tier is free', async () => {
    state.enforced = true;
    const res = await app.inject({ method: 'GET', url: '/api/admin/api-keys' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TIER_NOT_INCLUDED');
  });
});
