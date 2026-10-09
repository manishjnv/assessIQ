/**
 * FU-B1 adversarial review (codex, 2026-10-09): the CSV/JSONL exports must not
 * buffer the whole tenant audit log for a slow consumer. The cursor loop awaits
 * write(), and write() waits for the Readable to drain. Proof here: a fake
 * client serves 2000 rows in batches of 1000; with nobody reading, only the
 * first FETCH runs; once the stream is consumed every row arrives and the
 * cursor is closed and committed.
 */
import { describe, it, expect, vi } from 'vitest';

const fetchCalls = { n: 0 };
const ROWS_PER_BATCH = 1000;
const TOTAL_ROWS = 2000;
const fakeClient = {
  query: vi.fn(async (sql: string) => {
    if (sql.startsWith('FETCH')) {
      fetchCalls.n += 1;
      if ((fetchCalls.n - 1) * ROWS_PER_BATCH >= TOTAL_ROWS) return { rows: [], rowCount: 0 };
      const rows = Array.from({ length: ROWS_PER_BATCH }, (_, i) => ({
        id: `row-${(fetchCalls.n - 1) * ROWS_PER_BATCH + i}`,
        tenant_id: 't',
        actor_user_id: null,
        actor_kind: 'system',
        action: 'x.y',
        entity_type: 'e',
        entity_id: null,
        before: null,
        after: { k: 'v'.repeat(40) },
        ip: null,
        user_agent: null,
        at: 'now',
      }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock('@assessiq/tenancy', () => ({
  withTenant: vi.fn(async (_t: string, fn: (c: unknown) => Promise<unknown>) => fn(fakeClient)),
}));

import { exportJsonl, lineStream } from '../service.js';

describe('audit export backpressure', () => {
  it('lineStream.write waits until the consumer reads', async () => {
    const { readable, write } = lineStream(16);
    await write('a'.repeat(10) + '\n'); // 11 bytes, fits the 16-byte buffer
    let second = false;
    const p = write('b'.repeat(10) + '\n').then(() => { second = true; }); // crosses the mark, waits
    await new Promise((r) => setTimeout(r, 10));
    expect(second).toBe(false);
    const chunks: string[] = [];
    readable.on('data', (c: Buffer) => chunks.push(c.toString()));
    await p;
    expect(second).toBe(true);
    readable.push(null);
    await new Promise((r) => readable.once('end', r));
    expect(chunks.join('')).toBe('a'.repeat(10) + '\n' + 'b'.repeat(10) + '\n');
  });

  it('lineStream.write rejects after the consumer destroys the stream', async () => {
    const { readable, write } = lineStream(16);
    await write('a'.repeat(10) + '\n');
    const p = write('b'.repeat(10) + '\n');
    readable.destroy();
    await expect(p).rejects.toThrow(/consumer closed/);
  });

  it('lineStream.write rejects when the consumer reads nothing for the idle timeout', async () => {
    const { readable, write } = lineStream(16, 30);
    await write('a'.repeat(10) + '\n');
    const p = write('b'.repeat(10) + '\n');
    let destroyErr: Error | undefined;
    readable.on('error', (e: Error) => { destroyErr = e; });
    await expect(p).rejects.toThrow(/consumer closed/);
    expect(destroyErr?.message).toMatch(/idle for 30 ms/);
  });

  it('exportJsonl fetches the second cursor batch only after the first is consumed', async () => {
    fetchCalls.n = 0;
    const readable = await exportJsonl({ tenantId: 't', filters: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls.n).toBe(1); // 1000 rows x ~150 bytes is far above the 16 KiB highWaterMark

    const lines: string[] = [];
    let buf = '';
    for await (const chunk of readable) {
      buf += (chunk as Buffer).toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    expect(lines).toHaveLength(TOTAL_ROWS);
    expect(JSON.parse(lines[0]!).id).toBe('row-0');
    expect(JSON.parse(lines[TOTAL_ROWS - 1]!).id).toBe(`row-${TOTAL_ROWS - 1}`);
    const sqls = fakeClient.query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((q) => q.startsWith('CLOSE'))).toBe(true);
    expect(sqls).toContain('COMMIT');
  });
});
