/**
 * modules/13-notifications/src/email/bulk-cap.ts
 *
 * Daily soft cap for BULK email (Q11). The provider (Brevo free plan) allows
 * 300 emails/day shared with other products, so a big invitation batch is
 * spread over several days instead of bouncing off the provider limit.
 *
 * At enqueue time a bulk job reserves a slot on a per-day Redis counter
 * (Asia/Kolkata date). Under the cap: send now. Over the cap: the job is
 * delayed to 09:00 IST of the first later day whose counter is under the cap.
 * Auth emails never call this (sign-in codes are never delayed or counted).
 * Redis down: the caller fails open (sends now) and logs a warning.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

export const DEFAULT_EMAIL_BULK_DAILY_CAP = 250;

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const SEND_HOUR_IST = 9;
const KEY_TTL_S = 3 * 86_400;
/** Look-ahead limit; a queue that deep is a config problem, not a use case. */
const MAX_DAYS_AHEAD = 60;

// ponytail: read from process.env here, not modules/00-core config (off-limits for this row); move to the config schema when 00-core is next opened.
/** EMAIL_BULK_DAILY_CAP: positive integer, default 250; a bad value falls back to the default. */
export function readBulkDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['EMAIL_BULK_DAILY_CAP'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_EMAIL_BULK_DAILY_CAP;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EMAIL_BULK_DAILY_CAP;
}

/** Calendar date (YYYY-MM-DD) in Asia/Kolkata for a UTC ms timestamp. */
export function istDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function bulkCounterKey(date: string): string {
  return `aiq:email:bulk:${date}`;
}

/** UTC ms of 09:00 IST on the IST calendar day that is `daysAhead` after the day of `ms`. */
export function nextSendTimeMs(ms: number, daysAhead: number): number {
  const istMidnightUtc = Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return istMidnightUtc + daysAhead * DAY_MS + SEND_HOUR_IST * 3_600_000;
}

/** The slice of ioredis this file needs. */
export interface CounterRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/**
 * Reserve one bulk slot. Returns the BullMQ `delay` in ms (0 = send now).
 * Each INCR reserves; an over-cap try on today's counter is kept (it only
 * pushes `sentToday` readers to clamp with Math.min).
 */
export async function reserveBulkSlot(
  redis: CounterRedis,
  cap: number,
  now: number = Date.now(),
): Promise<number> {
  for (let day = 0; day <= MAX_DAYS_AHEAD; day++) {
    const key = bulkCounterKey(istDate(now + day * DAY_MS));
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, KEY_TTL_S);
    if (n <= cap) return day === 0 ? 0 : nextSendTimeMs(now, day) - now;
  }
  return nextSendTimeMs(now, MAX_DAYS_AHEAD) - now;
}
