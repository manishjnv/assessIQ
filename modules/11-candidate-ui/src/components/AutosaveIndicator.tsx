import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutosaveStatus = "idle" | "saving" | "saved" | "error" | "offline";

export interface AutosaveIndicatorProps {
  status: AutosaveStatus;
  /** ISO 8601 UTC string — last successful save time. Rendered when status === "saved". */
  lastSavedAt?: string | null;
  /** Pending retry count when status === "error". */
  retryCount?: number;
  "data-test-id"?: string;
}

// ---------------------------------------------------------------------------
// Keyframe injection (once per page load, SSR-safe)
// ---------------------------------------------------------------------------

const STYLE_ID = "aiq-autosave-style";

function injectStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;

  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
@keyframes aiq-autosave-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.5; }
}
.aiq-autosave-dot-saving {
  animation: aiq-autosave-pulse 800ms ease-in-out infinite;
}
`.trim();
  document.head.appendChild(el);
}

// ---------------------------------------------------------------------------
// Relative-time helper
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  return `${diffHour}h ago`;
}

// ---------------------------------------------------------------------------
// Dot color map
// ---------------------------------------------------------------------------

const DOT_COLOR: Record<AutosaveStatus, string> = {
  idle:    "var(--aiq-color-fg-muted)",
  saving:  "var(--aiq-color-info)",
  saved:   "var(--aiq-color-success)",
  error:   "var(--aiq-color-danger)",
  offline: "var(--aiq-color-warning)",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AutosaveIndicator(props: AutosaveIndicatorProps) {
  const {
    status,
    lastSavedAt,
    retryCount,
    "data-test-id": testId,
  } = props;

  // Tick state — forces re-render every 30 s while status is "saved" so the
  // relative timestamp stays current without a save event.
  const [tick, setTick] = useState(0);

  // Inject keyframe CSS once on mount (SSR-safe: injectStyles guards on window).
  useEffect(() => {
    injectStyles();
  }, []);

  // 30-second interval — only active while status === "saved".
  useEffect(() => {
    if (status !== "saved") return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [status]);

  // Suppress the unused-variable lint warning; tick is consumed implicitly via
  // the closure that re-runs the render when it changes.
  void tick;

  // -------------------------------------------------------------------
  // Label
  // -------------------------------------------------------------------

  let label: string;

  switch (status) {
    case "idle":
      label = "Idle";
      break;

    case "saving":
      label = "Saving…"; // "Saving…"
      break;

    case "saved":
      if (lastSavedAt) {
        label = `Saved · ${formatRelative(lastSavedAt)}`; // "Saved · X"
      } else {
        label = "Saved";
      }
      break;

    case "error":
      if (retryCount && retryCount > 0) {
        label = `Save failed · retry ${retryCount}/5`;
      } else {
        label = "Save failed";
      }
      break;

    case "offline":
      label = "Offline · queued"; // "Offline · queued"
      break;
  }

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  return (
    <span
      role="status"
      aria-live="polite"
      data-test-id={testId}
      style={{
        display:        "inline-flex",
        alignItems:     "center",
        gap:            "var(--aiq-space-xs)",
        padding:        "var(--aiq-space-2xs) var(--aiq-space-sm)",
        border:         "1px solid var(--aiq-color-border)",
        borderRadius:   "var(--aiq-radius-pill)",
        background:     "var(--aiq-color-bg-raised)",
        fontSize:       "var(--aiq-text-sm)",
        fontFamily:     "var(--aiq-font-sans)",
        lineHeight:     1.4,
        userSelect:     "none",
        whiteSpace:     "nowrap",
      }}
    >
      {/* Status dot — pure CSS circle, no Icon import needed for a simple shape */}
      <span
        aria-hidden="true"
        className={status === "saving" ? "aiq-autosave-dot-saving" : undefined}
        style={{
          display:      "inline-block",
          width:        8,
          height:       8,
          borderRadius: "50%",
          flexShrink:   0,
          backgroundColor: DOT_COLOR[status],
        }}
      />

      {/* Visible + announced label */}
      <span>{label}</span>
    </span>
  );
}

AutosaveIndicator.displayName = "AutosaveIndicator";
