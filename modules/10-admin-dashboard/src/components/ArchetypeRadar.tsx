// AssessIQ — ArchetypeRadar component.
//
// Radar chart of archetype_signals (pure SVG, no chart library).
// Shows top 6 signals normalized 0–1 across the 6 axes.
//
// P2.D11 — signals shape is the contract from @assessiq/scoring.

import React from "react";
import type { ArchetypeSignals } from "@assessiq/scoring";

export interface ArchetypeRadarProps {
  signals: ArchetypeSignals;
  /** Width/height of the SVG. Default: 200. */
  size?: number;
  "data-test-id"?: string;
}

interface Axis {
  key: keyof ArchetypeSignals;
  label: string;
  /** Normalization ceiling — values above this clamp to 1. */
  max: number;
}

const AXES: Axis[] = [
  { key: "time_per_question_p50_ms", label: "Pace", max: 300_000 },
  { key: "edit_count_total", label: "Edits", max: 30 },
  { key: "flag_count", label: "Flags", max: 10 },
  { key: "tab_blur_count", label: "Focus loss", max: 20 },
  { key: "copy_paste_count", label: "Copy/paste", max: 10 },
  { key: "multi_tab_conflict_count", label: "Multi-tab", max: 5 },
];

function polarToXY(angle: number, r: number, cx: number, cy: number) {
  return {
    x: cx + r * Math.cos(angle - Math.PI / 2),
    y: cy + r * Math.sin(angle - Math.PI / 2),
  };
}

export function ArchetypeRadar({
  signals,
  size = 200,
  "data-test-id": testId,
}: ArchetypeRadarProps): React.ReactElement {
  const cx = size / 2;
  const cy = size / 2;
  const maxR = (size / 2) * 0.72;
  const n = AXES.length;
  const step = (2 * Math.PI) / n;

  // Normalize values
  const values = AXES.map((a) => {
    const raw = signals[a.key];
    const num = typeof raw === "number" ? raw : 0;
    return Math.min(1, Math.max(0, num / a.max));
  });

  // Data polygon
  const dataPoints = AXES.map((_, i) => {
    const v = values[i] ?? 0;
    const { x, y } = polarToXY(i * step, v * maxR, cx, cy);
    return `${x},${y}`;
  }).join(" ");

  // Axis lines + grid rings
  const gridLevels = [0.25, 0.5, 0.75, 1];

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-label="Archetype radar chart"
      role="img"
      data-test-id={testId}
    >
      {/* Grid rings */}
      {gridLevels.map((level) => {
        const gridPoints = AXES.map((_, i) => {
          const { x, y } = polarToXY(i * step, level * maxR, cx, cy);
          return `${x},${y}`;
        }).join(" ");
        return (
          <polygon
            key={level}
            points={gridPoints}
            fill="none"
            stroke="var(--aiq-color-border)"
            strokeWidth={0.5}
          />
        );
      })}

      {/* Axis lines */}
      {AXES.map((_, i) => {
        const { x, y } = polarToXY(i * step, maxR, cx, cy);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="var(--aiq-color-border)"
            strokeWidth={0.5}
          />
        );
      })}

      {/* Data polygon */}
      <polygon
        points={dataPoints}
        fill="var(--aiq-color-accent)"
        fillOpacity={0.2}
        stroke="var(--aiq-color-accent)"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />

      {/* Axis labels */}
      {AXES.map((axis, i) => {
        const { x, y } = polarToXY(i * step, maxR + 16, cx, cy);
        return (
          <text
            key={axis.key}
            x={x}
            y={y}
            textAnchor="middle"
            dominantBaseline="central"
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: 9,
              fill: "var(--aiq-color-fg-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {axis.label}
          </text>
        );
      })}
    </svg>
  );
}

ArchetypeRadar.displayName = "ArchetypeRadar";
