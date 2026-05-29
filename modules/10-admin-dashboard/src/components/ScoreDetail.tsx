// AssessIQ — ScoreDetail component.
//
// Per-question breakdown: shows anchor hits + band + justification for each
// graded question. Reads GradingsRow shape.
//
// INVARIANTS:
//  - Bands displayed as 0/25/50/75/100 — never raw floats.
//  - ai_justification as plain text (no dangerouslySetInnerHTML).
//  - score_earned / score_max in serif tabular-nums.

import React from "react";
import type { GradingsRow } from "@assessiq/ai-grading";
import { AnchorChip } from "./AnchorChip.js";

export interface ScoreDetailProps {
  grading: GradingsRow;
  /** Human-readable question label. */
  questionLabel?: string;
  /**
   * Optional rubric anchors (id + concept + weight + synonyms) from the
   * frozen question's rubric snapshot — when provided, each AnchorChip
   * renders with the human-readable concept + weight ("✓ pivot to identity
   * · 20pts") instead of the raw anchor_id. Phase 3 review UX, 2026-05-29.
   * Lookup is by anchor_id; unmatched findings fall back to the prior
   * label-or-id behaviour.
   */
  rubricAnchors?: Array<{
    id: string;
    concept: string;
    weight: number;
    synonyms?: string[];
  }>;
  "data-test-id"?: string;
}

const BAND_PCT: Record<number, number> = { 0: 0, 1: 25, 2: 50, 3: 75, 4: 100 };

export function ScoreDetail({
  grading,
  questionLabel,
  rubricAnchors,
  "data-test-id": testId,
}: ScoreDetailProps): React.ReactElement {
  const band = grading.reasoning_band;
  const bandPct = band !== null ? (BAND_PCT[band] ?? 0) : null;
  // Build an id→anchor-def lookup once per render so chip enrichment is O(1).
  // Empty map when no rubricAnchors provided → chips fall back to id label.
  const anchorDefById = React.useMemo(() => {
    const map = new Map<string, { concept: string; weight: number; synonyms?: string[] }>();
    if (rubricAnchors) {
      for (const a of rubricAnchors) {
        map.set(a.id, { concept: a.concept, weight: a.weight, ...(a.synonyms ? { synonyms: a.synonyms } : {}) });
      }
    }
    return map;
  }, [rubricAnchors]);

  return (
    <div
      className="aiq-card"
      data-test-id={testId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--aiq-space-sm)",
        padding: "var(--aiq-space-md)",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--aiq-space-sm)" }}>
        {questionLabel && (
          <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>
            {questionLabel}
          </span>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", marginLeft: "auto" }}>
          {bandPct !== null && (
            <span style={{ fontFamily: "var(--aiq-font-serif)", fontVariantNumeric: "lining-nums tabular-nums", fontSize: "var(--aiq-text-lg)", color: "var(--aiq-color-fg-primary)" }}>
              Band {band} · {bandPct}%
            </span>
          )}
          <span style={{ fontFamily: "var(--aiq-font-serif)", fontVariantNumeric: "lining-nums tabular-nums", fontSize: "var(--aiq-text-lg)", color: "var(--aiq-color-fg-secondary)" }}>
            {grading.score_earned}/{grading.score_max}
          </span>
          <span
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              padding: "1px 8px",
              borderRadius: "var(--aiq-radius-pill)",
              background: grading.grader === "admin_override" ? "var(--aiq-color-warning)" : "var(--aiq-color-accent-soft)",
              color: grading.grader === "admin_override" ? "#fff" : "var(--aiq-color-accent)",
            }}
          >
            {grading.grader}
          </span>
        </div>
      </div>

      {/* Anchors — enriched with concept + weight when rubricAnchors prop is provided. */}
      {grading.anchor_hits && grading.anchor_hits.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-xs)" }}>
          {grading.anchor_hits.map((a) => {
            const def = anchorDefById.get(a.anchor_id);
            return (
              <AnchorChip
                key={a.anchor_id}
                finding={a}
                {...(def ? { anchorDef: def } : {})}
              />
            );
          })}
        </div>
      )}

      {/* AI justification — plain text */}
      {grading.ai_justification && (
        <p style={{ margin: 0, fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5, whiteSpace: "pre-wrap", fontFamily: "var(--aiq-font-sans)" }}>
          {grading.ai_justification}
        </p>
      )}

      {/* Override reason */}
      {grading.override_reason && (
        <div style={{ borderTop: "1px solid var(--aiq-color-border)", paddingTop: "var(--aiq-space-sm)" }}>
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", display: "block", marginBottom: 2 }}>
            Override reason
          </span>
          <p style={{ margin: 0, fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", whiteSpace: "pre-wrap" }}>
            {grading.override_reason}
          </p>
        </div>
      )}
    </div>
  );
}

ScoreDetail.displayName = "ScoreDetail";
