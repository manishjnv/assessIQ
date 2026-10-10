// AssessIQ — DangerConfirmModal.
//
// A small confirmation dialog for irreversible / destructive admin actions
// (delete an assessment, cancel an assessment), kept generic for reuse.
//
// INVARIANTS:
//  - Plain text / React nodes only — no dangerouslySetInnerHTML.
//  - Click-outside and ESC both cancel, but NOT while an action is in flight
//    (busy) — so a mis-click can't abandon a half-run request.
//  - Built on the kit ConfirmDialog (danger=true tints the confirm button).

import React from "react";
import { ConfirmDialog } from "@assessiq/ui-system";

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
  return (
    <ConfirmDialog
      open={open}
      title={title}
      cancelLabel="Keep it"
      confirmLabel={busy ? busyLabel : confirmLabel}
      danger={danger}
      busy={busy}
      onConfirm={onConfirm}
      // Escape / backdrop must not abandon a half-run request.
      onCancel={() => {
        if (!busy) onCancel();
      }}
      body={
        <>
          {body}
          {error != null && error !== "" && (
            <div
              style={{
                marginTop: "var(--aiq-space-md)",
                color: "var(--aiq-color-danger)",
                background: "var(--aiq-color-bg-sunken)",
                borderRadius: "var(--aiq-radius-sm)",
                padding: "var(--aiq-space-sm)",
              }}
            >
              {error}
            </div>
          )}
        </>
      }
    />
  );
}

DangerConfirmModal.displayName = "DangerConfirmModal";
