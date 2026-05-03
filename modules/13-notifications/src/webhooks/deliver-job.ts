/**
 * modules/13-notifications/src/webhooks/deliver-job.ts
 *
 * BullMQ job processor for 'webhook.deliver' jobs.
 *
 * Registered in apps/api/src/worker.ts via runJobWithLogging wrapper.
 *
 * Retry semantics (P3.D12):
 *   - 2xx → status='delivered', done.
 *   - 4xx (excluding 408/425/429) → status='failed' PERMANENT, no retry.
 *   - 408/425/429 + 5xx + network errors → throw (triggers BullMQ retry
 *     per the WEBHOOK_RETRY_DELAYS_MS literal schedule).
 *
 * NEVER log full webhook payload at INFO (PII/data-leakage risk).
 * Only log structural metadata: deliveryId, endpointId, event, status, httpStatus.
 */

import type { Job } from 'bullmq';
import { streamLogger } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import * as repo from '../repository.js';
import { signPayload } from './signature.js';
import { getDecryptedSecret } from './service.js';

const log = streamLogger('webhook');

export interface WebhookDeliverJobData {
  deliveryId: string;
  tenantId: string;
}

/**
 * Process one webhook delivery attempt.
 * Called by the BullMQ worker via runJobWithLogging.
 */
export async function processWebhookDeliverJob(
  job: Job<WebhookDeliverJobData>,
): Promise<{ deliveryId: string; status: string; httpStatus: number | null }> {
  const { deliveryId, tenantId } = job.data;

  // 1. Load the delivery row.
  const delivery = await withTenant(tenantId, (client) =>
    repo.getWebhookDeliveryById(client, deliveryId),
  );
  if (delivery === null) {
    // Delivery row not found — likely deleted. Mark permanent fail, don't retry.
    log.warn({ deliveryId, tenantId }, 'webhook.delivery.not_found');
    return { deliveryId, status: 'not_found', httpStatus: null };
  }

  // 2. Load the endpoint row.
  const endpoint = await withTenant(tenantId, (client) =>
    repo.getWebhookEndpointById(client, delivery.endpoint_id),
  );
  if (endpoint === null) {
    log.warn(
      { deliveryId, endpointId: delivery.endpoint_id, tenantId },
      'webhook.endpoint.not_found',
    );
    await withTenant(tenantId, (client) =>
      repo.updateWebhookDeliveryStatus(client, deliveryId, {
        status: 'failed',
        lastError: 'Endpoint not found',
        attempts: job.attemptsMade + 1,
      }),
    );
    return { deliveryId, status: 'failed', httpStatus: null };
  }

  // 3. Decrypt the endpoint secret.
  const secret = await getDecryptedSecret(tenantId, endpoint.id);
  if (secret === null) {
    log.error({ deliveryId, endpointId: endpoint.id }, 'webhook.secret.missing');
    await withTenant(tenantId, (client) =>
      repo.updateWebhookDeliveryStatus(client, deliveryId, {
        status: 'failed',
        lastError: 'Secret unavailable',
        attempts: job.attemptsMade + 1,
      }),
    );
    return { deliveryId, status: 'failed', httpStatus: null };
  }

  // 4. Serialize payload + sign.
  const body = JSON.stringify(delivery.payload);
  const signature = signPayload(body, secret);
  const timestamp = new Date().toISOString();

  // 5. POST to the endpoint URL.
  let httpStatus: number | null = null;
  let lastError: string | null = null;

  const startMs = Date.now();

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AssessIQ-Event': delivery.event,
        'X-AssessIQ-Delivery': deliveryId,
        'X-AssessIQ-Signature': signature,
        'X-AssessIQ-Timestamp': timestamp,
        'User-Agent': 'AssessIQ-Webhooks/1.0',
      },
      body,
      signal: AbortSignal.timeout(30_000), // 30s request timeout
    });

    httpStatus = response.status;
    const latencyMs = Date.now() - startMs;

    if (response.ok) {
      // 2xx — success
      await withTenant(tenantId, (client) =>
        repo.updateWebhookDeliveryStatus(client, deliveryId, {
          status: 'delivered',
          ...(httpStatus !== null ? { httpStatus } : {}),
          deliveredAt: new Date(),
          attempts: job.attemptsMade + 1,
          retryAt: null,
        }),
      );

      log.info(
        { deliveryId, endpointId: endpoint.id, event: delivery.event, httpStatus, latencyMs },
        'webhook.delivery.delivered',
      );

      return { deliveryId, status: 'delivered', httpStatus };
    }

    // Non-2xx — determine retry vs permanent fail.
    // 4xx (excluding transient ones) = permanent fail.
    // Transient 4xx that we DO retry: 408 (Request Timeout), 425 (Too Early), 429 (Rate Limited).
    const isTransient4xx = [408, 425, 429].includes(httpStatus);
    const isPermanentFail = httpStatus >= 400 && httpStatus < 500 && !isTransient4xx;

    lastError = `HTTP ${httpStatus}`;

    if (isPermanentFail) {
      await withTenant(tenantId, (client) =>
        repo.updateWebhookDeliveryStatus(client, deliveryId, {
          status: 'failed',
          ...(httpStatus !== null ? { httpStatus } : {}),
          ...(lastError !== null ? { lastError } : {}),
          attempts: job.attemptsMade + 1,
        }),
      );

      log.warn(
        { deliveryId, endpointId: endpoint.id, event: delivery.event, httpStatus, latencyMs },
        'webhook.delivery.permanent_fail',
      );

      // Return without throwing — BullMQ should NOT retry permanent 4xx failures.
      return { deliveryId, status: 'failed', httpStatus };
    }

    // Transient error (5xx or 408/425/429) — throw to trigger BullMQ retry.
    const err = new Error(`Transient HTTP ${httpStatus} from webhook endpoint`);
    log.warn(
      { deliveryId, endpointId: endpoint.id, event: delivery.event, httpStatus, latencyMs, attemptsMade: job.attemptsMade },
      'webhook.delivery.retry',
    );
    throw err;

  } catch (err: unknown) {
    const latencyMs = Date.now() - startMs;

    // If err is a response-related Error we already threw — re-throw.
    // If err is a network error (fetch threw before we got a response), throw to retry.
    if (httpStatus !== null && [408, 425, 429].includes(httpStatus)) {
      throw err; // already logged above
    }
    if (httpStatus !== null && httpStatus >= 500) {
      throw err; // already logged above
    }
    if (httpStatus !== null) {
      // This branch shouldn't occur given the logic above, but be safe.
      throw err;
    }

    // Network-level error (no HTTP response).
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorClass = err instanceof Error ? err.constructor.name : 'Error';

    log.warn(
      {
        deliveryId,
        endpointId: endpoint.id,
        event: delivery.event,
        latencyMs,
        errorClass,
        errorMessage,
        attemptsMade: job.attemptsMade,
      },
      'webhook.delivery.network_error',
    );

    // Re-throw to let BullMQ handle retry scheduling.
    throw err;
  }
}
