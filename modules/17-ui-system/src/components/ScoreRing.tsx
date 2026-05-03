// AssessIQ — ScoreRing component.
//
// Circular progress ring with animated count-up. Displays a numeric value
// (0–100) inside a ring. Respects prefers-reduced-motion via useCountUp.
//
// INVARIANTS (branding-guideline.md):
//  - The numeric label inside the ring uses serif tabular-nums (.aiq-num).
//  - No box-shadow on the ring itself.
//  - Accent color from --aiq-color-accent.

import React from "react";
import { useCountUp } from "../hooks/useCountUp.js";

export type ScoreRingSize = "sm" | "md" | "lg";

export interface ScoreRingProps {
  /** Value 0–100. */
  value: number;
  /** Optional label below the number (e.g. "band 3"). */
  label?: string;
  size?: ScoreRingSize;
  /** Custom color for the ring fill; defaults to --aiq-color-accent. */
  color?: string;
  "data-test-id"?: string;
}

const SIZE_PX: Record<ScoreRingSize, number> = { sm: 48, md: 72, lg: 96 };
const STROKE_PX: Record<ScoreRingSize, number> = { sm: 4, md: 5, lg: 6 };
const LABEL_PX: Record<ScoreRingSize, number> = { sm: 12, md: 18, lg: 24 };

export function ScoreRing({
  value,
  label,
  size = "md",
  color,
  "data-test-id": testId,
}: ScoreRingProps): React.ReactElement {
  const px = SIZE_PX[size];
  const stroke = STROKE_PX[size];
  const radius = (px - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  const animated = useCountUp(clamped);
  const dashOffset = circ * (1 - animated / 100);

  return (
    <div
      style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 4 }}
      data-test-id={testId}
    >
      <svg
        width={px}
        height={px}
        viewBox={`0 0 ${px} ${px}`}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        role="progressbar"
        style={{ transform: "rotate(-90deg)" }}
      >
        {/* Track */}
        <circle
          cx={px / 2}
          cy={px / 2}
          r={radius}
          fill="none"
          stroke="var(--aiq-color-bg-sunken)"
          strokeWidth={stroke}
        />
        {/* Fill */}
        <circle
          cx={px / 2}
          cy={px / 2}
          r={radius}
          fill="none"
          stroke={color ?? "var(--aiq-color-accent)"}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={dashOffset}
          style={{ transition: "stroke-dashoffset 180ms var(--aiq-motion-easing-out)" }}
        />
        {/* Numeric label inside ring — rotated back upright */}
        <text
          x={px / 2}
          y={px / 2}
          textAnchor="middle"
          dominantBaseline="central"
          style={{
            transform: "rotate(90deg)",
            transformOrigin: `${px / 2}px ${px / 2}px`,
            fontFamily: "var(--aiq-font-serif)",
            fontVariantNumeric: "lining-nums tabular-nums",
            fontSize: LABEL_PX[size],
            fill: "var(--aiq-color-fg-primary)",
          }}
        >
          {animated}
        </text>
      </svg>
      {label && (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

ScoreRing.displayName = "ScoreRing";
