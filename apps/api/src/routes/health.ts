import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { getRedis } from '@assessiq/core';
import { getPool } from '@assessiq/tenancy';

const execFileP = promisify(execFile);

export interface ReadinessDeps {
  db: () => Promise<unknown>;
  redis: () => Promise<unknown>;
  claude: () => Promise<unknown>;
}

export interface Readiness {
  status: 'ready' | 'not_ready';
  checks: { db: boolean; redis: boolean; claude: boolean };
}

/**
 * Cache the claude probe so an unauthenticated caller cannot spawn processes
 * at will: one spawn per `ttlMs`, concurrent callers share the in-flight run.
 */
export function makeCachedCheck(
  run: () => Promise<unknown>,
  ttlMs = 60_000,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let at = -Infinity;
  let value = false;
  let inflight: Promise<boolean> | null = null;
  return () => {
    if (now() - at < ttlMs) return Promise.resolve(value);
    inflight ??= run()
      .then(() => true, () => false)
      .then((ok) => {
        value = ok;
        at = now();
        inflight = null;
        return ok;
      });
    return inflight;
  };
}

const defaultDeps: ReadinessDeps = {
  // 5 s coalescing cache: a public caller cannot amplify DB/Redis work, and a
  // hung probe stays one outstanding op instead of piling up.
  db: makeCachedCheck(() => getPool().query('SELECT 1'), 5_000),
  redis: makeCachedCheck(() => getRedis().ping(), 5_000),
  // `--version` makes no model call and uses no quota, so this is not an ambient
  // AI call (the ambient-AI lint targets model-running spawns; deliberate).
  claude: makeCachedCheck(() => execFileP('claude', ['--version'], { timeout: 5000 })),
};

async function probe(fn: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function runReadiness(
  deps: ReadinessDeps = defaultDeps,
  timeoutMs = 5000,
): Promise<Readiness> {
  const [db, redis, claude] = await Promise.all([
    probe(deps.db, timeoutMs),
    probe(deps.redis, timeoutMs),
    probe(deps.claude, timeoutMs),
  ]);
  return { status: db && redis && claude ? 'ready' : 'not_ready', checks: { db, redis, claude } };
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', { config: { skipAuth: true } }, async () => ({ status: 'ok' }));
  // Unauthenticated by design (uptime monitor): body is booleans only, claude probe is cached 60 s.
  app.get('/api/ready', { config: { skipAuth: true } }, async (_req, reply) => {
    const r = await runReadiness();
    return reply.code(r.status === 'ready' ? 200 : 503).send(r);
  });
}
