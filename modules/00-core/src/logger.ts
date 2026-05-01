/**
 * Operational logger — pino with per-stream fan-out, ALS-aware mixin,
 * and a centralized redaction allowlist.
 *
 * Three modes, decided at logger construction time:
 *
 *   1. `LOG_DIR` unset, NODE_ENV=development, pino-pretty installed
 *      → single transport: pretty-printed stdout (legacy dev experience)
 *
 *   2. `LOG_DIR` unset (test, prod-without-files-yet)
 *      → single transport: JSON stdout
 *
 *   3. `LOG_DIR` set
 *      → multistream: JSON stdout + `<LOG_DIR>/<stream>.log`
 *        + `<LOG_DIR>/error.log` mirror (level >= error)
 *
 * Public API:
 *
 *   - `logger`          — root pino, stream='app' (back-compat with prior export)
 *   - `streamLogger(n)` — memoized per-stream pino; routes to `<LOG_DIR>/<n>.log`
 *                         when `n` is a known stream, else falls through to app.log
 *   - `childLogger(b)`  — convenience: `logger.child(bindings)`. Mixin auto-adds
 *                         requestId/tenantId/userId from AsyncLocalStorage.
 *   - `createLogger(o)` — escape hatch for callers that need a non-memoized pino
 *
 * Circular-import note: this module imports the lightweight ALS getter from
 * request-context.ts. request-context.ts does NOT import from here. One-way.
 */
import {
  createWriteStream,
  mkdirSync,
  type WriteStream,
} from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import pino, {
  type Logger,
  type LoggerOptions,
  type StreamEntry,
} from "pino";
import { config } from "./config.js";
import { getRequestContext } from "./request-context.js";
import { LOG_REDACT_PATHS } from "./log-redact.js";

const _require = createRequire(import.meta.url);

/**
 * Stream names that get a dedicated `<LOG_DIR>/<name>.log` file.
 * Anything else routes to app.log so a typo cannot create a stray file.
 */
const KNOWN_STREAMS = new Set([
  "app",
  "request",
  "auth",
  "grading",
  "migration",
  "webhook",
  "frontend",
]);

function buildBaseOptions(streamName: string): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...LOG_REDACT_PATHS],
      censor: "[Redacted]",
    },
    base: { stream: streamName, pid: process.pid },
    /**
     * Mixin runs at log time on every line. Pulls correlation fields from the
     * active AsyncLocalStorage request context. Children inherit this mixin.
     */
    mixin: () => {
      const ctx = getRequestContext();
      if (ctx === undefined) return {};
      const out: Record<string, string> = {};
      if (ctx.requestId !== undefined) out.requestId = ctx.requestId;
      if (ctx.tenantId !== undefined) out.tenantId = ctx.tenantId;
      if (ctx.userId !== undefined) out.userId = ctx.userId;
      return out;
    },
  };
}

function buildPrettyTransport(): LoggerOptions["transport"] | undefined {
  if (config.NODE_ENV === "production") return undefined;
  try {
    _require.resolve("pino-pretty");
    return {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    };
  } catch {
    return undefined;
  }
}

const _fileStreamCache = new Map<string, WriteStream>();

function getOrOpenFileStream(absPath: string): WriteStream {
  const cached = _fileStreamCache.get(absPath);
  if (cached !== undefined) return cached;
  mkdirSync(path.dirname(absPath), { recursive: true });
  const ws = createWriteStream(absPath, { flags: "a" });
  _fileStreamCache.set(absPath, ws);
  return ws;
}

function buildFileStreams(streamName: string): StreamEntry[] {
  const dir = config.LOG_DIR;
  if (dir === undefined || dir.length === 0) return [];
  const fileBase = KNOWN_STREAMS.has(streamName) ? streamName : "app";
  const streamFile = path.join(dir, `${fileBase}.log`);
  const errorMirror = path.join(dir, "error.log");
  return [
    { stream: getOrOpenFileStream(streamFile), level: config.LOG_LEVEL },
    { stream: getOrOpenFileStream(errorMirror), level: "error" },
  ];
}

function buildLogger(streamName: string): Logger {
  const baseOpts = buildBaseOptions(streamName);
  const fileStreams = buildFileStreams(streamName);

  if (fileStreams.length > 0) {
    // Mode 3: multistream JSON to stdout + per-stream file + error mirror.
    // pino-pretty is intentionally NOT used here; on-disk files must be JSON.
    return pino(
      baseOpts,
      pino.multistream(
        [
          { stream: process.stdout, level: config.LOG_LEVEL },
          ...fileStreams,
        ],
        { dedupe: false },
      ),
    );
  }

  // Mode 1/2: single-destination stdout (pretty in dev when available)
  const transportOpt = buildPrettyTransport();
  return pino({
    ...baseOpts,
    ...(transportOpt !== undefined ? { transport: transportOpt } : {}),
  });
}

const _streamLoggers = new Map<string, Logger>();

export function streamLogger(name: string): Logger {
  const cached = _streamLoggers.get(name);
  if (cached !== undefined) return cached;
  const built = buildLogger(name);
  _streamLoggers.set(name, built);
  return built;
}

export function createLogger(opts?: LoggerOptions): Logger {
  return pino({ ...buildBaseOptions("app"), ...opts });
}

export const logger: Logger = streamLogger("app");

/**
 * Convenience for callers that want extra bindings on the default `app` logger.
 * Correlation fields (requestId, tenantId, userId) are added by the mixin and
 * MUST NOT be passed as bindings here — that would shadow the live ALS values.
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

export { LOG_REDACT_PATHS } from "./log-redact.js";
