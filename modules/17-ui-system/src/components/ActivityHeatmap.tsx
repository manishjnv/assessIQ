import { forwardRef } from "react";
import type { HTMLAttributes } from "react";

export interface ActivityHeatmapProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "aria-label"> {
  /**
   * Pre-binned intensity values, 0–4 inclusive, column-major chronological order:
   * idx = week * 7 + day, total length = weeks * 7 (default 52 * 7 = 364).
   * Callers pre-bucket their raw activity counts into 0–4 bands. Out-of-range
   * values are clamped to [0, 4].
   */
  data: number[];
  /** Number of week columns. Default 52. */
  weeks?: number;
  /** Optional month-label strip across the top (12 entries). Defaults to undefined (renders no month labels). */
  monthLabels?: string[];
  /** Day-of-week labels on the left strip. Default `["M", "W", "F"]` (kit shows only odd weekdays). */
  dayLabels?: string[];
  /** Optional mono-microcopy line on the legend row, right-aligned (kit example: "42-day streak · longest 71 days"). */
  streakSummary?: string;
  /** Override "Less" microcopy. Default "Less". */
  legendLessLabel?: string;
  /** Override "More" microcopy. Default "More". */
  legendMoreLabel?: string;
  /** Accessible label for the heatmap as a whole. */
  "aria-label"?: string;
  "data-test-id"?: string;
  className?: string;
}

function clamp(v: number): number {
  if (!isFinite(v) || isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 4) return 4;
  return Math.floor(v);
}

const HEATMAP_COLORS = [
  "var(--aiq-color-heatmap-0)",
  "var(--aiq-color-heatmap-1)",
  "var(--aiq-color-heatmap-2)",
  "var(--aiq-color-heatmap-3)",
  "var(--aiq-color-heatmap-4)",
] as const;

export const ActivityHeatmap = forwardRef<HTMLDivElement, ActivityHeatmapProps>(
  function ActivityHeatmap(props, ref) {
    const {
      data,
      weeks = 52,
      monthLabels,
      dayLabels = ["M", "W", "F"],
      streakSummary,
      legendLessLabel = "Less",
      legendMoreLabel = "More",
      "aria-label": ariaLabel,
      "data-test-id": dataTestId,
      className,
      ...rest
    } = props;

    const totalCells = weeks * 7;
    const accessibleLabel = ariaLabel ?? `Activity over ${weeks} weeks`;

    // Normalize data: pad with 0s if short, truncate if long, clamp each value
    const cells: number[] = Array.from({ length: totalCells }, (_, i) => {
      const raw = data[i];
      return raw === undefined ? 0 : clamp(raw);
    });

    return (
      <div
        ref={ref}
        className={["aiq-activity-heatmap", className].filter(Boolean).join(" ")}
        data-test-id={dataTestId}
        {...rest}
      >
        {/* Month label strip */}
        {monthLabels && monthLabels.length > 0 && (
          <div
            aria-hidden="true"
            style={{
              display: "grid",
              gridTemplateColumns: `28px repeat(${weeks}, 1fr)`,
              gap: 3,
              marginBottom: 6,
            }}
          >
            {/* spacer for day-label column */}
            <div />
            {monthLabels.map((m, i) => (
              <div
                key={`month-${i}`}
                style={{
                  gridColumn: `${2 + Math.floor((i * weeks) / 12)} / span ${Math.floor(weeks / 12)}`,
                  fontSize: 10,
                  fontFamily: "var(--aiq-font-mono)",
                  color: "var(--aiq-color-fg-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  minWidth: 8,
                }}
              >
                {m}
              </div>
            ))}
          </div>
        )}

        {/* Main grid: day-label column + cell grid */}
        <div
          role="img"
          aria-label={accessibleLabel}
          style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 6 }}
        >
          {/* Day-of-week labels */}
          <div
            aria-hidden="true"
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              padding: "2px 0",
              fontSize: 10,
              fontFamily: "var(--aiq-font-mono)",
              color: "var(--aiq-color-fg-muted)",
            }}
          >
            {dayLabels.map((label, i) => (
              <span key={`day-${i}`}>{label}</span>
            ))}
          </div>

          {/* Cell grid — column-major via gridAutoFlow: column */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${weeks}, 1fr)`,
              gridTemplateRows: "repeat(7, 1fr)",
              gap: 3,
              gridAutoFlow: "column",
            }}
          >
            {cells.map((v, i) => (
              <div
                key={`cell-${i}`}
                data-cell
                style={{
                  aspectRatio: "1",
                  borderRadius: 2,
                  background: HEATMAP_COLORS[v],
                  minWidth: 8,
                }}
              />
            ))}
          </div>
        </div>

        {/* Legend row */}
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginTop: 14,
            fontSize: 11,
            color: "var(--aiq-color-fg-muted)",
            fontFamily: "var(--aiq-font-mono)",
          }}
        >
          <span
            style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}
          >
            {legendLessLabel}
          </span>
          {([0, 1, 2, 3, 4] as const).map((v) => (
            <span
              key={`legend-${v}`}
              aria-hidden="true"
              style={{
                width: 11,
                height: 11,
                borderRadius: 2,
                background: HEATMAP_COLORS[v],
                display: "inline-block",
              }}
            />
          ))}
          <span
            style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}
          >
            {legendMoreLabel}
          </span>
          {streakSummary && (
            <>
              <span style={{ flex: 1 }} />
              <span>{streakSummary}</span>
            </>
          )}
        </div>
      </div>
    );
  },
);

ActivityHeatmap.displayName = "ActivityHeatmap";
