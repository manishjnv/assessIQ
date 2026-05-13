import { forwardRef } from "react";
import type { HTMLAttributes } from "react";
import { Button } from "./Button.js";

export interface LeaderboardListDelta {
  /** Display string for the delta (e.g. "12%", "0.4"). */
  value: string;
  /** Direction — drives icon + color. true = up/positive (success), false = down/negative (danger). */
  up: boolean;
}

export interface LeaderboardListItem {
  /** Primary line — the assessment / item name. */
  name: string;
  /** Secondary line below `name` (kit example: "by AccessIQ Cognitive"). Optional. */
  subline?: string;
  /** Right-side primary metric (kit example: "4.2k takers"). Pre-formatted by caller. */
  metric: string;
  /** Optional change indicator below `metric`. */
  delta?: LeaderboardListDelta;
}

export interface LeaderboardListProps extends HTMLAttributes<HTMLOListElement> {
  items: LeaderboardListItem[];
  /** Number of columns. Default 2 (kit). When 1, single-column flow. */
  columns?: 1 | 2;
  /**
   * Per-rank avatar colors, indexed by rank. Defaults to the production chart palette
   * `--aiq-color-chart-{1..8}` and wraps around if `items.length > 8`.
   */
  colors?: string[];
  /** Optional "Show more" callback. When provided, renders a ghost button below the list. */
  onShowMore?: () => void;
  /** Override "Show more" label. Default "Show more". */
  showMoreLabel?: string;
  "data-test-id"?: string;
  className?: string;
}

const DEFAULT_COLORS: string[] = [
  "var(--aiq-color-chart-1)",
  "var(--aiq-color-chart-2)",
  "var(--aiq-color-chart-3)",
  "var(--aiq-color-chart-4)",
  "var(--aiq-color-chart-5)",
  "var(--aiq-color-chart-6)",
  "var(--aiq-color-chart-7)",
  "var(--aiq-color-chart-8)",
];

export const LeaderboardList = forwardRef<HTMLOListElement, LeaderboardListProps>(
  function LeaderboardList(props, ref) {
    const {
      items,
      columns = 2,
      colors = DEFAULT_COLORS,
      onShowMore,
      showMoreLabel = "Show more",
      className,
      style,
      ...rest
    } = props;

    const gridStyle =
      columns === 2
        ? { display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 40, rowGap: 4 }
        : { display: "grid", gridTemplateColumns: "1fr", rowGap: 4 };

    return (
      <div className={className} style={style}>
        <ol
          ref={ref}
          style={{ ...gridStyle, listStyle: "none", margin: 0, padding: 0 }}
          {...rest}
        >
          {items.map((item, i) => {
            const slotColor = colors[i % colors.length];
            const hasBorder =
              columns === 2 ? i < items.length - 2 : i < items.length - 1;
            const cleanDelta = item.delta?.value
              .replace("+", "")
              .replace("-", "");

            return (
              <li
                key={i}
                style={{
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  padding: "12px 0",
                  gap: 14,
                  borderBottom: hasBorder
                    ? "1px solid var(--aiq-color-border)"
                    : undefined,
                }}
              >
                {/* Rank number */}
                <span
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: 13,
                    color: "var(--aiq-color-fg-muted)",
                    width: 24,
                    textAlign: "right",
                    flexShrink: 0,
                  }}
                >
                  {i + 1}.
                </span>

                {/* Avatar: outer ring (0.18 opacity via position:relative wrapper) + inner solid dot */}
                <div
                  aria-hidden="true"
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    flexShrink: 0,
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {/* Outer filled circle at 0.18 opacity — absolute so opacity doesn't cascade to inner dot */}
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      borderRadius: "50%",
                      backgroundColor: slotColor,
                      opacity: 0.18,
                    }}
                  />
                  {/* Inner solid dot — sits above the outer fill, full opacity */}
                  <div
                    style={{
                      position: "relative",
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      backgroundColor: slotColor,
                    }}
                  />
                </div>

                {/* Name / subline column */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 500,
                      color: "var(--aiq-color-fg-primary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {item.name}
                  </div>
                  {item.subline !== undefined && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--aiq-color-fg-muted)",
                      }}
                    >
                      {item.subline}
                    </div>
                  )}
                </div>

                {/* Metric / delta column */}
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: 13,
                      color: "var(--aiq-color-fg-primary)",
                    }}
                  >
                    {item.metric}
                  </div>
                  {item.delta !== undefined && (
                    <div
                      style={{
                        fontFamily: "var(--aiq-font-mono)",
                        fontSize: 11,
                        color: item.delta.up
                          ? "var(--aiq-color-success)"
                          : "var(--aiq-color-danger)",
                      }}
                    >
                      {item.delta.up ? "↑" : "↓"} {cleanDelta}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {onShowMore !== undefined && (
          <div style={{ textAlign: "center", marginTop: 16 }}>
            <Button variant="ghost" size="sm" onClick={onShowMore}>
              {showMoreLabel}
            </Button>
          </div>
        )}
      </div>
    );
  },
);

LeaderboardList.displayName = "LeaderboardList";
