// AssessIQ — "Default negative marks" card on the assessment detail page (EX-1).
// Edits only settings.scoring.negative_marks_default. The general assessment PATCH replaces
// settings wholesale and is draft-only, so this re-reads the fresh settings, merges, and saves
// (same pattern as SectionsCard). The value is frozen per attempt at start; a question's own
// negative marks wins over this default.

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";

export interface ScoringSettingsValue {
  negative_marks_default?: number;
}

export function NegativeMarksCard({
  assessmentId,
  initial,
  isDraft,
}: {
  assessmentId: string;
  initial?: ScoringSettingsValue | undefined;
  isDraft: boolean;
}): React.ReactElement {
  const [value, setValue] = useState(initial?.negative_marks_default !== undefined ? String(initial.negative_marks_default) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(): Promise<void> {
    const trimmed = value.trim();
    const num = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isFinite(num) || num < 0 || num > 1000) {
      setMsg({ ok: false, text: "Enter a number from 0 to 1000." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const fresh = await adminApi<{ settings?: Record<string, unknown> | null }>(`/admin/assessments/${assessmentId}`);
      const { scoring: _drop, ...rest } = fresh.settings ?? {};
      const next = num > 0 ? { ...rest, scoring: { negative_marks_default: num } } : rest;
      await adminApi(`/admin/assessments/${assessmentId}`, {
        method: "PATCH",
        body: JSON.stringify({ settings: next }),
      });
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
      data-help-id="admin.assessments.settings.negative_marks_default"
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
      <HelpTip helpId="admin.assessments.settings.negative_marks_default">
        <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>
          Default negative marks
        </h2>
      </HelpTip>
      <label htmlFor="assessment-negative-marks-default" style={{ color: "var(--aiq-color-fg-muted)" }}>
        Marks deducted for a wrong answer on auto-scored questions. A question with its own value keeps it. 0 means no penalty.
      </label>
      <input
        id="assessment-negative-marks-default"
        className="aiq-input"
        style={{ maxWidth: 160 }}
        type="number"
        min={0}
        step={0.25}
        value={value}
        disabled={!isDraft}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0"
      />
      {isDraft ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
          <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save negative marks"}
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
