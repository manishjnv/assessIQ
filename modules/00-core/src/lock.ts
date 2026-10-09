import { getRedis } from "./redis.js";
import { uuidv7 } from "./ids.js";

// Redis lease lock. Redis errors PROPAGATE on purpose: callers decide fail-open/closed.

const REFRESH_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
const RELEASE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** SET key token PX ttl NX. Returns the token, or null when the lock is held. */
export async function acquireLock(key: string, ttlMs: number, token: string = uuidv7()): Promise<string | null> {
  const res = await getRedis().set(key, token, "PX", ttlMs, "NX");
  return res === "OK" ? token : null;
}

/** Extend the TTL only if we still own the lock. */
export async function refreshLock(key: string, token: string, ttlMs: number): Promise<boolean> {
  return (await getRedis().eval(REFRESH_LUA, 1, key, token, String(ttlMs))) === 1;
}

/** Compare-and-delete. A wrong token is a no-op returning false. */
export async function releaseLock(key: string, token: string): Promise<boolean> {
  return (await getRedis().eval(RELEASE_LUA, 1, key, token)) === 1;
}

export async function peekLock(key: string): Promise<string | null> {
  return getRedis().get(key);
}
