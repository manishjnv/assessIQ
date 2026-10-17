// AssessIQ — Drawer component.
//
// Right-side slide-in panel (560px default). Escape key closes.
// Shares visual language with 16-help-system's HelpDrawer but has
// explicit onClose semantics and no help-data coupling.
//
// INVARIANTS (branding-guideline.md):
//  - Backdrop semi-transparent.
//  - Panel has no box-shadow at rest — only the elevation from z-index
//    positioning makes it appear on top.

import React, { useEffect, useRef } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Width of the drawer panel. Default: 560px. */
  width?: number | string;
  /** Whether clicking the backdrop closes the drawer. Default: true. */
  closeOnBackdrop?: boolean;
  children: React.ReactNode;
  "data-test-id"?: string;
}

export function Drawer({
  open,
  onClose,
  title,
  width = 560,
  closeOnBackdrop = true,
  children,
  "data-test-id": testId,
}: DrawerProps): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !panelRef.current) return;
      // Focus trap (aria-modal): Tab and Shift+Tab wrap inside the panel.
      const items = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!panelRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => opener?.focus(); // return focus to the trigger on close
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
        justifyContent: "flex-end",
      }}
    >
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={closeOnBackdrop ? onClose : undefined}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.35)",
        }}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        style={{
          position: "relative",
          width,
          maxWidth: "100vw",
          height: "100%",
          background: "var(--aiq-color-bg-base)",
          borderLeft: "1px solid var(--aiq-color-border)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "var(--aiq-space-lg) var(--aiq-space-xl)",
            borderBottom: "1px solid var(--aiq-color-border)",
            flexShrink: 0,
          }}
        >
          {title && (
            <h2
              style={{
                margin: 0,
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                color: "var(--aiq-color-fg-primary)",
              }}
            >
              {title}
            </h2>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--aiq-color-fg-muted)",
              fontSize: 18,
              padding: 4,
              lineHeight: 1,
              marginLeft: "auto",
            }}
          >
            ✕
          </button>
        </div>
        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "var(--aiq-space-xl)" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

Drawer.displayName = "Drawer";
