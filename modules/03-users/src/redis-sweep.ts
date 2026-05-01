/**
 * Redis session sweep helpers for 03-users.
 *
 * Per addendum § 7: when a user is disabled or soft-deleted, we actively sweep
 * their Redis session index rather than relying on reject-on-next-request.
 *
 * Session index populated by 01-auth sessions.create (Window 4 carry-forward):
 *   SADD aiq:user:sessions:<userId> aiq:sess:<sha256>
 *   EXPIRE aiq:user:sessions:<userId> 32400
 *
 * The sweep is idempotent — DEL on missing keys is a no-op. Stale entries
 * (sessions that have already expired) cause harmless no-op DELs. No SREM
 * is done on session destroy; lazy-GC on the sweep side is sufficient.
 *
 * ioredis is a hard dependency. If REDIS_URL is unreachable at runtime
 * the connect attempt logs a warning and the sweep is a no-op for the
 * remainder of the process — Postgres-side sessionLoader rejection
 * (01-auth Window 4 carry-forward item 2) catches sessions that survive.
 */

// ioredis 5.x uses class+namespace merging via `export = Redis` (CJS).
// Under NodeNext+esModuleInterop, the namespace shadows the class for
// TypeScript so neither default nor named imports satisfy the constructor
// constraint. createRequire is the documented escape hatch for CJS interop.
import { createRequire } from 'node:module';
import { config, logger } from '@assessiq/core';

const cjsRequire = createRequire(import.meta.url);
type RedisCtor = new (url: string, opts?: Record<string, unknown>) => {
  connect: () => Promise<void>;
  smembers: (key: string) => Promise<string[]>;
  del: (...keys: string[]) => Promise<number>;
};
const IORedis = cjsRequire('ioredis').Redis as RedisCtor;
type RedisClient = InstanceType<typeof IORedis>;

const SESSION_INDEX_KEY = (userId: string): string =>
  `aiq:user:sessions:${userId}`;

// ---------------------------------------------------------------------------
// Lazy singleton Redis client
// ---------------------------------------------------------------------------

let redisClient: RedisClient | undefined;
let redisInitFailed = false;

async function getRedis(): Promise<RedisClient | null> {
  if (redisInitFailed) return null;
  if (redisClient !== undefined) return redisClient;

  try {
    const client: RedisClient = new IORedis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    await client.connect();
    redisClient = client;
    return client;
  } catch (err) {
    redisInitFailed = true;
    logger.warn({ err }, 'redis-sweep: failed to connect to Redis — session sweep disabled');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public sweep API
// ---------------------------------------------------------------------------

/**
 * Sweep all Redis sessions for the given user.
 *
 * Called after a successful disable (updateUser status→disabled) or
 * soft-delete. Per addendum § 7, the sweep:
 *   1. SMEMBERS aiq:user:sessions:<userId>  → list of session keys
 *   2. DEL each member key (idempotent — missing keys = no-op)
 *   3. DEL aiq:user:sessions:<userId>       — remove the index itself
 *
 * Non-transactional: this runs AFTER the Postgres transaction commits.
 * Redis failures are logged as warnings but do NOT fail the caller — the
 * Postgres sessionLoader fallback (01-auth Window 4 carry-forward item 2)
 * catches any sessions that survive a failed sweep.
 */
export async function sweepUserSessions(userId: string): Promise<void> {
  const redis = await getRedis();
  if (redis === null) {
    logger.warn({ userId }, 'redis-sweep: Redis unavailable, skipping session sweep');
    return;
  }

  const indexKey = SESSION_INDEX_KEY(userId);

  try {
    const sessionKeys = await redis.smembers(indexKey);
    if (sessionKeys.length > 0) {
      await redis.del(...sessionKeys);
    }
    await redis.del(indexKey);
    logger.info({ userId, swept: sessionKeys.length }, 'redis-sweep: user sessions swept');
  } catch (err) {
    // Log and continue — Postgres sessionLoader is the belt for these suspenders.
    logger.warn({ err, userId }, 'redis-sweep: error during session sweep');
  }
}
