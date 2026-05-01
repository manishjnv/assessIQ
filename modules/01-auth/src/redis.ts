import { Redis, type RedisOptions } from "ioredis";
import { config, streamLogger } from "@assessiq/core";

const log = streamLogger('auth');

// Singleton ioredis client. Lazy: created on first getRedis() call so unit
// tests that don't hit Redis don't open a connection. Process-scoped — the
// pool is closed in test teardown via closeRedis() / setRedisForTesting().

let client: Redis | undefined;

const DEFAULT_OPTS: RedisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  // Lazy connection so importing the module doesn't fail at config-load time
  // when REDIS_URL points at a Redis that isn't up yet (e.g. fresh dev box).
  lazyConnect: true,
};

export function getRedis(): Redis {
  if (client === undefined) {
    client = new Redis(config.REDIS_URL, DEFAULT_OPTS);
    client.on("error", (err) => {
      log.error({ err }, "redis client error");
    });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client !== undefined) {
    const c = client;
    client = undefined;
    await c.quit().catch(() => {
      // Best-effort: connection may already be closed; nothing further to do.
    });
  }
}

// Test escape hatch — replace the singleton with a client pointed at the
// container's mapped port. Mirrors `setPoolForTesting` from @assessiq/tenancy.
// NOT exported via index.ts; tests import from "./redis.js" directly.
export async function setRedisForTesting(url: string): Promise<Redis> {
  await closeRedis();
  client = new Redis(url, { ...DEFAULT_OPTS, lazyConnect: false });
  client.on("error", (err) => {
    log.error({ err }, "redis client error (test)");
  });
  return client;
}
