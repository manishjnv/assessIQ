// AssessIQ — modules/18-certification/src/__tests__/public-repository.test.ts
//
// Phase 5 Session 3 — TDD RED tests for the public-verify repository functions.
//
// Tests (2 — collectively cover spec test #6: GUC scoping):
//
//   R8a: findByCredentialIdPublic SQL has NO tenant_id predicate.
//        The cross-tenant lookup is authorised by the GUC-based RLS policy
//        (app.public_verify='true'), NOT by explicit tenant scoping. An
//        accidental tenant_id filter would break the public verify page for
//        any credential issued by a tenant the caller didn't know about.
//
//   R8b: findByCredentialIdPublic normalises the credential_id to uppercase
//        before querying (credential_ids are stored uppercase; recruiters
//        often copy them in lowercase from business cards / LinkedIn).
//
// Strategy: minimal PoolClient mock that captures SQL + params, same pattern
// as repository.test.ts (R5/R7). No Postgres required.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { findByCredentialIdPublic, withPublicVerifyContext } from '../repository.js';

// ---------------------------------------------------------------------------
// Mock PoolClient factory
// ---------------------------------------------------------------------------

function makeQueryClient(rows: unknown[] = []): PoolClient {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as PoolClient;
}

const CREDENTIAL_ID = 'AIQ-2026-05-A7F3K9';

// ---------------------------------------------------------------------------
// R8a — no tenant_id predicate in the query
// ---------------------------------------------------------------------------

describe('findByCredentialIdPublic — R8: no tenant_id filter (cross-tenant by design)', () => {
  it('executes a query that does NOT include a tenant_id predicate', async () => {
    const client = makeQueryClient([]);
    await findByCredentialIdPublic(client, CREDENTIAL_ID);

    const queryMock = vi.mocked(client.query);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    const [sql] = call;

    // CERTIFICATE_PROJECTION legitimately includes `tenant_id::text` in the
    // SELECT list — the invariant is that there is no WHERE / AND tenant_id = $N
    // filter, not that the word never appears.
    expect(sql).not.toMatch(/WHERE\s+.*tenant_id\s*=/is);
    expect(sql).not.toMatch(/AND\s+tenant_id\s*=/i);
  });

  // ---------------------------------------------------------------------------
  // R8b — uppercase normalisation
  // ---------------------------------------------------------------------------

  it('normalises credential_id to uppercase before querying', async () => {
    const client = makeQueryClient([]);
    await findByCredentialIdPublic(client, 'aiq-2026-05-a7f3k9');

    const call = (vi.mocked(client.query).mock.calls[0] as unknown) as [string, unknown[]];
    const [, params] = call;
    expect(params[0]).toBe('AIQ-2026-05-A7F3K9');
  });
});

// ---------------------------------------------------------------------------
// R9 — withPublicVerifyContext sets app.current_tenant to a UUID sentinel
// ---------------------------------------------------------------------------
//
// Prod bug surfaced 2026-05-13: the tenant_isolation RLS policy on certificates
// casts current_setting('app.current_tenant')::uuid on every SELECT. Without a
// value, Postgres throws "invalid input syntax for type uuid" on '' BEFORE the
// OR'd public_verify_lookup policy can grant access. The fix is to set a
// reserved UUID_NIL sentinel so the cast succeeds, the equality fails, and the
// OR-evaluation falls through to public_verify_lookup.

describe('withPublicVerifyContext — R9: tenant_isolation cast guard', () => {
  it('issues SET app.current_tenant with UUID_NIL inside the transaction', async () => {
    // Mock getPool().connect() via a one-shot client that records every query.
    const calls: string[] = [];
    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    } as unknown as PoolClient & { release: () => void };

    // Stub the pool — small inline mock; matches the shape used by other
    // module tests.
    const { getPool } = await import('@assessiq/tenancy');
    vi.mocked(getPool).mockReturnValue({
      connect: async () => client,
    } as never);

    await withPublicVerifyContext(async () => 'ok');

    const seen = calls.join('\n');
    expect(seen).toMatch(/BEGIN/);
    expect(seen).toMatch(/SET LOCAL ROLE assessiq_app/);
    expect(seen).toMatch(/set_config\('app\.public_verify', 'true', true\)/);
    expect(seen).toMatch(
      /set_config\('app\.current_tenant', '00000000-0000-0000-0000-000000000000', true\)/,
    );
    expect(seen).toMatch(/COMMIT/);
  });
});

vi.mock('@assessiq/tenancy', () => ({
  getPool: vi.fn(),
}));
