// AssessIQ — "High-stakes grading" card on the assessment detail page.
// Edits only settings.high_stakes via PATCH /admin/assessments/:id/grading
// (allowed in any status; applies to AI grading runs started afterwards).

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";

export function HighStakesCard({
  assessmentId,
  initial,
}: {
  assessmentId: string;
  initial?: boolean | undefined;
}): React.ReactElement {
  const [highStakes, setHighStakes] = useState(initial === true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await adminApi(`/admin/assessments/${assessmentId}/grading`, {
        method: "PATCH",
        body: JSON.stringify({ high_stakes: highStakes }),
      });
      setMsg({ ok: true, text: "Saved. Applies to grading runs that start from now on." });
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
      data-help-id="admin.assessment.high_stakes.edit"
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
      <HelpTip helpId="admin.assessment.high_stakes.edit">
        <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>
          High-stakes grading
        </h2>
      </HelpTip>
      <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
        <input type="checkbox" checked={highStakes} onChange={(e) => setHighStakes(e.target.checked)} />
        Two AI models must agree
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
        <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save grading settings"}
        </button>
        {msg && (
          <span
            role={msg.ok ? "status" : "alert"}
            style={{ color: msg.ok ? "var(--aiq-color-success)" : "var(--aiq-color-danger)" }}
          >
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
