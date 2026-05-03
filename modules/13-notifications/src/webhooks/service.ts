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
 */

import { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config, streamLogger, uuidv7 } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
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

  const endpoint = await withTenant(input.tenantId, (client) =>
    repo.insertWebhookEndpoint(client, {
      id: uuidv7(),
      tenantId: input.tenantId,
      name: input.name,
      url: input.url,
      secretEnc,
      events: input.events,
      requiresFreshMfa: input.requiresFreshMfa,
    }),
  );

  log.info(
    { endpointId: endpoint.id, tenantId: input.tenantId, events: input.events },
    'webhook.endpoint.created',
  );

  // G3.A audit hook — dynamic import to avoid circular dep:
  // @assessiq/audit-log statically imports @assessiq/notifications (for fanout),
  // so @assessiq/notifications must dynamically import @assessiq/audit-log.
  // This is intentionally best-effort: audit failure here does NOT block
  // webhook creation (the hook is secondary; the audit module's own failures
  // propagate from its own call sites).
  await (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const mod = await (Function('m', 'return import(m)')('@assessiq/audit-log') as Promise<{
        audit: (input: {
          tenantId: string; actorKind: 'user' | 'api_key' | 'system';
          action: string; entityType: string; entityId?: string;
          after?: Record<string, unknown>;
        }) => Promise<void>;
      }>).catch(() => null);
      if (mod !== null) {
        await mod.audit({
          tenantId: input.tenantId,
          actorKind: 'system',
          action: 'webhook.created',
          entityType: 'webhook_endpoint',
          entityId: endpoint.id,
          after: { endpointId: endpoint.id, url: endpoint.url, events: endpoint.events },
        });
      }
    } catch (auditErr) {
      log.warn({ auditErr, endpointId: endpoint.id }, 'webhook.created: audit hook failed (dynamic import)');
    }
  })();

  return { endpoint, plaintextSecret };
}

export async function deleteWebhookEndpoint(
  tenantId: string,
  endpointId: string,
): Promise<void> {
  await withTenant(tenantId, (client) =>
    repo.deleteWebhookEndpoint(client, endpointId),
  );
  log.info({ endpointId, tenantId }, 'webhook.endpoint.deleted');

  // G3.A audit hook — dynamic import (see webhook.created comment above).
  await (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const mod = await (Function('m', 'return import(m)')('@assessiq/audit-log') as Promise<{
        audit: (input: {
          tenantId: string; actorKind: 'user' | 'api_key' | 'system';
          action: string; entityType: string; entityId?: string;
        }) => Promise<void>;
      }>).catch(() => null);
      if (mod !== null) {
        await mod.audit({
          tenantId,
          actorKind: 'system',
          action: 'webhook.deleted',
          entityType: 'webhook_endpoint',
          entityId: endpointId,
        });
      }
    } catch (auditErr) {
      log.warn({ auditErr, endpointId }, 'webhook.deleted: audit hook failed (dynamic import)');
    }
  })();
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
 */
export async function replayDelivery(
  tenantId: string,
  deliveryId: string,
): Promise<{ deliveryId: string }> {
  const original = await withTenant(tenantId, (client) =>
    repo.getWebhookDeliveryById(client, deliveryId),
  );

  if (original === null) {
    throw new Error(`Delivery not found: ${deliveryId}`);
  }

  return emitWebhookToEndpoint(
    tenantId,
    original.endpoint_id,
    original.event,
    original.payload,
  );
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
