/**
 * modules/13-notifications/src/webhooks/business-events.ts
 *
 * FU-B6: business webhook events (attempt.submitted, attempt.graded,
 * result.released). Ids-only payload: no scores, answers, or PII.
 *
 * Call inside the caller's withTenant transaction. The emit runs AFTER COMMIT
 * (onCommit), so a rollback sends nothing; a delivery failure is logged and
 * never reaches the caller.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import type { PoolClient } from 'pg';
import { streamLogger } from '@assessiq/core';
import { onCommit } from '@assessiq/tenancy';
import { emitWebhook } from './service.js';

const log = streamLogger('webhook');

export const BUSINESS_WEBHOOK_EVENTS = [
  'attempt.submitted',
  'attempt.graded',
  'result.released',
] as const;
export type BusinessWebhookEvent = (typeof BUSINESS_WEBHOOK_EVENTS)[number];

export interface BusinessEventPayload {
  event: BusinessWebhookEvent;
  tenant_id: string;
  attempt_id: string;
  assessment_id: string;
  candidate_id: string | null;
  occurred_at: string;
}

export async function emitAttemptEventAfterCommit(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
  event: BusinessWebhookEvent,
): Promise<void> {
  const res = await client.query<{ assessment_id: string; user_id: string | null }>(
    `SELECT assessment_id, user_id FROM attempts WHERE id = $1`,
    [attemptId],
  );
  const row = res.rows[0];
  if (row === undefined) return;
  const payload: BusinessEventPayload = {
    event,
    tenant_id: tenantId,
    attempt_id: attemptId,
    assessment_id: row.assessment_id,
    candidate_id: row.user_id,
    occurred_at: new Date().toISOString(),
  };
  const registered = onCommit(client, async () => {
    try {
      await emitWebhook({ tenantId, event, payload });
    } catch (err: unknown) {
      log.error({ err, tenantId, attemptId, event }, 'business-event: emitWebhook failed');
    }
  });
  // ponytail: every caller runs inside withTenant today; log if one ever does not.
  if (!registered) log.warn({ tenantId, attemptId, event }, 'business-event: not inside withTenant, event not sent');
}
