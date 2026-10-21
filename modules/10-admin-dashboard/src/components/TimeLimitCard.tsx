// AssessIQ — "Time limit" card on the assessment detail page.
// Edits only assessments.duration_minutes via PATCH /admin/assessments/:id/time-limit
// (any status; empty = the time of the difficulty level). A running attempt keeps the time
// it started with; the change applies to attempts that start afterwards.

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";

export function TimeLimitCard({
  assessmentId,
  initial,
  effective,
}: {
  assessmentId: string;
  initial: number | null;
  effective: number | null;
}): React.ReactElement {
  const [minutes, setMinutes] = useState(initial === null ? "" : String(initial));
  const [now, setNow] = useState(effective);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(): Promise<void> {
    const trimmed = minutes.trim();
    const num = Number(trimmed);
    if (trimmed !== "" && (!Number.isInteger(num) || num < 1 || num > 600)) {
      setMsg({ ok: false, text: "Enter a whole number from 1 to 600, or leave it empty." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await adminApi(`/admin/assessments/${assessmentId}/time-limit`, {
        method: "PATCH",
        body: JSON.stringify({ duration_minutes: trimmed === "" ? null : num }),
      });
      const fresh = await adminApi<{ effective_duration_minutes?: number | null }>(`/admin/assessments/${assessmentId}`);
      setNow(fresh.effective_duration_minutes ?? null);
      setMsg({ ok: true, text: "Saved. Applies to attempts that start from now on." });
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
      data-help-id="admin.assessments.time_limit"
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
      <HelpTip helpId="admin.assessments.time_limit">
        <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>
          Time limit
        </h2>
      </HelpTip>
      <div style={{ color: "var(--aiq-color-fg-muted)" }}>
        {now === null ? "Time now: set by the difficulty level." : `Time now: ${now} minutes.`}
      </div>
      <label htmlFor="assessment-time-limit" style={{ color: "var(--aiq-color-fg-muted)" }}>
        Time limit (minutes). Leave this empty to use the time of the difficulty you chose. A running attempt keeps the time it started with.
      </label>
      <input
        id="assessment-time-limit"
        type="number"
        min={1}
        max={600}
        step={1}
        className="aiq-input"
        style={{ maxWidth: 160 }}
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
      />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
        <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save time limit"}
        </button>
        {msg && (
          <span role={msg.ok ? "status" : "alert"} style={{ color: msg.ok ? "var(--aiq-color-success)" : "var(--aiq-color-danger)" }}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
