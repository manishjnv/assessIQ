// AssessIQ — Modal component.
//
// Focus-trapped dialog. Escape key and backdrop click both close (configurable).
//
// INVARIANTS (branding-guideline.md):
//  - No box-shadow on the modal panel at rest — uses --aiq-shadow-lg for floating.
//  - Backdrop is semi-transparent with a blur.

import React, { useEffect, useRef } from "react";

export interface ModalProps {
  /** Whether the modal is visible. */
  open: boolean;
  /** Called when the modal should close (Escape / backdrop click). */
  onClose: () => void;
  /** Optional title shown in the modal header. */
  title?: string;
  /** Whether clicking the backdrop closes the modal. Default: true. */
  closeOnBackdrop?: boolean;
  /** Width of the modal panel. Default: 480px. */
  width?: number | string;
  children: React.ReactNode;
  "data-test-id"?: string;
}

export function Modal({
  open,
  onClose,
  title,
  closeOnBackdrop = true,
  width = 480,
  children,
  "data-test-id": testId,
}: ModalProps): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Focus trap: move focus into panel when opened
  useEffect(() => {
    if (open && panelRef.current) {
      const first = panelRef.current.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-test-id={testId}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "var(--aiq-z-modal)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={closeOnBackdrop ? onClose : undefined}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "blur(2px)",
        }}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        className="aiq-card"
        style={{
          position: "relative",
          width,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)",
          overflowY: "auto",
          padding: "var(--aiq-space-xl)",
          boxShadow: "var(--aiq-shadow-lg)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--aiq-space-md)",
        }}
      >
        {title && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h2
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                margin: 0,
                color: "var(--aiq-color-fg-primary)",
              }}
            >
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close modal"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--aiq-color-fg-muted)",
                padding: 4,
                lineHeight: 1,
                fontSize: 18,
              }}
            >
              ✕
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

Modal.displayName = "Modal";
