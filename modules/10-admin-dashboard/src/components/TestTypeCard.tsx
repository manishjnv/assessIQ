// AssessIQ — "Test type" card on the assessment detail page (Z-89).
// Edits assessments.delivery_mode: the default for new invitations ('real' or 'mock').
// Draft only (the server rejects a patch on a published assessment). The admin can still
// pick the type per invitation batch in the invite form.

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";

export function TestTypeCard({
  assessmentId,
  initial,
  isDraft,
}: {
  assessmentId: string;
  initial: "real" | "mock";
  isDraft: boolean;
}): React.ReactElement {
  const [value, setValue] = useState<"real" | "mock">(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await adminApi(`/admin/assessments/${assessmentId}`, {
        method: "PATCH",
        body: JSON.stringify({ delivery_mode: value }),
      });
      setMsg({ ok: true, text: "Saved." });
    } catch (err) {
      setMsg({
        ok: false,
        text: err instanceof AdminApiError ? err.apiError.message : "Could not save. Try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-help-id="admin.assessment.invite.test_type"
      style={{
        border: "1px solid var(--aiq-color-border)",
        borderRadius: "var(--aiq-radius-md)",
        padding: "var(--aiq-space-md)",
        fontFamily: "var(--aiq-font-sans)",
        fontSize: "var(--aiq-text-sm)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--aiq-space-sm)",
      }}
    >
      <HelpTip helpId="admin.assessment.invite.test_type">
        <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>
          Test type
        </h2>
      </HelpTip>
      <label htmlFor="assessment-test-type" style={{ color: "var(--aiq-color-fg-muted)" }}>
        The type new invitations start with. You can still change it for each batch when you invite.
      </label>
      <select
        id="assessment-test-type"
        className="aiq-input"
        style={{ maxWidth: 280 }}
        value={value}
        disabled={!isDraft}
        onChange={(e) => setValue(e.target.value === "mock" ? "mock" : "real")}
      >
        <option value="real">Real exam (laptop or desktop only)</option>
        <option value="mock">Mock test (any device, no certificate)</option>
      </select>
      {isDraft ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
          <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save test type"}
          </button>
          {msg && (
            <span role={msg.ok ? "status" : "alert"} style={{ color: msg.ok ? "var(--aiq-color-success)" : "var(--aiq-color-danger)" }}>
              {msg.text}
            </span>
          )}
        </div>
      ) : (
        <div style={{ color: "var(--aiq-color-fg-muted)" }}>Locked: this can only change while the assessment is a draft.</div>
      )}
    </div>
  );
}
