// AssessIQ — DangerConfirmModal.
//
// A small confirmation dialog for irreversible / destructive admin actions
// (delete an assessment, cancel an assessment). Mirrors ReleaseConfirmModal's
// overlay + card + ESC + click-outside conventions, kept generic so other
// destructive flows can reuse it.
//
// INVARIANTS:
//  - Plain text / React nodes only — no dangerouslySetInnerHTML.
//  - Click-outside and ESC both cancel, but NOT while an action is in flight
//    (busy) — so a mis-click can't abandon a half-run request.
//  - No danger button class exists in the kit (only ghost/outline/primary), so
//    the destructive button is aiq-btn-primary tinted with --aiq-color-danger.

import React from "react";

export interface DangerConfirmModalProps {
  open: boolean;
  title: string;
  /** Body copy — typically the entity name + an "this cannot be undone" note. */
  body: React.ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  /** Red destructive button when true (default); neutral primary when false. */
  danger?: boolean;
  /** Optional error (e.g. a 422 from the server) shown above the buttons. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const DANGER_BTN_STYLE: React.CSSProperties = {
  background: "var(--aiq-color-danger)",
  borderColor: "var(--aiq-color-danger)",
  color: "#fff",
};

export function DangerConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  busyLabel,
  busy,
  danger = true,
  error,
  onConfirm,
  onCancel,
}: DangerConfirmModalProps): React.ReactElement | null {
  React.useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dcm-heading"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--aiq-space-md)",
        background: "rgba(0,0,0,0.55)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="aiq-card"
        style={{
          width: "100%",
          maxWidth: 460,
          background: "var(--aiq-color-bg-base)",
          borderRadius: "var(--aiq-radius-md)",
          padding: "var(--aiq-space-lg)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--aiq-space-md)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2
            id="dcm-heading"
            style={{
              margin: 0,
              fontFamily: "var(--aiq-font-serif)",
              fontSize: "var(--aiq-text-xl)",
              color: "var(--aiq-color-fg-primary)",
              fontWeight: 600,
            }}
          >
            {title}
          </h2>
          <div
            style={{
              margin: "var(--aiq-space-xs) 0 0",
              fontSize: "var(--aiq-text-sm)",
              color: "var(--aiq-color-fg-secondary)",
              fontFamily: "var(--aiq-font-sans)",
              lineHeight: 1.5,
            }}
          >
            {body}
          </div>
        </div>

        {error != null && error !== "" && (
          <div
            style={{
              fontSize: "var(--aiq-text-sm)",
              fontFamily: "var(--aiq-font-sans)",
              color: "var(--aiq-color-danger)",
              background: "var(--aiq-color-bg-sunken)",
              borderRadius: "var(--aiq-radius-sm)",
              padding: "var(--aiq-space-sm)",
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--aiq-space-sm)",
            paddingTop: "var(--aiq-space-sm)",
            borderTop: "1px solid var(--aiq-color-border)",
          }}
        >
          <button
            className="aiq-btn aiq-btn-ghost"
            onClick={onCancel}
            disabled={busy}
            type="button"
          >
            Keep it
          </button>
          <button
            className="aiq-btn aiq-btn-primary"
            style={danger ? DANGER_BTN_STYLE : undefined}
            onClick={onConfirm}
            disabled={busy}
            type="button"
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

DangerConfirmModal.displayName = "DangerConfirmModal";
