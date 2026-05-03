// AssessIQ — RubricEditor component.
//
// Admin inline editor for question rubrics.
// Supports: anchor list (add/remove/toggle required) + reasoning bands 0-4
//           + weight validation.
//
// DECISIONS:
//  - Plain textareas only (no Monaco) — per PHASE_2_KICKOFF.md.
//  - Weight validation: all anchor weights must sum to ≤ 1.0 (shown as warning,
//    not hard block — admin can still save a draft).
//  - anchor_synonyms: comma-separated input.

import React, { useCallback, useState } from "react";

export interface AnchorDraft {
  anchor_id: string;
  phrase: string;
  synonyms: string[];
  weight: number;
  required: boolean;
}

export interface BandDraft {
  band: number; // 0-4
  label: string;
  description: string;
}

export interface RubricDraft {
  anchors: AnchorDraft[];
  bands: BandDraft[];
}

export interface RubricEditorProps {
  initialDraft: RubricDraft;
  /** Called when admin saves the rubric. */
  onSave: (draft: RubricDraft) => void;
  submitting?: boolean;
  "data-test-id"?: string;
}

const BAND_DEFAULTS: Omit<BandDraft, "label" | "description">[] = [
  { band: 0 }, { band: 1 }, { band: 2 }, { band: 3 }, { band: 4 },
];

const BAND_PCT: Record<number, number> = { 0: 0, 1: 25, 2: 50, 3: 75, 4: 100 };

function newAnchor(): AnchorDraft {
  return {
    anchor_id: crypto.randomUUID(),
    phrase: "",
    synonyms: [],
    weight: 0.2,
    required: false,
  };
}

export function RubricEditor({
  initialDraft,
  onSave,
  submitting = false,
  "data-test-id": testId,
}: RubricEditorProps): React.ReactElement {
  const [draft, setDraft] = useState<RubricDraft>(initialDraft);

  const totalWeight = draft.anchors.reduce((sum, a) => sum + a.weight, 0);
  const weightOk = totalWeight <= 1.001; // small float tolerance

  // ── Anchor mutations ──

  function updateAnchor(id: string, patch: Partial<AnchorDraft>) {
    setDraft((d) => ({
      ...d,
      anchors: d.anchors.map((a) => (a.anchor_id === id ? { ...a, ...patch } : a)),
    }));
  }

  function removeAnchor(id: string) {
    setDraft((d) => ({ ...d, anchors: d.anchors.filter((a) => a.anchor_id !== id) }));
  }

  function addAnchor() {
    setDraft((d) => ({ ...d, anchors: [...d.anchors, newAnchor()] }));
  }

  // ── Band mutations ──

  function updateBand(band: number, patch: Partial<Omit<BandDraft, "band">>) {
    setDraft((d) => ({
      ...d,
      bands: d.bands.map((b) => (b.band === band ? { ...b, ...patch } : b)),
    }));
  }

  const handleSave = useCallback(() => {
    onSave(draft);
  }, [draft, onSave]);

  return (
    <div data-test-id={testId} style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }}>
      {/* Weight warning */}
      {!weightOk && (
        <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", background: "var(--aiq-color-danger-soft)", borderRadius: "var(--aiq-radius-md)" }}>
          Anchor weights sum to {totalWeight.toFixed(2)} — total exceeds 1.0. Adjust weights before saving.
        </div>
      )}

      {/* Anchors */}
      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--aiq-space-md)" }}>
          <h3 style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", margin: 0 }}>
            Anchors ({draft.anchors.length})
          </h3>
          <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={addAnchor}>
            + Add anchor
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          {draft.anchors.map((anchor) => (
            <div
              key={anchor.anchor_id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr auto auto auto",
                gap: "var(--aiq-space-sm)",
                alignItems: "center",
                padding: "var(--aiq-space-sm)",
                border: "1px solid var(--aiq-color-border)",
                borderRadius: "var(--aiq-radius-md)",
                background: "var(--aiq-color-bg-surface)",
              }}
            >
              <input
                type="text"
                placeholder="Anchor phrase"
                value={anchor.phrase}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAnchor(anchor.anchor_id, { phrase: e.target.value })}
                style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", padding: "var(--aiq-space-xs) var(--aiq-space-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)" }}
              />
              <input
                type="text"
                placeholder="Synonyms (comma-separated)"
                value={anchor.synonyms.join(", ")}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAnchor(anchor.anchor_id, { synonyms: e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean) })}
                style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", padding: "var(--aiq-space-xs) var(--aiq-space-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)" }}
              />
              <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", cursor: "pointer", whiteSpace: "nowrap", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-secondary)" }}>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={anchor.weight}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAnchor(anchor.anchor_id, { weight: parseFloat(e.target.value) || 0 })}
                  style={{ width: 56, fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", padding: "2px 4px", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", textAlign: "right" }}
                />
                wt.
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", cursor: "pointer", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-secondary)", whiteSpace: "nowrap" }}>
                <input
                  type="checkbox"
                  checked={anchor.required}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAnchor(anchor.anchor_id, { required: e.target.checked })}
                />
                Required
              </label>
              <button
                type="button"
                className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                style={{ color: "var(--aiq-color-danger)" }}
                onClick={() => removeAnchor(anchor.anchor_id)}
                aria-label="Remove anchor"
              >
                ×
              </button>
            </div>
          ))}
          {draft.anchors.length === 0 && (
            <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              No anchors defined. Click "Add anchor" to start.
            </p>
          )}
        </div>
      </section>

      {/* Bands */}
      <section>
        <h3 style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", margin: "0 0 var(--aiq-space-md)" }}>
          Reasoning bands
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          {BAND_DEFAULTS.map(({ band }) => {
            const b = draft.bands.find((x) => x.band === band) ?? { band, label: "", description: "" };
            return (
              <div key={band} style={{ display: "grid", gridTemplateColumns: "80px 160px 1fr", gap: "var(--aiq-space-sm)", alignItems: "start" }}>
                <div style={{ fontFamily: "var(--aiq-font-serif)", fontVariantNumeric: "lining-nums tabular-nums", fontSize: "var(--aiq-text-md)", color: "var(--aiq-color-fg-primary)", paddingTop: "var(--aiq-space-xs)" }}>
                  Band {band}<br />
                  <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>{BAND_PCT[band]}%</span>
                </div>
                <input
                  type="text"
                  placeholder="Label"
                  value={b.label}
                  onChange={(e) => updateBand(band, { label: e.target.value })}
                  style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", padding: "var(--aiq-space-xs) var(--aiq-space-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)" }}
                />
                <textarea
                  rows={2}
                  placeholder="Description shown to AI grader"
                  value={b.description}
                  onChange={(e) => updateBand(band, { description: e.target.value })}
                  style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", padding: "var(--aiq-space-xs) var(--aiq-space-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)", resize: "vertical" }}
                />
              </div>
            );
          })}
        </div>
      </section>

      {/* Save */}
      <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
        <button
          type="button"
          className="aiq-btn aiq-btn-primary"
          disabled={submitting || !weightOk}
          onClick={handleSave}
        >
          {submitting ? "Saving…" : "Save rubric"}
        </button>
        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: totalWeight > 1 ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-muted)", alignSelf: "center" }}>
          Weight total: {totalWeight.toFixed(2)} / 1.00
        </span>
      </div>
    </div>
  );
}

RubricEditor.displayName = "RubricEditor";
