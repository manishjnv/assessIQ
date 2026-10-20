/**
 * Q11: daily soft cap for bulk email. Auth class ignores it; bulk over the cap is
 * delayed to 09:00 IST of the first later day under the cap; Redis down fails open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  counters: new Map<string, number>(),
  redisDown: false,
  mockAdd: vi.fn(),
  getDelayed: vi.fn(),
  get: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@assessiq/core', () => ({
  config: { NODE_ENV: 'test', SMTP_URL: 'smtp://smtp.test:587', EMAIL_FROM: 'A <a@t.com>', REDIS_URL: 'redis://localhost:6379' },
  streamLogger: () => h.mockLog,
  uuidv7: () => '019e0da4-22ac-72df-86cd-abcdef123456',
}));
vi.mock('@assessiq/tenancy', () => ({
  withTenant: async (_t: string, fn: (c: unknown) => Promise<unknown>) => fn({}),
  getPool: () => ({}),
}));
vi.mock('../email/transport.js', () => ({ resolveTransport: vi.fn(() => ({ sendMail: vi.fn() })) }));
vi.mock('../email/render.js', () => ({ renderTemplate: () => ({ subject: 'S', html: '<p>x</p>', text: 'x' }) }));
vi.mock('../repository.js', () => ({ insertEmailLog: vi.fn().mockResolvedValue({}), updateEmailLogStatus: vi.fn() }));
vi.mock('bullmq', async (orig) => ({
  ...(await orig<typeof import('bullmq')>()),
  Queue: vi.fn().mockImplementation(function () { return { add: h.mockAdd, getDelayed: h.getDelayed }; }),
}));
vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return {
      on: () => undefined,
      get: h.get,
      incr: async (k: string) => {
        if (h.redisDown) throw new Error('ECONNREFUSED');
        const n = (h.counters.get(k) ?? 0) + 1;
        h.counters.set(k, n);
        return n;
      },
      expire: async () => 1,
    };
  }),
}));

import { sendEmail, getEmailQueueStatus } from '../email/index.js';
import { istDate, nextSendTimeMs, readBulkDailyCap, reserveBulkSlot, bulkCounterKey } from '../email/bulk-cap.js';

const bulkInput = { to: 'c@x.com', template: 'invitation_candidate', vars: {}, tenantId: 'T1' } as never;
const authInput = { to: 'a@x.com', template: 'admin_email_otp', vars: {}, tenantId: 'T1' } as never;

beforeEach(() => {
  h.counters.clear();
  h.redisDown = false;
  h.mockAdd.mockReset();
  h.getDelayed.mockReset();
  h.get.mockReset();
  h.mockLog.warn.mockReset();
  process.env['EMAIL_BULK_DAILY_CAP'] = '2';
});

describe('bulk daily cap at enqueue', () => {
  it('under the cap sends now (no delay)', async () => {
    await sendEmail(bulkInput);
    await sendEmail(bulkInput);
    for (const call of h.mockAdd.mock.calls) expect(call[2].delay).toBeUndefined();
  });

  it('over the cap delays the job to 09:00 IST of a later day', async () => {
    for (let i = 0; i < 3; i++) await sendEmail(bulkInput);
    const third = h.mockAdd.mock.calls[2]![2];
    expect(third.delay).toBeGreaterThan(0);
    const at = new Date(Date.now() + third.delay);
    expect(new Date(at.getTime() + 330 * 60_000).toISOString().slice(11, 16)).toBe('09:00');
    expect(istDate(at.getTime())).not.toBe(istDate(Date.now()));
  });

  it('auth class ignores the cap and does not use the counter', async () => {
    for (let i = 0; i < 5; i++) await sendEmail(authInput);
    for (const call of h.mockAdd.mock.calls) expect(call[2].delay).toBeUndefined();
    expect(h.counters.size).toBe(0);
  });

  it('fails open with a warning when Redis is down', async () => {
    h.redisDown = true;
    await sendEmail(bulkInput);
    expect(h.mockAdd.mock.calls[0]![2].delay).toBeUndefined();
    expect(h.mockLog.warn).toHaveBeenCalled();
  });
});

describe('reserveBulkSlot day rolling', () => {
  const redis = () => ({
    incr: async (k: string) => {
      const n = (h.counters.get(k) ?? 0) + 1;
      h.counters.set(k, n);
      return n;
    },
    expire: async () => 1,
  });
  const now = Date.parse('2026-10-19T10:00:00Z'); // 15:30 IST, 19 Oct

  it('fills today, then the next day, then the day after', async () => {
    const r = redis();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) delays.push(await reserveBulkSlot(r, 2, now));
    expect(delays.slice(0, 2)).toEqual([0, 0]);
    expect(delays[2]).toBe(nextSendTimeMs(now, 1) - now);
    expect(delays[3]).toBe(delays[2]);
    expect(delays[4]).toBe(nextSendTimeMs(now, 2) - now);
    expect(new Date(now + delays[2]!).toISOString()).toBe('2026-10-20T03:30:00.000Z'); // 09:00 IST
    expect(h.counters.get(bulkCounterKey('2026-10-19'))).toBeGreaterThanOrEqual(2);
  });

  it('rolls the counter key at IST midnight', () => {
    expect(istDate(Date.parse('2026-10-19T18:29:00Z'))).toBe('2026-10-19');
    expect(istDate(Date.parse('2026-10-19T18:31:00Z'))).toBe('2026-10-20');
  });

  it('reads the cap with a safe default', () => {
    expect(readBulkDailyCap({})).toBe(250);
    expect(readBulkDailyCap({ EMAIL_BULK_DAILY_CAP: '40' })).toBe(40);
    expect(readBulkDailyCap({ EMAIL_BULK_DAILY_CAP: 'x' })).toBe(250);
    expect(readBulkDailyCap({ EMAIL_BULK_DAILY_CAP: '-3' })).toBe(250);
  });
});

describe('getEmailQueueStatus', () => {
  it("counts only this tenant's cap-deferred jobs and returns the earliest send time", async () => {
    const t0 = Date.now(); // a fixed date made the delayed jobs "past" and the test failed after the date
    const H = 3_600_000;
    const job = (tenantId: string, delay: number | undefined) => ({
      name: 'email.send', data: { tenantId }, timestamp: t0, opts: { delay },
    });
    h.getDelayed.mockResolvedValue([
      job('T1', 20 * H),
      job('T1', 44 * H),
      job('T2', 20 * H), // other tenant
      job('T1', undefined), // retry backoff, not cap-deferred
    ]);
    h.get.mockResolvedValue('9');
    const s = await getEmailQueueStatus('T1');
    expect(s).toEqual({
      queuedCount: 2,
      nextSendAt: new Date(t0 + 20 * H).toISOString(),
      dailyCap: 2,
      sentToday: 2, // clamped to the cap
    });
  });
});
