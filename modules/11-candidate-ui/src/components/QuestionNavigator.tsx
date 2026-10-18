import { useEffect, useState, type CSSProperties } from "react";
import { Icon } from "@assessiq/ui-system";
import { groupNavigatorItems, countAnswered } from "./navigatorGroups.js";

type NavigatorFilter = "all" | "flagged" | "unanswered";
const FILTERS: ReadonlyArray<readonly [NavigatorFilter, string]> = [
  ["all", "All"],
  ["flagged", "Flagged"],
  ["unanswered", "Unanswered"],
];

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
}

export interface QuestionNavigatorProps {
  items: NavigatorItem[];
  /** Called when the candidate clicks a square. */
  onSelect: (questionId: string) => void;
  /** Optional layout override — default is responsive grid auto-fit, min 36px squares. */
  squareSize?: number;
  "data-test-id"?: string;
}

// ---------------------------------------------------------------------------
// Style injection (once per page load, SSR-safe)
// ---------------------------------------------------------------------------

const STYLE_ID = "aiq-question-navigator-style";

function injectStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;

  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
.aiq-question-navigator-square:hover:not([data-current="true"]) {
  transform: translateY(-1px);
}
.aiq-question-navigator-square:focus-visible {
  outline: 2px solid var(--aiq-color-accent);
  outline-offset: 2px;
}
`.trim();
  document.head.appendChild(el);
}

// ---------------------------------------------------------------------------
// Status → style map
// ---------------------------------------------------------------------------

interface SquareStyles {
  border: string;
  background: string;
  color: string;
  fontWeight?: number | string;
}

const STATUS_LABEL: Record<NavigatorItem["status"], string> = {
  unanswered: "unanswered",
  answered: "answered",
  flagged: "flagged",
  current: "current",
};

const STATUS_STYLES: Record<NavigatorItem["status"], SquareStyles> = {
  unanswered: {
    border:     "1px solid var(--aiq-color-border)",
    background: "var(--aiq-color-bg-base)",
    color:      "var(--aiq-color-fg-secondary)",
  },
  answered: {
    border:     "1px solid var(--aiq-color-success)",
    background: "var(--aiq-color-success-soft)",
    color:      "var(--aiq-color-fg-primary)",
  },
  flagged: {
    border:     "1px solid var(--aiq-color-warning)",
    background: "var(--aiq-color-warning-soft)",
    color:      "var(--aiq-color-fg-primary)",
  },
  current: {
    border:      "2px solid var(--aiq-color-accent)",
    background:  "var(--aiq-color-accent-soft)",
    color:       "var(--aiq-color-fg-primary)",
    fontWeight:  600,
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuestionNavigator(props: QuestionNavigatorProps) {
  const {
    items,
    onSelect,
    squareSize = 36,
    "data-test-id": testId,
  } = props;

  // Inject hover/focus CSS once on mount (SSR-safe: injectStyles guards on document).
  useEffect(() => {
    injectStyles();
  }, []);

  const [filter, setFilter] = useState<NavigatorFilter>("all");
  const counts = {
    all: items.length,
    flagged: items.filter((i) => i.status === "flagged").length,
    unanswered: items.filter((i) => i.status === "unanswered").length,
  };
  // The current square always stays visible so the candidate never loses their place.
  const visible = filter === "all" ? items : items.filter((i) => i.status === filter || i.status === "current");

  const jumpFlagged = (dir: 1 | -1) => {
    const flagged = items.filter((i) => i.status === "flagged");
    if (flagged.length === 0) return;
    const cur = items.findIndex((i) => i.status === "current");
    // Walk from the current square (or the list edge) in `dir`, wrapping around.
    for (let step = 1; step <= items.length; step++) {
      const idx = (((cur === -1 ? (dir === 1 ? -1 : items.length) : cur) + dir * step) % items.length + items.length) % items.length;
      if (items[idx]!.status === "flagged") {
        onSelect(items[idx]!.questionId);
        return;
      }
    }
  };

  const ctrl: CSSProperties = {
    padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
    border: "1px solid var(--aiq-color-border)",
    borderRadius: "var(--aiq-radius-sm)",
    background: "var(--aiq-color-bg-base)",
    color: "var(--aiq-color-fg-primary)",
    fontSize: "var(--aiq-text-sm)",
    cursor: "pointer",
  };

  return (
    <div>
      <div
        role="group"
        aria-label="Filter questions"
        style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-xs)", padding: "var(--aiq-space-md) var(--aiq-space-md) 0" }}
      >
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
            style={{ ...ctrl, fontWeight: filter === key ? 600 : "normal", borderColor: filter === key ? "var(--aiq-color-accent)" : "var(--aiq-color-border)" }}
          >
            {label} ({counts[key]})
          </button>
        ))}
        <button type="button" disabled={counts.flagged === 0} onClick={() => jumpFlagged(-1)} style={{ ...ctrl, opacity: counts.flagged === 0 ? 0.5 : 1 }}>
          Previous flagged
        </button>
        <button type="button" disabled={counts.flagged === 0} onClick={() => jumpFlagged(1)} style={{ ...ctrl, opacity: counts.flagged === 0 ? 0.5 : 1 }}>
          Next flagged
        </button>
      </div>
      <p role="status" aria-live="polite" style={{ margin: 0, padding: "var(--aiq-space-xs) var(--aiq-space-md) 0", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)" }}>
        Showing {visible.length} of {counts.all} questions. {counts.flagged} flagged, {counts.unanswered} unanswered.
      </p>
    <nav
      aria-label="Question navigator"
      data-test-id={testId}
      style={{ padding: "var(--aiq-space-md)" }}
    >
      {groupNavigatorItems(visible).map((group) => {
        const sec = group.section;
        const all = sec === null ? [] : items.filter((i) => i.section?.index === sec.index);
        return (
        <div key={sec?.index ?? "flat"}>
          {sec !== null && (
            <button
              type="button"
              onClick={() => onSelect((all[0] ?? group.items[0]!).questionId)}
              style={{ ...ctrl, width: "100%", textAlign: "left", fontWeight: 600, margin: "var(--aiq-space-sm) 0 var(--aiq-space-xs)" }}
            >
              {sec.name} ({countAnswered(all)}/{all.length} answered)
            </button>
          )}
          <div
            style={{
              display:             "grid",
              gridTemplateColumns: `repeat(auto-fill, minmax(${squareSize}px, 1fr))`,
              gap:                 "var(--aiq-space-xs)",
            }}
          >
      {group.items.map((item) => {
        const isCurrent = item.status === "current";
        const styles = STATUS_STYLES[item.status];

        return (
          <button
            key={item.questionId}
            type="button"
            className="aiq-question-navigator-square"
            data-current={isCurrent ? "true" : undefined}
            aria-label={`Question ${item.position}: ${STATUS_LABEL[item.status]}`}
            aria-current={isCurrent ? "step" : undefined}
            onClick={() => onSelect(item.questionId)}
            style={{
              // Layout
              width:         "100%",
              aspectRatio:   "1",
              position:      "relative",
              display:       "flex",
              alignItems:    "center",
              justifyContent:"center",
              // Sizing
              boxSizing:     "border-box",
              // Status-driven appearance
              border:        styles.border,
              background:    styles.background,
              color:         styles.color,
              fontWeight:    styles.fontWeight ?? "normal",
              // Typography
              fontFamily:    "var(--aiq-font-mono)",
              fontSize:      "var(--aiq-text-sm)",
              // Shape
              borderRadius:  "var(--aiq-radius-sm)",
              // Interaction
              cursor:        "pointer",
              // Motion
              transition:    "transform var(--aiq-motion-duration-fast) var(--aiq-motion-easing-out)",
              // Reset default button styles
              padding:       0,
              margin:        0,
              lineHeight:    1,
            }}
          >
            {item.position}

            {/* Flag indicator — absolute top-right pip, only for flagged items */}
            {item.status === "flagged" && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top:      2,
                  right:    2,
                  display:  "flex",
                  color:    "var(--aiq-color-warning)",
                  lineHeight: 1,
                }}
              >
                <Icon name="flag" size={8} />
              </span>
            )}
          </button>
        );
      })}
          </div>
        </div>
        );
      })}
    </nav>
    </div>
  );
}

QuestionNavigator.displayName = "QuestionNavigator";
