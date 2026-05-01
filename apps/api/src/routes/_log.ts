import type { FastifyInstance } from 'fastify';
import { streamLogger } from '@assessiq/core';

const frontendLog = streamLogger('frontend');

// Per-IP rate limiter: 600 requests/minute/IP (in-memory token bucket, 60s window)
interface IpWindow {
  count: number;
  windowStart: number;
}
const ipWindows = new Map<string, IpWindow>();
const RATE_LIMIT_MAX = 600;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkIpRateLimit(ip: string): boolean {
  const now = Date.now();

  // Sweep stale entries on each request to avoid unbounded growth
  for (const [key, win] of ipWindows) {
    if (now - win.windowStart >= RATE_LIMIT_WINDOW_MS) {
      ipWindows.delete(key);
    }
  }

  const win = ipWindows.get(ip);
  if (win === undefined || now - win.windowStart >= RATE_LIMIT_WINDOW_MS) {
    ipWindows.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (win.count >= RATE_LIMIT_MAX) {
    return false;
  }
  win.count++;
  return true;
}

const logIngestBodySchema = {
  type: 'object',
  required: ['entries'],
  additionalProperties: false,
  properties: {
    entries: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        required: ['level', 'msg', 'ts'],
        additionalProperties: false,
        properties: {
          level: { type: 'string', enum: ['info', 'warn', 'error'] },
          msg: { type: 'string', maxLength: 200 },
          ts: { type: 'number' },
          fields: {
            type: 'object',
            additionalProperties: {
              anyOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'null' },
              ],
            },
            maxProperties: 20,
          },
        },
      },
    },
  },
} as const;

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  msg: string;
  ts: number;
  fields?: Record<string, string | number | boolean | null>;
}

export async function registerLogIngestRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { entries: LogEntry[] } }>(
    '/api/_log',
    {
      config: { skipAuth: true },
      schema: { body: logIngestBodySchema },
    },
    async (req, reply) => {
      const ip = (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip;

      if (!checkIpRateLimit(ip)) {
        return reply.code(429).send({
          error: {
            code: 'RATE_LIMITED',
            message: 'too many ingest requests',
          },
        });
      }

      const ua = (req.headers['user-agent'] as string | undefined) ?? 'unknown';
      const refererRaw = (req.headers['referer'] as string | undefined) ?? '';
      const referer = refererRaw.slice(0, 256);

      for (const entry of req.body.entries) {
        const { level, msg, ts, fields } = entry;
        frontendLog[level](
          {
            ...(fields ?? {}),
            clientTs: ts,
            ip,
            ua,
            referer,
          },
          msg,
        );
      }

      return reply.code(204).send();
    },
  );
}
