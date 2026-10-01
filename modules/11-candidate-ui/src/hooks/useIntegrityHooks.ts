import { useCallback, useEffect, useRef, useState } from "react";
import { recordEvent } from "../api";
import type { CandidateEventType } from "../types";

export interface UseIntegrityHooksArgs {
  attemptId: string;
  /** Active question id, used as the question_id on emitted events. */
  currentQuestionId: string | null;
  /** When false, the hooks attach but emit nothing (e.g. while attempt is locked / submitted). */
  enabled?: boolean;
  /** settings.integrity.block_copy_paste: cancel copy/cut/paste/contextmenu (still recorded, blocked:true). */
  blockCopyPaste?: boolean;
  /** settings.integrity.fullscreen: require full screen (only enforced where the browser supports it). */
  fullscreenRequired?: boolean;
}

export interface IntegrityHooksState {
  /** Times the candidate came back after leaving the test tab (this page load, or session). */
  leaveCount: number;
  /** True right after a return; cleared by dismissLeaveWarning. */
  showLeaveWarning: boolean;
  dismissLeaveWarning: () => void;
  /** True for a few seconds after a blocked copy/cut/paste/contextmenu (throttled). */
  copyBlockedNotice: boolean;
  /** Full screen is required, supported, and the candidate is not in it. */
  fullscreenGateOpen: boolean;
  /** Times the candidate left full screen after entering it. */
  fullscreenExitCount: number;
  /** Call from a click handler — requestFullscreen needs a user gesture. */
  enterFullscreen: () => void;
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
  blockCopyPaste = false,
  fullscreenRequired = false,
}: UseIntegrityHooksArgs): IntegrityHooksState {
  const bucketRef = useRef<TokenBucket>({ tokens: RATE_LIMIT_PER_SEC, lastRefill: Date.now() });
  const emitCountRef = useRef(0);
  const questionIdRef = useRef<string | null>(currentQuestionId);
  questionIdRef.current = currentQuestionId;

  // Tab-leave count survives a reload within the browser session (best effort).
  const leaveKey = `aiq:leaves:${attemptId}`;
  const [leaveCount, setLeaveCount] = useState<number>(() => {
    try {
      return Number(sessionStorage.getItem(leaveKey)) || 0;
    } catch {
      return 0;
    }
  });
  const [showLeaveWarning, setShowLeaveWarning] = useState(false);
  const [copyBlockedNotice, setCopyBlockedNotice] = useState(false);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hiddenRef = useRef(false);

  const fullscreenSupported =
    fullscreenRequired && typeof document !== "undefined" && document.fullscreenEnabled === true;
  const [isFullscreen, setIsFullscreen] = useState(
    () => typeof document !== "undefined" && document.fullscreenElement != null,
  );
  const [fullscreenExitCount, setFullscreenExitCount] = useState(0);

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
        hiddenRef.current = true;
        emit("tab_blur", currentQuestionId);
      } else {
        emit("tab_focus", currentQuestionId);
        if (hiddenRef.current) {
          hiddenRef.current = false;
          setLeaveCount((n) => {
            const next = n + 1;
            try {
              sessionStorage.setItem(leaveKey, String(next));
            } catch {
              /* storage unavailable — per-page-load count only */
            }
            return next;
          });
          setShowLeaveWarning(true);
        }
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [attemptId, currentQuestionId, enabled]);

  // ── Copy / paste ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!enabled) return;

    function notifyBlocked() {
      // Throttled: one visible note per 5 s.
      if (noticeTimerRef.current !== null) return;
      setCopyBlockedNotice(true);
      noticeTimerRef.current = setTimeout(() => {
        noticeTimerRef.current = null;
        setCopyBlockedNotice(false);
      }, 5000);
    }

    function handleCopy(e: ClipboardEvent) {
      // Only emit the text length — never the actual clipboard content.
      const length = e.clipboardData?.getData("text/plain").length ?? 0;
      emit("copy", currentQuestionId, blockCopyPaste ? { length, blocked: true } : { length });
      if (blockCopyPaste) {
        e.preventDefault();
        notifyBlocked();
      }
      // Do NOT retain a reference to e after handler returns.
    }

    function handlePaste(e: ClipboardEvent) {
      const length = e.clipboardData?.getData("text/plain").length ?? 0;
      emit("paste", currentQuestionId, blockCopyPaste ? { length, blocked: true } : { length });
      if (blockCopyPaste) {
        e.preventDefault();
        notifyBlocked();
      }
    }

    // cut and right-click menu: cancelled only; not in the event catalog.
    function handleBlockOnly(e: Event) {
      e.preventDefault();
      notifyBlocked();
    }

    document.addEventListener("copy", handleCopy);
    document.addEventListener("paste", handlePaste);
    if (blockCopyPaste) {
      document.addEventListener("cut", handleBlockOnly);
      document.addEventListener("contextmenu", handleBlockOnly);
    }
    return () => {
      document.removeEventListener("copy", handleCopy);
      document.removeEventListener("paste", handlePaste);
      document.removeEventListener("cut", handleBlockOnly);
      document.removeEventListener("contextmenu", handleBlockOnly);
    };
  }, [attemptId, currentQuestionId, enabled, blockCopyPaste]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  // ── Full screen ───────────────────────────────────────────────────────────
  // Exits are recorded, not prevented. The server timer is authoritative and
  // keeps running under the overlay.

  useEffect(() => {
    if (!fullscreenSupported || !enabled) return;

    function handleChange() {
      if (document.fullscreenElement != null) {
        setIsFullscreen(true);
        emit("fullscreen_enter", questionIdRef.current);
      } else {
        setIsFullscreen(false);
        setFullscreenExitCount((n) => n + 1);
        emit("fullscreen_exit", questionIdRef.current);
      }
    }

    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, [attemptId, enabled, fullscreenSupported]);

  // Leave full screen when the attempt ends (locked) or the page unmounts (submit).
  useEffect(() => {
    if (!enabled && document.fullscreenElement != null) void document.exitFullscreen().catch(() => {});
  }, [enabled]);
  useEffect(
    () => () => {
      if (document.fullscreenElement != null) void document.exitFullscreen().catch(() => {});
    },
    [],
  );

  const enterFullscreen = useCallback(() => {
    void document.documentElement.requestFullscreen().catch(() => {});
  }, []);
  const dismissLeaveWarning = useCallback(() => setShowLeaveWarning(false), []);

  // ── Question view ─────────────────────────────────────────────────────────

  useEffect(() => {
    // Don't emit if there is no active question yet.
    if (!enabled || currentQuestionId === null) return;

    emit("question_view", currentQuestionId);
  }, [attemptId, currentQuestionId, enabled]);

  return {
    leaveCount,
    showLeaveWarning,
    dismissLeaveWarning,
    copyBlockedNotice,
    fullscreenGateOpen: fullscreenSupported && enabled && !isFullscreen,
    fullscreenExitCount,
    enterFullscreen,
  };
}
