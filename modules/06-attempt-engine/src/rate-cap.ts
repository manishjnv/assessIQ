/**
 * In-process per-attempt rate cap (decision #23).
 *
 * Two distinct caps:
 *   1. PER-SECOND BURST: at most 10 events/second per attempt. Token bucket
 *      with 1s window and 10 tokens; bursts above the cap are dropped silently
 *      (no error to the candidate so the rate logic is not learnable client-side).
 *   2. PER-ATTEMPT TOTAL: at most 5000 events per attempt. The DB enforces the
 *      cap-once invariant via a partial UNIQUE index on
 *      (attempt_id) WHERE event_type = 'event_volume_capped' — the FIRST overflow
 *      attempt inserts the marker; subsequent inserts hit a 23505 unique
 *      violation that the service layer catches and translates into a no-op.
 *
 * THIS MODULE handles the per-second cap. The per-attempt total cap lives in
 * the service layer because it requires a DB count.
 *
 * SCALE-OUT NOTE: this implementation is in-process per-Node-process. Because
 * each candidate is a single user with a single attempt active at a time, and
 * the API is a single-process Fastify server in Phase 1, in-process is
 * sufficient. Phase 2+ scale-out (multi-replica API) needs a Redis token bucket
 * keyed `aiq:attempt:<id>:events` per the original SKILL.md design. Documented
 * in modules/06-attempt-engine/SKILL.md § Open questions.
 *
 * Memory: at most 10000 active attempts × ~64 bytes = ~640 KB. Buckets are
 * lazily created and pruned when an attempt's bucket has been idle longer
 * than IDLE_PRUNE_MS. Pruning runs probabilistically on each call (1 in 1000
 * lookups) to avoid a separate timer and stay deterministic for tests.
 */

const PER_SECOND_LIMIT = 10;
const PER_SECOND_WINDOW_MS = 1000;
const IDLE_PRUNE_MS = 60_000; // drop buckets idle > 60s

interface Bucket {
  windowStartMs: number;
  countInWindow: number;
  lastSeenMs: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Try to admit one event for `attemptId` at time `nowMs`. Returns true if
 * the event is within the per-second cap; false otherwise.
 */
export function tryAdmitEvent(attemptId: string, nowMs: number = Date.now()): boolean {
  // Probabilistic prune to keep the map bounded under long-running tests.
  if (Math.random() < 0.001) {
    pruneIdleBuckets(nowMs);
  }

  const existing = buckets.get(attemptId);
  if (existing === undefined) {
    buckets.set(attemptId, {
      windowStartMs: nowMs,
      countInWindow: 1,
      lastSeenMs: nowMs,
    });
    return true;
  }

  if (nowMs - existing.windowStartMs >= PER_SECOND_WINDOW_MS) {
    // Window rolled — reset.
    existing.windowStartMs = nowMs;
    existing.countInWindow = 1;
    existing.lastSeenMs = nowMs;
    return true;
  }

  existing.lastSeenMs = nowMs;
  if (existing.countInWindow >= PER_SECOND_LIMIT) {
    return false;
  }
  existing.countInWindow++;
  return true;
}

/** Drop buckets idle longer than IDLE_PRUNE_MS. */
export function pruneIdleBuckets(nowMs: number = Date.now()): number {
  let pruned = 0;
  for (const [id, b] of buckets) {
    if (nowMs - b.lastSeenMs > IDLE_PRUNE_MS) {
      buckets.delete(id);
      pruned++;
    }
  }
  return pruned;
}

/** Test-only: clear all buckets (call from afterEach in unit tests). */
export function _resetForTesting(): void {
  buckets.clear();
}

/** Test-only: bucket count. */
export function _bucketCount(): number {
  return buckets.size;
}

export const RATE_CAP_CONSTANTS = {
  PER_SECOND_LIMIT,
  PER_SECOND_WINDOW_MS,
  IDLE_PRUNE_MS,
  /** Per-attempt total event cap (decision #23) — enforced in service.ts via DB count. */
  PER_ATTEMPT_TOTAL: 5000,
} as const;
