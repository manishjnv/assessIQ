// AssessIQ — AnchorChip component.
//
// Displays a single AI grading anchor finding: hit/miss icon + anchor ID +
// optional evidence-quote tooltip. The tooltip content is the raw evidence
// quote from Stage 1; it is rendered as text (not HTML) per the admin-anti-
// pattern guard "sanitize AI output via remark-rehype, never raw HTML".
//
// Domain composite — lives in module 10 (not 17-ui-system) because it
// binds to @assessiq/ai-grading's AnchorFinding type.

import React from "react";
import type { AnchorFinding } from "@assessiq/ai-grading";

export interface AnchorChipProps {
  finding: AnchorFinding;
  /** Human-readable anchor label (anchor_id is the stable key). */
  label?: string;
  "data-test-id"?: string;
}

export function AnchorChip({
  finding,
  label,
  "data-test-id": testId,
}: AnchorChipProps): React.ReactElement {
  const [tipVisible, setTipVisible] = React.useState(false);

  const color = finding.hit
    ? "var(--aiq-color-success)"
    : "var(--aiq-color-fg-muted)";
  const bgColor = finding.hit
    ? "var(--aiq-color-success-soft)"
    : "var(--aiq-color-bg-sunken)";

  return (
    <span
      data-test-id={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: "var(--aiq-radius-pill)",
        background: bgColor,
        color,
        fontFamily: "var(--aiq-font-mono)",
        fontSize: "var(--aiq-text-xs)",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        cursor: finding.evidence_quote ? "help" : "default",
        position: "relative",
      }}
      onMouseEnter={() => finding.evidence_quote && setTipVisible(true)}
      onMouseLeave={() => setTipVisible(false)}
    >
      {/* hit/miss icon */}
      <span aria-hidden="true">{finding.hit ? "✓" : "✗"}</span>
      <span>{label ?? finding.anchor_id}</span>

      {/* Evidence quote tooltip — plain text, never HTML */}
      {tipVisible && finding.evidence_quote && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--aiq-color-fg-primary)",
            color: "var(--aiq-color-bg-base)",
            borderRadius: "var(--aiq-radius-sm)",
            padding: "4px 8px",
            fontSize: 11,
            fontFamily: "var(--aiq-font-sans)",
            textTransform: "none",
            letterSpacing: 0,
            whiteSpace: "pre-wrap",
            maxWidth: 280,
            zIndex: 10,
            pointerEvents: "none",
          }}
        >
          {/* Plain text — no dangerouslySetInnerHTML */}
          {finding.evidence_quote}
        </span>
      )}
    </span>
  );
}

AnchorChip.displayName = "AnchorChip";
