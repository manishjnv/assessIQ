// AssessIQ — "Automatic reminders" card on the assessment detail page.
// Edits only settings.reminders via PATCH /admin/assessments/:id/reminders (any status).

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";

export interface RemindersValue {
  enabled?: boolean;
  hours_before?: number;
}

const HOURS = [6, 12, 24, 48, 72];

export function RemindersCard({
  assessmentId,
  initial,
}: {
  assessmentId: string;
  initial?: RemindersValue | undefined;
}): React.ReactElement {
  const [enabled, setEnabled] = useState(initial?.enabled === true);
  const [hours, setHours] = useState(initial?.hours_before ?? 24);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await adminApi(`/admin/assessments/${assessmentId}/reminders`, {
        method: "PATCH",
        body: JSON.stringify({ enabled, hours_before: hours }),
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

  const hourOptions = HOURS.includes(hours) ? HOURS : [...HOURS, hours].sort((a, b) => a - b);

  return (
    <div
      data-help-id="admin.assessment.reminders"
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
      <HelpTip helpId="admin.assessment.reminders">
        <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>
          Reminders
        </h2>
      </HelpTip>
      <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Send automatic reminders
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
        Remind students who have not started
        <select
          value={hours}
          disabled={!enabled}
          onChange={(e) => setHours(Number(e.target.value))}
          aria-label="Hours before the deadline"
        >
          {hourOptions.map((h) => (
            <option key={h} value={h}>
              {h} hours
            </option>
          ))}
        </select>
        before the deadline
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
        <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save reminder settings"}
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
