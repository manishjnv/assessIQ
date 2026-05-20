import { useEffect } from "react";
import { VIEWPORT_QUERY } from "./useViewport.js";

/**
 * Side-effect hook that writes `data-viewport="mobile" | "desktop"` on
 * `document.documentElement` (<html>) and keeps it in sync on resize /
 * orientation change.
 *
 * This is the React side of the inline-script handoff: the inline script in
 * apps/web/index.html sets the initial value before React mounts (avoids
 * first-paint flicker); this hook takes over once mounted and keeps the
 * attribute correct for the lifetime of the app.
 *
 * Called once inside ThemeProvider — consumers do NOT need to call this
 * directly. Use useViewport() if you need to read the viewport value in a
 * component.
 *
 * See docs/plans/MOBILE_KIT_PORT.md § Phase M0.
 */
export function useViewportSync(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const mql = window.matchMedia(VIEWPORT_QUERY);

    const apply = (matches: boolean) => {
      document.documentElement.setAttribute(
        "data-viewport",
        matches ? "mobile" : "desktop",
      );
    };

    // Sync immediately on mount (inline script may already have set it, but
    // a React hydration cycle could run after a navigation that changes
    // the effective viewport — keep them in lockstep).
    apply(mql.matches);

    const handler = (e: MediaQueryListEvent) => apply(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
}
