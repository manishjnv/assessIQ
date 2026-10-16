import { describe, it, expect, vi, beforeEach } from 'vitest';

const consume = vi.fn();
vi.mock('@assessiq/auth', () => ({ consumeRateLimit: (...a: unknown[]) => consume(...a) }));

import { RateLimitError } from '@assessiq/core';
import { tenantRateLimit } from '../../middleware/tenant-rate-limit.js';

const guard = tenantRateLimit({ name: 'audit-export', max: 5, windowSeconds: 600 });
const call = (req: unknown, reply: unknown) =>
  (guard as unknown as (a: unknown, b: unknown) => Promise<void>)(req, reply);

describe('tenantRateLimit', () => {
  beforeEach(() => consume.mockReset());

  it('passes when allowed', async () => {
    consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 600 });
    await expect(call({ session: { tenantId: 't1' } }, { header: vi.fn() })).resolves.toBeUndefined();
    expect(consume).toHaveBeenCalledWith('aiq:rl:tenant-op:audit-export:t1', 5, 600);
  });

  it('throws RateLimitError with scope tenant-op and sets Retry-After when exhausted', async () => {
    consume.mockResolvedValue({ allowed: false, retryAfterSeconds: 321 });
    const header = vi.fn();
    const err = await call({ session: { tenantId: 't1' } }, { header }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.details).toMatchObject({ retryAfterSeconds: 321, scope: 'tenant-op' });
    expect(header).toHaveBeenCalledWith('Retry-After', 321);
    expect(consume.mock.calls[0]![0]).toContain('t1');
  });

  it('fails closed without a session (AuthzError, no bucket consumed)', async () => {
    await expect(call({}, { header: vi.fn() })).rejects.toMatchObject({ code: 'AUTHZ_FAILED' });
    expect(consume).not.toHaveBeenCalled();
  });
});
