// AssessIQ — "Attempts" card on the assessment detail page (Z-39).
// Edits assessments.max_attempts (empty or 1 = no retake, 2..10) and settings.score_counts
// (latest | best). Draft only: the server rejects a change after publish. The general PATCH
// replaces settings wholesale, so score_counts is merged into freshly read settings
// (same pattern as NegativeMarksCard).

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";

export function RetakeCard({
  assessmentId,
  initialMax,
  initialScoreCounts,
  isDraft,
}: {
  assessmentId: string;
  initialMax: number | null;
  initialScoreCounts: "latest" | "best";
  isDraft: boolean;
}): React.ReactElement {
  const [max, setMax] = useState(initialMax === null || initialMax <= 1 ? "1" : String(initialMax));
  const [counts, setCounts] = useState<"latest" | "best">(initialScoreCounts);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(): Promise<void> {
    const num = Number(max);
    if (!Number.isInteger(num) || num < 1 || num > 10) {
      setMsg({ ok: false, text: "Choose a whole number from 1 to 10." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const fresh = await adminApi<{ settings?: Record<string, unknown> | null }>(`/admin/assessments/${assessmentId}`);
      const { score_counts: _drop, ...rest } = fresh.settings ?? {};
      const settings = counts === "best" ? { ...rest, score_counts: "best" } : rest;
      await adminApi(`/admin/assessments/${assessmentId}`, {
        method: "PATCH",
        body: JSON.stringify({ max_attempts: num === 1 ? null : num, settings }),
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
      data-help-id="admin.assessments.max_attempts"
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
      <HelpTip helpId="admin.assessments.max_attempts">
        <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>
          Attempts
        </h2>
      </HelpTip>
      <label htmlFor="assessment-max-attempts" style={{ color: "var(--aiq-color-fg-muted)" }}>
        How many times one candidate can take this assessment. 1 means no retake.
      </label>
      <select
        id="assessment-max-attempts"
        className="aiq-input"
        style={{ maxWidth: 160 }}
        value={max}
        disabled={!isDraft}
        onChange={(e) => setMax(e.target.value)}
      >
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <option key={n} value={String(n)}>
            {n}
          </option>
        ))}
      </select>
      <div data-help-id="admin.assessments.score_counts" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="assessment-score-counts" style={{ color: "var(--aiq-color-fg-muted)" }}>
          Score that counts when a candidate retakes
        </label>
        <select
          id="assessment-score-counts"
          className="aiq-input"
          style={{ maxWidth: 220 }}
          value={counts}
          disabled={!isDraft}
          onChange={(e) => setCounts(e.target.value === "best" ? "best" : "latest")}
        >
          <option value="latest">Latest attempt</option>
          <option value="best">Best attempt</option>
        </select>
      </div>
      {isDraft ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
          <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save attempts"}
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
