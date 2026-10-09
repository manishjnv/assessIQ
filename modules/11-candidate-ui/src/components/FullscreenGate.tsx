import { useEffect, useRef } from "react";
import { Button } from "@assessiq/ui-system";

export interface FullscreenGateProps {
  /** Times the candidate left full screen after entering it (0 = first prompt). */
  exitCount: number;
  /** Must call requestFullscreen synchronously — it runs inside the click handler. */
  onEnter: () => void;
}

/**
 * Blocking "this test runs in full screen" dialog. Focus is trapped on the single
 * button, Esc does not dismiss it, the timer is not paused (server-authoritative).
 */
export function FullscreenGate({ exitCount, onEnter }: FullscreenGateProps) {
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    btnRef.current?.focus();
  }, []);

  function trap(e: React.KeyboardEvent) {
    // One focusable control: Tab/Shift+Tab stay on it; Esc is swallowed.
    if (e.key === "Tab" || e.key === "Escape") {
      e.preventDefault();
      btnRef.current?.focus();
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="aiq-fs-title"
      aria-describedby="aiq-fs-desc"
      data-test-id="fullscreen-gate"
      onKeyDown={trap}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "color-mix(in srgb, var(--aiq-color-bg-base) 94%, transparent)",
        fontFamily: "var(--aiq-font-sans)",
      }}
    >
      <div
        style={{
          maxWidth: 440,
          padding: "var(--aiq-space-lg)",
          border: "1px solid var(--aiq-color-border)",
          borderRadius: "var(--aiq-radius-md)",
          background: "var(--aiq-color-bg-raised)",
          textAlign: "center",
        }}
      >
        <h2 id="aiq-fs-title" style={{ margin: 0, fontSize: "var(--aiq-text-lg)" }}>
          This assessment runs in full screen
        </h2>
        <p id="aiq-fs-desc" style={{ fontSize: "var(--aiq-text-sm)" }}>
          {exitCount > 0 ? (
            <span role="status" aria-live="polite">
              You left full screen {exitCount} time{exitCount === 1 ? "" : "s"}. This is recorded.{" "}
            </span>
          ) : null}
          Your timer keeps running. Press the button to continue.
        </p>
        <Button ref={btnRef} variant="primary" onClick={onEnter}>
          Enter full screen
        </Button>
      </div>
    </div>
  );
}

FullscreenGate.displayName = "FullscreenGate";
