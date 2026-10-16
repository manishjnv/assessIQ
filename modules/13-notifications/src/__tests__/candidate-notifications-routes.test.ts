/**
 * Z-3: candidate notice routes (GET/POST /api/me/notifications).
 * Service is mocked; the repository SQL is checked with a fake client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { preHandlerHookHandler } from 'fastify';

const svc = vi.hoisted(() => ({
  listInAppNotifications: vi.fn(),
  countUnreadForUser: vi.fn(),
  markManyRead: vi.fn(),
  markRead: vi.fn(),
}));
vi.mock('../in-app/service.js', () => svc);
vi.mock('../webhooks/service.js', () => ({}));

import { registerNotificationsRoutes } from '../routes.js';
import { markInAppNotificationsRead, listInAppNotificationsForUser } from '../repository.js';

const TENANT = '0190c0de-0000-7000-8000-000000000001';
const USER = '0190c0de-0000-7000-8000-000000000002';

async function build(withCandidate = true) {
  const app = Fastify();
  const as = (role: string): preHandlerHookHandler => (async (req: unknown) => { (req as { session?: unknown }).session = { tenantId: TENANT, userId: USER, role }; }) as unknown as preHandlerHookHandler;
  await registerNotificationsRoutes(app, {
    adminOnly: as('admin'),
    ...(withCandidate ? { candidateOnly: as('candidate') } : {}),
  });
  return app;
}

beforeEach(() => Object.values(svc).forEach((f) => f.mockReset()));

describe('GET /api/me/notifications', () => {
  it('returns items, cursor, unread_count; scoped to the session user as candidate', async () => {
    svc.listInAppNotifications.mockResolvedValue({ items: [{ id: 'n1', kind: 'result.released' }], cursor: 'c1' });
    svc.countUnreadForUser.mockResolvedValue(1);
    const res = await (await build()).inject({ method: 'GET', url: '/api/me/notifications?unread=1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ id: 'n1', kind: 'result.released' }], cursor: 'c1', unread_count: 1 });
    expect(svc.listInAppNotifications).toHaveBeenCalledWith({
      tenantId: TENANT, userId: USER, userRole: 'candidate', limit: 50, unreadOnly: true, ownOnly: true,
    });
    expect(svc.countUnreadForUser).toHaveBeenCalledWith(TENANT, USER, 'result.released');
  });

  it('rejects a bad limit with 4xx', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/api/me/notifications?limit=500' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(svc.listInAppNotifications).not.toHaveBeenCalled();
  });

  it('is not registered without a candidate chain', async () => {
    const res = await (await build(false)).inject({ method: 'GET', url: '/api/me/notifications' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/me/notifications/mark-read', () => {
  it('marks by kind for the session user only and returns the count', async () => {
    svc.markManyRead.mockResolvedValue(2);
    const res = await (await build()).inject({
      method: 'POST', url: '/api/me/notifications/mark-read', payload: { kind: 'result.released' },
    });
    expect(res.json()).toEqual({ updated: 2 });
    expect(svc.markManyRead).toHaveBeenCalledWith(TENANT, USER, { kind: 'result.released' });
  });

  it('rejects unknown keys and non-uuid ids', async () => {
    const app = await build();
    expect((await app.inject({ method: 'POST', url: '/api/me/notifications/mark-read', payload: { x: 1 } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: 'POST', url: '/api/me/notifications/mark-read', payload: { ids: ['nope'] } })).statusCode).toBeGreaterThanOrEqual(400);
    expect(svc.markManyRead).not.toHaveBeenCalled();
  });
});

describe('repository SQL', () => {
  it('bulk mark-read keeps the ownership guard and binds userId, ids, kind', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 3 });
    const n = await markInAppNotificationsRead({ query } as never, { userId: USER, kind: 'result.released' });
    expect(n).toBe(3);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("audience = 'user' AND user_id = $1");
    expect(params).toEqual([USER, null, 'result.released']);
  });

  it('unreadOnly adds the read_at filter parameter', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await listInAppNotificationsForUser({ query } as never, { tenantId: TENANT, userId: USER, userRole: 'candidate', unreadOnly: true });
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain('read_at IS NULL');
    expect(params[3]).toBe(true);
  });
});
