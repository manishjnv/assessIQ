/**
 * POST /api/admin/users/import — route wiring (validation, pre-flight,
 * invite mapping, >150 warning). Persistence/audit/tenant isolation are
 * covered by modules/03-users/src/__tests__/import.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { AppError } from '@assessiq/core';

const importCandidates = vi.fn();
const parseCandidateCsv = vi.fn();
const getAssessment = vi.fn();
const inviteUsers = vi.fn();

vi.mock('../../middleware/auth-chain.js', () => ({
  authChain: () => async (req: { session?: unknown }) => {
    req.session = { tenantId: 't1', userId: 'admin1', role: 'admin' };
  },
}));
vi.mock('@assessiq/users', () => ({
  importCandidates: (...a: unknown[]) => importCandidates(...a),
  parseCandidateCsv: (...a: unknown[]) => parseCandidateCsv(...a),
}));
vi.mock('@assessiq/assessment-lifecycle', () => ({
  getAssessment: (...a: unknown[]) => getAssessment(...a),
  inviteUsers: (...a: unknown[]) => inviteUsers(...a),
}));
vi.mock('@assessiq/auth', () => ({ logLifecycleEvent: vi.fn() }));
vi.mock('@assessiq/audit-log', () => ({ audit: vi.fn() }));
vi.mock('@assessiq/data-rights', () => ({ eraseCandidatePii: vi.fn(), exportCandidateData: vi.fn() }));

import { registerAdminUserRoutes } from '../../routes/admin-users.js';

async function build() {
  const app = Fastify();
  app.setErrorHandler((err: Error, _req, reply) => {
    const status = err instanceof AppError ? err.status : 500;
    return reply.code(status).send({ error: { message: err.message } });
  });
  await registerAdminUserRoutes(app);
  return app;
}

const post = (app: Awaited<ReturnType<typeof build>>, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/admin/users/import', payload: payload as object });

beforeEach(() => {
  vi.resetAllMocks();
  parseCandidateCsv.mockReturnValue({ valid: [], skipped: [], totalRows: 0 });
});

describe('POST /api/admin/users/import', () => {
  it('rejects a non-string csv', async () => {
    const res = await post(await build(), { csv: 5 });
    expect(res.statusCode).toBe(400);
    expect(importCandidates).not.toHaveBeenCalled();
  });

  it('imports without invites when no assessment_id', async () => {
    importCandidates.mockResolvedValue({ created: 2, existing: 1, skipped: [{ row: 4, email: 'x', reason: 'INVALID_EMAIL' }], candidates: [] });
    const res = await post(await build(), { csv: 'name,email\n' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      created: 2,
      existing: 1,
      invited: 0,
      skipped: [{ row: 4, email: 'x', reason: 'INVALID_EMAIL' }],
    });
    expect(importCandidates).toHaveBeenCalledWith('t1', 'name,email\n', 'admin1');
    expect(inviteUsers).not.toHaveBeenCalled();
  });

  it('rejects more than 200 invites per import BEFORE creating users', async () => {
    parseCandidateCsv.mockReturnValue({ valid: new Array(201).fill({}), skipped: [], totalRows: 201 });
    const res = await post(await build(), { csv: 'x', assessment_id: 'a1' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/split the file/);
    expect(importCandidates).not.toHaveBeenCalled();
    expect(inviteUsers).not.toHaveBeenCalled();
  });

  it('blocks BEFORE creating users when the assessment is not invitable', async () => {
    getAssessment.mockResolvedValue({ status: 'draft' });
    const res = await post(await build(), { csv: 'name,email\n', assessment_id: 'a1' });
    expect(res.statusCode).toBe(409);
    expect(importCandidates).not.toHaveBeenCalled();
  });

  it('invites via inviteUsers and merges its skip reasons back onto CSV rows', async () => {
    getAssessment.mockResolvedValue({ status: 'published' });
    importCandidates.mockResolvedValue({
      created: 1,
      existing: 1,
      skipped: [],
      candidates: [
        { userId: 'u1', row: 2, email: 'a@x.com' },
        { userId: 'u2', row: 3, email: 'b@x.com' },
      ],
    });
    inviteUsers.mockResolvedValue({ invited: [{}], skipped: [{ userId: 'u2', reason: 'INVITATION_EXISTS' }] });
    const res = await post(await build(), { csv: 'x', assessment_id: 'a1' });
    expect(inviteUsers).toHaveBeenCalledWith('t1', 'a1', ['u1', 'u2'], 'admin1');
    expect(res.json()).toEqual({
      created: 1,
      existing: 1,
      invited: 1,
      skipped: [{ row: 3, email: 'b@x.com', reason: 'INVITATION_EXISTS' }],
    });
  });

  it('adds a warning when more than 150 invites are queued', async () => {
    getAssessment.mockResolvedValue({ status: 'active' });
    importCandidates.mockResolvedValue({
      created: 151,
      existing: 0,
      skipped: [],
      candidates: [{ userId: 'u1', row: 2, email: 'a@x.com' }],
    });
    inviteUsers.mockResolvedValue({ invited: new Array(151).fill({}), skipped: [] });
    const res = await post(await build(), { csv: 'x', assessment_id: 'a1' });
    expect(res.json().warning).toMatch(/300\/day/);
  });
});
