/**
 * modules/13-notifications/src/in-app/service.ts
 *
 * In-app notification service — P3.D13.
 *
 * Short-poll delivery via GET /api/admin/notifications?since=<cursor>.
 * NO WebSocket / SSE — deferred to Phase 4.
 *
 * Audience semantics:
 *   'user'  — only the target user_id sees it.
 *   'role'  — all users with matching role in the tenant.
 *   'all'   — all users in the tenant.
 *
 * Cross-tenant RLS: every query runs inside withTenant(), which pins
 * app.current_tenant. The repository does NOT add WHERE tenant_id = $x
 * filters; RLS enforces isolation at the DB layer.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { streamLogger, uuidv7 } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import * as repo from '../repository.js';
import type { InAppNotification, NotifyInAppInput } from '../types.js';

const log = streamLogger('app');

export interface ListInAppResult {
  items: InAppNotification[];
  /** ISO-8601 timestamp cursor — pass as `since` to get only newer items */
  cursor: string;
}

/**
 * Write a new in-app notification.
 * NEVER broadcasts cross-tenant — tenantId from input is the RLS anchor.
 */
export async function notifyInApp(input: NotifyInAppInput): Promise<InAppNotification> {
  const notification = await withTenant(input.tenantId, (client) =>
    repo.insertInAppNotification(client, {
      id: uuidv7(),
      tenantId: input.tenantId,
      audience: input.audience,
      userId: input.userId ?? null,
      role: input.role ?? null,
      kind: input.kind,
      message: input.message,
      link: input.link ?? null,
    }),
  );

  log.info(
    { notificationId: notification.id, tenantId: input.tenantId, audience: input.audience, kind: input.kind },
    'in-app.notification.created',
  );

  return notification;
}

/**
 * List in-app notifications for a user (short-poll endpoint).
 * Returns items the user can see based on audience matching.
 * `since` is an ISO-8601 timestamp cursor from the previous response.
 */
export async function listInAppNotifications(input: {
  tenantId: string;
  userId: string;
  userRole: string;
  since?: string;
  limit?: number;
}): Promise<ListInAppResult> {
  const repoInput: repo.ListInAppNotificationsInput = {
    tenantId: input.tenantId,
    userId: input.userId,
    userRole: input.userRole,
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };

  const items = await withTenant(input.tenantId, (client) =>
    repo.listInAppNotificationsForUser(client, repoInput),
  );

  // Cursor = the created_at of the last item returned, or the current time.
  const cursor =
    items.length > 0
      ? items[items.length - 1]!.created_at.toISOString()
      : new Date().toISOString();

  return { items, cursor };
}

/**
 * Mark a notification as read by the requesting user.
 * RLS ensures the notification belongs to the user's tenant.
 */
export async function markRead(
  tenantId: string,
  notificationId: string,
  userId: string,
): Promise<void> {
  await withTenant(tenantId, (client) =>
    repo.markInAppNotificationRead(client, notificationId, userId),
  );
}
