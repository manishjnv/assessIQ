// Z-87: one pure rule for "is this a phone or tablet?". The server calls it at POST /take/start
// for REAL exams; the candidate page reuses the same signals for the early message.
// No I/O. The server never trusts the page alone: the header and the UA come from the request.

export interface ReportedDeviceSignals {
  coarsePointerOnly: boolean;
  maxTouchPoints: number;
  screenWidth: number;
}

export interface DeviceInput {
  userAgent?: string | null | undefined;
  /** Value of the Sec-CH-UA-Mobile request header, e.g. "?1". */
  secChUaMobile?: string | null | undefined;
  /** Client-reported signals (body field `device`). Optional; malformed values are ignored. */
  reported?: unknown;
}

/** Below this screen width (px) the device counts as a phone or tablet. */
export const MOBILE_SCREEN_WIDTH_LIMIT = 900;

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle|webOS|BlackBerry|Opera Mini/i;

/** Lenient parse of the body field: null unless all three keys have the right type. */
export function parseReportedDevice(raw: unknown): ReportedDeviceSignals | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const { coarsePointerOnly, maxTouchPoints, screenWidth } = o;
  if (typeof coarsePointerOnly !== "boolean") return null;
  if (typeof maxTouchPoints !== "number" || !Number.isFinite(maxTouchPoints)) return null;
  if (typeof screenWidth !== "number" || !Number.isFinite(screenWidth)) return null;
  return { coarsePointerOnly, maxTouchPoints, screenWidth };
}

export function isMobileOrTabletClient(input: DeviceInput): boolean {
  if ((input.secChUaMobile ?? "").trim() === "?1") return true;
  if (MOBILE_UA.test(input.userAgent ?? "")) return true;
  const r = parseReportedDevice(input.reported);
  if (r === null) return false;
  // iPadOS sends a Mac user agent, so the touch signals decide.
  if (r.coarsePointerOnly && r.maxTouchPoints >= 1) return true;
  return r.screenWidth > 0 && r.screenWidth < MOBILE_SCREEN_WIDTH_LIMIT;
}
