/**
 * modules/13-notifications/src/webhooks/service.ts
 *
 * Webhook endpoint CRUD + delivery enqueue.
 *
 * Key invariants:
 * - Secrets encrypted at rest with AES-256-GCM (ASSESSIQ_MASTER_KEY).
 * - Plaintext secret returned EXACTLY ONCE at create-time; never again.
 * - audit.* subscription requires requiresFreshMfa=true (P3.D16 — the backend
 *   enforces regardless of UI state; this service stores the flag; routes.ts
 *   gates the HTTP call).
 * - emitWebhook enqueues one BullMQ 'webhook.deliver' job per matching endpoint.
 * - replayDelivery writes a NEW row — NEVER updates the original (append-only).
 *
 * G3.D audit-write sweep (2026-05-11):
 * - createWebhookEndpoint, deleteWebhookEndpoint, replayDelivery each emit one
 *   audit_log row via auditInTx() inside the same withTenant transaction as the
 *   domain mutation. webhook.created / webhook.deleted / webhook.replayed.
 * - @assessiq/audit-log is imported statically. The fanout path in that module
 *   uses a dynamic import back to @assessiq/notifications (webhook-fanout.ts),
 *   so there is no static circular dependency.
 * - Operational paths (emitWebhook, emitWebhookToEndpoint, deliver-job) are
 *   intentionally NOT audited — they are delivery-tracking telemetry, not admin
 *   config mutations.
 */

import { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config, streamLogger, uuidv7 } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import { auditInTx } from '@assessiq/audit-log';
import * as repo from '../repository.js';
import { encrypt, decrypt } from './crypto.js';
import type {
  WebhookEndpoint,
  WebhookDelivery,
  CreateWebhookEndpointInput,
} from '../types.js';

const log = streamLogger('webhook');

// ---------------------------------------------------------------------------
// BullMQ queue (lazy-initialised — do not create on module load to keep
// tests able to stub before the module is imported).
// ---------------------------------------------------------------------------

let _webhookQueue: Queue | null = null;

function getWebhookQueue(): Queue {
  if (_webhookQueue === null) {
    const redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    _webhookQueue = new Queue('assessiq-cron', { connection: redis });
  }
  return _webhookQueue;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listWebhookEndpoints(
  tenantId: string,
): Promise<WebhookEndpoint[]> {
  return withTenant(tenantId, (client) => repo.listWebhookEndpoints(client));
}

export interface CreateWebhookEndpointResult {
  endpoint: WebhookEndpoint;
  /** Plaintext secret — returned ONCE, never again. */
  plaintextSecret: string;
}

export async function createWebhookEndpoint(
  input: CreateWebhookEndpointInput,
): Promise<CreateWebhookEndpointResult> {
  // Generate a high-entropy secret.
  const plaintextSecret = randomBytes(32).toString('base64url');
  const secretEnc = encrypt(plaintextSecret);
  const endpointId = uuidv7();

  // Single transaction: INSERT webhook_endpoint + auditInTx (G3.D pattern).
  const endpoint = await withTenant(input.tenantId, async (client) => {
    const result = await repo.insertWebhookEndpoint(client, {
      id: endpointId,
      tenantId: input.tenantId,
      name: input.name,
      url: input.url,
      secretEnc,
      events: input.events,
      requiresFreshMfa: input.requiresFreshMfa,
    });
    await auditInTx(client, {
      tenantId: input.tenantId,
      actorKind: input.actorUserId != null ? 'user' : 'system',
      ...(input.actorUserId != null ? { actorUserId: input.actorUserId } : {}),
      action: 'webhook.created',
      entityType: 'webhook_endpoint',
      entityId: endpointId,
      // no 'before' — INSERT, no prior state
      after: {
        name: input.name,
        url: input.url,
        events: input.events as unknown as Record<string, unknown>,
        requires_fresh_mfa: input.requiresFreshMfa,
      },
    });
    return result;
  });

  log.info(
    { endpointId: endpoint.id, tenantId: input.tenantId, events: input.events },
    'webhook.endpoint.created',
  );

  return { endpoint, plaintextSecret };
}

export async function deleteWebhookEndpoint(
  tenantId: string,
  endpointId: string,
  actorUserId?: string,
): Promise<void> {
  // Single transaction: snapshot before, DELETE webhook_endpoint, auditInTx.
  await withTenant(tenantId, async (client) => {
    const before = await repo.getWebhookEndpointById(client, endpointId);
    await repo.deleteWebhookEndpoint(client, endpointId);
    await auditInTx(client, {
      tenantId,
      actorKind: actorUserId != null ? 'user' : 'system',
      ...(actorUserId != null ? { actorUserId } : {}),
      action: 'webhook.deleted',
      entityType: 'webhook_endpoint',
      entityId: endpointId,
      ...(before !== null ? { before: { name: before.name, url: before.url, events: before.events as unknown as Record<string, unknown>, status: before.status } } : {}),
      // no 'after' — DELETE
    });
  });
  log.info({ endpointId, tenantId }, 'webhook.endpoint.deleted');
}

export async function sendTestEvent(
  tenantId: string,
  endpointId: string,
  eventName: string,
): Promise<{ deliveryId: string }> {
  const payload = {
    event: eventName,
    tenant_id: tenantId,
    test: true,
    sent_at: new Date().toISOString(),
  };
  return emitWebhookToEndpoint(tenantId, endpointId, eventName, payload);
}

export async function listDeliveries(
  tenantId: string,
  filter: { endpointId?: string; status?: string },
): Promise<WebhookDelivery[]> {
  return withTenant(tenantId, (client) =>
    repo.listWebhookDeliveries(client, filter),
  );
}

/**
 * Replay a delivery by writing a NEW row referencing the same endpoint + event.
 * NEVER updates the original row — append-only delivery history.
 *
 * G3.D: bypasses emitWebhookToEndpoint() to keep insertWebhookDelivery +
 * auditInTx in a single withTenant transaction. BullMQ enqueue happens after
 * the transaction commits (same ordering as emitWebhookToEndpoint).
 */
export async function replayDelivery(
  tenantId: string,
  deliveryId: string,
  actorUserId?: string,
): Promise<{ deliveryId: string }> {
  const original = await withTenant(tenantId, (client) =>
    repo.getWebhookDeliveryById(client, deliveryId),
  );

  if (original === null) {
    throw new Error(`Delivery not found: ${deliveryId}`);
  }

  const newDeliveryId = uuidv7();

  // Single transaction: INSERT new delivery row + auditInTx (G3.D).
  await withTenant(tenantId, async (client) => {
    await repo.insertWebhookDelivery(client, {
      id: newDeliveryId,
      endpointId: original.endpoint_id,
      event: original.event,
      payload: original.payload,
    });
    await auditInTx(client, {
      tenantId,
      actorKind: actorUserId != null ? 'user' : 'system',
      ...(actorUserId != null ? { actorUserId } : {}),
      action: 'webhook.replayed',
      entityType: 'webhook_delivery',
      entityId: original.id,
      after: {
        new_delivery_id: newDeliveryId,
        original_delivery_id: original.id,
        endpoint_id: original.endpoint_id,
        event: original.event,
      },
    });
  });

  const queue = getWebhookQueue();
  await queue.add(
    'webhook.deliver',
    { deliveryId: newDeliveryId, tenantId },
    {
      attempts: 5,
      backoff: { type: 'custom' },
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  );

  log.info(
    { deliveryId: newDeliveryId, originalDeliveryId: deliveryId, tenantId },
    'webhook.delivery.replayed',
  );

  return { deliveryId: newDeliveryId };
}

/**
 * Emit a webhook event to all matching endpoints for a tenant.
 * Enqueues one BullMQ 'webhook.deliver' job per matching endpoint.
 */
export async function emitWebhook(input: {
  tenantId: string;
  event: string;
  payload: unknown;
}): Promise<void> {
  const endpoints = await withTenant(input.tenantId, (client) =>
    repo.findEndpointsForEvent(client, input.event),
  );

  await Promise.all(
    endpoints.map((endpoint) =>
      emitWebhookToEndpoint(
        input.tenantId,
        endpoint.id,
        input.event,
        input.payload,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function emitWebhookToEndpoint(
  tenantId: string,
  endpointId: string,
  event: string,
  payload: unknown,
): Promise<{ deliveryId: string }> {
  const deliveryId = uuidv7();

  // Write delivery row first (status='pending'), then enqueue job.
  // If the enqueue fails, the row is still there for manual replay.
  await withTenant(tenantId, (client) =>
    repo.insertWebhookDelivery(client, {
      id: deliveryId,
      endpointId,
      event,
      payload,
    }),
  );

  const queue = getWebhookQueue();
  await queue.add(
    'webhook.deliver',
    { deliveryId, tenantId },
    {
      attempts: 5,
      backoff: { type: 'custom' },
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  );

  log.info(
    { deliveryId, endpointId, event, tenantId },
    'webhook.delivery.enqueued',
  );

  return { deliveryId };
}

/**
 * Retrieve and decrypt the secret for a given delivery's endpoint.
 * Used by the deliver-job processor. Not exported from the module barrel
 * to prevent accidental exposure.
 */
export async function getDecryptedSecret(
  tenantId: string,
  endpointId: string,
): Promise<string | null> {
  const secretEnc = await withTenant(tenantId, (client) =>
    repo.getWebhookEndpointSecret(client, endpointId),
  );
  if (secretEnc === null) return null;
  return decrypt(secretEnc);
}
