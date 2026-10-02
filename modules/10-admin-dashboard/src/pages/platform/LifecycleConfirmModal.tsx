// LifecycleConfirmModal — split from platform.tsx (E9, no behaviour change).

import React, { useState } from "react";
import { Button, Card } from "@assessiq/ui-system";
import { MfaStepUp } from "../../components/mfa-step-up.js";
import { AdminApiError, type TenantListItem } from "../../api.js";
import { type LifecycleAction, META_LABEL } from "./shared.js";

// ── Lifecycle confirmation modal ─────────────────────────────────────────────

export const LIFECYCLE_COPY: Record<
  LifecycleAction,
  { title: (name: string) => string; body: (name: string, userCount: number) => string; verb: string }
> = {
  suspend: {
    title: (name) => `Suspend ${name}?`,
    body: (name) =>
      `Suspending ${name} will immediately sign out all active users — admins and candidates — and prevent future logins. All data, billing, and entitlements are preserved. You can resume any time.`,
    verb: "Suspend",
  },
  resume: {
    title: (name) => `Resume ${name}?`,
    body: (name) =>
      `Resuming will allow ${name}'s users to sign in again. They will need to re-authenticate.`,
    verb: "Resume",
  },
  archive: {
    title: (name) => `Archive ${name}?`,
    body: () =>
      `Archiving will sign out all active users immediately, prevent future logins, and hide this tenant from the default Platform view. All data is preserved. You can unarchive any time.`,
    verb: "Archive",
  },
  unarchive: {
    title: (name) => `Unarchive ${name}?`,
    body: () =>
      `Unarchiving will restore this tenant to active status. Users may sign in again.`,
    verb: "Unarchive",
  },
};

export function LifecycleConfirmModal({
  action,
  tenant,
  onConfirm,
  onCancel,
}: {
  action: LifecycleAction;
  tenant: TenantListItem;
  onConfirm: (reason: string | undefined) => Promise<void>;
  onCancel: () => void;
}): React.ReactElement {
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [modalState, setModalState] = useState<"confirm" | "mfa">("confirm");
  const copy = LIFECYCLE_COPY[action];
  const userCount = tenant.admin_count ?? 0;

  const handleConfirm = async (): Promise<void> => {
    setLoading(true);
    try {
      await onConfirm(reason.trim() || undefined);
    } catch (err) {
      // The parent re-throws ONLY the fresh-MFA 401 so we can step the operator
      // through in-place TOTP re-verification (mirrors CreateCompanyForm). Every
      // other error is handled at the page level by the parent, which closes us.
      if (
        err instanceof AdminApiError &&
        err.status === 401 &&
        /fresh totp/i.test(err.apiError.message)
      ) {
        setModalState("mfa");
      }
    } finally {
      setLoading(false);
    }
  };

  // After re-verification succeeds, return to the confirm view and retry the
  // original action — now within the 15-minute fresh-MFA window.
  const handleMfaVerified = (): void => {
    setModalState("confirm");
    void handleConfirm();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.36)",
        display: "grid",
        placeItems: "center",
        zIndex: 300,
      }}
      onClick={onCancel}
      role="presentation"
    >
      <Card
        padding="lg"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 480 }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2
            className="aiq-serif"
            style={{ fontSize: 22, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
          >
            {modalState === "mfa" ? "Verify MFA" : copy.title(tenant.name)}
          </h2>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={onCancel} aria-label="Close" disabled={loading}>
            ×
          </Button>
        </div>

        {modalState === "mfa" ? (
          <MfaStepUp
            prompt={`Your admin MFA needs to be re-verified before you can ${copy.verb.toLowerCase()} ${tenant.name}. Enter your 6-digit authenticator code to continue.`}
            confirmLabel={`Verify & ${copy.verb.toLowerCase()}`}
            onVerified={handleMfaVerified}
            onCancel={onCancel}
          />
        ) : (
          <>
            <p
              style={{
                fontSize: 13,
                color: "var(--aiq-color-fg-secondary)",
                margin: "0 0 20px",
                lineHeight: 1.5,
              }}
            >
              {copy.body(tenant.name, userCount)}
            </p>

            {/* Optional reason textarea */}
            <div style={{ marginBottom: 20 }}>
              <label
                style={{
                  display: "block",
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: 12,
                  fontWeight: 500,
                  marginBottom: 6,
                }}
              >
                Reason (optional)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                disabled={loading}
                placeholder="Briefly describe why (recorded in the audit log)…"
                rows={3}
                style={{
                  width: "100%",
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: 13,
                  padding: "8px 10px",
                  borderRadius: "var(--aiq-radius-md)",
                  border: "1px solid var(--aiq-color-border)",
                  background: "var(--aiq-color-bg-raised)",
                  color: "var(--aiq-color-fg-primary)",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
              <span style={{ ...META_LABEL, display: "block", marginTop: 4, fontSize: 10 }}>
                {reason.length} / 500
              </span>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button variant="ghost" onClick={onCancel} disabled={loading}>
                Cancel
              </Button>
              <Button onClick={() => void handleConfirm()} loading={loading}>
                {copy.verb}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
