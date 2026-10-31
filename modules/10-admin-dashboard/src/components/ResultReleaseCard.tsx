// AssessIQ — "Result release" card on the assessment detail page.
// Sets only this assessment's release override via PATCH /admin/assessments/:id/result-release (any status).
// "Use organisation default" sends null. Manual "Release" clicks always work whatever is chosen here.

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";

export type ResultReleaseValue = "manual" | "auto" | null;

const CHOICES: { value: "" | "auto" | "manual"; label: string }[] = [
  { value: "", label: "Use organisation default" },
  { value: "auto", label: "Release automatically" },
  { value: "manual", label: "Admin releases manually" },
];

export function ResultReleaseCard({
  assessmentId,
  initial,
}: {
  assessmentId: string;
  initial?: ResultReleaseValue | undefined;
}): React.ReactElement {
  const [value, setValue] = useState<"" | "auto" | "manual">(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await adminApi(`/admin/assessments/${assessmentId}/result-release`, {
        method: "PATCH",
        body: JSON.stringify({ result_release_mode: value === "" ? null : value }),
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
      data-help-id="admin.assessments.result_release"
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
      <HelpTip helpId="admin.assessments.result_release">
        <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>
          Result release
        </h2>
      </HelpTip>
      <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
        When results are released
        <select
          value={value}
          onChange={(e) => setValue(e.target.value as "" | "auto" | "manual")}
          aria-label="Result release"
        >
          {CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
        <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save result release"}
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
