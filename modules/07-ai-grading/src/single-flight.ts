/**
 * Single-flight mutex for Phase 1 admin AI work (D7) — grading AND generation.
 *
 * At most one AI subprocess runs across ALL API/worker processes. The lock is a
 * Redis lease on ONE global key (`aiq:ai:single-flight`); its value is
 * `${key}|${uuidv7}` so a contender can tell "same attempt" from "other work".
 *
 * TTL + heartbeat: generation runs can last 90s + 240s/item, so a fixed TTL
 * cannot cover them. The lease is 120s and refreshed every 40s while held; a
 * crashed holder frees the lock within 120s.
 *
 * RW-64 lease loss: the slot carries `signal`. It aborts when a refresh finds the
 * lease gone (refresh returned false), or after LOST_AFTER_FAILURES (2) refresh
 * errors in a row (2 x 40s = 80s, inside the 120s TTL, so we abort before the
 * lease can lapse unseen). The runtime kills the subprocess on abort; the
 * handler fails the attempt with AIG_LEASE_LOST. Scope note: the lock is per AI
 * *operation* (sharded generation fans out inside one lease, by design).
 *
 * FAIL-CLOSED (owner decision): if Redis is unreachable, acquire throws 503
 * AIG_LOCK_UNAVAILABLE. There is deliberately no in-process fallback.
 *
 * See docs/05-ai-pipeline.md § D7.
 *
 * Usage:
 *   const slot = await singleFlight.acquire(attemptId);
 *   if (slot.kind === "rejected") throw ...;
 *   try { ... } finally { await slot.release(); }
 */

import { AppError, acquireLock, peekLock, refreshLock, releaseLock, streamLogger, uuidv7 } from "@assessiq/core";
import { AI_GRADING_ERROR_CODES } from "./types.js";

const log = streamLogger("ai-grading");

const LOCK_KEY = "aiq:ai:single-flight";
const TTL_MS = 120_000;
const HEARTBEAT_MS = 40_000;
/** Consecutive refresh errors (Redis unreachable) that count as a lost lease. */
const LOST_AFTER_FAILURES = 2;

export type AcquireResult =
  | { kind: "acquired"; release: () => Promise<void>; signal: AbortSignal }
  | { kind: "rejected"; reason: "same_attempt_in_flight" | "other_attempt_in_flight" };

export const singleFlight = {
  /** D7: no queueing, no merging, no auto-retry. 409 is the intentional UX. */
  async acquire(key: string): Promise<AcquireResult> {
    const token = `${key}|${uuidv7()}`;
    let got: string | null;
    try {
      got = await acquireLock(LOCK_KEY, TTL_MS, token);
    } catch (err) {
      log.error({ err }, "single-flight: redis unavailable (fail-closed)");
      throw new AppError(
        "AI lock service is unavailable — try again shortly",
        AI_GRADING_ERROR_CODES.LOCK_UNAVAILABLE,
        503,
      );
    }
    if (got === null) {
      const held = await peekLock(LOCK_KEY).catch(() => null);
      return {
        kind: "rejected",
        reason: held?.startsWith(`${key}|`) ? "same_attempt_in_flight" : "other_attempt_in_flight",
      };
    }

    const lost = new AbortController();
    let failures = 0;
    const timer = setInterval(() => {
      // A hung Redis counts as a failed refresh after one heartbeat period.
      let hung: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, rej) => {
        hung = setTimeout(() => rej(new Error("lease refresh timed out")), HEARTBEAT_MS);
      });
      Promise.race([refreshLock(LOCK_KEY, token, TTL_MS), deadline])
        .finally(() => clearTimeout(hung))
        .then((ok) => {
          failures = 0;
          if (!ok) {
            log.warn({ key }, "single-flight: lease lost (refresh returned false)");
            lost.abort(new Error("single-flight lease lost"));
          }
        })
        .catch((err) => {
          log.warn({ err, key }, "single-flight: lease refresh failed");
          if (++failures >= LOST_AFTER_FAILURES) lost.abort(new Error("single-flight lease refresh failing"));
        });
    }, HEARTBEAT_MS);
    timer.unref();

    return {
      kind: "acquired",
      signal: lost.signal,
      async release() {
        clearInterval(timer);
        try {
          await releaseLock(LOCK_KEY, token);
        } catch (err) {
          log.warn({ err, key }, "single-flight: release failed (lease will expire)");
        }
      },
    };
  },

  /** Exposed for testing only — is any AI work in flight (any process)? */
  async isInFlight(): Promise<boolean> {
    return (await peekLock(LOCK_KEY)) !== null;
  },
} as const;
