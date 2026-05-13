// AssessIQ — StatCard component.
//
// KPI tile: label + big numeric value + optional Sparkline + optional delta.
// v1.1: optional `breakdown` prop renders a mini stacked-bar + colored legend
// list instead of a sparkline. Used on /admin/activity and /candidate/activity
// (mirrors the kit's StatChart pattern in screens/activity.jsx).
//
// INVARIANTS (branding-guideline.md):
//  - Big numbers use serif tabular-nums (aiq-num pattern).
//  - Card has no box-shadow at rest.
//  - Delta indicator is mono-spaced, uppercase.

import React from "react";
import { useCountUp } from "../hooks/useCountUp.js";
import { Sparkline } from "./Sparkline.js";
import type { SparklineProps } from "./Sparkline.js";

export interface StatCardBreakdownItem {
  /** Category name shown in the legend row. */
  label: string;
  /** Display value (pre-formatted by caller — e.g. "61", "2.4k", "92.1%"). */
  value: string | number;
  /** 0–1 fraction; drives the segment's height share in the mini stacked bar. */
  pct: number;
  /** Optional CSS color override. Defaults to --aiq-color-chart-{index+1}. */
  color?: string;
}

export interface StatCardProps {
  /** The KPI label. */
  label: string;
  /** Numeric value to display. */
  value: number;
  /** Optional unit suffix (e.g. "%", "ms"). */
  unit?: string;
  /** Optional sparkline data (7–30 points). Ignored if `breakdown` is set. */
  sparkline?: number[];
  /** Optional delta vs previous period (e.g. +3, -2). */
  delta?: number;
  sparklineColor?: SparklineProps["color"];
  /**
   * Optional breakdown segments. When provided, renders a mini stacked bar
   * + colored legend rows in place of the sparkline. Max 4 items shown in
   * the legend (excess are aggregated into "Other" by caller).
   */
  breakdown?: StatCardBreakdownItem[];
  "data-test-id"?: string;
}

const DEFAULT_CHART_COLORS = [
  "var(--aiq-color-chart-1)",
  "var(--aiq-color-chart-2)",
  "var(--aiq-color-chart-3)",
  "var(--aiq-color-chart-4)",
  "var(--aiq-color-chart-5)",
  "var(--aiq-color-chart-6)",
  "var(--aiq-color-chart-7)",
  "var(--aiq-color-chart-8)",
];

export function StatCard({
  label,
  value,
  unit,
  sparkline,
  delta,
  sparklineColor,
  breakdown,
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
        {breakdown && breakdown.length > 0 ? (
          <BreakdownBar items={breakdown} />
        ) : (
          sparkline && sparkline.length >= 2 && (
            <Sparkline data={sparkline} width={80} height={32} {...(sparklineColor !== undefined ? { color: sparklineColor } : {})} />
          )
        )}
      </div>
      {breakdown && breakdown.length > 0 && (
        <BreakdownLegend items={breakdown.slice(0, 4)} />
      )}
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

// ---------------------------------------------------------------------------
// Internal: mini stacked breakdown bar (kit activity.jsx:10-51 — `StatChart`)
// ---------------------------------------------------------------------------

function BreakdownBar({ items }: { items: StatCardBreakdownItem[] }): React.ReactElement {
  const totalPct = items.reduce((sum, it) => sum + it.pct, 0);
  const norm = totalPct > 0 ? totalPct : 1;
  return (
    <div
      role="img"
      aria-label="breakdown"
      style={{
        display: "flex",
        flexDirection: "column",
        width: 64,
        height: 36,
        background: "var(--aiq-color-bg-sunken)",
        borderRadius: "var(--aiq-radius-sm)",
        overflow: "hidden",
        justifyContent: "flex-end",
      }}
    >
      {items.map((it, i) => {
        const color = it.color ?? DEFAULT_CHART_COLORS[i % DEFAULT_CHART_COLORS.length];
        return (
          <div
            key={`${it.label}-${i}`}
            style={{
              height: `${(it.pct / norm) * 100}%`,
              background: color,
              minHeight: it.pct > 0 ? 2 : 0,
            }}
          />
        );
      })}
    </div>
  );
}

function BreakdownLegend({ items }: { items: StatCardBreakdownItem[] }): React.ReactElement {
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        marginTop: "var(--aiq-space-xs)",
      }}
    >
      {items.map((it, i) => {
        const color = it.color ?? DEFAULT_CHART_COLORS[i % DEFAULT_CHART_COLORS.length];
        return (
          <li
            key={`${it.label}-${i}`}
            style={{
              display: "grid",
              gridTemplateColumns: "10px 1fr auto",
              alignItems: "center",
              gap: 8,
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              color: "var(--aiq-color-fg-secondary)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: color,
              }}
            />
            <span style={{ textTransform: "none", letterSpacing: 0 }}>{it.label}</span>
            <span style={{ color: "var(--aiq-color-fg-primary)" }}>{it.value}</span>
          </li>
        );
      })}
    </ul>
  );
}
