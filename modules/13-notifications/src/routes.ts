/**
 * modules/13-notifications/src/routes.ts
 *
 * Fastify plugin — notifications + webhook admin routes.
 *
 * Route resolution note (plan vs brief divergence):
 *   The brief lists: GET /admin/notifications, POST /admin/notifications/:id/read,
 *   POST /admin/webhooks, GET /admin/webhooks, DELETE /admin/webhooks/:id,
 *   GET /admin/webhook-failures, POST /admin/webhook-failures/:id/retry.
 *   The PLAN (canonical) lists: all of the above PLUS:
 *     POST /admin/webhooks/:id/test
 *     GET /admin/webhooks/deliveries (with endpointId/status filter params)
 *     POST /admin/webhooks/deliveries/:id/replay
 *     POST /admin/notifications/:id/mark-read (canonical name from plan)
 *   Resolution: the plan wins on naming conflicts. GET /admin/webhook-failures
 *   is an alias surface covered by GET /admin/webhooks/deliveries?status=failed.
 *   Both endpoints ship: /admin/webhooks/deliveries (full list+filter) and
 *   /admin/webhook-failures (convenience alias → same handler, status=failed).
 *   POST /admin/webhook-failures/:id/retry is a convenience alias for
 *   POST /admin/webhooks/deliveries/:id/replay.
 *
 * Auth invariants:
 *   - Admin-gated: all webhook CRUD + test + replay routes.
 *   - Any-role-gated: GET /admin/notifications, POST /admin/notifications/:id/mark-read.
 *   - audit.* subscription requires requiresFreshMfa=true at endpoint CREATE time
 *     (P3.D16 backend gate — enforced regardless of UI state).
 *
 * Multi-tenancy: tenantId is ALWAYS from req.session — never from the request body.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { ValidationError, AuthzError } from '@assessiq/core';
import * as webhookService from './webhooks/service.js';
import * as inAppService from './in-app/service.js';
import { getEmailQueueStatus } from './email/index.js';

// ---------------------------------------------------------------------------
// Options — DI auth chains (mirrors pattern from modules/07-ai-grading)
// ---------------------------------------------------------------------------

export interface RegisterNotificationsRoutesOptions {
  /** Admin-only preHandler chain */
  adminOnly: preHandlerHookHandler[] | preHandlerHookHandler;
  /** Z-3: candidate-only chain; when absent the /api/me/notifications routes are not registered. */
  candidateOnly?: preHandlerHookHandler[] | preHandlerHookHandler;
  /** PT1: appended after adminOnly on /api/admin/webhook* routes (plan-tier gate injected by apps/api). */
  webhooksGuard?: preHandlerHookHandler;
}

// ---------------------------------------------------------------------------
// Inline request schemas
// ---------------------------------------------------------------------------

const CreateWebhookEndpointBodySchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
}).strict();

const ListDeliveriesQuerySchema = z.object({
  endpointId: z.string().uuid().optional(),
  status: z.enum(['pending', 'delivered', 'failed']).optional(),
});

const NotificationsQuerySchema = z.object({
  since: z.string().optional(),
  limit: z.string().optional().transform((v) => (v !== undefined ? parseInt(v, 10) : 50)),
});

const MeNotificationsQuerySchema = z.object({
  unread: z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true').optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const MeMarkReadBodySchema = z.object({
  ids: z.array(z.string().uuid()).max(100).optional(),
  kind: z.string().min(1).max(100).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

export async function registerNotificationsRoutes(
  app: FastifyInstance,
  opts: RegisterNotificationsRoutesOptions,
): Promise<void> {
  const { adminOnly } = opts;
  const adminChain = Array.isArray(adminOnly) ? adminOnly : [adminOnly];
  // PT1: optional plan-tier guard, webhook routes only (not in-app notifications).
  // Removal (DELETE /api/admin/webhooks/:id) stays on adminChain: a downgraded tenant can still remove a webhook.
  const webhooksChain = opts.webhooksGuard ? [...adminChain, opts.webhooksGuard] : adminChain;

  // ──────────────────────────────────────────────────────────────────────────
  // Webhook endpoints CRUD
  // ──────────────────────────────────────────────────────────────────────────

  // Helper: extract tenantId from request session
  type AiqReq = FastifyRequest & { session?: { tenantId?: string; userId?: string; role?: string; totpVerified?: boolean; lastTotpAt?: string | null } };

  function getTenantId(req: FastifyRequest): string {
    const tenantId = (req as AiqReq).session?.tenantId;
    if (!tenantId) throw new AuthzError('No organisation context');
    return tenantId;
  }

  /** GET /api/admin/email-queue — this tenant's bulk emails held back by the daily cap (Q11). */
  app.get('/api/admin/email-queue', { preHandler: adminChain }, async (req: FastifyRequest) => {
    return getEmailQueueStatus(getTenantId(req));
  });

  /** GET /api/admin/webhooks — list all webhook endpoints for the tenant */
  app.get('/api/admin/webhooks', { preHandler: webhooksChain }, async (req: FastifyRequest) => {
    const tenantId = getTenantId(req);
    const endpoints = await webhookService.listWebhookEndpoints(tenantId);
    return { items: endpoints };
  });

  /**
   * POST /api/admin/webhooks — create a webhook endpoint.
   * P3.D16: if events includes 'audit.*' or any 'audit.' prefix, the call
   * must come from a request with fresh MFA (within 5 minutes).
   * Returns plaintext secret ONCE — never again.
   */
  app.post('/api/admin/webhooks', { preHandler: webhooksChain }, async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const userId = (req as AiqReq).session?.userId;

    const bodyParsed = CreateWebhookEndpointBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw new ValidationError('Invalid webhook endpoint input', {
        details: { issues: bodyParsed.error.issues },
      });
    }

    const { name, url, events } = bodyParsed.data;

    // P3.D16 — audit.* subscriptions require fresh MFA
    const hasAuditWildcard = events.some(
      (e) => e === 'audit.*' || e.startsWith('audit.'),
    );

    let requiresFreshMfa = false;
    if (hasAuditWildcard) {
      const session = (req as AiqReq).session;
      const lastTotpAt = session?.lastTotpAt;
      const totpVerified = session?.totpVerified ?? false;

      if (!totpVerified || lastTotpAt == null) {
        return reply.code(401).send({
          error: {
            code: 'FRESH_MFA_REQUIRED',
            message: 'audit.* webhook subscriptions require a fresh MFA verification (within 5 minutes).',
          },
        });
      }

      const ageMs = Date.now() - new Date(lastTotpAt).getTime();
      if (ageMs > 5 * 60 * 1000) {
        return reply.code(401).send({
          error: {
            code: 'FRESH_MFA_REQUIRED',
            message: 'audit.* webhook subscriptions require a fresh MFA verification (within 5 minutes).',
          },
        });
      }
      requiresFreshMfa = true;
    }

    const { endpoint, plaintextSecret } = await webhookService.createWebhookEndpoint({
      tenantId,
      name,
      url,
      events,
      requiresFreshMfa,
      actorUserId: userId,
    });

    return reply.code(201).send({
      endpoint,
      secret: plaintextSecret, // returned ONCE only
    });
  });

  /** DELETE /api/admin/webhooks/:id — delete a webhook endpoint */
  app.delete('/api/admin/webhooks/:id', { preHandler: adminChain }, async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const userId = (req as AiqReq).session?.userId;
    const { id } = req.params as { id: string };

    await webhookService.deleteWebhookEndpoint(tenantId, id, userId);
    return reply.code(204).send();
  });

  /** POST /api/admin/webhooks/:id/test — send a synthetic test event */
  app.post('/api/admin/webhooks/:id/test', { preHandler: webhooksChain }, async (req: FastifyRequest) => {
    const tenantId = getTenantId(req);
    const { id } = req.params as { id: string };

    const result = await webhookService.sendTestEvent(tenantId, id, 'test.ping');
    return { deliveryId: result.deliveryId };
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Webhook deliveries
  // ──────────────────────────────────────────────────────────────────────────

  /** GET /api/admin/webhooks/deliveries — list delivery history (with optional filter) */
  app.get('/api/admin/webhooks/deliveries', { preHandler: webhooksChain }, async (req: FastifyRequest) => {
    const tenantId = getTenantId(req);

    const queryParsed = ListDeliveriesQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      throw new ValidationError('Invalid query params', {
        details: { issues: queryParsed.error.issues },
      });
    }

    const filter: { endpointId?: string; status?: string } = {};
    if (queryParsed.data.endpointId !== undefined) filter.endpointId = queryParsed.data.endpointId;
    if (queryParsed.data.status !== undefined) filter.status = queryParsed.data.status;

    const deliveries = await webhookService.listDeliveries(tenantId, filter);
    return { items: deliveries };
  });

  /** GET /api/admin/webhook-failures — convenience alias for failed deliveries */
  app.get('/api/admin/webhook-failures', { preHandler: webhooksChain }, async (req: FastifyRequest) => {
    const tenantId = getTenantId(req);

    const queryParsed = ListDeliveriesQuerySchema.safeParse(req.query);
    const filter: { endpointId?: string; status?: string } = { status: 'failed' };
    if (queryParsed.success && queryParsed.data.endpointId !== undefined) {
      filter.endpointId = queryParsed.data.endpointId;
    }

    const deliveries = await webhookService.listDeliveries(tenantId, filter);
    return { items: deliveries };
  });

  /** POST /api/admin/webhooks/deliveries/:id/replay — replay (append-only) */
  app.post('/api/admin/webhooks/deliveries/:id/replay', { preHandler: webhooksChain }, async (req: FastifyRequest) => {
    const tenantId = getTenantId(req);
    const userId = (req as AiqReq).session?.userId;
    const { id } = req.params as { id: string };

    const result = await webhookService.replayDelivery(tenantId, id, userId);
    return { deliveryId: result.deliveryId };
  });

  /** POST /api/admin/webhook-failures/:id/retry — convenience alias for replay */
  app.post('/api/admin/webhook-failures/:id/retry', { preHandler: webhooksChain }, async (req: FastifyRequest) => {
    const tenantId = getTenantId(req);
    const userId = (req as AiqReq).session?.userId;
    const { id } = req.params as { id: string };

    const result = await webhookService.replayDelivery(tenantId, id, userId);
    return { deliveryId: result.deliveryId };
  });

  // ──────────────────────────────────────────────────────────────────────────
  // In-app notifications (admin-gated)
  // ──────────────────────────────────────────────────────────────────────────

  /** GET /api/admin/notifications?since=<cursor> — short-poll for in-app notifications */
  app.get('/api/admin/notifications', { preHandler: adminChain }, async (req: FastifyRequest) => {
    const session = (req as AiqReq).session;
    const tenantId = session?.tenantId;
    const userId = session?.userId;
    const userRole = session?.role ?? 'admin';

    if (!tenantId || !userId) throw new AuthzError('No session context');

    const queryParsed = NotificationsQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      throw new ValidationError('Invalid query params', {
        details: { issues: queryParsed.error.issues },
      });
    }

    const listInput: Parameters<typeof inAppService.listInAppNotifications>[0] = {
      tenantId,
      userId,
      userRole,
    };
    if (queryParsed.data.since !== undefined) listInput.since = queryParsed.data.since;
    if (typeof queryParsed.data.limit === 'number') listInput.limit = queryParsed.data.limit;

    return inAppService.listInAppNotifications(listInput);
  });

  /** POST /api/admin/notifications/:id/mark-read — mark a notification as read */
  app.post('/api/admin/notifications/:id/mark-read', { preHandler: adminChain }, async (req: FastifyRequest, reply: FastifyReply) => {
    const session = (req as AiqReq).session;
    const tenantId = session?.tenantId;
    const userId = session?.userId;

    if (!tenantId || !userId) throw new AuthzError('No session context');
    const { id } = req.params as { id: string };

    await inAppService.markRead(tenantId, id, userId);
    return reply.code(204).send();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Z-3: candidate notices (candidate-gated; own rows only)
  // ──────────────────────────────────────────────────────────────────────────
  if (opts.candidateOnly === undefined) return;
  const candidateChain = Array.isArray(opts.candidateOnly) ? opts.candidateOnly : [opts.candidateOnly];

  app.get('/api/me/notifications', { preHandler: candidateChain }, async (req: FastifyRequest) => {
    const session = (req as AiqReq).session;
    const tenantId = session?.tenantId;
    const userId = session?.userId;
    if (!tenantId || !userId) throw new AuthzError('No session context');

    const parsed = MeNotificationsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query params', { details: { issues: parsed.error.issues } });
    }
    const q = parsed.data;
    const [list, unread_count] = await Promise.all([
      inAppService.listInAppNotifications({
        tenantId,
        userId,
        userRole: 'candidate',
        limit: q.limit,
        unreadOnly: q.unread === true,
        ownOnly: true,
        ...(q.since !== undefined ? { since: q.since } : {}),
      }),
      inAppService.countUnreadForUser(tenantId, userId, 'result.released'),
    ]);
    return { items: list.items, cursor: list.cursor, unread_count };
  });

  app.post('/api/me/notifications/mark-read', { preHandler: candidateChain }, async (req: FastifyRequest) => {
    const session = (req as AiqReq).session;
    const tenantId = session?.tenantId;
    const userId = session?.userId;
    if (!tenantId || !userId) throw new AuthzError('No session context');

    const parsed = MeMarkReadBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid mark-read input', { details: { issues: parsed.error.issues } });
    }
    const updated = await inAppService.markManyRead(tenantId, userId, {
      ...(parsed.data.ids !== undefined ? { ids: parsed.data.ids } : {}),
      ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
    });
    return { updated };
  });
}
