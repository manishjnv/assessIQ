// AssessIQ — "Test sections" card on the assessment detail page.
// Reuses the create-form SectionsEditor. Saves via PATCH /admin/assessments/:id (draft only);
// the server answers 409 SECTIONS_LOCKED once any attempt exists.

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";
import { SectionsEditor, buildSections } from "../pages/SectionsEditor.js";
import type { SectionRow, SectionsSettings } from "../pages/SectionsEditor.js";

export type SectionsSettingsValue = SectionsSettings["sections"];

function toRows(sections: SectionsSettingsValue | undefined): SectionRow[] {
  return (sections ?? []).map((s) => ({
    name: s.name,
    count: s.question_count === undefined ? "" : String(s.question_count),
    minutes: String(s.minutes),
    calculator: s.calculator === true,
    categoryIds: s.category_ids ?? [],
  }));
}

export function SectionsCard({
  assessmentId,
  settings,
  hasAttempts,
  isDraft,
  onSaved,
}: {
  assessmentId: string;
  /** Page copy of settings, used for the summary only; save() re-reads fresh settings. */
  settings: Record<string, unknown> | null | undefined;
  hasAttempts: boolean;
  isDraft: boolean;
  onSaved: (settings: Record<string, unknown>, questionCount: number | null) => void;
}): React.ReactElement {
  const saved = (settings?.["sections"] as SectionsSettingsValue | undefined) ?? [];
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<SectionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Owner decision 2026-10-02: no edit button at all once published or started.
  const canEdit = isDraft && !hasAttempts;

  async function save(): Promise<void> {
    setError(null);
    const built = rows.length > 0 ? buildSections(rows) : null;
    if (built !== null && "error" in built) {
      setError(built.error);
      return;
    }
    setBusy(true);
    try {
      // PATCH replaces settings wholesale and the sibling cards (integrity, high stakes,
      // reminders) save via their own routes without updating the page copy — so re-read
      // the current settings right before saving, or their changes would be reverted.
      const fresh = await adminApi<{ settings?: Record<string, unknown> | null }>(`/admin/assessments/${assessmentId}`);
      const { sections: _drop, ...rest } = fresh.settings ?? {};
      const next = built === null ? rest : { ...rest, ...built.settings };
      await adminApi(`/admin/assessments/${assessmentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          settings: next,
          ...(built?.total != null ? { question_count: built.total } : {}),
        }),
      });
      onSaved(next, built?.total ?? null);
      setEditing(false);
    } catch (err) {
      const locked =
        err instanceof AdminApiError &&
        err.status === 409 &&
        (err.apiError.code === "SECTIONS_LOCKED" || err.apiError.details?.["code"] === "SECTIONS_LOCKED");
      setError(
        locked
          ? "Sections can't be changed after students have started this test. Reload the page to see the current state."
          : err instanceof AdminApiError
            ? err.apiError.message
            : "Could not save. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-help-id="admin.assessment.sections.edit"
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
      <HelpTip helpId="admin.assessment.sections.edit">
        <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>
          Test sections
        </h2>
      </HelpTip>
      {!editing && (
        <>
          <p style={{ margin: 0, color: "var(--aiq-color-fg-muted)" }}>
            {saved.length === 0
              ? "No sections. The test runs as one timed test."
              : saved.map((s) => `${s.name} (${s.minutes} min)`).join(" · ")}
          </p>
          {canEdit && (
          <div>
            <button
              type="button"
              className="aiq-btn aiq-btn-outline aiq-btn-sm"
              onClick={() => {
                setRows(toRows(saved));
                setError(null);
                setEditing(true);
              }}
            >
              Edit sections
            </button>
          </div>
          )}
        </>
      )}
      {editing && (
        <>
          <SectionsEditor rows={rows} onChange={setRows} />
          <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
            <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save sections"}
            </button>
            <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {error && (
        <span role="alert" style={{ color: "var(--aiq-color-danger)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
