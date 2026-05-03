// AssessIQ — Sparkline component.
//
// A 7–30 point line chart rendered in pure SVG with optional area fill.
// No chart library dependency. Respects prefers-reduced-motion (no animation).
//
// INVARIANTS (branding-guideline.md):
//  - Line color defaults to --aiq-color-accent.
//  - No box-shadow.

import React from "react";

export interface SparklineProps {
  /** Array of numeric data points (≥2). */
  data: number[];
  /** Width of the SVG in px. Default: 120. */
  width?: number;
  /** Height of the SVG in px. Default: 36. */
  height?: number;
  /** Whether to fill the area below the line. Default: true. */
  fill?: boolean;
  /** Stroke color. Default: var(--aiq-color-accent). */
  color?: string;
  /** Stroke width in px. Default: 1.5. */
  strokeWidth?: number;
  /** Optional accessible label. */
  "aria-label"?: string;
  "data-test-id"?: string;
}

export function Sparkline({
  data,
  width = 120,
  height = 36,
  fill = true,
  color = "var(--aiq-color-accent)",
  strokeWidth = 1.5,
  "aria-label": ariaLabel,
  "data-test-id": testId,
}: SparklineProps): React.ReactElement | null {
  if (data.length < 2) return null;

  const pad = strokeWidth;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const toX = (i: number) => pad + (i / (data.length - 1)) * innerW;
  const toY = (v: number) => pad + innerH - ((v - min) / range) * innerH;

  const points = data.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");
  const linePath = `M ${points.split(" ").join(" L ")}`;
  const areaPath = `${linePath} L ${toX(data.length - 1)},${pad + innerH} L ${toX(0)},${pad + innerH} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-label={ariaLabel ?? "trend chart"}
      role="img"
      data-test-id={testId}
    >
      {fill && (
        <path
          d={areaPath}
          fill={color}
          fillOpacity={0.12}
          stroke="none"
        />
      )}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

Sparkline.displayName = "Sparkline";
