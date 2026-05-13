// AssessIQ — StackedBarChart component.
//
// Multi-series stacked-bar timeline, ported from the kit's `StackedBars`
// component in AssessIQ_UI_Template/screens/activity.jsx:109-143.
//
// Pure div/flex layout — no chart library. Chart palette uses the production
// --aiq-color-chart-{1..8} tokens (NOT the kit's ACT_COLORS hex array; the two
// palettes differ intentionally — production is Google-brand blue-anchored).
//
// Normalization:
//  - Each bar's displayed height = (sum of its segments) / max(sum across all bars).
//  - Each segment's share within a bar = segment / sum(bar's segments).
//  - Empty bars (total = 0) are skipped gracefully — no NaN rendered.

import React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StackedBarChartBar {
  /** Per-series values; will be auto-normalized — pass absolute counts or pre-computed shares. */
  segments: number[];
  /** Optional per-bar label, useful for tooltips/aria. */
  label?: string;
}

export interface StackedBarChartProps {
  /** Bars in chronological order (left → right). */
  bars: StackedBarChartBar[];
  /**
   * Per-segment colors, indexed by segment position. Defaults to the production
   * chart palette `--aiq-color-chart-{1..8}`. Wraps around if `bars[i].segments.length > 8`.
   */
  colors?: string[];
  /** Optional series labels for an auto-rendered legend below the chart. Length should equal max segment count. */
  seriesLabels?: string[];
  /** Optional left-axis tick labels (top → bottom order; kit example: ["28T", "21T", "14T", "7T", "0"]). */
  yAxisLabels?: string[];
  /** Optional meta line below the bars on the left (kit: "May 2025"). */
  xAxisStartLabel?: string;
  /** Optional meta line below the bars on the right (kit: "May 2026"). */
  xAxisEndLabel?: string;
  /** Chart height in px. Default 200. */
  height?: number;
  /** Gap between bars in px. Default 4. */
  gap?: number;
  /** Accessible label for the chart (required for SVG/visualization per branding-guideline §10.3). */
  "aria-label"?: string;
  "data-test-id"?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StackedBarChart(props: StackedBarChartProps): React.ReactElement {
  const {
    bars,
    colors = DEFAULT_CHART_COLORS,
    seriesLabels,
    yAxisLabels,
    xAxisStartLabel,
    xAxisEndLabel,
    height = 200,
    gap = 4,
    "aria-label": ariaLabel,
    "data-test-id": dataTestId,
    className,
  } = props;

  // Compute per-bar totals and the global max total for height normalization.
  const totals = bars.map((bar) => bar.segments.reduce((s, v) => s + v, 0));
  const maxTotal = Math.max(...totals, 1); // guard against empty bars array

  const hasYAxis = yAxisLabels && yAxisLabels.length > 0;
  const hasXLabels = xAxisStartLabel !== undefined || xAxisEndLabel !== undefined;
  const hasLegend = seriesLabels && seriesLabels.length > 0;

  const chartAriaLabel = ariaLabel ?? `Stacked bar chart with ${bars.length} bars`;

  // Y-axis labels are positioned absolutely on the left. Reserve paddingLeft
  // when they're present so they don't overlap the chart area (kit: 36px).
  const chartPaddingLeft = hasYAxis ? 36 : 0;

  return (
    <div
      role="img"
      aria-label={chartAriaLabel}
      data-test-id={dataTestId}
      className={["aiq-stacked-bar-chart", className].filter(Boolean).join(" ")}
      style={{ width: "100%" }}
    >
      {/* Chart area */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap,
          height,
          paddingLeft: chartPaddingLeft,
          borderLeft: "1px solid var(--aiq-color-border)",
          borderBottom: "1px solid var(--aiq-color-border)",
          position: "relative",
          boxSizing: "border-box",
        }}
      >
        {/* Y-axis labels — positioned absolutely to the left of the chart area */}
        {hasYAxis &&
          yAxisLabels!.map((label, i) => {
            const topPct = (i / (yAxisLabels!.length - 1)) * 100;
            return (
              <div
                key={`y-${i}`}
                aria-hidden
                style={{
                  position: "absolute",
                  left: -chartPaddingLeft,
                  top: `${topPct}%`,
                  transform: "translateY(-50%)",
                  fontFamily: "var(--aiq-font-mono)",
                  fontSize: 10,
                  color: "var(--aiq-color-fg-secondary)",
                  width: chartPaddingLeft - 4,
                  textAlign: "right",
                  lineHeight: 1,
                  pointerEvents: "none",
                }}
              >
                {label}
              </div>
            );
          })}

        {/* Bars */}
        {bars.map((bar, barIdx) => {
          const total = totals[barIdx] ?? 0;
          // Skip rendering if bar is empty — avoids NaN heights.
          const barHeightPct = total > 0 ? (total / maxTotal) * 100 : 0;
          const segTotal = total > 0 ? total : 1; // safe divisor

          return (
            <div
              key={barIdx}
              data-bar
              aria-label={bar.label}
              style={{
                flex: 1,
                height: `${barHeightPct}%`,
                display: "flex",
                flexDirection: "column-reverse",
                minWidth: 4,
                overflow: "hidden",
              }}
            >
              {bar.segments.map((seg, segIdx) => {
                const segHeightPct = (seg / segTotal) * 100;
                const color = colors[segIdx % colors.length];
                return (
                  <div
                    key={segIdx}
                    style={{
                      width: "100%",
                      height: `${segHeightPct}%`,
                      background: color,
                      opacity: 0.85,
                      flexShrink: 0,
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      {/* X-axis start/end meta labels */}
      {hasXLabels && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 8,
            paddingLeft: chartPaddingLeft,
            fontFamily: "var(--aiq-font-mono)",
            fontSize: 10,
            color: "var(--aiq-color-fg-secondary)",
          }}
        >
          <span>{xAxisStartLabel}</span>
          <span>{xAxisEndLabel}</span>
        </div>
      )}

      {/* Series legend */}
      {hasLegend && (
        <ul
          aria-hidden
          style={{
            listStyle: "none",
            margin: 0,
            marginTop: "var(--aiq-space-xs)",
            padding: 0,
            paddingLeft: chartPaddingLeft,
            display: "flex",
            flexWrap: "wrap",
            gap: "4px 12px",
          }}
        >
          {seriesLabels!.map((label, i) => (
            <li
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontFamily: "var(--aiq-font-mono)",
                fontSize: 10,
                color: "var(--aiq-color-fg-secondary)",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: colors[i % colors.length],
                  flexShrink: 0,
                }}
              />
              {label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

StackedBarChart.displayName = "StackedBarChart";
