import { useEffect, useState } from "react";

/**
 * Returns true when the user has requested reduced motion via the OS/browser
 * "prefers-reduced-motion: reduce" media query.
 *
 * Subscribes to the MediaQueryList so it reacts to live changes (e.g. the user
 * toggles the OS accessibility setting while the page is open).
 *
 * Falls back to `false` in non-browser environments (SSR, Jest node runner).
 *
 * Usage:
 *   const reduced = useReducedMotion();
 *   // if (reduced) skip animation, show final state immediately
 */
export function useReducedMotion(): boolean {
  const getMatch = (): boolean => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  };

  const [reduced, setReduced] = useState<boolean>(getMatch);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    // Use addEventListener for modern browsers; addListener is deprecated.
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return reduced;
}
