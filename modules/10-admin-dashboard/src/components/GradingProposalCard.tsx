// AssessIQ — GradingProposalCard component.
//
// Displays a GradingProposal from the AI grading runtime:
//   - Anchor chips (hit/miss with evidence)
//   - Band indicator
//   - AI justification (sanitized plain text — no dangerouslySetInnerHTML)
//   - Error class (if any)
//   - Footer: Accept / Override / Re-run buttons
//
// P2.D16: when proposal.escalation is present, the card shows a "Stage 3
// escalation" badge. The full side-by-side diff is rendered by EscalationDiff.
//
// INVARIANTS:
//  - ai_justification is shown as pre-wrapped plain text, never raw HTML.
//  - Score display: band → percentage mapping (0→0, 1→25, 2→50, 3→75, 4→100).

import React from "react";
import type { GradingProposal } from "@assessiq/ai-grading";
import { AnchorChip } from "./AnchorChip.js";

export interface GradingProposalCardProps {
  proposal: GradingProposal;
  /** Whether an accept/override/rerun action is in flight. */
  submitting?: boolean;
  onAccept?: () => void;
  onOverride?: () => void;
  onRerun?: () => void;
  /** If true, the footer actions are hidden (used in override modal context). */
  hideFooter?: boolean;
  "data-test-id"?: string;
}

const BAND_PCT: Record<number, number> = { 0: 0, 1: 25, 2: 50, 3: 75, 4: 100 };

export function GradingProposalCard({
  proposal,
  submitting = false,
  onAccept,
  onOverride,
  onRerun,
  hideFooter = false,
  "data-test-id": testId,
}: GradingProposalCardProps): React.ReactElement {
  const band = proposal.band.reasoning_band;
  const bandPct = BAND_PCT[band] ?? 0;

  return (
    <div className="aiq-card" data-test-id={testId} style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", justifyContent: "space-between" }}>
        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
          AI Proposal
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
          {proposal.escalation_chosen_stage === "3" && (
            <span style={{ background: "var(--aiq-color-warning)", color: "#fff", borderRadius: "var(--aiq-radius-pill)", fontSize: 10, padding: "1px 6px", fontFamily: "var(--aiq-font-mono)", textTransform: "uppercase" }}>
              Stage 3
            </span>
          )}
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
            {proposal.prompt_version_label}
          </span>
        </div>
      </div>

      {/* Band + score */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)" }}>
        <div>
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", display: "block", marginBottom: 2 }}>
            Reasoning band
          </span>
          <span style={{ fontFamily: "var(--aiq-font-serif)", fontVariantNumeric: "lining-nums tabular-nums", fontSize: "var(--aiq-text-2xl)", color: "var(--aiq-color-fg-primary)" }}>
            Band {band}
          </span>
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", marginLeft: 6 }}>
            ({bandPct}%)
          </span>
        </div>
        <div>
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", display: "block", marginBottom: 2 }}>
            Score
          </span>
          <span style={{ fontFamily: "var(--aiq-font-serif)", fontVariantNumeric: "lining-nums tabular-nums", fontSize: "var(--aiq-text-xl)", color: "var(--aiq-color-fg-primary)" }}>
            {proposal.score_earned}/{proposal.score_max}
          </span>
        </div>
      </div>

      {/* Anchors */}
      {proposal.anchors.length > 0 && (
        <div>
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", display: "block", marginBottom: "var(--aiq-space-xs)" }}>
            Anchors
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-xs)" }}>
            {proposal.anchors.map((a) => (
              <AnchorChip key={a.anchor_id} finding={a} />
            ))}
          </div>
        </div>
      )}

      {/* AI justification — plain text, no HTML */}
      <div>
        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", display: "block", marginBottom: "var(--aiq-space-xs)" }}>
          Justification
        </span>
        <p style={{ margin: 0, fontSize: "var(--aiq-text-md)", color: "var(--aiq-color-fg-secondary)", lineHeight: 1.6, whiteSpace: "pre-wrap", fontFamily: "var(--aiq-font-sans)" }}>
          {/* Plain text — never dangerouslySetInnerHTML */}
          {proposal.band.ai_justification}
        </p>
      </div>

      {/* Error class (if any) */}
      {proposal.band.error_class && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
            Error class:
          </span>
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-danger)", background: "oklch(0.97 0.02 25)", borderRadius: "var(--aiq-radius-pill)", padding: "1px 8px" }}>
            {proposal.band.error_class}
          </span>
        </div>
      )}

      {/* Footer */}
      {!hideFooter && (
        <div style={{ display: "flex", gap: "var(--aiq-space-sm)", borderTop: "1px solid var(--aiq-color-border)", paddingTop: "var(--aiq-space-md)", flexWrap: "wrap" }}>
          {onAccept && (
            <button
              type="button"
              className="aiq-btn aiq-btn-primary aiq-btn-sm"
              disabled={submitting}
              onClick={onAccept}
              data-test-id="proposal-accept"
            >
              Accept
            </button>
          )}
          {onOverride && (
            <button
              type="button"
              className="aiq-btn aiq-btn-outline aiq-btn-sm"
              disabled={submitting}
              onClick={onOverride}
            >
              Override
            </button>
          )}
          {onRerun && (
            <button
              type="button"
              className="aiq-btn aiq-btn-ghost aiq-btn-sm"
              disabled={submitting}
              onClick={onRerun}
            >
              Re-run
            </button>
          )}
        </div>
      )}
    </div>
  );
}

GradingProposalCard.displayName = "GradingProposalCard";
