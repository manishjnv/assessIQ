import { useEffect } from "react";
import { Icon } from "@assessiq/ui-system";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NavigatorItem {
  questionId: string;
  position: number; // 1-based for display
  /** "answered" if there's a non-null answer; "flagged" if flagged; "current" if active; else "unanswered". */
  status: "unanswered" | "answered" | "flagged" | "current";
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
    // TODO(token): --aiq-color-warning-soft
    background: "oklch(0.97 0.05 70)",
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

  return (
    <nav
      aria-label="Question navigator"
      data-test-id={testId}
      style={{
        display:             "grid",
        gridTemplateColumns: `repeat(auto-fill, minmax(${squareSize}px, 1fr))`,
        gap:                 "var(--aiq-space-xs)",
        padding:             "var(--aiq-space-md)",
      }}
    >
      {items.map((item) => {
        const isCurrent = item.status === "current";
        const styles = STATUS_STYLES[item.status];

        return (
          <button
            key={item.questionId}
            type="button"
            className="aiq-question-navigator-square"
            data-current={isCurrent ? "true" : undefined}
            aria-label={`Question ${item.position}: ${item.status}`}
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
    </nav>
  );
}

QuestionNavigator.displayName = "QuestionNavigator";
