import { describe, it, expect } from "vitest";
import { accentContrast, accentBranding } from "../accent.js";

describe("accent helpers (Z-119)", () => {
  it("contrast: black 21, white 1, non-hex null", () => {
    expect(accentContrast("#000000")).toBeCloseTo(21, 0);
    expect(accentContrast("#ffffff")).toBeCloseTo(1, 1);
    expect(accentContrast("red")).toBeNull();
    expect(accentContrast("#000000;x")).toBeNull();
  });
  it("branding: dark colour gives overrides, light or bad value gives undefined", () => {
    expect(accentBranding("#3b4cca")?.primary).toBe("#3b4cca");
    expect(accentBranding("#5eead4")).toBeUndefined();
    expect(accentBranding(null)).toBeUndefined();
    expect(accentBranding("javascript:1")).toBeUndefined();
  });
  it("boundary: #767676 passes, #777777 fails", () => {
    expect(accentBranding("#767676")).toBeDefined();
    expect(accentBranding("#777777")).toBeUndefined();
  });
});
