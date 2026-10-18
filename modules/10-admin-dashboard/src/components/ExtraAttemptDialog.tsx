// AssessIQ — "Give one extra attempt" dialog (Z-39 follow-up).
// Replaces window.prompt: enforces the required reason (1..500 chars, trimmed),
// shows a live counter, keeps API errors inside the dialog, and returns focus
// to the trigger on close. Mount it only while open.

import React, { useEffect, useRef, useState } from "react";
import { Modal, Button } from "@assessiq/ui-system";

export const EXTRA_ATTEMPT_REASON_MAX = 500;

export function ExtraAttemptDialog({
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [reason, setReason] = useState("");
  const len = reason.trim().length;
  const valid = len > 0 && len <= EXTRA_ATTEMPT_REASON_MAX;

  // Return focus to whatever opened the dialog.
  const trigger = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    const el = trigger.current;
    return () => {
      if (el instanceof HTMLElement && el.isConnected) el.focus();
    };
  }, []);

  return (
    <Modal
      open
      title="Give one extra attempt"
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <label htmlFor="extra-attempt-reason" style={{ fontSize: 13, fontWeight: 500 }}>
        Reason (required, up to 500 characters)
      </label>
      <textarea
        id="extra-attempt-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={4}
        disabled={busy}
        aria-describedby="extra-attempt-count"
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontFamily: "var(--aiq-font-sans)",
          fontSize: 13,
          padding: "8px 10px",
          borderRadius: "var(--aiq-radius-md)",
          border: "1px solid var(--aiq-color-border)",
          background: "var(--aiq-color-bg-raised)",
          color: "var(--aiq-color-fg-primary)",
        }}
      />
      <div
        id="extra-attempt-count"
        style={{
          fontSize: 12,
          color: len > EXTRA_ATTEMPT_REASON_MAX ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-muted)",
        }}
      >
        {len} / {EXTRA_ATTEMPT_REASON_MAX}
      </div>
      {error !== null && error !== "" && (
        <p role="alert" style={{ margin: 0, color: "var(--aiq-color-danger)" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--aiq-space-sm)" }}>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !valid} onClick={() => onSubmit(reason.trim())}>
          {busy ? "Saving…" : "Give extra attempt"}
        </Button>
      </div>
    </Modal>
  );
}
ExtraAttemptDialog.displayName = "ExtraAttemptDialog";
