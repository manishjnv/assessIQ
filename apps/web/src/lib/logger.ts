const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

export type ClientLogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  level: ClientLogLevel;
  msg: string;
  fields?: Record<string, string | number | boolean | null>;
  ts: number;
}

// Per-session rate-limit state
const RATE_LIMIT_MAX = 200;
const RATE_LIMIT_WINDOW_MS = 60_000;
let rateWindowStart = Date.now();
let rateCount = 0;
let rateLimitWarned = false;

// In-memory buffer and dropped counter
const buffer: LogEntry[] = [];
let droppedCount = 0;

// Flush debounce timer
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_DEBOUNCE_MS = 2000;
const BUFFER_MAX = 20;
const MSG_MAX_LEN = 200;
const FIELDS_MAX_JSON_BYTES = 1024;

// Substrings checked against the lowercased field key. `key.includes(sub)` does
// not bridge underscores, so snake_case variants (`api_key`, `id_token`,
// `refresh_token`) are listed explicitly alongside their camelCase forms.
// Mirrors the server-side `LOG_REDACT_PATHS` allowlist in @assessiq/core.
const BLOCKED_KEY_SUBSTRINGS = [
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'id_token',
  'refresh_token',
  'cookie',
  'authorization',
  'auth',
  'recovery',
  'session',
];

function sanitizeFields(
  fields: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(fields)) {
    const keyLower = k.toLowerCase();
    const blocked = BLOCKED_KEY_SUBSTRINGS.some((sub) => keyLower.includes(sub));
    if (blocked) {
      if (import.meta.env.DEV) {
        console.warn(`[assessiq/logger] dropping PII-adjacent field key: "${k}"`);
      }
      continue;
    }
    result[k] = v;
  }
  return result;
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushBuffer();
  }, FLUSH_DEBOUNCE_MS);
}

function flushBuffer(useBeacon = false): void {
  if (buffer.length === 0 && droppedCount === 0) return;

  const entries = buffer.splice(0, buffer.length);
  const dropped = droppedCount;
  droppedCount = 0;

  const body: { entries: LogEntry[]; dropped?: number } = { entries };
  if (dropped > 0) body.dropped = dropped;

  const json = JSON.stringify(body);
  const url = `${API_BASE}/_log`;

  if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }));
    return;
  }

  fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: json,
  }).catch(() => {
    // Swallow all errors — do not retry to avoid retry storms.
    // Re-add dropped count for next successful flush.
    droppedCount += entries.length + dropped;
  });
}

export function clientLog(
  level: ClientLogLevel,
  msg: string,
  fields?: Record<string, string | number | boolean | null>,
): void {
  // Rate-limit check (per-session, per-minute window)
  const now = Date.now();
  if (now - rateWindowStart >= RATE_LIMIT_WINDOW_MS) {
    rateWindowStart = now;
    rateCount = 0;
    rateLimitWarned = false;
  }
  if (rateCount >= RATE_LIMIT_MAX) {
    if (!rateLimitWarned) {
      rateLimitWarned = true;
      if (import.meta.env.DEV) {
        console.warn('[assessiq/logger] rate limit reached (200/min); further entries dropped');
      }
    }
    droppedCount++;
    return;
  }
  rateCount++;

  // msg size cap
  let safeMsg = msg;
  if (msg.length > MSG_MAX_LEN) {
    if (import.meta.env.DEV) {
      console.warn(`[assessiq/logger] msg truncated from ${msg.length} to ${MSG_MAX_LEN} chars`);
    }
    safeMsg = msg.slice(0, MSG_MAX_LEN);
  }

  // fields validation
  let safeFields: Record<string, string | number | boolean | null> | undefined;
  if (fields !== undefined) {
    const sanitized = sanitizeFields(fields);
    const jsonLen = JSON.stringify(sanitized).length;
    if (jsonLen > FIELDS_MAX_JSON_BYTES) {
      if (import.meta.env.DEV) {
        console.warn(
          `[assessiq/logger] fields JSON (${jsonLen} bytes) exceeds 1 KB limit; entry dropped`,
        );
      }
      droppedCount++;
      return;
    }
    safeFields = sanitized;
  }

  const entry: LogEntry = { level, msg: safeMsg, ts: now };
  if (safeFields !== undefined) entry.fields = safeFields;

  buffer.push(entry);

  if (buffer.length >= BUFFER_MAX) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushBuffer();
    return;
  }

  scheduleFlush();
}

export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (e) => {
    clientLog('error', e.message, {
      source: e.filename ?? '',
      line: e.lineno ?? 0,
      col: e.colno ?? 0,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    clientLog('error', String(e.reason).slice(0, MSG_MAX_LEN), { kind: 'unhandledrejection' });
  });

  window.addEventListener('beforeunload', () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushBuffer(/* useBeacon= */ true);
  });
}
