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
 * ponytail: a lost lease (Redis gone >80s mid-run, then back) only logs; the
 * running subprocess is not killed, so a second holder could overlap until the
 * first one's runtime timeout. Upgrade path: pass an AbortSignal into the
 * runtime and abort on lease loss. Scope note: the lock is per AI *operation*
 * (sharded generation fans out inside one lease, by design); rubric and
 * answer-guidance drafts in 04-question-bank do not take it yet (follow-up row).
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

export type AcquireResult =
  | { kind: "acquired"; release: () => Promise<void> }
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

    const timer = setInterval(() => {
      refreshLock(LOCK_KEY, token, TTL_MS)
        .then((ok) => {
          if (!ok) log.warn({ key }, "single-flight: lease lost (refresh returned false)");
        })
        .catch((err) => log.warn({ err, key }, "single-flight: lease refresh failed"));
    }, HEARTBEAT_MS);
    timer.unref();

    return {
      kind: "acquired",
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
