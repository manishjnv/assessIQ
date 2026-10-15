// AssessIQ — super-admin "Reset two-factor" dialog (RW-45).
// ConfirmDialog with a required reason. The parent refetches the list on success.

import React, { useState } from "react";
import { ConfirmDialog } from "@assessiq/ui-system";
import { AdminApiError, superResetUserTotpApi } from "../api.js";

export interface ResetTotpTarget {
  id: string;
  email: string;
}

export function ResetTotpDialog({
  tenantId,
  user,
  onDone,
  onCancel,
}: {
  tenantId: string;
  user: ResetTotpTarget;
  onDone: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (): Promise<void> => {
    if (reason.trim().length === 0) {
      setError("Enter a reason. It is saved in the audit log.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await superResetUserTotpApi(tenantId, user.id, reason.trim());
      onDone();
    } catch (err) {
      setError(
        err instanceof AdminApiError
          ? err.apiError.message
          : "Could not reset two-factor. Try again.",
      );
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      danger
      busy={busy}
      title="Reset two-factor sign-in?"
      confirmLabel="Reset two-factor"
      onConfirm={() => void confirm()}
      onCancel={onCancel}
      body={
        <div data-help-id="admin.users.list.reset_totp">
          <p style={{ margin: "0 0 12px" }}>
            {user.email} will lose the authenticator app and all backup codes. The person must set up two-factor again at next sign-in.
          </p>
          <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 6 }} htmlFor="reset-totp-reason">
            Reason (saved in the audit log)
          </label>
          <textarea
            id="reset-totp-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={3}
            disabled={busy}
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
          {error !== null && (
            <p role="alert" style={{ margin: "8px 0 0", color: "var(--aiq-color-danger)" }}>{error}</p>
          )}
        </div>
      }
    />
  );
}
