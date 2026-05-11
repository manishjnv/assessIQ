// AssessIQ — modules/18-certification/src/__tests__/repository.test.ts
//
// Phase 5 Session 2 (adversarial revision) — unit tests for repository-level
// defensive invariants:
//
//   R5: explicit tenant_id WHERE predicates on listCertificates +
//       findByCredentialId (defense-in-depth against bypassed RLS).
//   R7: incrementCounter runtime allowlist rejects invalid column names.
//
// Strategy: pass a minimal PoolClient mock that captures the SQL query and
// parameters, then assert the query shape. We do NOT spin up a real Postgres
// instance — the RLS bypass scenario cannot be simulated in unit tests anyway
// (RLS is enforced by the DB engine), so we pin the *SQL* invariant instead.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PoolClient } from 'pg';

import {
  findByCredentialId,
  incrementCounter,
  listCertificates,
} from '../repository.js';
import type { ListCertificatesQuery } from '../types.js';

// ---------------------------------------------------------------------------
// Mock PoolClient factory
// ---------------------------------------------------------------------------

function makeQueryClient(rows: unknown[] = []): PoolClient {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as PoolClient;
}

const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const CREDENTIAL_ID = 'AIQ-2026-05-A7F3K9';

// ---------------------------------------------------------------------------
// R5 — findByCredentialId explicit tenant_id predicate
// ---------------------------------------------------------------------------

describe('findByCredentialId — R5: explicit tenant_id predicate', () => {
  it('passes tenantId as the second query parameter', async () => {
    const client = makeQueryClient([]);
    await findByCredentialId(client, CREDENTIAL_ID, TENANT_ID);

    const queryMock = vi.mocked(client.query);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    const [sql, params] = call;

    // SQL must include the tenant_id predicate.
    expect(sql).toMatch(/AND\s+tenant_id\s*=\s*\$2/i);
    // Params: $1 = normalised credential_id, $2 = tenantId.
    expect(params[0]).toBe(CREDENTIAL_ID.toUpperCase());
    expect(params[1]).toBe(TENANT_ID);
  });

  it('normalises credential_id to uppercase before querying', async () => {
    const client = makeQueryClient([]);
    await findByCredentialId(client, 'aiq-2026-05-a7f3k9', TENANT_ID);

    const call = (vi.mocked(client.query).mock.calls[0] as unknown) as [string, unknown[]];
    const [, params] = call;
    expect(params[0]).toBe('AIQ-2026-05-A7F3K9');
  });
});

// ---------------------------------------------------------------------------
// R5 — listCertificates explicit tenant_id predicate
// ---------------------------------------------------------------------------

describe('listCertificates — R5: explicit tenant_id predicate', () => {
  const defaultQuery: ListCertificatesQuery = { limit: 20, offset: 0 };

  it('includes tenant_id = $1 as the first WHERE condition', async () => {
    const client = makeQueryClient([{ total: '0' }]); // for COUNT then SELECT
    // listCertificates calls query twice: COUNT(*) and SELECT.
    // Give each call a result.
    vi.mocked(client.query)
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await listCertificates(client, TENANT_ID, defaultQuery);

    const queryMock = vi.mocked(client.query);
    // Both the COUNT query and the SELECT query should have tenant_id = $1.
    const calls = queryMock.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    for (const [sql, params] of calls) {
      expect(sql).toMatch(/tenant_id\s*=\s*\$1/i);
      expect(params[0]).toBe(TENANT_ID);
    }
  });

  it('no longer has a void tenantId line — tenantId IS used in the query', async () => {
    // This test is a documentation pin. If listCertificates ever reverts to
    // `void tenantId`, the SQL predicate assertion in the test above will catch it.
    // Here we just confirm tenantId is passed through to params[0].
    const client = makeQueryClient([]);
    vi.mocked(client.query)
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await listCertificates(client, TENANT_ID, defaultQuery);

    const call = (vi.mocked(client.query).mock.calls[0] as unknown) as [string, unknown[]];
    const [, params] = call;
    expect(params[0]).toBe(TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// R7 — incrementCounter runtime allowlist
// ---------------------------------------------------------------------------

describe('incrementCounter — R7: runtime allowlist', () => {
  let client: PoolClient;

  beforeEach(() => {
    client = makeQueryClient([]);
  });

  it.each(['pdf_downloads', 'linkedin_shares', 'verification_views'] as const)(
    'accepts valid column "%s"',
    async (column) => {
      await expect(
        incrementCounter(client, '11111111-1111-1111-1111-111111111111', column),
      ).resolves.toBeUndefined();
    },
  );

  it('throws on an invalid column name', async () => {
    await expect(
      incrementCounter(
        client,
        '11111111-1111-1111-1111-111111111111',
        'malicious; DROP TABLE certificates;--' as 'pdf_downloads',
      ),
    ).rejects.toThrow(/invalid counter column/i);
  });

  it('does not execute a query when the column is invalid', async () => {
    await expect(
      incrementCounter(
        client,
        '11111111-1111-1111-1111-111111111111',
        'injected_column' as 'pdf_downloads',
      ),
    ).rejects.toThrow();

    // The query must NOT have been called — the allowlist fires before SQL.
    expect(vi.mocked(client.query)).not.toHaveBeenCalled();
  });
});
