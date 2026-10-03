// RV77: the two analytics exports must go through the guarded csvCell. Fake client, no database.
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';

vi.mock('@assessiq/audit-log', () => ({ audit: vi.fn(async () => undefined) }));

import { streamAttemptExportRows } from '../repository.js';

async function read(r: NodeJS.ReadableStream): Promise<string> {
  let out = '';
  for await (const c of r) out += String(c);
  return out;
}

describe('streamAttemptExportRows csv guard', () => {
  it('neutralises a formula cell', async () => {
    const client = { query: async () => ({ rows: [{ tenant_id: 't', user_email: '=1+1', assessment_name: 'ok' }] }) } as unknown as PoolClient;
    const csv = await read(await streamAttemptExportRows(client, 't', {}, 'csv'));
    expect(csv).toContain("'=1+1");
    expect(csv).not.toMatch(/(^|,)=1\+1/m);
  });
});
