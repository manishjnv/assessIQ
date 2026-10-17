// AssessIQ — "Pass mark" card on the assessment detail page (Z-16).
// Edits assessments.passing_score_pct (integer 1..100). Draft only: the server rejects a
// change after publish, and results keep the mark they were judged by.

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";

export function PassMarkCard({
  assessmentId,
  initial,
  isDraft,
}: {
  assessmentId: string;
  initial: number | undefined;
  isDraft: boolean;
}): React.ReactElement {
  const [value, setValue] = useState(initial !== undefined ? String(initial) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(): Promise<void> {
    const num = Number(value.trim());
    if (value.trim() === "" || !Number.isInteger(num) || num < 1 || num > 100) {
      setMsg({ ok: false, text: "Enter a whole number from 1 to 100." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await adminApi(`/admin/assessments/${assessmentId}`, {
        method: "PATCH",
        body: JSON.stringify({ passing_score_pct: num }),
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
      data-help-id="admin.assessments.pass_mark"
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
      <HelpTip helpId="admin.assessments.pass_mark">
        <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>
          Pass mark
        </h2>
      </HelpTip>
      <label htmlFor="assessment-pass-mark" style={{ color: "var(--aiq-color-fg-muted)" }}>
        Percent a candidate must score to pass. A pass mark above 90 makes Completion and Distinction the same band.
      </label>
      <input
        id="assessment-pass-mark"
        className="aiq-input"
        style={{ maxWidth: 160 }}
        type="number"
        min={1}
        max={100}
        step={1}
        value={value}
        disabled={!isDraft}
        onChange={(e) => setValue(e.target.value)}
      />
      {isDraft ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
          <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save pass mark"}
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
