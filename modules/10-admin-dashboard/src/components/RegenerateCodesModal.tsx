// AssessIQ — "Regenerate recovery codes" dialog, shared by the Account
// security page and the AdminShell "My account" footer card (Z-21).
// Asks for a current authenticator code, then hands the new codes to onCodes.

import React, { useState } from "react";
import { Button, Field, Modal } from "@assessiq/ui-system";
import { AdminApiError, regenerateRecoveryCodesApi } from "../api.js";

export interface RegenerateCodesModalProps {
  open: boolean;
  onClose: () => void;
  onCodes: (codes: string[]) => void;
}

export function RegenerateCodesModal({ open, onClose, onCodes }: RegenerateCodesModalProps): React.ReactElement {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (): void => {
    setCode("");
    setError(null);
    onClose();
  };

  const regenerate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await regenerateRecoveryCodesApi(code);
      onCodes(res.codes);
      close();
    } catch (err) {
      setError(
        err instanceof AdminApiError && (err.status === 401 || err.status === 403)
          ? "That code is not correct. Your old backup codes still work."
          : "Could not make new backup codes. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Regenerate recovery codes">
      <p style={{ margin: "0 0 12px", fontSize: 14 }}>
        Enter the 6-digit code from your authenticator app. The old backup codes stop working.
      </p>
      <div data-help-id="admin.account.security.code_field">
        <Field
          label="Authenticator code"
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(null); }}
          {...(error !== null ? { error } : {})}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
        <Button onClick={() => void regenerate()} disabled={busy || code.length !== 6} data-help-id="admin.account.security.confirm">
          Make new codes
        </Button>
      </div>
    </Modal>
  );
}
