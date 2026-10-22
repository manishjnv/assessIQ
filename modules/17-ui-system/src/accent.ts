// Z-119: org accent helpers (browser side). The server runs the same 4.5:1
// check in 02-tenancy/src/accent.ts; keep the two in step.

export const ACCENT_MIN_CONTRAST = 4.5;

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** Contrast of a #rrggbb colour against white, or null when the value is not #rrggbb. */
export function accentContrast(hex: string): number | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  const l = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  return 1.05 / (l + 0.05);
}

/** Theme overrides for an org accent, or undefined (default theme) when absent or below 4.5:1. */
export function accentBranding(hex: string | null | undefined): { primary: string; primarySoft: string; primaryHover: string } | undefined {
  if (typeof hex !== "string") return undefined;
  const ratio = accentContrast(hex);
  if (ratio === null || ratio < ACCENT_MIN_CONTRAST) return undefined;
  return {
    primary: hex,
    primarySoft: `color-mix(in srgb, ${hex} 12%, white)`,
    primaryHover: `color-mix(in srgb, ${hex} 85%, black)`,
  };
}
