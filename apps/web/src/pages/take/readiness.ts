// Z-87 / Z-91: client side of the desktop-only rule and the readiness check.
// The server repeats both at POST /take/start and is the one that decides:
//   modules/06-attempt-engine/src/device.ts      (isMobileOrTabletClient)
//   modules/06-attempt-engine/src/readiness.ts   (evaluateReadiness)
// The rules and numbers below mirror those files so the page can show the same
// result early. If you change one side, change the other.

import { apiRequest } from '../../lib/api.js';

export interface DeviceSignals {
  coarsePointerOnly: boolean;
  maxTouchPoints: number;
  screenWidth: number;
}

export interface ReadinessSignalsWire {
  browser: { name: string; version: string };
  screenWidth: number;
  screenHeight: number;
  downlinkMbps: number | null;
  rttMs: number | null;
}

export type ReadinessCheckId = 'device' | 'screen' | 'browser' | 'network';

export interface ReadinessRow {
  id: ReadinessCheckId;
  label: string;
  status: 'checking' | 'ok' | 'fail';
  /** Plain-words message, shown for a failed row. */
  message?: string;
}

export const DEVICE_BLOCKED_MESSAGE = 'Please open this link on a laptop or desktop computer to take this test';

const MIN_SCREEN_WIDTH = 1024;
const MIN_SCREEN_HEIGHT = 600;
const MIN_DOWNLINK_MBPS = 0.5;
/** A health call slower than this counts as a slow connection (when the browser reports no speed). */
const MAX_RTT_MS = 4000;
const MOBILE_SCREEN_WIDTH_LIMIT = 900;
const MIN_BROWSER_MAJOR: Record<string, number> = { chrome: 100, edge: 100, firefox: 100, safari: 15 };
const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle|webOS|BlackBerry|Opera Mini/i;

export function collectDeviceSignals(): DeviceSignals {
  const mq = (q: string): boolean => {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  return {
    coarsePointerOnly: mq('(pointer: coarse)') && !mq('(any-pointer: fine)'),
    maxTouchPoints: typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0,
    screenWidth: typeof screen !== 'undefined' && typeof screen.width === 'number' ? screen.width : 0,
  };
}

export function isMobileOrTabletClient(d: DeviceSignals): boolean {
  const uaData = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData?.mobile === true) return true;
  if (MOBILE_UA.test(navigator.userAgent)) return true;
  if (d.coarsePointerOnly && d.maxTouchPoints >= 1) return true; // iPadOS reports a Mac user agent
  return d.screenWidth > 0 && d.screenWidth < MOBILE_SCREEN_WIDTH_LIMIT;
}

export function detectBrowser(ua: string = navigator.userAgent): { name: string; version: string } {
  const pick = (re: RegExp, name: string): { name: string; version: string } | null => {
    const m = re.exec(ua);
    return m ? { name, version: m[1] ?? '' } : null;
  };
  return (
    pick(/Edg(?:e|A|iOS)?\/(\d+)/, 'edge') ??
    pick(/OPR\/(\d+)/, 'opera') ??
    pick(/(?:Firefox|FxiOS)\/(\d+)/, 'firefox') ??
    pick(/(?:Chrome|CriOS)\/(\d+)/, 'chrome') ??
    (/Safari\//.test(ua) ? pick(/Version\/(\d+)/, 'safari') : null) ?? { name: 'unknown', version: '' }
  );
}

async function measureNetwork(): Promise<{ downlinkMbps: number | null; rttMs: number | null }> {
  const conn = (navigator as { connection?: { downlink?: number } }).connection;
  const downlink = typeof conn?.downlink === 'number' ? conn.downlink : null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  const t0 = performance.now();
  try {
    await apiRequest('/health', { cache: 'no-store', signal: ctl.signal });
    return { downlinkMbps: downlink, rttMs: Math.round(performance.now() - t0) };
  } catch {
    return { downlinkMbps: downlink, rttMs: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectReadinessSignals(): Promise<ReadinessSignalsWire> {
  const net = await measureNetwork();
  return {
    browser: detectBrowser(),
    screenWidth: typeof screen !== 'undefined' ? screen.width : 0,
    screenHeight: typeof screen !== 'undefined' ? screen.height : 0,
    ...net,
  };
}

/** One row per check, each with a plain-words message when it fails. The camera check is not part of this wave. */
export function evaluateReadinessRows(s: ReadinessSignalsWire, d: DeviceSignals): ReadinessRow[] {
  const major = parseInt(s.browser.version, 10);
  const minMajor = MIN_BROWSER_MAJOR[s.browser.name];
  const slow =
    s.rttMs === null || s.rttMs > MAX_RTT_MS || (s.downlinkMbps !== null && s.downlinkMbps < MIN_DOWNLINK_MBPS);
  const row = (id: ReadinessCheckId, label: string, ok: boolean, message: string): ReadinessRow => ({
    id,
    label,
    status: ok ? 'ok' : 'fail',
    ...(ok ? {} : { message }),
  });
  return [
    row('device', 'Laptop or desktop', !isMobileOrTabletClient(d), DEVICE_BLOCKED_MESSAGE),
    row(
      'screen',
      'Screen size',
      s.screenWidth >= MIN_SCREEN_WIDTH && s.screenHeight >= MIN_SCREEN_HEIGHT,
      `Your screen is too small. Use a screen of at least ${MIN_SCREEN_WIDTH} by ${MIN_SCREEN_HEIGHT} pixels.`,
    ),
    row(
      'browser',
      `Browser (${s.browser.name === 'unknown' ? 'not recognised' : `${s.browser.name} ${s.browser.version}`})`,
      minMajor !== undefined && Number.isFinite(major) && major >= minMajor,
      'Please use a recent version of Chrome, Edge, Firefox or Safari.',
    ),
    row(
      'network',
      'Internet speed',
      !slow,
      'Your internet connection is too slow. Move closer to your router or use another network.',
    ),
  ];
}
