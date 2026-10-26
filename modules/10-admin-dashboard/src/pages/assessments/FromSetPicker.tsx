import React, { useEffect, useState } from "react";
import { Chip } from "@assessiq/ui-system";
import { AdminApiError, getAvailableSets } from "../../api.js";
import type { AvailableSet } from "../../api.js";

/** Owner rule 2026-10-25: a new assessment starts with 60 questions; the admin can change the count (1 to 100) and the time. */
export const DEFAULT_QUESTION_COUNT = 60;

export interface FromSetSelection {
  source_pack_id: string;
  /** Subject (domain slug) of the chosen set. The section editor shows only this subject's categories. */
  domain: string;
  level_position: number;
  question_count: number;
}

interface FromSetPickerProps {
  /** Stable setState reference from the parent (mirrors BlueprintBuilder). */
  onChange: (sel: FromSetSelection | null) => void;
}

export function FromSetPicker({ onChange }: FromSetPickerProps): React.ReactElement {
  const [sets, setSets] = useState<AvailableSet[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [levelPosition, setLevelPosition] = useState<number>(1);
  const [questionCount, setQuestionCount] = useState<number>(DEFAULT_QUESTION_COUNT);

  // Load licensed sets on mount (only mounts when "From a set" mode is active).
  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const data = await getAvailableSets();
        setSets(data.sets);
      } catch (err) {
        setLoadError(
          err instanceof AdminApiError ? err.apiError.message : "Failed to load available sets.",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Reset level when the set changes (positions are 1-based within the set).
  useEffect(() => {
    setLevelPosition(1);
  }, [selectedSourceId]);

  // Report selection up on every change. Null until a complete, valid selection.
  useEffect(() => {
    const set = sets?.find((s) => s.source_pack_id === selectedSourceId) ?? null;
    if (!selectedSourceId || set === null) { onChange(null); return; }
    if (!Number.isInteger(levelPosition) || levelPosition < 1) { onChange(null); return; }
    if (!Number.isInteger(questionCount) || questionCount < 1) { onChange(null); return; }
    onChange({ source_pack_id: selectedSourceId, domain: set.domain, level_position: levelPosition, question_count: Math.min(questionCount, set.question_count) }); // the default can be above a small set
  }, [sets, selectedSourceId, levelPosition, questionCount, onChange]);

  const selectedSet = sets?.find((s) => s.source_pack_id === selectedSourceId) ?? null;

  const labelStyle: React.CSSProperties = {
    fontFamily: "var(--aiq-font-sans)",
    fontSize: "var(--aiq-text-xs)",
    fontWeight: 600,
    color: "var(--aiq-color-fg-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 4,
  };

  return (
    <div
      style={{
        border: "1px solid var(--aiq-color-border)",
        borderRadius: "var(--aiq-radius-sm)",
        padding: "var(--aiq-space-md)",
        background: "var(--aiq-color-bg-sunken)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--aiq-space-md)",
      }}
    >
      <p
        style={{
          fontFamily: "var(--aiq-font-sans)",
          fontSize: "var(--aiq-text-xs)",
          color: "var(--aiq-color-fg-muted)",
          margin: 0,
        }}
      >
        Pick a question set your organisation is licensed for. The set is copied into your
        organisation the first time you assess from it, and each candidate draws a fresh
        set from your own stable copy.
      </p>

      {loadError && (
        <div style={{ color: "var(--aiq-color-danger)", fontSize: "var(--aiq-text-xs)" }}>
          {loadError}
        </div>
      )}

      {loading ? (
        <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
          Loading available sets…
        </span>
      ) : sets !== null && sets.length === 0 ? (
        <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
          No question sets are licensed for your organisation yet — contact your platform
          operator to enable one.
        </span>
      ) : (
        <>
          {/* Set picker */}
          <div>
            <div style={labelStyle}>Question set</div>
            <select
              className="aiq-input"
              value={selectedSourceId}
              onChange={(e) => setSelectedSourceId(e.target.value)}
            >
              <option value="">— Select a set —</option>
              {(sets ?? []).map((s) => (
                <option key={s.source_pack_id} value={s.source_pack_id}>
                  {s.name} · {s.domain} · {s.level_count} difficult{s.level_count !== 1 ? "ies" : "y"} · {s.question_count} q
                  {s.update_available ? " · update available" : ""}
                </option>
              ))}
            </select>
          </div>

          {selectedSet !== null && (
            <>
              <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
                {selectedSet.cloned && (
                  <Chip leftIcon="check">In your organisation</Chip>
                )}
                {selectedSet.update_available && (
                  <Chip>Source updated · re-sync available</Chip>
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--aiq-space-md)" }}>
                {/* Level */}
                <div>
                  <div style={labelStyle}>Difficulty</div>
                  <select
                    className="aiq-input"
                    value={String(levelPosition)}
                    onChange={(e) => setLevelPosition(parseInt(e.target.value, 10) || 1)}
                  >
                    {Array.from({ length: Math.max(1, selectedSet.level_count) }, (_, i) => i + 1).map((pos) => (
                      <option key={pos} value={pos}>{(["Beginner", "Intermediate", "Advanced"][pos - 1]) ?? `Difficulty ${pos}`}</option>
                    ))}
                  </select>
                </div>

                {/* Questions to draw */}
                <div>
                  <div style={labelStyle}>Questions to draw</div>
                  <input
                    className="aiq-input"
                    type="number"
                    min={1}
                    max={100}
                    value={questionCount}
                    onChange={(e) => {
                      const v = Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1));
                      setQuestionCount(v);
                    }}
                  />
                </div>
              </div>
              <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", margin: 0 }}>
                The pool is checked when you publish — if the chosen difficulty has fewer
                questions than this, lower the count before publishing.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AdminAssessments — main page
// ---------------------------------------------------------------------------

