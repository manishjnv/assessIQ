// AssessIQ — BandPicker component.
//
// Five radio cards (0..4) with band descriptions read from the question's
// rubric. The selected band is highlighted in accent-soft.
//
// INVARIANTS:
//  - Bands are 0/1/2/3/4 (integer). Never raw floats.
//  - The band label maps to 0/25/50/75/100 score percentage for display.

import React from "react";

export interface BandPickerProps {
  /** Currently selected band (0..4). */
  value: number | null;
  onChange: (band: number) => void;
  /** Human-readable band descriptions from the rubric. Length must be 5. */
  bandDescriptions?: [string, string, string, string, string];
  disabled?: boolean;
  "data-test-id"?: string;
}

const DEFAULT_DESCRIPTIONS: [string, string, string, string, string] = [
  "No evidence — answer absent, irrelevant, or entirely incorrect.",
  "Partial attempt — some relevant content but significant gaps.",
  "Adequate — core concepts addressed with minor gaps or errors.",
  "Proficient — correct and well-structured with minor refinements possible.",
  "Exemplary — comprehensive, precise, and demonstrates deep understanding.",
];

const BAND_SCORE: Record<number, number> = { 0: 0, 1: 25, 2: 50, 3: 75, 4: 100 };

export function BandPicker({
  value,
  onChange,
  bandDescriptions = DEFAULT_DESCRIPTIONS,
  disabled = false,
  "data-test-id": testId,
}: BandPickerProps): React.ReactElement {
  return (
    <div
      data-test-id={testId}
      role="radiogroup"
      aria-label="Select reasoning band"
      style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}
    >
      {([0, 1, 2, 3, 4] as const).map((band) => {
        const selected = value === band;
        return (
          <label
            key={band}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "var(--aiq-space-sm)",
              padding: "var(--aiq-space-sm) var(--aiq-space-md)",
              border: `1px solid ${selected ? "var(--aiq-color-accent)" : "var(--aiq-color-border)"}`,
              borderRadius: "var(--aiq-radius-md)",
              background: selected ? "var(--aiq-color-accent-soft)" : "var(--aiq-color-bg-base)",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.6 : 1,
              transition: "background var(--aiq-motion-duration-fast), border-color var(--aiq-motion-duration-fast)",
            }}
          >
            <input
              type="radio"
              name="band-picker"
              value={band}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(band)}
              style={{ marginTop: 2, accentColor: "var(--aiq-color-accent)" }}
            />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
                <span
                  style={{
                    fontFamily: "var(--aiq-font-serif)",
                    fontVariantNumeric: "lining-nums tabular-nums",
                    fontSize: "var(--aiq-text-lg)",
                    fontWeight: 400,
                    color: selected ? "var(--aiq-color-accent)" : "var(--aiq-color-fg-primary)",
                  }}
                >
                  Band {band}
                </span>
                <span
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: "var(--aiq-text-xs)",
                    color: "var(--aiq-color-fg-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  {BAND_SCORE[band]}%
                </span>
              </div>
              <p
                style={{
                  margin: "2px 0 0",
                  fontSize: "var(--aiq-text-sm)",
                  color: "var(--aiq-color-fg-secondary)",
                  lineHeight: 1.5,
                }}
              >
                {bandDescriptions[band]}
              </p>
            </div>
          </label>
        );
      })}
    </div>
  );
}

BandPicker.displayName = "BandPicker";
