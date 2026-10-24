// AssessIQ — "Test type" card on the assessment detail page (Z-89, Z-142 camera).
// Edits assessments.delivery_mode ('real' or 'mock') and assessments.camera_required.
// Draft only (the server rejects a patch on a published assessment). Temporary: the card
// chooser (Z-143) replaces this in the next batch.

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";

function typeLabel(mode: "real" | "mock", camera: boolean): string {
  if (mode === "mock") return "Mock";
  return camera ? "Real + camera" : "Real";
}

export function TestTypeCard({
  assessmentId,
  initial,
  initialCameraRequired,
  isDraft,
}: {
  assessmentId: string;
  initial: "real" | "mock";
  initialCameraRequired: boolean;
  isDraft: boolean;
}): React.ReactElement {
  const [value, setValue] = useState<"real" | "mock">(initial);
  const [cameraRequired, setCameraRequired] = useState(initial === "real" && initialCameraRequired);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await adminApi(`/admin/assessments/${assessmentId}`, {
        method: "PATCH",
        body: JSON.stringify({ delivery_mode: value, camera_required: value === "real" && cameraRequired }),
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
      {isDraft ? (
        <>
          <label htmlFor="assessment-test-type" style={{ color: "var(--aiq-color-fg-muted)" }}>
            The type of this test. It cannot change after you publish.
          </label>
          <select
            id="assessment-test-type"
            className="aiq-input"
            style={{ maxWidth: 280 }}
            value={value}
            onChange={(e) => {
              const next = e.target.value === "mock" ? "mock" : "real";
              setValue(next);
              if (next === "mock") setCameraRequired(false);
            }}
          >
            <option value="real">Real exam (laptop or desktop only)</option>
            <option value="mock">Mock test (any device, no certificate)</option>
          </select>
          <label style={{ display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
            <input
              type="checkbox"
              checked={value === "real" && cameraRequired}
              disabled={value === "mock"}
              onChange={(e) => setCameraRequired(e.target.checked)}
            />
            Camera required
          </label>
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
        </>
      ) : (
        <>
          <div>Type: {typeLabel(value, value === "real" && cameraRequired)}</div>
          <div style={{ color: "var(--aiq-color-fg-muted)" }}>Locked: this can only change while the assessment is a draft.</div>
        </>
      )}
    </div>
  );
}
