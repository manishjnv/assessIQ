import { describe, it, expect, vi, beforeEach } from 'vitest';

const hooks: Array<() => Promise<void>> = [];
const emitWebhook = vi.fn();

vi.mock('@assessiq/core', () => ({
  streamLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@assessiq/tenancy', () => ({
  onCommit: (_c: unknown, h: () => Promise<void>) => { hooks.push(h); return true; },
}));
vi.mock('../webhooks/service.js', () => ({ emitWebhook: (a: unknown) => emitWebhook(a) }));

import { emitAttemptEventAfterCommit } from '../webhooks/business-events.js';

const client = {
  query: vi.fn().mockResolvedValue({ rows: [{ assessment_id: 'as1', user_id: 'u1' }] }),
} as never;

describe('business webhook events', () => {
  beforeEach(() => { hooks.length = 0; emitWebhook.mockReset(); });

  it.each(['attempt.submitted', 'attempt.graded', 'result.released'] as const)(
    '%s: nothing before commit, exact ids-only payload after',
    async (event) => {
      await emitAttemptEventAfterCommit(client, 't1', 'a1', event);
      expect(emitWebhook).not.toHaveBeenCalled(); // rollback path: hook never runs
      expect(hooks).toHaveLength(1);
      await hooks[0]!();
      const arg = emitWebhook.mock.calls[0]![0] as { tenantId: string; event: string; payload: Record<string, unknown> };
      expect(arg.tenantId).toBe('t1');
      expect(arg.event).toBe(event);
      expect(Object.keys(arg.payload).sort()).toEqual(
        ['assessment_id', 'attempt_id', 'candidate_id', 'event', 'occurred_at', 'tenant_id'],
      );
      expect(arg.payload).toMatchObject({ event, tenant_id: 't1', attempt_id: 'a1', assessment_id: 'as1', candidate_id: 'u1' });
    },
  );

  it('delivery failure does not throw', async () => {
    emitWebhook.mockRejectedValue(new Error('redis down'));
    await emitAttemptEventAfterCommit(client, 't1', 'a1', 'attempt.graded');
    await expect(hooks[0]!()).resolves.toBeUndefined();
  });
});
