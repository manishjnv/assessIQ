// Z-91: pure readiness check for a REAL exam. The page collects the signals and shows the
// result; the server runs this same function at POST /take/start, so the page alone is not trusted.
// Camera is Wave 2 and is not checked here.

export interface ReadinessSignals {
  browser: { name: string; version: string };
  screenWidth: number;
  screenHeight: number;
  downlinkMbps: number | null;
  rttMs: number | null;
}

export interface ReadinessFailure {
  check: "screen" | "browser" | "network";
  message: string;
}

export interface ReadinessResult {
  passed: boolean;
  failed: ReadinessFailure[];
}

export const READINESS_MIN_SCREEN_WIDTH = 1024;
export const READINESS_MIN_SCREEN_HEIGHT = 600;
/** Checked only when a speed is reported. */
export const READINESS_MIN_DOWNLINK_MBPS = 0.5;
/** Minimum major version per supported browser (lower-case name). */
export const READINESS_MIN_BROWSER_MAJOR: Readonly<Record<string, number>> = {
  chrome: 100,
  edge: 100,
  firefox: 100,
  safari: 15,
};

/** Lenient parse of the body field `readiness`: null unless the shape is right. */
export function parseReadinessSignals(raw: unknown): ReadinessSignals | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const b = o["browser"];
  if (typeof b !== "object" || b === null) return null;
  const bn = (b as Record<string, unknown>)["name"];
  const bv = (b as Record<string, unknown>)["version"];
  if (typeof bn !== "string" || typeof bv !== "string") return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const w = num(o["screenWidth"]);
  const h = num(o["screenHeight"]);
  if (w === null || h === null) return null;
  return {
    browser: { name: bn.slice(0, 40), version: bv.slice(0, 40) },
    screenWidth: w,
    screenHeight: h,
    downlinkMbps: num(o["downlinkMbps"]),
    rttMs: num(o["rttMs"]),
  };
}

export function evaluateReadiness(s: ReadinessSignals): ReadinessResult {
  const failed: ReadinessFailure[] = [];
  if (s.screenWidth < READINESS_MIN_SCREEN_WIDTH || s.screenHeight < READINESS_MIN_SCREEN_HEIGHT) {
    failed.push({
      check: "screen",
      message: `Your screen is too small. Use a screen of at least ${String(READINESS_MIN_SCREEN_WIDTH)} by ${String(READINESS_MIN_SCREEN_HEIGHT)} pixels.`,
    });
  }
  const min = READINESS_MIN_BROWSER_MAJOR[s.browser.name.trim().toLowerCase()];
  const major = parseInt(s.browser.version, 10);
  if (min === undefined || !Number.isFinite(major) || major < min) {
    failed.push({
      check: "browser",
      message: "Please use a recent version of Chrome, Edge, Firefox or Safari.",
    });
  }
  if (s.downlinkMbps !== null && s.downlinkMbps < READINESS_MIN_DOWNLINK_MBPS) {
    failed.push({
      check: "network",
      message: "Your internet connection is too slow. Move closer to your router or use another network.",
    });
  }
  return { passed: failed.length === 0, failed };
}
