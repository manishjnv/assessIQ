// AssessIQ — EscalationDiff component.
//
// P2.D16: when Stage 2 and Stage 3 disagree by ≥2 bands, the admin can
// trigger "Re-run with Opus". The re-run returns a new proposals array.
// This component compares two proposals (original vs rerun) side-by-side
// with a "Reconcile" affordance.
//
// The chosen stage is written to `gradings.escalation_chosen_stage` via
// the accept/override endpoint body.

import React, { useState } from "react";
import type { GradingProposal } from "@assessiq/ai-grading";

export interface EscalationDiffProps {
  /** Original Stage-2 proposal. */
  stageTwo: GradingProposal;
  /** Stage-3 (Opus) re-run proposal. */
  stageThree: GradingProposal;
  /** Called with the chosen stage + admin note. */
  onReconcile: (stage: "2" | "3" | "manual", note: string) => void;
  submitting?: boolean;
  "data-test-id"?: string;
}

const BAND_PCT: Record<number, number> = { 0: 0, 1: 25, 2: 50, 3: 75, 4: 100 };

function VerdictCard({
  title,
  band,
  justification,
  errorClass,
  selected,
  onSelect,
}: {
  title: string;
  band: number;
  justification: string;
  errorClass?: string | null;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <div
      className="aiq-card"
      style={{
        flex: 1,
        border: `2px solid ${selected ? "var(--aiq-color-accent)" : "var(--aiq-color-border)"}`,
        cursor: "pointer",
        background: selected ? "var(--aiq-color-accent-soft)" : undefined,
        padding: "var(--aiq-space-md)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--aiq-space-sm)",
      }}
      onClick={onSelect}
    >
      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: selected ? "var(--aiq-color-accent)" : "var(--aiq-color-fg-muted)" }}>
        {title}
      </span>
      <span style={{ fontFamily: "var(--aiq-font-serif)", fontVariantNumeric: "lining-nums tabular-nums", fontSize: "var(--aiq-text-xl)" }}>
        Band {band} · {BAND_PCT[band] ?? 0}%
      </span>
      <p style={{ margin: 0, fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
        {justification}
      </p>
      {errorClass && (
        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 10, color: "var(--aiq-color-danger)", textTransform: "uppercase" }}>
          {errorClass}
        </span>
      )}
    </div>
  );
}

export function EscalationDiff({
  stageTwo,
  stageThree,
  onReconcile,
  submitting = false,
  "data-test-id": testId,
}: EscalationDiffProps): React.ReactElement {
  const [chosen, setChosen] = useState<"2" | "3" | null>(null);
  const [note, setNote] = useState("");

  return (
    <div data-test-id={testId} style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
        <span style={{ background: "var(--aiq-color-warning)", color: "#fff", borderRadius: "var(--aiq-radius-pill)", fontSize: 10, padding: "2px 8px", fontFamily: "var(--aiq-font-mono)", textTransform: "uppercase" }}>
          Stage-2 vs Stage-3 comparison
        </span>
        <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)" }}>
          Pick the verdict to accept.
        </span>
      </div>

      {/* Side-by-side */}
      <div style={{ display: "flex", gap: "var(--aiq-space-md)" }}>
        <VerdictCard
          title="Stage 2 · Sonnet"
          band={stageTwo.band.reasoning_band}
          justification={stageTwo.band.ai_justification}
          errorClass={stageTwo.band.error_class ?? null}
          selected={chosen === "2"}
          onSelect={() => setChosen("2")}
        />
        <VerdictCard
          title="Stage 3 · Opus re-run"
          band={stageThree.band.reasoning_band}
          justification={stageThree.band.ai_justification}
          errorClass={stageThree.band.error_class ?? null}
          selected={chosen === "3"}
          onSelect={() => setChosen("3")}
        />
      </div>

      {/* Admin note */}
      <label style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
          Reconciliation note (required)
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Why are you picking this verdict?"
          style={{
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-md)",
            padding: "var(--aiq-space-sm)",
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-md)",
            resize: "vertical",
          }}
        />
      </label>

      <button
        type="button"
        className="aiq-btn aiq-btn-primary aiq-btn-sm"
        disabled={!chosen || !note.trim() || submitting}
        onClick={() => chosen && onReconcile(chosen, note.trim())}
      >
        Confirm reconciliation
      </button>
    </div>
  );
}

EscalationDiff.displayName = "EscalationDiff";
