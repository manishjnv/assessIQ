/**
 * Z-87 / Z-91: pure rules, no DB. isMobileOrTabletClient (desktop-only gate) and evaluateReadiness.
 */
import { describe, it, expect } from "vitest";
import { isMobileOrTabletClient } from "../device.js";
import { evaluateReadiness, type ReadinessSignals } from "../readiness.js";

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

describe("isMobileOrTabletClient (Z-87)", () => {
  it("desktop Chrome is allowed", () => {
    expect(isMobileOrTabletClient({ userAgent: DESKTOP_UA, secChUaMobile: "?0" })).toBe(false);
    expect(
      isMobileOrTabletClient({ userAgent: DESKTOP_UA, reported: { coarsePointerOnly: false, maxTouchPoints: 0, screenWidth: 1920 } }),
    ).toBe(false);
  });
  it("Sec-CH-UA-Mobile ?1 is a phone", () => {
    expect(isMobileOrTabletClient({ userAgent: DESKTOP_UA, secChUaMobile: "?1" })).toBe(true);
  });
  it("iPhone and Android user agents are phones", () => {
    expect(isMobileOrTabletClient({ userAgent: IPHONE_UA })).toBe(true);
    expect(isMobileOrTabletClient({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile Safari/537.36" })).toBe(true);
  });
  it("iPadOS with a Mac user agent is caught by the touch signal", () => {
    expect(isMobileOrTabletClient({ userAgent: IPAD_AS_MAC_UA })).toBe(false); // UA alone cannot tell
    expect(
      isMobileOrTabletClient({ userAgent: IPAD_AS_MAC_UA, reported: { coarsePointerOnly: true, maxTouchPoints: 5, screenWidth: 1024 } }),
    ).toBe(true);
  });
  it("a small screen is a phone or tablet; malformed reported signals are ignored", () => {
    expect(isMobileOrTabletClient({ userAgent: DESKTOP_UA, reported: { coarsePointerOnly: false, maxTouchPoints: 0, screenWidth: 600 } })).toBe(true);
    expect(isMobileOrTabletClient({ userAgent: DESKTOP_UA, reported: { screenWidth: "tiny" } })).toBe(false);
    expect(isMobileOrTabletClient({ userAgent: DESKTOP_UA, reported: "x" })).toBe(false);
    expect(isMobileOrTabletClient({})).toBe(false);
  });
});

const GOOD: ReadinessSignals = {
  browser: { name: "chrome", version: "126" },
  screenWidth: 1920,
  screenHeight: 1080,
  downlinkMbps: 10,
  rttMs: 50,
};

describe("evaluateReadiness (Z-91)", () => {
  it("passes a good desktop", () => {
    expect(evaluateReadiness(GOOD)).toEqual({ passed: true, failed: [] });
    expect(evaluateReadiness({ ...GOOD, downlinkMbps: null }).passed).toBe(true); // speed unknown is not a failure
  });
  it("fails a small screen with a plain message", () => {
    const r = evaluateReadiness({ ...GOOD, screenWidth: 800 });
    expect(r.passed).toBe(false);
    expect(r.failed.map((f) => f.check)).toEqual(["screen"]);
    expect(r.failed[0]?.message).toMatch(/too small/);
  });
  it("fails a slow network", () => {
    const r = evaluateReadiness({ ...GOOD, downlinkMbps: 0.2 });
    expect(r.failed.map((f) => f.check)).toEqual(["network"]);
  });
  it("fails an old or unknown browser", () => {
    expect(evaluateReadiness({ ...GOOD, browser: { name: "chrome", version: "80" } }).failed.map((f) => f.check)).toEqual(["browser"]);
    expect(evaluateReadiness({ ...GOOD, browser: { name: "opera", version: "100" } }).passed).toBe(false);
    expect(evaluateReadiness({ ...GOOD, browser: { name: "safari", version: "17.1" } }).passed).toBe(true);
  });
});
