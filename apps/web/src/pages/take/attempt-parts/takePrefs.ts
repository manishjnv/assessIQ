// Z-167: display preferences for the take page (theme, text size, organisation display).
// Display prefs are not a candidate session: they hold no identity, answer or token, so the
// "no localStorage for candidate session" rule in Attempt.tsx does not apply (the autosave
// backup and the key-shortcut switch already use localStorage the same way). Kept per browser.
import { useEffect, useState } from "react";

export type TakeTheme = "mid" | "light" | "dark";
export type TakeOrgDisplay = "both" | "logo" | "name" | "off";
export type TakeTextSize = "S" | "M" | "L" | "XL";

export const TEXT_SCALE: Record<TakeTextSize, number> = { S: 0.92, M: 1, L: 1.12, XL: 1.25 };

export interface TakePrefs {
  theme: TakeTheme;
  size: TakeTextSize;
  org: TakeOrgDisplay;
}

const STORE_KEY = "aiq.take.prefs";
const DEFAULTS: TakePrefs = { theme: "mid", size: "M", org: "both" };

function read(): TakePrefs {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw === null) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<TakePrefs>;
    return {
      theme: p.theme === "light" || p.theme === "dark" || p.theme === "mid" ? p.theme : DEFAULTS.theme,
      size: p.size === "S" || p.size === "M" || p.size === "L" || p.size === "XL" ? p.size : DEFAULTS.size,
      org: p.org === "both" || p.org === "logo" || p.org === "name" || p.org === "off" ? p.org : DEFAULTS.org,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Prefs plus a setter. Also puts the root class and theme on <html> while mounted, so dialogs in portals match. */
export function useTakePrefs(): [TakePrefs, (patch: Partial<TakePrefs>) => void] {
  const [prefs, setPrefs] = useState<TakePrefs>(read);
  useEffect(() => {
    const el = document.documentElement;
    el.classList.add("aiq-take-root");
    el.setAttribute("data-take-theme", prefs.theme);
    el.style.setProperty("--aiq-take-fs", String(TEXT_SCALE[prefs.size]));
    return () => {
      el.classList.remove("aiq-take-root");
      el.removeAttribute("data-take-theme");
      el.style.removeProperty("--aiq-take-fs");
    };
  }, [prefs.theme, prefs.size]);
  return [
    prefs,
    (patch) => {
      const next = { ...prefs, ...patch };
      setPrefs(next);
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked: the choice lasts for this page view only */
      }
    },
  ];
}
