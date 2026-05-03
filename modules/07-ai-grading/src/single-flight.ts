/**
 * Single-flight mutex for Phase 1 admin grading (D7).
 *
 * Enforces at most one concurrent grading subprocess per API process.
 * Keyed by attempt_id; also blocks cross-attempt concurrency (inFlight.size > 0).
 *
 * See docs/05-ai-pipeline.md § D7 for the full rationale and multi-replica
 * safety discussion.
 *
 * Usage:
 *   const slot = singleFlight.acquire(attemptId);
 *   if (slot.kind === "rejected") throw ...;
 *   try { ... } finally { slot.release(); }
 */

export type AcquireResult =
  | { kind: "acquired"; release: () => void }
  | { kind: "rejected"; reason: "same_attempt_in_flight" | "other_attempt_in_flight" };

const inFlight = new Map<string, true>();

export const singleFlight = {
  /**
   * Attempt to acquire the single-flight slot for the given attemptId.
   *
   * Returns `{ kind: "acquired", release }` on success.
   * Returns `{ kind: "rejected", reason }` when another grading is in flight:
   *   - "same_attempt_in_flight"  — same attemptId already running
   *   - "other_attempt_in_flight" — different attempt is running
   *
   * D7: no queueing, no merging, no auto-retry. 409 is the intentional UX.
   */
  acquire(attemptId: string): AcquireResult {
    if (inFlight.has(attemptId)) {
      return { kind: "rejected", reason: "same_attempt_in_flight" };
    }
    if (inFlight.size > 0) {
      return { kind: "rejected", reason: "other_attempt_in_flight" };
    }
    inFlight.set(attemptId, true);
    return {
      kind: "acquired",
      release() {
        inFlight.delete(attemptId);
      },
    };
  },

  /** Exposed for testing only — check if any grading is in flight. */
  isInFlight(): boolean {
    return inFlight.size > 0;
  },
} as const;
