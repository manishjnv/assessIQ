// Shared admin MFA step-up sub-form.
//
// Extracted from platform.tsx so the Platform page AND the Generate wizard use
// ONE copy of the fresh-MFA re-verification flow (a security flow must not be
// duplicated). Renders a prompt + 6-digit code field; on a successful TOTP
// verify it refreshes the admin session (so the new MFA freshness is picked up
// by the next call) and calls onVerified(). The caller decides what to retry.

import React, { useState, type CSSProperties } from "react";
import { Button, Chip, Field } from "@assessiq/ui-system";
import { AdminApiError, verifyTotpApi } from "../api.js";
import { fetchAdminWhoami } from "../session.js";

const META_LABEL: CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--aiq-color-fg-muted)",
};

type MfaState =
  | { status: "idle" }
  | { status: "locked" }
  | { status: "expired" }
  | { status: "error"; message: string };

export function MfaStepUp({
  onVerified,
  onCancel,
  prompt = "Your admin MFA needs to be verified before provisioning a new company. Enter your 6-digit authenticator code to continue.",
  confirmLabel = "Verify & create",
}: {
  onVerified: () => void;
  onCancel: () => void;
  prompt?: string;
  confirmLabel?: string;
}): React.ReactElement {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<MfaState>({ status: "idle" });

  const handleInput = (raw: string): void => {
    setCode(raw.replace(/\D/g, "").slice(0, 6));
    setState({ status: "idle" });
  };

  const verify = async (): Promise<void> => {
    if (code.length !== 6) return;
    setLoading(true);
    setState({ status: "idle" });
    try {
      await verifyTotpApi(code);
      await fetchAdminWhoami(true);
      setCode("");
      onVerified();
    } catch (err) {
      if (err instanceof AdminApiError) {
        if (err.apiError.code === "ACCOUNT_LOCKED" || err.status === 423) {
          setState({ status: "locked" });
        } else if (err.status === 401) {
          setState({ status: "expired" });
        } else if (err.apiError.code === "INVALID_CODE") {
          setState({ status: "error", message: "Invalid code. Try again." });
        } else {
          setState({ status: "error", message: err.apiError.message });
        }
      } else {
        setState({ status: "error", message: "Unexpected error — please try again." });
      }
    } finally {
      setLoading(false);
    }
  };

  const isLocked = state.status === "locked";
  const isExpired = state.status === "expired";

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div
        style={{
          padding: "12px 16px",
          background: "var(--aiq-color-bg-raised)",
          borderRadius: "var(--aiq-radius-md)",
          border: "1px solid var(--aiq-color-border)",
        }}
      >
        <p style={{ margin: 0, fontSize: 13, color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5 }}>
          {prompt}
        </p>
      </div>

      {state.status === "locked" && <Chip>Too many attempts; locked for 15 minutes.</Chip>}
      {state.status === "expired" && (
        <div>
          <Chip>Your session expired — </Chip>{" "}
          <a href="/admin/login" style={{ fontSize: 13, color: "var(--aiq-color-accent)", fontWeight: 500 }}>
            sign in again.
          </a>
        </div>
      )}
      {state.status === "error" && <Chip>{state.message}</Chip>}

      <div data-help-id="admin.platform.mfa_code">
        <Field
          label="Authenticator code"
          placeholder="000000"
          value={code}
          onChange={(e) => handleInput(e.target.value)}
          disabled={isLocked || isExpired || loading}
        />
        <span style={{ ...META_LABEL, display: "block", marginTop: 4, fontSize: 10 }}>
          6 digits · rotates every 30 s
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button onClick={() => void verify()} loading={loading} disabled={code.length !== 6 || isLocked || isExpired}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
