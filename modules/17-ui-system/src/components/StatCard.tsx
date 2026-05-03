// AssessIQ — StatCard component.
//
// KPI tile: label + big numeric value + optional Sparkline + optional delta.
//
// INVARIANTS (branding-guideline.md):
//  - Big numbers use serif tabular-nums (aiq-num pattern).
//  - Card has no box-shadow at rest.
//  - Delta indicator is mono-spaced, uppercase.

import React from "react";
import { useCountUp } from "../hooks/useCountUp.js";
import { Sparkline } from "./Sparkline.js";
import type { SparklineProps } from "./Sparkline.js";

export interface StatCardProps {
  /** The KPI label. */
  label: string;
  /** Numeric value to display. */
  value: number;
  /** Optional unit suffix (e.g. "%", "ms"). */
  unit?: string;
  /** Optional sparkline data (7–30 points). */
  sparkline?: number[];
  /** Optional delta vs previous period (e.g. +3, -2). */
  delta?: number;
  sparklineColor?: SparklineProps["color"];
  "data-test-id"?: string;
}

export function StatCard({
  label,
  value,
  unit,
  sparkline,
  delta,
  sparklineColor,
  "data-test-id": testId,
}: StatCardProps): React.ReactElement {
  const animated = useCountUp(value);

  const deltaColor =
    delta === undefined ? "var(--aiq-color-fg-muted)"
    : delta > 0 ? "var(--aiq-color-success)"
    : delta < 0 ? "var(--aiq-color-danger)"
    : "var(--aiq-color-fg-muted)";

  return (
    <div
      className="aiq-card"
      data-test-id={testId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--aiq-space-xs)",
        padding: "var(--aiq-space-lg)",
        minWidth: 140,
      }}
    >
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
      <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--aiq-space-sm)", justifyContent: "space-between" }}>
        <span
          style={{
            fontFamily: "var(--aiq-font-serif)",
            fontVariantNumeric: "lining-nums tabular-nums",
            fontSize: "var(--aiq-text-3xl)",
            lineHeight: 1,
            color: "var(--aiq-color-fg-primary)",
          }}
        >
          {animated}
          {unit && (
            <span
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-md)",
                color: "var(--aiq-color-fg-secondary)",
                marginLeft: 2,
              }}
            >
              {unit}
            </span>
          )}
        </span>
        {sparkline && sparkline.length >= 2 && (
          <Sparkline data={sparkline} width={80} height={32} {...(sparklineColor !== undefined ? { color: sparklineColor } : {})} />
        )}
      </div>
      {delta !== undefined && (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: deltaColor,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {delta > 0 ? "▲" : delta < 0 ? "▼" : "→"} {Math.abs(delta)} vs prev
        </span>
      )}
    </div>
  );
}

StatCard.displayName = "StatCard";
