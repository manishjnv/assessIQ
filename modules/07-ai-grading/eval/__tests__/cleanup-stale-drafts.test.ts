/**
 * Unit tests for tools/cleanup-stale-drafts.ts
 *
 * Exercises the exported query functions with a mocked pg client.
 * No real DB, no Docker, no DATABASE_URL required.
 *
 * Test cases:
 *   1. dry-run (find only): findStaleDrafts returns rows; archiveStaleDrafts NOT called.
 *   2. --apply: archiveStaleDrafts called with correct ids; UPDATE SQL contains ANY($1).
 *   3. empty result set: findStaleDrafts returns []; archiveStaleDrafts returns [] cleanly.
 *   4. DB query failure: findStaleDrafts propagates the thrown error.
 *   5. pack-id filter: findStaleDrafts passes pack_id as second parameter.
 *   6. archiveStaleDrafts with empty ids returns [] without calling query.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findStaleDrafts,
  archiveStaleDrafts,
  type MinimalClient,
  type StaleDraftRow,
} from "../../../../tools/cleanup-stale-drafts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(id: string, ageDays = 8): StaleDraftRow {
  return {
    id,
    type: "mcq",
    topic: "Test topic for " + id,
    points: 5,
    pack_id: "019df000-0000-0000-0000-000000000001",
    level_id: "019df008-0000-0000-0000-000000000001",
    created_at: new Date("2026-04-28T10:00:00Z"),
    age_days: ageDays,
  };
}

function makeMockClient(selectRows: StaleDraftRow[] = []): MinimalClient & {
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn();
  // Default: SELECT returns the provided rows; UPDATE returns RETURNING ids.
  query.mockImplementation(
    async (sql: string, _params?: unknown[]) => {
      if (/^\s*SELECT/i.test(sql)) {
        return { rows: selectRows };
      }
      // UPDATE ... RETURNING id — return same ids that were passed in
      return { rows: selectRows.map((r) => ({ id: r.id })) };
    },
  );
  return { query };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findStaleDrafts", () => {
  it("dry-run: SELECT is called once; no UPDATE issued", async () => {
    const rows = [makeRow("id-001"), makeRow("id-002")];
    const client = makeMockClient(rows);

    const result = await findStaleDrafts(client, 7);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("id-001");
    // Only one query call (SELECT); no UPDATE
    expect(client.query).toHaveBeenCalledTimes(1);
    const [[sql]] = (client.query as ReturnType<typeof vi.fn>).mock.calls as [[string, unknown[]]];
    expect(sql).toMatch(/SELECT/i);
    expect(sql).not.toMatch(/UPDATE/i);
  });

  it("passes olderThanDays as first parameter to the interval expression", async () => {
    const client = makeMockClient([]);
    await findStaleDrafts(client, 14);

    const [[_sql, params]] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls as [[string, unknown[]]];
    expect(params![0]).toBe(14);
  });

  it("pack-id filter: passes packId as second parameter when provided", async () => {
    const client = makeMockClient([]);
    const packId = "019df000-44f3-7c97-9403-f7bde6a36843";
    await findStaleDrafts(client, 7, packId);

    const [[sql, params]] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls as [[string, unknown[]]];
    expect(sql).toMatch(/AND pack_id = \$2/);
    expect(params![1]).toBe(packId);
  });

  it("empty result set: returns empty array cleanly", async () => {
    const client = makeMockClient([]);
    const result = await findStaleDrafts(client, 7);
    expect(result).toHaveLength(0);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("DB query failure: propagates the thrown error", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockRejectedValueOnce(new Error("connection refused")),
    };
    await expect(findStaleDrafts(client, 7)).rejects.toThrow("connection refused");
  });
});

describe("archiveStaleDrafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("--apply: calls UPDATE with correct ids array and RETURNING clause", async () => {
    const ids = ["id-001", "id-002", "id-003"];
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: ids.map((id) => ({ id })),
      }),
    };

    const updated = await archiveStaleDrafts(client, ids);

    expect(updated).toEqual(ids);
    expect(client.query).toHaveBeenCalledTimes(1);
    const [[sql, params]] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls as [[string, unknown[]]];
    expect(sql).toMatch(/UPDATE questions/i);
    expect(sql).toMatch(/status\s*=\s*'archived'/i);
    expect(sql).toMatch(/WHERE id = ANY\(\$1\)/i);
    expect(sql).toMatch(/RETURNING id/i);
    expect(params![0]).toEqual(ids);
  });

  it("empty ids: returns [] immediately without calling query", async () => {
    const client: MinimalClient = {
      query: vi.fn(),
    };

    const updated = await archiveStaleDrafts(client, []);

    expect(updated).toHaveLength(0);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("idempotent: second call with already-archived ids returns [] from 0-row RETURNING", async () => {
    // Simulate 0 rows returned — the rows were already archived by another process.
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    };

    const updated = await archiveStaleDrafts(client, ["id-already-done"]);

    expect(updated).toHaveLength(0);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("DB query failure: propagates the thrown error", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockRejectedValueOnce(new Error("deadlock detected")),
    };
    await expect(archiveStaleDrafts(client, ["id-001"])).rejects.toThrow("deadlock detected");
  });
});
