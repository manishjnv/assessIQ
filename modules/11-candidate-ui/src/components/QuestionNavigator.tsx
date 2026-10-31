import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { groupNavigatorItems, countAnswered } from "./navigatorGroups.js";
import { NavigatorRail } from "./NavigatorRail.js";
import {
  filterCounts,
  isAnswered,
  isFlagged,
  matchesFilter,
  neighbor,
  type NavigatorFilter,
} from "./navigatorFilter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NavigatorItem {
  questionId: string;
  position: number; // 1-based for display
  /** "answered" if there's a non-null answer; "flagged" if flagged; "current" if active; else "unanswered". */
  status: "unanswered" | "answered" | "flagged" | "current";
  /** Whole-test mode: the section this question belongs to (groups the navigator). Absent = flat list. */
  section?: { index: number; name: string };
  /** True when the question has an answer, even if status shows current/flagged. Falls back to status. */
  answered?: boolean;
  /** True when the question is flagged, even if status shows current. Falls back to status. */
  flagged?: boolean;
}

export interface QuestionNavigatorProps {
  items: NavigatorItem[];
  /** Called when the candidate clicks a square. */
  onSelect: (questionId: string) => void;
  /** Minimum square height in px (default 36). */
  squareSize?: number;
  /** Z-169: controlled filter. Absent = the panel keeps its own. */
  filter?: NavigatorFilter;
  onFilterChange?: (filter: NavigatorFilter) => void;
  /** Z-169: "Next unanswered". Absent = onSelect with the next open question. */
  onNextOpen?: () => void;
  /** Z-169/Z-170: folded to the 88 px rail. The collapse pill is `NavCollapseHandle`, placed by the page. */
  collapsed?: boolean;
  /** Z-170: "strip" = the 68 px horizontal strip of the mobile layout (same rail logic on the X axis). */
  layout?: "panel" | "strip";
  /** Strip only: the button that opens the full navigator sheet. */
  trailing?: ReactNode;
  "data-test-id"?: string;
}

// ---------------------------------------------------------------------------
// Style injection (once per page load, SSR-safe): focus ring, hover, reduced motion
// ---------------------------------------------------------------------------

const STYLE_ID = "aiq-question-navigator-style";

function injectStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;

  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
.aiq-qnav-cell, .aiq-qnav-stat { transition: transform var(--aiq-motion-duration-fast, 120ms) var(--aiq-motion-easing-out, ease); }
.aiq-qnav-cell:hover:not([data-current="true"]), .aiq-qnav-stat:hover { transform: translateY(-1px); }
.aiq-qnav-cell:focus-visible, .aiq-qnav-stat:focus-visible, .aiq-qnav-btn:focus-visible {
  outline: 2px solid var(--aiq-color-accent);
  outline-offset: 2px;
}
.aiq-qnav-btn:disabled { opacity: 0.5; cursor: not-allowed; }
@media (prefers-reduced-motion: reduce) {
  .aiq-qnav-cell, .aiq-qnav-stat { transition: none; }
  .aiq-qnav-cell:hover:not([data-current="true"]), .aiq-qnav-stat:hover { transform: none; }
}
`.trim();
  document.head.appendChild(el);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERIF = "var(--aiq-font-serif, Georgia, serif)";

/** "Question 3, answered, flagged, current". */
function cellName(item: NavigatorItem): string {
  const parts = [`Question ${item.position}`, isAnswered(item) ? "answered" : "unanswered"];
  if (isFlagged(item)) parts.push("flagged");
  if (item.status === "current") parts.push("current");
  return parts.join(", ");
}

function cellLook(item: NavigatorItem): CSSProperties {
  if (item.status === "current") {
    return {
      border: "2px solid var(--aiq-color-accent)",
      background: "var(--aiq-color-accent-soft)",
      color: "var(--aiq-color-fg-primary)",
      fontWeight: 600,
    };
  }
  if (isAnswered(item)) {
    return {
      border: "1px solid var(--aiq-color-success)",
      background: "var(--aiq-color-success-soft)",
      color: "var(--aiq-color-fg-primary)",
    };
  }
  return {
    border: "1px solid var(--aiq-color-border)",
    background: "var(--aiq-color-bg-base)",
    color: "var(--aiq-color-fg-secondary)",
  };
}

const STATS: ReadonlyArray<readonly ["answered" | "flagged" | "open", string]> = [
  ["answered", "Answered"],
  ["flagged", "Flagged"],
  ["open", "Open"],
];

const ctrl: CSSProperties = {
  padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
  border: "1px solid var(--aiq-color-border)",
  borderRadius: "var(--aiq-radius-sm)",
  background: "var(--aiq-color-bg-base)",
  color: "var(--aiq-color-fg-primary)",
  fontSize: "var(--aiq-text-sm)",
  cursor: "pointer",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuestionNavigator(props: QuestionNavigatorProps) {
  const {
    items,
    onSelect,
    squareSize = 36,
    filter: filterProp,
    onFilterChange,
    onNextOpen,
    collapsed = false,
    layout = "panel",
    trailing,
    "data-test-id": testId,
  } = props;

  useEffect(() => {
    injectStyles();
  }, []);

  const [ownFilter, setOwnFilter] = useState<NavigatorFilter>("all");
  const filter = filterProp ?? ownFilter;
  const setFilter = (f: NavigatorFilter): void => {
    setOwnFilter(f);
    onFilterChange?.(f);
  };

  const counts = filterCounts(items);
  // The current square always stays visible so the candidate never loses their place.
  const visible = items.filter((i) => i.status === "current" || matchesFilter(i, filter));
  const currentId = items.find((i) => i.status === "current")?.questionId ?? "";
  const nextOpen = neighbor(items, currentId, 1, "open");

  const goNextOpen = (): void => {
    if (onNextOpen !== undefined) onNextOpen();
    else if (nextOpen !== null) onSelect(nextOpen.questionId);
  };

  const info =
    filter === "all"
      ? "Select a count to show and navigate only those questions."
      : `Showing ${filter} only. Previous and Next skip the rest.`;

  const renderCell = (item: NavigatorItem, railStyle?: CSSProperties, distance?: number) => {
    const current = item.status === "current";
    return (
      <button
        key={item.questionId}
        type="button"
        className="aiq-qnav-cell"
        data-current={current ? "true" : undefined}
        data-rail-far={distance !== undefined && Math.abs(distance) >= 3 ? "true" : undefined}
        aria-label={cellName(item)}
        aria-current={current ? "step" : undefined}
        onClick={() => onSelect(item.questionId)}
        style={{
          ...cellLook(item),
          width: "100%",
          aspectRatio: collapsed ? undefined : "1",
          minHeight: squareSize,
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxSizing: "border-box",
          fontFamily: "var(--aiq-font-mono)",
          fontSize: "var(--aiq-text-sm)",
          borderRadius: 10,
          cursor: "pointer",
          padding: 0,
          margin: 0,
          lineHeight: 1,
          ...railStyle,
        }}
      >
        {item.position}
        {isFlagged(item) && (
          <span
            aria-hidden="true"
            data-flag-dot="true"
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--aiq-color-warning)",
            }}
          />
        )}
      </button>
    );
  };

  if (collapsed || layout === "strip") {
    const currentIndex = Math.max(0, visible.findIndex((i) => i.questionId === currentId));
    const cur = visible[currentIndex];
    const step = (dir: 1 | -1): void => {
      const t = neighbor(items, currentId, dir, filter);
      if (t !== null) onSelect(t.questionId);
    };
    const pad = (n: number): string => String(n).padStart(2, "0");
    const footer =
      cur === undefined ? undefined : (
        <>
          <div style={{ fontFamily: SERIF, fontSize: 22, color: "var(--aiq-color-fg-primary)" }}>
            {filter === "all" ? pad(cur.position) : currentIndex + 1}
          </div>
          <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 11, color: "var(--aiq-color-fg-secondary)" }}>
            {filter === "all" ? `of ${counts.all}` : `of ${visible.length} ${filter}`}
          </div>
        </>
      );
    return (
      <NavigatorRail
        items={visible}
        currentIndex={currentIndex}
        axis={layout === "strip" ? "x" : "y"}
        renderCell={renderCell}
        onStep={step}
        canStep={{ prev: neighbor(items, currentId, -1, filter) !== null, next: neighbor(items, currentId, 1, filter) !== null }}
        label={layout === "strip" ? "Question strip" : "Question navigator"}
        footer={footer}
        trailing={trailing}
      />
    );
  }

  const empty = filter !== "all" && counts[filter] === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--aiq-space-sm)" }}>
        <div>
          <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>Questions</div>
          <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 12, color: "var(--aiq-color-fg-secondary)" }}>
            {counts.answered} / {counts.all} answered
          </div>
        </div>
      </div>

      <div
        role="group"
        aria-label="Filter questions"
        data-help-id="candidate.attempt.nav.filter"
        style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--aiq-space-xs)" }}
      >
        {STATS.map(([key, label]) => {
          const pressed = filter === key;
          const tone = key === "flagged" ? "warning" : "accent";
          return (
            <button
              key={key}
              type="button"
              className="aiq-qnav-stat"
              aria-pressed={pressed}
              onClick={() => setFilter(pressed ? "all" : key)}
              style={{
                minHeight: 44,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                padding: "var(--aiq-space-xs)",
                borderRadius: 10,
                cursor: "pointer",
                border: `1px solid ${pressed ? `var(--aiq-color-${tone})` : "var(--aiq-color-border)"}`,
                background: pressed ? `var(--aiq-color-${tone}-soft)` : "var(--aiq-color-bg-base)",
                color: "var(--aiq-color-fg-primary)",
              }}
            >
              <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 18, fontWeight: 600, lineHeight: 1 }}>
                {counts[key]}
              </span>
              {" "}
              <span style={{ fontSize: 11, color: "var(--aiq-color-fg-secondary)" }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>

      <p role="status" aria-live="polite" style={{ margin: 0, fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)" }}>
        {info}
      </p>
      {filter !== "all" && (
        <button
          type="button"
          className="aiq-qnav-btn"
          onClick={() => setFilter("all")}
          style={{ alignSelf: "flex-start", background: "none", border: "none", padding: "var(--aiq-space-2xs) 0", color: "var(--aiq-color-accent)", textDecoration: "underline", fontSize: "var(--aiq-text-sm)", cursor: "pointer", minHeight: 36 }}
        >
          Show all
        </button>
      )}

      <nav aria-label="Question navigator" data-test-id={testId}>
        {empty && (
          <p style={{ margin: "0 0 var(--aiq-space-sm)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)" }}>Nothing here.</p>
        )}
        {groupNavigatorItems(visible).map((group) => {
          const sec = group.section;
          const all = sec === null ? [] : items.filter((i) => i.section?.index === sec.index);
          return (
            <div key={sec?.index ?? "flat"}>
              {sec !== null && (
                <button
                  type="button"
                  className="aiq-qnav-btn"
                  onClick={() => onSelect((all[0] ?? group.items[0]!).questionId)}
                  style={{ ...ctrl, width: "100%", textAlign: "left", fontWeight: 600, margin: "var(--aiq-space-sm) 0 var(--aiq-space-xs)" }}
                >
                  {sec.name} ({countAnswered(all)}/{all.length} answered)
                </button>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "var(--aiq-space-xs)" }}>
                {group.items.map((i) => renderCell(i))}
              </div>
            </div>
          );
        })}
      </nav>

      <div
        aria-label="Legend"
        role="group"
        style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-xs) var(--aiq-space-sm)", fontSize: 11, color: "var(--aiq-color-fg-secondary)" }}
      >
        {[
          { label: "Current", border: "2px solid var(--aiq-color-accent)", background: "var(--aiq-color-accent-soft)" },
          { label: "Answered", border: "1px solid var(--aiq-color-success)", background: "var(--aiq-color-success-soft)" },
          { label: "Flagged", border: "1px solid var(--aiq-color-warning)", background: "var(--aiq-color-warning)" },
          { label: "Open", border: "1px solid var(--aiq-color-border)", background: "var(--aiq-color-bg-base)" },
        ].map(({ label, border, background }) => (
          <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span
              aria-hidden="true"
              style={{ width: 10, height: 10, borderRadius: label === "Flagged" ? "50%" : 3, border, background, boxSizing: "border-box", flexShrink: 0 }}
            />
            {label}
          </span>
        ))}
      </div>

      <button
        type="button"
        className="aiq-qnav-btn"
        disabled={nextOpen === null}
        data-help-id="candidate.attempt.nav.next_open"
        onClick={goNextOpen}
        style={{ ...ctrl, minHeight: 40, fontWeight: 600, position: "sticky", bottom: 0, background: "var(--aiq-color-bg-raised, var(--aiq-color-bg-base))" }}
      >
        Next unanswered
      </button>
    </div>
  );
}

QuestionNavigator.displayName = "QuestionNavigator";
