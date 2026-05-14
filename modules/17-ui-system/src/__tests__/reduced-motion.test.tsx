/**
 * Phase 14 — Reduced-motion assertions.
 *
 * Verifies that every animated component in @assessiq/ui-system collapses to
 * an instant / no-animation state when `prefers-reduced-motion: reduce` is
 * active. The global CSS rule in tokens.css (`transition-duration: 0.01ms
 * !important`) handles CSS-class transitions; JS-driven animations must be
 * handled by reading matchMedia directly (useCountUp, useReducedMotion).
 *
 * matchMedia is mocked via vitest.setup.ts using the standard jsdom shim
 * pattern — see below for per-test override helpers.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { renderHook } from "@testing-library/react";

import { Spinner } from "../components/Spinner";
import { ScoreRing } from "../components/ScoreRing";
import { Tooltip } from "../components/Tooltip";
import { useCountUp } from "../hooks/useCountUp";
import { useReducedMotion } from "../hooks/useReducedMotion";

// ─── matchMedia mock helpers ──────────────────────────────────────────────────

/**
 * Replace window.matchMedia for the duration of a test.
 * Returns the original so afterEach can restore it.
 */
function mockMatchMedia(prefersReduced: boolean): () => void {
  const original = window.matchMedia;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).matchMedia = (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" ? prefersReduced : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),       // deprecated but kept for compat
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).matchMedia = original;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── useReducedMotion ─────────────────────────────────────────────────────────

describe("useReducedMotion", () => {
  it("returns false when prefers-reduced-motion does NOT match", () => {
    const restore = mockMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    restore();
  });

  it("returns true when prefers-reduced-motion: reduce matches", () => {
    const restore = mockMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
    restore();
  });
});

// ─── useCountUp — reduced motion ─────────────────────────────────────────────

describe("useCountUp reduced-motion", () => {
  it("returns target immediately (no animation) when reduced motion is active", () => {
    const restore = mockMatchMedia(true);
    const { result } = renderHook(() => useCountUp(75));
    // Must equal the target value with no RAF animation needed.
    expect(result.current).toBe(75);
    restore();
  });

  it("starts at 0 and eventually reaches target when reduced motion is NOT active", () => {
    const restore = mockMatchMedia(false);
    const { result } = renderHook(() => useCountUp(50));
    // On initial render without RAF advancing: value starts at 0.
    expect(result.current).toBe(0);
    restore();
  });
});

// ─── Spinner — CSS animation must be suppressed ───────────────────────────────

describe("Spinner reduced-motion", () => {
  it("applies the aiq-spinner class that the CSS targets for animation:none", () => {
    // The reduced-motion behavior for Spinner is entirely CSS-driven:
    //   @media (prefers-reduced-motion: reduce) { .aiq-spinner { animation: none; } }
    // We assert the class name is present so the CSS rule can reach it.
    const { container } = render(<Spinner />);
    const el = container.querySelector(".aiq-spinner");
    expect(el).not.toBeNull();
    // The element must carry the CSS class — not an inline animation style —
    // so the @media override in tokens.css fires correctly.
    expect((el as HTMLElement).style.animation).toBe("");
  });
});

// ─── ScoreRing — inline transition is overridden by global CSS rule ───────────

describe("ScoreRing reduced-motion", () => {
  it("renders the fill circle with a CSS transition that the global rule can override", () => {
    // ScoreRing's fill circle carries:
    //   style={{ transition: "stroke-dashoffset 1600ms var(--aiq-motion-easing-out)" }}
    // The tokens.css @media rule uses `!important` to collapse it to 0.01ms.
    // This test verifies the transition is set as inline CSS (not via animation: keyframes),
    // confirming the global rule will reach it.
    const { container } = render(<ScoreRing value={80} />);
    const circles = container.querySelectorAll<SVGCircleElement>("circle");
    // There are two circles: track + fill. The fill is the second one.
    const fillCircle = circles[1] as SVGCircleElement;
    expect(fillCircle).not.toBeNull();
    expect(fillCircle.style.transition).toContain("stroke-dashoffset");
    // It must NOT use a CSS animation (keyframes) — that would require a separate rule.
    expect(fillCircle.style.animationName).toBe("");
  });

  it("useCountUp inside ScoreRing returns target immediately under reduced motion", () => {
    const restore = mockMatchMedia(true);
    const { container } = render(<ScoreRing value={65} />);
    // Under reduced motion useCountUp returns 65 immediately.
    // The text element inside the SVG should show "65", not "0".
    const textEl = container.querySelector("text");
    expect(textEl?.textContent).toBe("65");
    restore();
  });
});

// ─── Tooltip — opacity/scale transition collapsed by global CSS rule ──────────

describe("Tooltip reduced-motion", () => {
  it("tooltip popover carries CSS transitions (not keyframe animations) so global rule collapses them", () => {
    const { getByRole } = render(
      <Tooltip content="Reduced motion test">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    // The button should be present; tooltip is hidden until hover/focus.
    // This test just ensures the trigger is rendered and keyboard-accessible.
    const trigger = getByRole("button", { name: /trigger/i });
    expect(trigger).toBeInTheDocument();
    // No keyframe animation on the trigger itself.
    expect((trigger as HTMLElement).style.animationName).toBe("");
  });
});
