import { useEffect, useState } from "react";

/**
 * Two viewport modes only — mobile and desktop.
 * Mobile when: (max-width: 719px) OR (pointer: coarse AND max-width: 1024px).
 * The combined OR covers small phones AND coarse-pointer tablets (iPads in portrait).
 *
 * SSR-safe: returns 'desktop' when window is undefined (no matchMedia available).
 * Subscribes to the MediaQueryList so it reacts to live resize / orientation changes.
 *
 * Usage:
 *   const viewport = useViewport();
 *   if (viewport === 'mobile') { ... }
 *
 * See docs/plans/MOBILE_KIT_PORT.md § Phase M0.
 */
export type Viewport = "mobile" | "desktop";

export const VIEWPORT_QUERY =
  "(max-width: 719px), ((pointer: coarse) and (max-width: 1024px))";

export function useViewport(): Viewport {
  const getMatch = (): Viewport => {
    if (typeof window === "undefined") return "desktop";
    return window.matchMedia?.(VIEWPORT_QUERY).matches ? "mobile" : "desktop";
  };

  const [viewport, setViewport] = useState<Viewport>(getMatch);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(VIEWPORT_QUERY);
    const handler = (e: MediaQueryListEvent) =>
      setViewport(e.matches ? "mobile" : "desktop");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return viewport;
}
