// FR1 / FU-B2: export row cap + truncation note, self-audit of exports, archive = audit row only.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const state = { matching: 3, queries: [] as string[] };
const fakeClient = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    // Record the SQL with its LIMIT parameter inlined so assertions can read "LIMIT n".
    const limitParam = params !== undefined && /LIMIT \$\d+/.test(sql) ? params[params.length - 1] : undefined;
    state.queries.push(limitParam === undefined ? sql : sql.replace(/LIMIT \$\d+/, `LIMIT ${String(limitParam)}`));
    if (sql.includes('SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM audit_log')) {
      const cap = Number(limitParam);
      return { rows: [{ n: Math.min(state.matching, cap) }] };
    }
    if (sql.startsWith('FETCH')) {
      const first = !state.queries.slice(0, -1).some((q) => q.startsWith('FETCH'));
      const rows = first ? [{ id: 'r1', tenant_id: 't', actor_user_id: null, actor_kind: 'system', action: 'x.y',
        entity_type: 'e', entity_id: null, before: null, after: null, ip: null, user_agent: null, at: 'now' }] : [];
      return { rows };
    }
    return { rows: [] };
  }),
};
vi.mock('@assessiq/tenancy', () => ({
  withTenant: vi.fn(async (_t: string, fn: (c: unknown) => Promise<unknown>) => fn(fakeClient)),
  onCommit: vi.fn(),
}));
const auditInTx = vi.fn(async (_c: unknown, input: { action: string }) => ({ id: 'audit-1', action: input.action }));
vi.mock('../audit.js', () => ({ auditInTx: (c: unknown, i: { action: string }) => auditInTx(c, i) }));

import { registerAuditRoutes } from '../routes.js';

async function build() {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId: '11111111-2222-3333-4444-555555555555', userId: 'u-1' };
  });
  app.setErrorHandler((err: { status?: number; message: string }, _req, reply) => {
    void reply.code(err.status ?? 500).send({ message: err.message });
  });
  await registerAuditRoutes(app, { adminOnly: async () => {} });
  return app;
}

beforeEach(() => { state.matching = 3; state.queries = []; auditInTx.mockClear(); });

describe('audit export cap', () => {
  it('threads limit into the cursor and flags truncation on JSONL (header + note line)', async () => {
    state.matching = 10; // more than limit 2
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/admin/audit/export.jsonl?limit=2' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-export-truncated']).toBe('true');
    const lines = res.body.trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]!)).toEqual({
      _note: 'truncated', limit: 2, hint: 'Narrow the date range and export again.',
    });
    expect(state.queries.some((q) => q.includes('DECLARE') && q.includes('LIMIT 2'))).toBe(true);
  });

  it('sets the header false and adds no note when under the cap; CSV gets the header only', async () => {
    const app = await build();
    const j = await app.inject({ method: 'GET', url: '/api/admin/audit/export.jsonl' });
    expect(j.headers['x-export-truncated']).toBe('false');
    expect(j.body).not.toContain('_note');
    state.matching = 10;
    const c = await app.inject({ method: 'GET', url: '/api/admin/audit/export.csv?limit=2' });
    expect(c.headers['x-export-truncated']).toBe('true');
    expect(c.body).not.toContain('truncated');
  });

  it('rejects a limit above 100000 (400)', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/admin/audit/export.csv?limit=100001' });
    expect(res.statusCode).toBe(400);
  });

  it('writes one audit.exported row per export, with no row contents', async () => {
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/admin/audit/export.csv?entityType=user' });
    expect(auditInTx).toHaveBeenCalledTimes(1);
    const input = auditInTx.mock.calls[0]![1] as Record<string, unknown>;
    expect(input).toMatchObject({
      action: 'audit.exported', entityType: 'audit_log', actorKind: 'user', actorUserId: 'u-1',
      after: { format: 'csv', filters: { entityType: 'user' }, limit: 100000, truncated: false },
    });
  });
});

describe('audit archive', () => {
  const post = (app: Awaited<ReturnType<typeof build>>, body: unknown) =>
    app.inject({ method: 'POST', url: '/api/admin/audit/archive', payload: body as object });

  it('returns row_count + export_url and writes one audit.archived row', async () => {
    const app = await build();
    const res = await post(app, { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', format: 'jsonl' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ archive_id: 'audit-1', row_count: 3, truncated: false });
    expect(body.export_url).toContain('/api/admin/audit/export.jsonl?from=');
    expect(auditInTx).toHaveBeenCalledTimes(1);
    expect((auditInTx.mock.calls[0]![1] as { action: string }).action).toBe('audit.archived');
  });

  it('rejects to <= from and spans over 366 days (400), without writing', async () => {
    const app = await build();
    const same = await post(app, { from: '2026-02-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', format: 'jsonl' });
    const long = await post(app, { from: '2025-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', format: 'jsonl' });
    expect([same.statusCode, long.statusCode]).toEqual([400, 400]);
    expect(auditInTx).not.toHaveBeenCalled();
  });

  it('never issues an UPDATE or DELETE', async () => {
    const app = await build();
    await post(app, { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', format: 'jsonl' });
    await app.inject({ method: 'GET', url: '/api/admin/audit/export.jsonl' });
    expect(state.queries.filter((q) => /^\s*(UPDATE|DELETE)/i.test(q))).toEqual([]);
  });
});
