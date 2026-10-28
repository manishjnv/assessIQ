import { useEffect } from "react";
import { accentBranding } from "@assessiq/ui-system";

/**
 * UAT 2026-10-29: buttons and accents on the candidate pages follow the org theme colour.
 * `accentBranding` refuses a colour below 4.5:1 with white text, so a weak colour keeps the AssessIQ default.
 * Set on <html> so dialogs in portals match. No colour set = nothing changes.
 */
export function useOrgAccent(accent: string | null | undefined): void {
  useEffect(() => {
    const b = accentBranding(accent);
    if (b === undefined) return;
    const el = document.documentElement;
    el.style.setProperty("--aiq-color-accent", b.primary);
    el.style.setProperty("--aiq-color-accent-soft", b.primarySoft);
    el.style.setProperty("--aiq-color-accent-hover", b.primaryHover);
    return () => {
      el.style.removeProperty("--aiq-color-accent");
      el.style.removeProperty("--aiq-color-accent-soft");
      el.style.removeProperty("--aiq-color-accent-hover");
    };
  }, [accent]);
}
