import { describe, it, expect } from "vitest";
import { contrastOnWhite, validateAccent } from "../accent.js";

describe("accent validation (Z-119)", () => {
  it("black on white is 21:1, white is 1:1", () => {
    expect(contrastOnWhite("#000000")).toBeCloseTo(21, 0);
    expect(contrastOnWhite("#ffffff")).toBeCloseTo(1, 1);
  });
  it("accepts a dark colour and lowercases it", () => {
    expect(validateAccent("#3B4CCA")).toEqual({ ok: true, hex: "#3b4cca" });
  });
  it("rejects a light colour with ACCENT_LOW_CONTRAST", () => {
    const r = validateAccent("#5eead4");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ACCENT_LOW_CONTRAST");
  });
  it("rejects non-hex and CSS injection strings", () => {
    for (const bad of ["red", "#fff", "#12345g", "#000000;x:y", "url(x)", "", null, 5]) {
      const r = validateAccent(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("ACCENT_INVALID_HEX");
    }
  });
  it("boundary: #767676 passes, #777777 fails", () => {
    expect(validateAccent("#767676").ok).toBe(true);
    expect(validateAccent("#777777").ok).toBe(false);
  });
});
