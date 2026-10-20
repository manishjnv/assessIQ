// Platform tenants page: "School" switch per tenant (camera feature).
// POST /api/admin/platform/tenants/:tenantId/school needs fresh MFA. A fresh-MFA
// answer opens the shared MfaStepUp inline, and the change is retried after it verifies.
import React, { useState } from "react";
import { AdminApiError, type TenantListItem } from "../../api.js";
import { setTenantSchoolApi } from "../../api/camera.js";
import { MfaStepUp } from "../../components/mfa-step-up.js";
import { CameraSwitch } from "../../components/CameraSwitch.js";

function isFreshMfaError(err: unknown): boolean {
  return (
    err instanceof AdminApiError &&
    (
      (err.status === 401 && /fresh totp/i.test(err.apiError.message)) ||
      (err.status === 403 && err.apiError.details?.code === "MFA_REQUIRED")
    )
  );
}

export function SchoolSwitch({
  tenant,
  onChanged,
}: {
  tenant: TenantListItem;
  onChanged: (message: string) => void;
}): React.ReactElement {
  // Local value: the list has no is_school field yet (see report), so the switch
  // starts from the list value when present and is updated after each save.
  const [isSchool, setIsSchool] = useState<boolean>(tenant.is_school === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);

  const save = async (next: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setTenantSchoolApi(tenant.id, next);
      setIsSchool(next);
      setPending(null);
      onChanged(`${tenant.name}: school ${next ? "on" : "off"}`);
    } catch (err) {
      if (isFreshMfaError(err)) {
        setPending(next);
      } else {
        setError(err instanceof AdminApiError ? err.apiError.message : "Could not save. Try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-help-id="admin.platform.tenants.school">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <CameraSwitch
          checked={isSchool}
          disabled={busy || pending !== null}
          label={`School for ${tenant.name}`}
          onChange={(next) => void save(next)}
        />
        <span style={{ fontSize: 12, color: "var(--aiq-color-fg-secondary)" }}>
          {isSchool ? "School" : "Not a school"}
        </span>
      </div>
      {pending !== null && (
        <MfaStepUp
          prompt="Your admin MFA needs to be verified before you change the school flag. Enter your 6-digit authenticator code to continue."
          confirmLabel="Verify & save"
          onCancel={() => setPending(null)}
          onVerified={() => {
            const next = pending;
            setPending(null);
            void save(next);
          }}
        />
      )}
      {error !== null && (
        <span role="alert" style={{ fontSize: 12, color: "var(--aiq-color-danger)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
