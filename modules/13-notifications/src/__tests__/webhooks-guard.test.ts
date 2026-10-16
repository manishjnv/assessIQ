/** PT1: webhooksGuard gates list/create but never removal or in-app notifications. */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { preHandlerHookHandler } from 'fastify';

const svc = vi.hoisted(() => ({ deleteWebhookEndpoint: vi.fn(), listWebhookEndpoints: vi.fn() }));
vi.mock('../webhooks/service.js', () => svc);
vi.mock('../in-app/service.js', () => ({ listInAppNotifications: vi.fn().mockResolvedValue({ items: [], cursor: null }) }));

import { registerNotificationsRoutes } from '../routes.js';

const T = '0190c0de-0000-7000-8000-000000000001';
async function build() {
  const app = Fastify();
  const admin = (async (req: unknown) => { (req as { session?: unknown }).session = { tenantId: T, userId: 'u', role: 'admin' }; }) as unknown as preHandlerHookHandler;
  const guard = (async () => { throw Object.assign(new Error('tier'), { statusCode: 403 }); }) as unknown as preHandlerHookHandler;
  await registerNotificationsRoutes(app, { adminOnly: admin, webhooksGuard: guard });
  return app;
}

describe('webhooksGuard', () => {
  it('blocks list but lets DELETE and in-app notifications through', async () => {
    const app = await build();
    svc.deleteWebhookEndpoint.mockResolvedValue(undefined);
    expect((await app.inject({ method: 'GET', url: '/api/admin/webhooks' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/webhooks/w1' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/admin/notifications' })).statusCode).not.toBe(403);
  });
});
