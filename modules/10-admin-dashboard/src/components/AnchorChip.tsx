// AssessIQ — AnchorChip component.
//
// Displays a single AI grading anchor finding: hit/miss icon + anchor ID +
// optional evidence-quote tooltip. Tooltip rendered as plain text — never HTML.
// Domain composite (module 10): binds to @assessiq/ai-grading's AnchorFinding.

import React from "react";
import type { AnchorFinding } from "@assessiq/ai-grading";

export interface AnchorChipProps {
  finding: AnchorFinding;
  /** Human-readable anchor label (anchor_id is the stable key). */
  label?: string;
  /** Rubric definition for this anchor. When provided, renders concept + weight. */
  anchorDef?: { concept: string; weight: number; synonyms?: string[] };
  "data-test-id"?: string;
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function AnchorChip({ finding, label, anchorDef, "data-test-id": testId }: AnchorChipProps): React.ReactElement {
  const [tipVisible, setTipVisible] = React.useState(false);
  const hasTooltip = Boolean(anchorDef ?? finding.evidence_quote);
  const chipLabel = anchorDef
    ? `${trunc(anchorDef.concept, 40)} · ${anchorDef.weight}pts`
    : (label ?? finding.anchor_id);
  const color = finding.hit ? "var(--aiq-color-success)" : "var(--aiq-color-fg-muted)";
  const bg    = finding.hit ? "var(--aiq-color-success-soft)" : "var(--aiq-color-bg-sunken)";

  return (
    <span
      data-test-id={testId}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px",
        borderRadius: "var(--aiq-radius-pill)", background: bg, color,
        fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)",
        textTransform: "uppercase", letterSpacing: "0.04em",
        cursor: hasTooltip ? "help" : "default", position: "relative" }}
      onMouseEnter={() => hasTooltip && setTipVisible(true)}
      onMouseLeave={() => setTipVisible(false)}
    >
      <span aria-hidden="true">{finding.hit ? "✓" : "✗"}</span>
      <span>{chipLabel}</span>

      {tipVisible && hasTooltip && (
        <span role="tooltip" style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%",
          transform: "translateX(-50%)", background: "var(--aiq-color-fg-primary)",
          color: "var(--aiq-color-bg-base)", borderRadius: "var(--aiq-radius-sm)",
          padding: "6px 10px", fontSize: 11, fontFamily: "var(--aiq-font-sans)",
          textTransform: "none", letterSpacing: 0, whiteSpace: "pre-wrap",
          maxWidth: 300, zIndex: 10, pointerEvents: "none",
          display: "flex", flexDirection: "column", gap: 4 }}
        >
          {/* Block 1: full concept (bold) */}
          {anchorDef && <span style={{ fontWeight: 500 }}>{anchorDef.concept}</span>}

          {/* Block 2: weight + optional confidence */}
          {anchorDef && (
            <span style={{ fontSize: 10, opacity: 0.8 }}>
              {`Weight: ${anchorDef.weight}pts`}
              {finding.confidence != null ? ` · Confidence: ${Math.round(finding.confidence * 100)}%` : ""}
            </span>
          )}

          {/* Block 3: evidence quote (with label when anchorDef present) */}
          {finding.evidence_quote && (
            <span>
              {anchorDef && (
                <span style={{ display: "block", fontFamily: "var(--aiq-font-mono)", fontSize: 9,
                  textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.6, marginBottom: 2 }}>
                  as the model cited:
                </span>
              )}
              <span style={{ fontStyle: "italic" }}>{finding.evidence_quote}</span>
            </span>
          )}
        </span>
      )}
    </span>
  );
}

AnchorChip.displayName = "AnchorChip";
