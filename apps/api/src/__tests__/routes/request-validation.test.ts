/**
 * RW-36(b): Zod request schemas (routes/_schemas.ts + routes/_validate.ts).
 *
 * Every schema gets one table row: a good payload passes (200) and a bad one is
 * rejected with HTTP 400 in the standard error envelope
 *   { error: { code: 'VALIDATION_FAILED', message, details: { code, part, issues[] } } }
 * using the same AppError -> reply mapping as server.ts. The anti-enumeration
 * schemas (tryParse) are tested for their null-on-bad contract instead.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError } from '@assessiq/core';
import { parseBody, parseParams, parseQuery, tryParse, tenantIdParams, userIdParams, invitationIdParams, idParams, lifecycleBody } from '../../routes/_validate.js';
import * as S from '../../routes/_schemas.js';

type Case = { schema: Parameters<typeof parseBody>[0]; part: 'body' | 'params' | 'query'; opts?: Parameters<typeof parseBody>[2]; good: unknown; bad: unknown; badCode: string };

const UUID = '00000000-0000-4000-8000-000000000001';

const CASES: Record<string, Case> = {
  // admin-super
  entitlementScopeBody: { schema: S.entitlementScopeBody, part: 'body', opts: { code: 'INVALID_SCOPE' }, good: { scopeType: 'domain', scopeId: UUID }, bad: { scopeType: '', scopeId: UUID }, badCode: 'INVALID_SCOPE' },
  updatePlanBody: { schema: S.updatePlanBody, part: 'body', opts: { code: { tier: 'INVALID_TIER', includedCredits: 'INVALID_CREDITS' } }, good: { tier: 'pro', includedCredits: null }, bad: { includedCredits: 'many' }, badCode: 'INVALID_CREDITS' },
  createDomainBody: { schema: S.createDomainBody, part: 'body', opts: { code: 'MISSING_REQUIRED' }, good: { name: 'Cloud' }, bad: { name: '   ' }, badCode: 'MISSING_REQUIRED' },
  setDomainStatusBody: { schema: S.setDomainStatusBody, part: 'body', opts: { code: 'INVALID_STATUS' }, good: { status: 'archived' }, bad: { status: 'gone' }, badCode: 'INVALID_STATUS' },
  setAiModeBody: { schema: S.setAiModeBody, part: 'body', opts: { code: 'INVALID_MODE' }, good: { mode: null }, bad: {}, badCode: 'INVALID_MODE' },
  renameTenantBody: { schema: S.renameTenantBody, part: 'body', good: { name: 'Acme' }, bad: { name: 'x'.repeat(201) }, badCode: 'NAME_TOO_LONG' },
  createCompanyBody: { schema: S.createCompanyBody, part: 'body', opts: { code: { name: 'MISSING_NAME', slug: 'INVALID_SLUG', adminEmail: 'MISSING_ADMIN_EMAIL' } }, good: { name: 'Acme', slug: 'acme-1', adminEmail: 'a@acme.test' }, bad: { name: 'Acme', slug: 'Bad Slug', adminEmail: 'a@acme.test' }, badCode: 'INVALID_SLUG' },
  listTenantsQuery: { schema: S.listTenantsQuery, part: 'query', good: { include_archived: 'true' }, bad: { include_archived: ['a', 'b'] }, badCode: 'INVALID_QUERY' },
  listTenantUsersQuery: { schema: S.listTenantUsersQuery, part: 'query', good: { include_disabled: '1', extra: 'ok' }, bad: { include_deleted: { a: 1 } }, badCode: 'INVALID_QUERY' },
  editUserBody: { schema: S.editUserBody, part: 'body', opts: { code: { name: 'MISSING_NAME', role: 'INVALID_ROLE', email: 'INVALID_EMAIL' } }, good: { name: 'New', role: 'admin', confirmEmailIdentityChange: true }, bad: { role: 'candidate' }, badCode: 'INVALID_ROLE' },
  // tenant admin
  renameOwnTenantBody: { schema: S.renameOwnTenantBody, part: 'body', opts: { code: 'MISSING_NAME' }, good: { name: 'Acme Corp' }, bad: { name: 7 }, badCode: 'MISSING_NAME' },
  resultReleaseModeBody: { schema: S.resultReleaseModeBody, part: 'body', opts: { code: 'INVALID_RESULT_RELEASE_MODE' }, good: { mode: 'auto' }, bad: { mode: 'sometimes' }, badCode: 'INVALID_RESULT_RELEASE_MODE' },
  retentionDaysBody: { schema: S.retentionDaysBody, part: 'body', opts: { code: 'MISSING_RETENTION_DAYS' }, good: { retention_days: 365 }, bad: { retention_days: '365' }, badCode: 'MISSING_RETENTION_DAYS' },
  runNowQuery: { schema: S.runNowQuery, part: 'query', good: { dryRun: 'true', maxPerTenant: '50' }, bad: { dryRun: ['x'] }, badCode: 'INVALID_QUERY' },
  erasedCandidatesQuery: { schema: S.erasedCandidatesQuery, part: 'query', good: { limit: '20' }, bad: { limit: '1'.repeat(11) }, badCode: 'INVALID_QUERY' },
  listUsersQuery: { schema: S.listUsersQuery, part: 'query', good: { page: '1', pageSize: '20', search: 'a' }, bad: { search: 'x'.repeat(201) }, badCode: 'INVALID_QUERY' },
  createUserBody: { schema: S.createUserBody, part: 'body', opts: { code: S.USER_BODY_CODES }, good: { email: 'a@b.test', name: 'A', role: 'candidate' }, bad: { email: 'a@b.test', name: 'A', role: 'owner' }, badCode: 'INVALID_ROLE' },
  updateUserBody: { schema: S.updateUserBody, part: 'body', opts: { code: S.USER_BODY_CODES }, good: { status: 'disabled' }, bad: { status: 'banned' }, badCode: 'INVALID_STATUS' },
  updateUserNameTooLong: { schema: S.updateUserBody, part: 'body', opts: { code: S.USER_BODY_CODES }, good: { name: 'ok' }, bad: { name: 'x'.repeat(201) }, badCode: 'NAME_TOO_LONG' },
  importUsersBody: { schema: S.importUsersBody, part: 'body', opts: { code: 'INVALID_PARAM' }, good: { csv: 'email,name\na@b.test,A' }, bad: { csv: 42 }, badCode: 'INVALID_PARAM' },
  jobIdParams: { schema: S.jobIdParams, part: 'params', good: { id: '1234' }, bad: { id: '' }, badCode: 'INVALID_PARAMS' },
  // auth
  selectIdentityBody: { schema: S.selectIdentityBody, part: 'body', opts: { code: 'MISSING_USER_ID' }, good: { userId: UUID }, bad: {}, badCode: 'MISSING_USER_ID' },
  sdkMintBody: { schema: S.sdkMintBody, part: 'body', opts: { code: 'MISSING_PARAM' }, good: { assessmentId: UUID }, bad: { assessmentId: '' }, badCode: 'MISSING_PARAM' },
  // shared helpers
  tenantIdParams: { schema: tenantIdParams, part: 'params', good: { tenantId: UUID }, bad: { tenantId: 'not-a-uuid' }, badCode: 'INVALID_PARAMS' },
  userIdParams: { schema: userIdParams, part: 'params', good: { userId: UUID }, bad: {}, badCode: 'INVALID_PARAMS' },
  invitationIdParams: { schema: invitationIdParams, part: 'params', good: { invitationId: UUID }, bad: { invitationId: 5 }, badCode: 'INVALID_PARAMS' },
  idParams: { schema: idParams, part: 'params', good: { id: UUID }, bad: { id: 'x' }, badCode: 'INVALID_PARAMS' },
  lifecycleBody: { schema: lifecycleBody, part: 'body', good: { reason: 'because', confirm_last_admin: true }, bad: { confirm_last_admin: 'yes' }, badCode: 'INVALID_BODY' },
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  // Same AppError -> envelope mapping as server.ts setErrorHandler.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      void reply.code(err.status).send({ error: err.toJson() });
      return;
    }
    void reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });
  app.post('/t/:name', async (req) => {
    const c = CASES[(req.params as { name: string }).name]!;
    const data = c.part === 'body' ? req.body : c.part === 'params' ? (req.query as { p?: string }).p === undefined ? {} : JSON.parse((req.query as { p: string }).p) : (req.body as { q?: unknown } | null)?.q;
    const out =
      c.part === 'body' ? parseBody(c.schema, data, c.opts)
      : c.part === 'params' ? parseParams(c.schema, data, c.opts)
      : parseQuery(c.schema, data, c.opts);
    return { ok: true, out };
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

// Drive each case over HTTP. params go in ?p=<json>, query objects in body.q (test transport only).
const send = (name: string, c: Case, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: `/t/${name}` + (c.part === 'params' ? `?p=${encodeURIComponent(JSON.stringify(payload))}` : ''),
    headers: { 'content-type': 'application/json' },
    payload: c.part === 'query' ? { q: payload } : c.part === 'body' ? (payload as object) : {},
  });

describe.each(Object.entries(CASES))('%s', (name, c) => {
  it('accepts a good payload (200)', async () => {
    const res = await send(name, c, c.good);
    expect(res.statusCode).toBe(200);
  });

  it('rejects a bad payload with 400 and the standard error envelope', async () => {
    const res = await send(name, c, c.bad);
    expect(res.statusCode).toBe(400);
    const e = res.json().error;
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(typeof e.message).toBe('string');
    expect(e.details.code).toBe(c.badCode);
    expect(e.details.part).toBe(c.part);
    expect(Array.isArray(e.details.issues)).toBe(true);
    expect(e.details.issues.length).toBeGreaterThan(0);
  });
});

describe('anti-enumeration schemas (tryParse returns null, never throws)', () => {
  it.each([
    ['requestLinkBody', S.requestLinkBody, { email: 'a@b.test', tenant_slug: 'acme' }, { email: 5 }],
    ['verifyLinkBody', S.verifyLinkBody, { token: 't' }, { token: ['x'] }],
    ['emailRequestBody', S.emailRequestBody, { email: 'a@b.test' }, 'not-an-object'],
    ['emailVerifyBody', S.emailVerifyBody, { email: 'a@b.test', code: '123456' }, { email: 'a@b.test', code: 'x'.repeat(33) }],
  ] as const)('%s', (_n, schema, good, bad) => {
    expect(tryParse(schema, good)).not.toBeNull();
    expect(tryParse(schema, bad)).toBeNull();
  });
});
