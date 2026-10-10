import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutosaveStatus = "idle" | "saving" | "saved" | "error" | "offline";

export interface AutosaveIndicatorProps {
  status: AutosaveStatus;
  /** @deprecated RW-28: no longer rendered. Kept so existing callers still type-check. */
  lastSavedAt?: string | null;
  /** @deprecated RW-28: no longer rendered. Kept so existing callers still type-check. */
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
  const { status, "data-test-id": testId } = props;

  // Inject keyframe CSS once on mount (SSR-safe: injectStyles guards on window).
  useEffect(() => {
    injectStyles();
  }, []);

  // -------------------------------------------------------------------
  // Label
  // -------------------------------------------------------------------

  // RW-28: binary to the candidate. "Saving…" is transient only.
  // idle / error / offline all read "Not saved yet" (dot colour still differs).
  const label =
    status === "saved" ? "Saved" : status === "saving" ? "Saving…" : "Not saved yet";

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
