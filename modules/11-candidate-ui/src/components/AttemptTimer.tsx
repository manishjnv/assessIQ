import React, { useEffect, useRef, useState } from "react";
import { Icon, Num } from "@assessiq/ui-system";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttemptTimerProps {
  /** ISO 8601 UTC string — server-pinned attempt deadline. */
  endsAt: string;
  /** Called once when remaining time crosses zero. The page should
   *  call /api/me/attempts/:id (which auto-submits server-side past
   *  ends_at) so server transitions, then route to /submitted. */
  onExpire?: () => void;
  /** Optional periodic drift-check callback. The hook fires every
   *  30 seconds and the page can re-fetch /api/me/attempts/:id to
   *  resync the local clock against server's `remaining_seconds`. */
  onDriftCheck?: () => void;
  "data-test-id"?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Formats a non-negative integer seconds value as mm:ss or h:mm:ss.
 * Negative input is clamped to 0.
 */
function formatRemaining(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h > 0) {
    return `${h}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/** Derive remaining seconds from an ISO deadline string. SSR-safe. */
function getRemainingSeconds(endsAt: string): number {
  if (typeof window === "undefined") {
    // SSR: parse deadline and use server-epoch diff — best-effort, no Date.now()
    // drift concern because the tick never starts server-side anyway.
    return Math.max(0, (new Date(endsAt).getTime() - Date.now()) / 1000);
  }
  return Math.max(0, (new Date(endsAt).getTime() - Date.now()) / 1000);
}

// ---------------------------------------------------------------------------
// Color logic
// ---------------------------------------------------------------------------

type FgToken =
  | "var(--aiq-color-fg-primary)"
  | "var(--aiq-color-warning)"
  | "var(--aiq-color-danger)";

function colorForRemaining(seconds: number): FgToken {
  if (seconds <= 60) return "var(--aiq-color-danger)";
  if (seconds <= 300) return "var(--aiq-color-warning)";
  return "var(--aiq-color-fg-primary)";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AttemptTimer: React.FC<AttemptTimerProps> = ({
  endsAt,
  onExpire,
  onDriftCheck,
  "data-test-id": testId,
}) => {
  // SSR-safe initial value: compute once from the deadline string.
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() =>
    getRemainingSeconds(endsAt)
  );

  // Guard: onExpire must fire exactly once, even under React StrictMode
  // double-invocation (which mounts → unmounts → mounts in dev).
  const expiredRef = useRef(false);

  // -------------------------------------------------------------------
  // Tick interval — derives remaining from deadline each tick (never
  // accumulates so tab-suspend / clock skew don't compound).
  // -------------------------------------------------------------------
  useEffect(() => {
    // If we're already at or past the deadline on mount, fire immediately.
    const initial = getRemainingSeconds(endsAt);
    if (initial <= 0) {
      setRemainingSeconds(0);
      if (!expiredRef.current) {
        expiredRef.current = true;
        onExpire?.();
      }
      return; // No interval needed.
    }

    setRemainingSeconds(initial);

    const id = setInterval(() => {
      const remaining = getRemainingSeconds(endsAt);
      setRemainingSeconds(remaining);

      if (remaining <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        clearInterval(id);
        onExpire?.();
      }
    }, 1000);

    return () => clearInterval(id);
    // endsAt intentionally not in deps: changing it mid-attempt is valid
    // (server may correct the deadline); we just let the new value flow
    // into getRemainingSeconds on each tick naturally.
    // onExpire omitted deliberately: changing the callback between renders
    // must not restart the interval — the ref captures the stable intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endsAt]);

  // -------------------------------------------------------------------
  // Drift-check interval — 30 s, separate lifecycle from the tick.
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!onDriftCheck) return;
    const id = setInterval(() => {
      onDriftCheck();
    }, 30_000);
    return () => clearInterval(id);
  }, [onDriftCheck]);

  // -------------------------------------------------------------------
  // Derived display values
  // -------------------------------------------------------------------
  const displaySeconds = Math.max(0, Math.floor(remainingSeconds));
  const formatted = formatRemaining(displaySeconds);
  const color = colorForRemaining(displaySeconds);

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------
  return (
    <div
      role="timer"
      aria-live="polite"
      aria-label={`${displaySeconds} seconds remaining`}
      data-test-id={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--aiq-space-sm)",
        borderRadius: "var(--aiq-radius-pill)",
        padding: "var(--aiq-space-xs) var(--aiq-space-md)",
        border: "1px solid var(--aiq-color-border)",
        background: "var(--aiq-color-bg-raised)",
        color,
        // Smooth color transitions between urgency states.
        transition: `color 300ms ease`,
      }}
    >
      {/* Decorative — aria-hidden by default when no aria-label passed */}
      <Icon name="clock" size={14} />
      <Num
        value={displaySeconds}
        format={formatRemaining}
        style={{ color }}
      />
    </div>
  );
};

AttemptTimer.displayName = "AttemptTimer";
