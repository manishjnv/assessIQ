import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

// ─── Public API ──────────────────────────────────────────────────────────────

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  /** Tooltip body — typically a short string. */
  content: ReactNode;
  /** Where to render the popover relative to the trigger. Default: 'top'.
   *  No flip / auto-placement logic — caller picks.
   *  Edge-of-viewport overflow is acceptable; use a different placement if needed. */
  placement?: TooltipPlacement;
  /** Open delay on hover (ms). Default: 200. */
  delayMs?: number;
  /** Single trigger element; cloned to attach handlers + aria-describedby. */
  children: ReactElement;
  "data-test-id"?: string;
}

// ─── Positioning helpers ─────────────────────────────────────────────────────

interface Coords {
  top: number;
  left: number;
}

/** Compute top/left for the popover given the trigger's bounding rect and
 *  the popover's own size. All values are viewport-relative px (position:fixed). */
function computeCoords(
  trigger: DOMRect,
  popover: DOMRect,
  placement: TooltipPlacement,
  gap: number,
): Coords {
  switch (placement) {
    case "top":
      return {
        top: trigger.top - popover.height - gap,
        left: trigger.left + trigger.width / 2 - popover.width / 2,
      };
    case "bottom":
      return {
        top: trigger.bottom + gap,
        left: trigger.left + trigger.width / 2 - popover.width / 2,
      };
    case "left":
      return {
        top: trigger.top + trigger.height / 2 - popover.height / 2,
        left: trigger.left - popover.width - gap,
      };
    case "right":
      return {
        top: trigger.top + trigger.height / 2 - popover.height / 2,
        left: trigger.right + gap,
      };
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

const GAP_PX = 8;

export function Tooltip({
  content,
  placement = "top",
  delayMs = 200,
  children,
  "data-test-id": testId,
}: TooltipProps): ReactElement {
  const id = useId();
  const tooltipId = `aiq-tooltip-${id}`;

  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<Coords>({ top: 0, left: 0 });

  const triggerRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Position calculation ────────────────────────────────────────────────

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const triggerRect = trigger.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    setCoords(computeCoords(triggerRect, popoverRect, placement, GAP_PX));
  }, [placement]);

  // Reposition whenever popover becomes visible (popover size is only available
  // once rendered; two-pass: show at (0,0) → measure → move to final position).
  useEffect(() => {
    if (visible) {
      reposition();
    }
  }, [visible, reposition]);

  // ── Timer helpers ────────────────────────────────────────────────────────

  const clearOpen = () => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };
  const clearClose = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleOpen = useCallback(() => {
    clearClose();
    if (visible) return;
    openTimerRef.current = setTimeout(() => {
      setVisible(true);
    }, delayMs);
  }, [delayMs, visible]);

  const scheduleClose = useCallback(
    (delay = 100) => {
      clearOpen();
      closeTimerRef.current = setTimeout(() => {
        setVisible(false);
      }, delay);
    },
    [],
  );

  // ── Cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      clearOpen();
      clearClose();
    };
  }, []);

  // ── Close on Esc ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearOpen();
        setVisible(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [visible]);

  // ── Close on outside click ────────────────────────────────────────────────

  useEffect(() => {
    if (!visible) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        popoverRef.current &&
        !popoverRef.current.contains(target)
      ) {
        clearOpen();
        setVisible(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [visible]);

  // ── Trigger event handlers ────────────────────────────────────────────────

  const handleMouseEnter = () => scheduleOpen();
  const handleMouseLeave = () => scheduleClose(100);
  const handleFocus = () => {
    clearClose();
    setVisible(true);
  };
  const handleBlur = () => scheduleClose(100);

  // ── Clone child to inject ref + aria + handlers ───────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const childProps: Record<string, any> = {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      // Forward an existing ref if the child already has one.
      const existingRef = (children as { ref?: React.Ref<HTMLElement> }).ref;
      if (typeof existingRef === "function") existingRef(node);
      else if (existingRef && typeof existingRef === "object") {
        (existingRef as React.MutableRefObject<HTMLElement | null>).current = node;
      }
    },
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    ...(visible ? { "aria-describedby": tooltipId } : {}),
  };

  const clonedChild = cloneElement(children, childProps);

  // ── Popover styles ────────────────────────────────────────────────────────

  // Fade-in/out via CSS opacity + scale. `prefers-reduced-motion` is handled
  // globally in tokens.css (transition-duration: 0.01ms !important), so we
  // only need the normal transition declaration here.
  const popoverStyle: CSSProperties = {
    position: "fixed",
    top: coords.top,
    left: coords.left,
    zIndex: "var(--aiq-z-popover)" as unknown as number,
    maxWidth: 280,
    padding: `var(--aiq-space-sm) var(--aiq-space-md)`,
    background: "var(--aiq-color-fg-primary)",
    color: "var(--aiq-color-bg-base)",
    borderRadius: "var(--aiq-radius-md)",
    boxShadow: "var(--aiq-shadow-md)",
    fontSize: "var(--aiq-text-sm)" as unknown as number,
    fontFamily: "var(--aiq-font-sans)",
    lineHeight: 1.4,
    pointerEvents: "auto",
    // Subtle appear animation; prefers-reduced-motion collapses it globally.
    opacity: visible ? 1 : 0,
    transform: visible ? "scale(1)" : "scale(0.95)",
    transition:
      "opacity var(--aiq-motion-duration-fast) var(--aiq-motion-easing-out), " +
      "transform var(--aiq-motion-duration-fast) var(--aiq-motion-easing-out)",
  };

  return (
    <>
      {clonedChild}
      {visible && (
        <div
          ref={popoverRef}
          id={tooltipId}
          role="tooltip"
          style={popoverStyle}
          data-test-id={testId}
          data-placement={placement}
          onMouseEnter={() => clearClose()}
          onMouseLeave={() => scheduleClose(100)}
        >
          {content}
        </div>
      )}
    </>
  );
}

Tooltip.displayName = "Tooltip";
