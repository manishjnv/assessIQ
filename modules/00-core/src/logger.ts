/**
 * Circular-import resolution:
 *
 * childLogger needs the current requestId from request-context.ts. A naive
 * approach of importing `getRequestContext` from "./request-context.js" inside
 * logger.ts would be safe because request-context.ts does NOT import logger.ts,
 * so there is no cycle. We import the lightweight `getRequestId` getter directly.
 *
 * Direction: logger.ts → request-context.ts (one-way, no cycle).
 */
import { createRequire } from "node:module";
import pino, { type Logger, type LoggerOptions } from "pino";
import { config } from "./config.js";
import { getRequestId } from "./request-context.js";

const _require = createRequire(import.meta.url);

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "password",
  "secret",
  "token",
  "apiKey",
  "totpSecret",
  "recoveryCode",
  "client_secret",
  "*.password",
  "*.secret",
];

function buildTransport(): LoggerOptions["transport"] | undefined {
  if (config.NODE_ENV === "production") {
    return undefined;
  }
  try {
    // pino-pretty is an optional dev dependency; if absent fall back to JSON.
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

// `transport` is conditionally added: under exactOptionalPropertyTypes:true,
// the field cannot be assigned `undefined`, so we only spread it in when set.
const transportOpt = buildTransport();
const baseOptions: LoggerOptions = {
  level: config.LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: REDACT_PATHS,
    censor: "[Redacted]",
  },
  ...(transportOpt !== undefined ? { transport: transportOpt } : {}),
};

export function createLogger(opts?: LoggerOptions): Logger {
  return pino({ ...baseOptions, ...opts });
}

export const logger: Logger = createLogger();

/**
 * Creates a child logger that automatically includes the `requestId` from the
 * active AsyncLocalStorage context (if one is running). Callers may also supply
 * extra bindings which are merged in.
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
  const requestId = getRequestId();
  return logger.child(requestId ? { requestId, ...bindings } : bindings);
}
