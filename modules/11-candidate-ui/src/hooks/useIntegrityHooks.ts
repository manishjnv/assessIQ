import { useEffect, useRef } from "react";
import { recordEvent } from "../api";
import type { CandidateEventType } from "../types";

export interface UseIntegrityHooksArgs {
  attemptId: string;
  /** Active question id, used as the question_id on emitted events. */
  currentQuestionId: string | null;
  /** When false, the hooks attach but emit nothing (e.g. while attempt is locked / submitted). */
  enabled?: boolean;
}

// Token-bucket state kept in a ref — not React state because mutations must be
// synchronous and should not trigger re-renders.
interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const RATE_LIMIT_PER_SEC = 8; // Server cap is 10/sec; we budget 8 for headroom (decision #23).
const PER_ATTEMPT_CAP = 5000;

export function useIntegrityHooks({
  attemptId,
  currentQuestionId,
  enabled = true,
}: UseIntegrityHooksArgs): void {
  const bucketRef = useRef<TokenBucket>({ tokens: RATE_LIMIT_PER_SEC, lastRefill: Date.now() });
  const emitCountRef = useRef(0);

  // ── Token-bucket emit helper ───────────────────────────────────────────────

  function emit(
    eventType: CandidateEventType,
    questionId: string | null | undefined,
    payload?: Record<string, unknown>
  ): void {
    if (!enabled) return;

    // Per-attempt total cap.
    if (emitCountRef.current >= PER_ATTEMPT_CAP) return;

    // Token-bucket refill.
    const now = Date.now();
    const bucket = bucketRef.current;
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(RATE_LIMIT_PER_SEC, bucket.tokens + elapsed * RATE_LIMIT_PER_SEC);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) return; // Rate limit exceeded — drop silently.

    bucket.tokens -= 1;
    emitCountRef.current += 1;

    // Fire-and-forget; never surface event API errors to the candidate.
    // exactOptionalPropertyTypes: omit keys when value is undefined rather
    // than passing `undefined` for `string | null` / optional fields.
    recordEvent(attemptId, {
      event_type: eventType,
      question_id: questionId ?? null,
      ...(payload !== undefined ? { payload } : {}),
    }).catch(() => {});
  }

  // ── Visibility (tab blur / focus) ─────────────────────────────────────────

  useEffect(() => {
    if (!enabled) return;

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        emit("tab_blur", currentQuestionId);
      } else {
        emit("tab_focus", currentQuestionId);
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId, currentQuestionId, enabled]);

  // ── Copy / paste ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!enabled) return;

    function handleCopy(e: ClipboardEvent) {
      // Only emit the text length — never the actual clipboard content.
      const length = e.clipboardData?.getData("text/plain").length ?? 0;
      emit("copy", currentQuestionId, { length });
      // Do NOT retain a reference to e after handler returns.
    }

    function handlePaste(e: ClipboardEvent) {
      const length = e.clipboardData?.getData("text/plain").length ?? 0;
      emit("paste", currentQuestionId, { length });
    }

    document.addEventListener("copy", handleCopy);
    document.addEventListener("paste", handlePaste);
    return () => {
      document.removeEventListener("copy", handleCopy);
      document.removeEventListener("paste", handlePaste);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId, currentQuestionId, enabled]);

  // ── Question view ─────────────────────────────────────────────────────────

  useEffect(() => {
    // Don't emit if there is no active question yet.
    if (!enabled || currentQuestionId === null) return;

    emit("question_view", currentQuestionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId, currentQuestionId, enabled]);
}
