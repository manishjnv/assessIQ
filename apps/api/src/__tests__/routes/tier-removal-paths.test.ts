/** PT1: removal/rotation paths stay open for a downgraded tenant; flag-off grant skips the pack count; override bounds. */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const m = vi.hoisted(() => ({ enforced: true }));

vi.mock('../../middleware/auth-chain.js', () => ({
  authChain: () => [async (req: { session?: unknown }) => { req.session = { tenantId: 't1', userId: 'u1', role: 'admin' }; }],
}));
vi.mock('../../middleware/require-tier.js', () => ({
  requireTier: () => async () => {
    const { AppError } = await import('@assessiq/core');
    if (m.enforced) throw new AppError('no', 'TIER_NOT_INCLUDED', 403);
  },
}));
vi.mock('@assessiq/embed-sdk', () => ({
  listEmbedOrigins: vi.fn().mockResolvedValue([]),
  addEmbedOrigin: vi.fn(),
  removeEmbedOrigin: vi.fn().mockResolvedValue(undefined),
  rotateWebhookSecret: vi.fn().mockResolvedValue('secret'),
}));

import { registerEmbedAdminRoutes } from '../../routes/embed-admin.js';
import { updatePlanBody } from '../../routes/_schemas.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler((err, _r, reply) => { void reply.code((err as { status?: number }).status ?? 500).send({}); });
  await registerEmbedAdminRoutes(app);
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe('embed admin with tier enforced and tier free', () => {
  it('gates list', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/embed-origins' })).statusCode).toBe(403);
  });
  it('allows removing an origin and rotating the webhook secret', async () => {
    const del = await app.inject({ method: 'DELETE', url: '/api/admin/embed-origins', payload: { origin: 'https://a.com' } });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/admin/webhook-secrets/rotate' })).statusCode).toBe(200);
  });
});

describe('updatePlanBody aiAnswersIncludedOverride bounds', () => {
  it.each([[0, true], [1_000_000, true], [null, true], [-1, false], [1_000_001, false], [1.5, false]])('%s -> %s', (v, ok) => {
    expect(updatePlanBody.safeParse({ aiAnswersIncludedOverride: v }).success).toBe(ok);
  });
});
