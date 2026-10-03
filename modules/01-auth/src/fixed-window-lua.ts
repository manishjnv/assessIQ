import type { Redis } from "ioredis";

// Fixed-window counter: INCR; EXPIRE only on the first hit so re-INCR inside the
// window never resets the TTL (spreading hits across the boundary cannot game it).
// Returns [count_after_incr, ttl_seconds].
export const FIXED_WINDOW_LUA = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local n = redis.call("INCR", key)
if n == 1 then
  redis.call("EXPIRE", key, window)
end
local ttl = redis.call("TTL", key)
return {n, ttl}
`;

export async function incrFixedWindow(
  redis: Pick<Redis, "eval">,
  key: string,
  windowSec: number,
): Promise<{ count: number; ttl: number }> {
  const [count, ttl] = (await redis.eval(FIXED_WINDOW_LUA, 1, key, windowSec)) as [number, number];
  return { count, ttl };
}
