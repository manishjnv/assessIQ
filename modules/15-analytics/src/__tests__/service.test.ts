/**
 * Unit tests for modules/15-analytics — cohort report.
 *
 * Uses a mocked pg PoolClient rather than a real DB or testcontainer.
 * Tests cover:
 *   - Happy path: correct AdminCohortReport shape with all fields populated
 *   - Archetype filter: narrows the attempts[] array only; stats unchanged
 *   - Empty cycle: total_attempts=0, all numeric aggregates null, empty arrays
 *
 * The @assessiq/tenancy module is mocked so withTenant() directly invokes
 * the callback with the mock client — no DB connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Mock @assessiq/tenancy — withTenant passes the mock client to the callback
//
// vi.hoisted() is required so the mutable `mockHolder` reference is available
// inside the vi.mock() factory, which is hoisted before any imports.
// ---------------------------------------------------------------------------

const mockHolder = vi.hoisted(() => ({
  client: null as PoolClient | null,
}));

vi.mock('@assessiq/tenancy', () => ({
  withTenant: async (
    _tenantId: string,
    fn: (client: PoolClient) => Promise<unknown>,
  ) => fn(mockHolder.client as PoolClient),
  getPool: vi.fn(),
}));

// Also mock @assessiq/core to avoid env-loading side-effects
vi.mock('@assessiq/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    config: { AI_PIPELINE_MODE: 'claude-code-vps', NODE_ENV: 'test' },
    streamLogger: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

// ---------------------------------------------------------------------------
// Module under test (imported AFTER mocks are registered)
// ---------------------------------------------------------------------------

// Lazy import so Vitest's mock hoisting resolves before the module loads.
const { getAdminCohortReport } = await import('../service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const ASSESSMENT_ID = '00000000-0000-0000-0000-000000000002';
const ATTEMPT_ID_A = '00000000-0000-0000-0000-000000000010';
const ATTEMPT_ID_B = '00000000-0000-0000-0000-000000000011';
const USER_ID_A = '00000000-0000-0000-0000-000000000020';
const USER_ID_B = '00000000-0000-0000-0000-000000000021';

/**
 * Build a PoolClient mock whose query() method returns the given rows in sequence.
 * Each call to client.query() consumes one entry from `responseQueue`.
 */
function buildMockClient(
  responseQueue: Array<{ rows: Record<string, unknown>[] }>,
): { client: PoolClient; assertAllConsumed: () => void } {
  let callIndex = 0;
  const query = vi.fn(async () => {
    const response = responseQueue[callIndex];
    if (response === undefined) {
      throw new Error(
        `Unexpected client.query() call #${callIndex} — no more responses in queue`,
      );
    }
    callIndex += 1;
    return response;
  });
  const client = { query } as unknown as PoolClient;
  return {
    client,
    assertAllConsumed: () => {
      expect(callIndex, `Expected all ${responseQueue.length} query responses to be consumed`).toBe(
        responseQueue.length,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Happy-path response sequence for queryAdminCohortReport (4 queries). */
function happyPathResponses() {
  return [
    // 1. Aggregate stats
    {
      rows: [
        {
          total_attempts: '2',
          graded_count: '1',
          released_count: '1',
          avg_total_score: '75.00',
          p50_total_score: '75.00',
          p90_total_score: '90.00',
        },
      ],
    },
    // 2. Archetype distribution
    {
      rows: [
        { archetype: 'methodical_diligent', count: '1' },
        { archetype: 'confident_correct', count: '1' },
      ],
    },
    // 3. Band avg
    {
      rows: [{ level_label: 'Foundation', avg_pct: '75.00' }],
    },
    // 4. Attempts list (no archetype filter)
    {
      rows: [
        { attempt_id: ATTEMPT_ID_A, user_id: USER_ID_A, auto_pct: '90.00', archetype: 'confident_correct' },
        { attempt_id: ATTEMPT_ID_B, user_id: USER_ID_B, auto_pct: '60.00', archetype: 'methodical_diligent' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getAdminCohortReport', () => {
  it('happy path — returns expected AdminCohortReport shape', async () => {
    const { client, assertAllConsumed } = buildMockClient(happyPathResponses());
    mockHolder.client = client;

    const report = await getAdminCohortReport(TENANT_ID, ASSESSMENT_ID);

    expect(report.cycle_id).toBe(ASSESSMENT_ID);
    expect(report.total_attempts).toBe(2);
    expect(report.graded_count).toBe(1);
    expect(report.released_count).toBe(1);
    expect(report.avg_total_score).toBeCloseTo(75.0);
    expect(report.p50_total_score).toBeCloseTo(75.0);
    expect(report.p90_total_score).toBeCloseTo(90.0);
    expect(report.archetype_distribution).toEqual({
      methodical_diligent: 1,
      confident_correct: 1,
    });
    expect(report.band_avg).toEqual({ Foundation: 75.0 });
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[0]).toEqual({
      attempt_id: ATTEMPT_ID_A,
      user_id: USER_ID_A,
      total_score: 90.0,
      archetype: 'confident_correct',
    });

    assertAllConsumed();
  });

  it('archetype filter — passes archetype to 4th query only; stats use full cohort', async () => {
    // With archetype filter, the response sequence is identical: the filter
    // is applied inside the SQL via $2 parameter — not detectable here, but
    // we verify the returned attempts[] only contains the filtered archetype.
    const responses = [
      // 1. Aggregate stats (unchanged — full cohort)
      {
        rows: [
          {
            total_attempts: '2',
            graded_count: '2',
            released_count: '0',
            avg_total_score: '75.00',
            p50_total_score: '75.00',
            p90_total_score: '90.00',
          },
        ],
      },
      // 2. Archetype distribution (full cohort)
      {
        rows: [
          { archetype: 'methodical_diligent', count: '1' },
          { archetype: 'confident_correct', count: '1' },
        ],
      },
      // 3. Band avg (full cohort)
      { rows: [{ level_label: 'Foundation', avg_pct: '75.00' }] },
      // 4. Attempts list (filtered to confident_correct only)
      {
        rows: [
          { attempt_id: ATTEMPT_ID_A, user_id: USER_ID_A, auto_pct: '90.00', archetype: 'confident_correct' },
        ],
      },
    ];

    const { client, assertAllConsumed } = buildMockClient(responses);
    mockHolder.client = client;

    const report = await getAdminCohortReport(TENANT_ID, ASSESSMENT_ID, {
      archetype: 'confident_correct',
    });

    // Aggregate stats reflect full cohort (no filter applied there)
    expect(report.total_attempts).toBe(2);
    expect(report.archetype_distribution).toEqual({
      methodical_diligent: 1,
      confident_correct: 1,
    });

    // Attempts array is filtered
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.archetype).toBe('confident_correct');

    // Verify query was called with the archetype param
    const queryCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    // 4th query (index 3) should include $2 = 'confident_correct'
    expect(queryCalls[3]?.[1]).toContain('confident_correct');

    assertAllConsumed();
  });

  it('empty cycle — total_attempts=0, all numeric aggregates null, empty arrays', async () => {
    const responses = [
      // 1. Aggregate stats — Postgres returns one row with NULLs and COUNT=0
      {
        rows: [
          {
            total_attempts: '0',
            graded_count: '0',
            released_count: '0',
            avg_total_score: null,
            p50_total_score: null,
            p90_total_score: null,
          },
        ],
      },
      // 2. Archetype distribution — no rows
      { rows: [] },
      // 3. Band avg — no rows
      { rows: [] },
      // 4. Attempts list — no rows
      { rows: [] },
    ];

    const { client, assertAllConsumed } = buildMockClient(responses);
    mockHolder.client = client;

    const report = await getAdminCohortReport(TENANT_ID, ASSESSMENT_ID);

    expect(report.cycle_id).toBe(ASSESSMENT_ID);
    expect(report.total_attempts).toBe(0);
    expect(report.graded_count).toBe(0);
    expect(report.released_count).toBe(0);
    expect(report.avg_total_score).toBeNull();
    expect(report.p50_total_score).toBeNull();
    expect(report.p90_total_score).toBeNull();
    expect(report.archetype_distribution).toEqual({});
    expect(report.band_avg).toEqual({});
    expect(report.attempts).toHaveLength(0);

    assertAllConsumed();
  });
});
