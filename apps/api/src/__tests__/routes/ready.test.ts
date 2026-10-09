import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeCachedCheck, runReadiness } from '../../routes/health.js';

const ok = async () => 'ok';
const bad = async () => {
  throw new Error('secret detail');
};

afterEach(() => vi.useRealTimers());

describe('GET /api/ready core', () => {
  it('all pass -> ready, all true', async () => {
    expect(await runReadiness({ db: ok, redis: ok, claude: ok })).toEqual({
      status: 'ready',
      checks: { db: true, redis: true, claude: true },
    });
  });

  it('one failing dep -> not_ready with only that check false, no error text', async () => {
    const r = await runReadiness({ db: ok, redis: bad, claude: ok });
    expect(r).toEqual({ status: 'not_ready', checks: { db: true, redis: false, claude: true } });
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('a hanging dep resolves false after the timeout', async () => {
    vi.useFakeTimers();
    const p = runReadiness({ db: ok, redis: ok, claude: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).checks).toEqual({ db: true, redis: true, claude: false });
  });

  it('cached check spawns once within the ttl and shares in-flight runs', async () => {
    let t = 0;
    const run = vi.fn(ok);
    const c = makeCachedCheck(run, 60_000, () => t);
    expect(await Promise.all([c(), c()])).toEqual([true, true]);
    t = 59_000;
    expect(await c()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    t = 61_000;
    await c();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
