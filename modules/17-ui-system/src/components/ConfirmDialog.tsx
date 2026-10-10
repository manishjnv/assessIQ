// AssessIQ — ConfirmDialog on Modal. Kit recipe: patterns.md "Modals / dialogs"
// (outline cancel + primary confirm, right-aligned). Escape/backdrop -> onCancel via Modal.
import React from "react";
import { Modal } from "./Modal.js";
import { Button } from "./Button.js";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Slot rendered above the buttons (e.g. an MFA prompt). No logic here. */
  mfaGuard?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  mfaGuard,
}: ConfirmDialogProps): React.ReactElement | null {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)" }}>{body}</div>
      {mfaGuard}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--aiq-space-sm)" }}>
        <Button variant="outline" disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={onConfirm}
          style={danger ? { background: "var(--aiq-color-danger)", borderColor: "var(--aiq-color-danger)" } : undefined}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
ConfirmDialog.displayName = "ConfirmDialog";
