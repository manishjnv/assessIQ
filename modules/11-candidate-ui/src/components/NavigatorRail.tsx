import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Icon } from "@assessiq/ui-system";
import type { NavigatorItem } from "./QuestionNavigator.js";
import { lensOffset, railDistanceStyle } from "./railLens.js";

// Z-170: the collapsed rail (vertical, 88 px aside) and the mobile strip (horizontal, 68 px).
// Same logic on both axes: the current cell is always centred under the lens.

const CELL = 42;
const GAP = 12;
const MASK = (dir: "bottom" | "right"): string =>
  `linear-gradient(to ${dir}, transparent, #000 20%, #000 80%, transparent)`;

export interface NavigatorRailProps {
  /** The visible (filtered) cells, in order. The current question is always among them. */
  items: NavigatorItem[];
  currentIndex: number;
  axis: "y" | "x";
  /** Renders one cell; the rail passes the size and distance style. */
  renderCell: (item: NavigatorItem, style: CSSProperties, distance: number) => ReactNode;
  onStep: (dir: 1 | -1) => void;
  canStep: { prev: boolean; next: boolean };
  label?: string;
  /** Vertical rail only: "03" over "of 18". */
  footer?: ReactNode;
  /** Strip only: the button that opens the full navigator. */
  trailing?: ReactNode;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function NavigatorRail(props: NavigatorRailProps) {
  const { items, currentIndex, axis, renderCell, onStep, canStep, label = "Question navigator", footer, trailing } = props;
  const x = axis === "x";
  const viewRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const currentId = items[currentIndex]?.questionId ?? "";

  const place = (animate: boolean): void => {
    const view = viewRef.current;
    const list = listRef.current;
    const cell = list?.querySelector<HTMLElement>('[data-current="true"]');
    if (!view || !list || !cell) return;
    const off = lensOffset(x ? view.clientWidth : view.clientHeight, x ? cell.offsetLeft : cell.offsetTop, x ? cell.offsetWidth : cell.offsetHeight);
    list.style.transition = animate && !reducedMotion() ? "transform .55s cubic-bezier(.2,.7,.3,1)" : "none";
    list.style.transform = x ? `translateX(${off}px)` : `translateY(${off}px)`;
  };

  // New current cell: animate (not on first paint).
  useLayoutEffect(() => {
    place(!first.current);
    first.current = false;
  }, [currentId, items.length, axis]);

  // Resize, and the end of the aside width change: recompute without animation.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const again = (): void => place(false);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(again);
    ro?.observe(view);
    const aside = view.closest("aside");
    aside?.addEventListener("transitionend", again);
    window.addEventListener("resize", again);
    return () => {
      ro?.disconnect();
      aside?.removeEventListener("transitionend", again);
      window.removeEventListener("resize", again);
    };
  }, [axis]);

  const chevron = (dir: 1 | -1): ReactNode => {
    const name = x ? (dir === 1 ? "arrow" : "arrowLeft") : "arrow";
    const turn = x ? undefined : { transform: `rotate(${dir === 1 ? 90 : -90}deg)` };
    return (
      <button
        type="button"
        className="aiq-qnav-btn"
        aria-label={dir === 1 ? "Next question" : "Previous question"}
        disabled={dir === 1 ? !canStep.next : !canStep.prev}
        onClick={() => onStep(dir)}
        style={{
          flex: "0 0 auto",
          minWidth: 40,
          minHeight: 40,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          background: "none",
          color: "var(--aiq-color-fg-secondary)",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <Icon name={name} size={16} style={turn} />
      </button>
    );
  };

  const listStyle: CSSProperties = x
    ? { position: "absolute", top: 0, bottom: 0, left: 0, display: "flex", alignItems: "center", gap: GAP, width: "max-content" }
    : { position: "absolute", top: 0, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: GAP };

  return (
    <div
      className="aiq-rail"
      data-axis={axis}
      style={{
        display: "flex",
        flexDirection: x ? "row" : "column",
        alignItems: "center",
        gap: x ? 4 : 8,
        height: "100%",
        minHeight: 0,
        width: "100%",
      }}
    >
      {chevron(-1)}
      <div
        ref={viewRef}
        onScroll={(e) => {
          // A focused faded cell must not scroll the clipped view; the transform does the moving.
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          alignSelf: "stretch",
          overflow: "hidden",
          maskImage: MASK(x ? "right" : "bottom"),
          WebkitMaskImage: MASK(x ? "right" : "bottom"),
        }}
      >
        <div
          aria-hidden="true"
          style={
            x
              ? { position: "absolute", left: 0, right: 0, top: "50%", height: 1, background: "var(--aiq-color-border)" }
              : { position: "absolute", top: 0, bottom: 0, left: "50%", width: 1, background: "var(--aiq-color-border)" }
          }
        />
        <div
          aria-hidden="true"
          data-rail-lens="true"
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: 62,
            height: 62,
            marginTop: -31,
            marginLeft: -31,
            borderRadius: 18,
            border: "1px solid color-mix(in srgb, var(--aiq-color-accent) 40%, transparent)",
            pointerEvents: "none",
          }}
        />
        <nav aria-label={label}>
          <div ref={listRef} style={listStyle}>
            {items.map((item, i) => {
              const { scale, opacity } = railDistanceStyle(i - currentIndex);
              return renderCell(
                item,
                {
                width: CELL,
                height: CELL,
                minHeight: CELL,
                flex: "0 0 auto",
                aspectRatio: undefined,
                transform: `scale(${scale})`,
                opacity,
                boxShadow: i === currentIndex ? "0 0 0 4px var(--aiq-color-accent-soft)" : undefined,
                transition: reducedMotion() ? "none" : "transform .5s, opacity .5s",
                },
                i - currentIndex,
              );
            })}
          </div>
        </nav>
      </div>
      {chevron(1)}
      {footer !== undefined && !x && (
        <div aria-live="polite" style={{ textAlign: "center", lineHeight: 1.1, paddingBottom: 4 }}>
          {footer}
        </div>
      )}
      {trailing}
    </div>
  );
}

/** Z-170: the 34 x 68 collapse pill, straddling the aside's left border. Sits OUTSIDE the scrolling area. */
export function NavCollapseHandle(props: { collapsed: boolean; onToggle: () => void }) {
  const { collapsed, onToggle } = props;
  return (
    <button
      type="button"
      className="aiq-qnav-pill"
      aria-label={collapsed ? "Expand question panel" : "Collapse question panel"}
      aria-expanded={!collapsed}
      data-help-id="candidate.attempt.nav.collapse"
      onClick={onToggle}
    >
      <Icon name={collapsed ? "arrowLeft" : "arrow"} size={14} />
    </button>
  );
}
