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
 *   - 3xx → status='failed' PERMANENT, no retry. Redirects are never followed
 *     (the target would be attacker-chosen) — see safe-post.ts.
 *   - Refused by the SSRF guard (destination resolves to a private / reserved
 *     address, or the URL breaks the policy) → status='failed' PERMANENT,
 *     last_error='blocked_address' | 'blocked_url', no retry.
 *   - 408/425/429 + 5xx + network errors (DNS, connect, TLS, 10 s timeout) →
 *     throw (triggers BullMQ retry per the WEBHOOK_RETRY_DELAYS_MS schedule).
 *     On the job's FINAL attempt the row is set to status='failed' first, so an
 *     exhausted delivery does not stay 'pending'.
 *
 * Every delivery carries two signatures: X-AssessIQ-Signature (V1, body only,
 * unchanged) and X-AssessIQ-Signature-V2 over "<X-AssessIQ-Timestamp>.<body>".
 *
 * NEVER log full webhook payload at INFO (PII/data-leakage risk), nor the full
 * endpoint URL (it often carries a secret path). Only structural metadata:
 * deliveryId, endpointId, event, status, httpStatus.
 */

import type { Job } from 'bullmq';
import { streamLogger } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import * as repo from '../repository.js';
import { signPayload, signPayloadV2 } from './signature.js';
import { getDecryptedSecret } from './service.js';
import {
  postWebhook,
  WebhookRefusedError,
  WEBHOOK_MAX_RESPONSE_BYTES,
  type PostDeps,
  type WebhookResponse,
} from './safe-post.js';

const log = streamLogger('webhook');

export interface WebhookDeliverJobData {
  deliveryId: string;
  tenantId: string;
}

/** "HTTP 400" or "HTTP 400: <receiver's error text>" — control chars out, <= 2 KB. */
function failureText(httpStatus: number, bodySnippet: string): string {
  const snippet = bodySnippet
    .replace(/[\u0000-\u001f\u007f]+/g, ' ') // NUL would make the Postgres write throw
    .trim()
    .slice(0, WEBHOOK_MAX_RESPONSE_BYTES);
  return snippet === '' ? `HTTP ${httpStatus}` : `HTTP ${httpStatus}: ${snippet}`;
}

/** True when the attempt now running is the job's last (BullMQ will not retry it). */
function isFinalAttempt(job: Job<WebhookDeliverJobData>): boolean {
  return job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
}

/**
 * Process one webhook delivery attempt.
 * Called by the BullMQ worker via runJobWithLogging. `deps` is a test seam;
 * production passes nothing.
 */
export async function processWebhookDeliverJob(
  job: Job<WebhookDeliverJobData>,
  deps: PostDeps = {},
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

  // 4. Serialize payload + sign. V1 (body only) stays for existing receivers;
  //    V2 binds the timestamp into the MAC so a captured delivery cannot be replayed.
  const body = JSON.stringify(delivery.payload);
  const timestamp = String(Math.floor(Date.now() / 1000)); // unix seconds

  // 5. POST through the SSRF-guarded transport.
  const startMs = Date.now();
  let response: WebhookResponse;

  try {
    response = await postWebhook(
      {
        url: endpoint.url,
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-AssessIQ-Event': delivery.event,
          'X-AssessIQ-Delivery': deliveryId,
          'X-AssessIQ-Signature': signPayload(body, secret),
          'X-AssessIQ-Timestamp': timestamp,
          'X-AssessIQ-Signature-V2': signPayloadV2(body, secret, timestamp),
          'User-Agent': 'AssessIQ-Webhooks/1.0',
        },
      },
      deps,
    );
  } catch (err: unknown) {
    if (err instanceof WebhookRefusedError) {
      // Deterministic policy refusal → permanent failure, never retried. The
      // tenant sees only the reason code; the resolved address stays in the log.
      await withTenant(tenantId, (client) =>
        repo.updateWebhookDeliveryStatus(client, deliveryId, {
          status: 'failed',
          lastError: err.reason,
          attempts: job.attemptsMade + 1,
        }),
      );
      log.warn(
        {
          deliveryId,
          endpointId: endpoint.id,
          event: delivery.event,
          reason: err.reason,
          host: err.host,
          address: err.address,
        },
        'webhook.delivery.refused',
      );
      return { deliveryId, status: 'failed', httpStatus: null };
    }

    // Network-level error (DNS, connect, TLS, timeout) — no HTTP response.
    log.warn(
      {
        deliveryId,
        endpointId: endpoint.id,
        event: delivery.event,
        latencyMs: Date.now() - startMs,
        errorClass: err instanceof Error ? err.constructor.name : 'Error',
        errorMessage: err instanceof Error ? err.message : String(err),
        attemptsMade: job.attemptsMade,
      },
      'webhook.delivery.network_error',
    );
    if (isFinalAttempt(job)) {
      await withTenant(tenantId, (client) =>
        repo.updateWebhookDeliveryStatus(client, deliveryId, {
          status: 'failed',
          lastError: `Retries exhausted: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            WEBHOOK_MAX_RESPONSE_BYTES,
          ),
          attempts: job.attemptsMade + 1,
        }),
      );
    }
    // Re-throw to let BullMQ handle retry scheduling.
    throw err;
  }

  const httpStatus = response.status;
  const latencyMs = Date.now() - startMs;

  if (httpStatus >= 200 && httpStatus < 300) {
    // 2xx — success
    await withTenant(tenantId, (client) =>
      repo.updateWebhookDeliveryStatus(client, deliveryId, {
        status: 'delivered',
        httpStatus,
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
  // 3xx = permanent (redirects are never followed).
  // 4xx (excluding transient ones) = permanent fail.
  // Transient 4xx that we DO retry: 408 (Request Timeout), 425 (Too Early), 429 (Rate Limited).
  const isRedirect = httpStatus >= 300 && httpStatus < 400;
  const isTransient4xx = [408, 425, 429].includes(httpStatus);
  const isPermanentFail =
    isRedirect || (httpStatus >= 400 && httpStatus < 500 && !isTransient4xx);

  if (isPermanentFail) {
    await withTenant(tenantId, (client) =>
      repo.updateWebhookDeliveryStatus(client, deliveryId, {
        status: 'failed',
        httpStatus,
        lastError: isRedirect
          ? `HTTP ${httpStatus}: redirects are not followed`
          : failureText(httpStatus, response.bodySnippet),
        attempts: job.attemptsMade + 1,
      }),
    );

    log.warn(
      { deliveryId, endpointId: endpoint.id, event: delivery.event, httpStatus, latencyMs },
      'webhook.delivery.permanent_fail',
    );

    // Return without throwing — BullMQ should NOT retry permanent failures.
    return { deliveryId, status: 'failed', httpStatus };
  }

  // Transient error (5xx or 408/425/429) — throw to trigger BullMQ retry.
  log.warn(
    { deliveryId, endpointId: endpoint.id, event: delivery.event, httpStatus, latencyMs, attemptsMade: job.attemptsMade },
    'webhook.delivery.retry',
  );
  if (isFinalAttempt(job)) {
    await withTenant(tenantId, (client) =>
      repo.updateWebhookDeliveryStatus(client, deliveryId, {
        status: 'failed',
        httpStatus,
        lastError: failureText(httpStatus, response.bodySnippet),
        attempts: job.attemptsMade + 1,
      }),
    );
  }
  throw new Error(`Transient HTTP ${httpStatus} from webhook endpoint`);
}
