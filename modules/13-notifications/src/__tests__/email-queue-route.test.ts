/** Q11: GET /api/admin/email-queue returns the status for the SESSION tenant only. */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { preHandlerHookHandler } from 'fastify';

const status = vi.hoisted(() => ({ getEmailQueueStatus: vi.fn() }));
vi.mock('../email/index.js', () => status);
vi.mock('../in-app/service.js', () => ({}));
vi.mock('../webhooks/service.js', () => ({}));

import { registerNotificationsRoutes } from '../routes.js';

const TENANT = '0190c0de-0000-7000-8000-000000000001';

describe('GET /api/admin/email-queue', () => {
  it('returns the 4-field shape and asks only for the session tenant', async () => {
    const body = { queuedCount: 3, nextSendAt: '2026-10-20T03:30:00.000Z', dailyCap: 250, sentToday: 250 };
    status.getEmailQueueStatus.mockResolvedValue(body);
    const app = Fastify();
    const as = (async (req: unknown) => {
      (req as { session?: unknown }).session = { tenantId: TENANT, role: 'admin' };
    }) as unknown as preHandlerHookHandler;
    await registerNotificationsRoutes(app, { adminOnly: as });
    const res = await app.inject({ method: 'GET', url: '/api/admin/email-queue?tenantId=other' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
    expect(status.getEmailQueueStatus).toHaveBeenCalledWith(TENANT);
  });
});
