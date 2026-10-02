/**
 * modules/13-notifications/src/webhooks/retry-schedule.ts
 *
 * Webhook retry schedule — P3.D12: LITERAL [1m, 5m, 30m, 2h, 12h].
 * NOT exponential. This is a published API contract per docs/03-api-contract.md:324.
 *
 * Used in BullMQ job options and in the deliver-job processor.
 */

/** Literal retry delay schedule in milliseconds. P3.D12 — NOT exponential. */
export const WEBHOOK_RETRY_DELAYS_MS: ReadonlyArray<number> = [
  60_000,       // 1 minute
  300_000,      // 5 minutes
  1_800_000,    // 30 minutes
  7_200_000,    // 2 hours
  43_200_000,   // 12 hours
] as const;

/**
 * Returns the delay in milliseconds for a given attempt number.
 * `attemptsMade` is BullMQ's zero-indexed count of previous attempts.
 *
 * Attempt 0 = first retry (after first failure): 1 minute
 * Attempt 1 = second retry: 5 minutes
 * ...
 * Attempt 4 = fifth retry: 12 hours
 * Attempt >= 5 = undefined (permanent fail, no more retries)
 */
export function delayFor(attemptsMade: number): number | undefined {
  return WEBHOOK_RETRY_DELAYS_MS[attemptsMade];
}

/**
 * BullMQ custom backoff strategy function.
 * Registered as the 'webhook-literal' strategy in the Worker settings.
 * BullMQ passes the 1-BASED count of attempts already made (1 after the first
 * failure), so retry N uses schedule[N-1]. Clamped to the last delay.
 */
export function webhookBackoffStrategy(attemptsMade: number): number {
  const last = WEBHOOK_RETRY_DELAYS_MS.length - 1;
  return WEBHOOK_RETRY_DELAYS_MS[Math.min(Math.max(attemptsMade - 1, 0), last)]!;
}
