// Z-119: org accent colour validation. Hex only (no CSS injection surface),
// and the colour must be readable as text on white (WCAG AA, 4.5:1).
// The same colour is the button fill with white text, so one check covers both.

export const ACCENT_MIN_CONTRAST = 4.5;

const HEX6 = /^#[0-9a-fA-F]{6}$/;

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG contrast ratio of a #rrggbb colour against white. Caller checks the format first. */
export function contrastOnWhite(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  return 1.05 / (l + 0.05);
}

export type AccentCheck =
  | { ok: true; hex: string }
  | { ok: false; code: "ACCENT_INVALID_HEX" | "ACCENT_LOW_CONTRAST"; message: string };

export function validateAccent(raw: unknown): AccentCheck {
  if (typeof raw !== "string" || !HEX6.test(raw)) {
    return { ok: false, code: "ACCENT_INVALID_HEX", message: "Colour must be a hex value like #3b4cca." };
  }
  const hex = raw.toLowerCase();
  const ratio = contrastOnWhite(hex);
  if (ratio < ACCENT_MIN_CONTRAST) {
    return {
      ok: false,
      code: "ACCENT_LOW_CONTRAST",
      message: `Colour is too light: contrast on white is ${ratio.toFixed(1)}:1, the minimum is 4.5:1. Choose a darker colour.`,
    };
  }
  return { ok: true, hex };
}
