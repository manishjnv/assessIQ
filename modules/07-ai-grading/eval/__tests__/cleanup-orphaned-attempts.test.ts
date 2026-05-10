/**
 * Unit tests for tools/cleanup-orphaned-attempts.ts
 *
 * Exercises the exported query functions with a mocked pg client.
 * No real DB, no Docker, no DATABASE_URL required.
 *
 * Test cases:
 *   1. dry-run (find only): findOrphanedAttempts returns rows; markAttemptsOrphaned NOT called.
 *   2. --apply: markAttemptsOrphaned called with correct ids; UPDATE sets ORPHANED error_code.
 *   3. empty result set: findOrphanedAttempts returns []; markAttemptsOrphaned returns [] cleanly.
 *   4. DB query failure: findOrphanedAttempts propagates the thrown error.
 *   5. error_message interpolates olderThanMinutes into the message string.
 *   6. markAttemptsOrphaned with empty ids returns [] without calling query.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findOrphanedAttempts,
  markAttemptsOrphaned,
  type MinimalClient,
  type OrphanedAttemptRow,
} from "../../../../tools/cleanup-orphaned-attempts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAttemptRow(id: string, ageMin = 45): OrphanedAttemptRow {
  return {
    id,
    pack_id: "019df000-0000-0000-0000-000000000001",
    level_id: "019df008-0000-0000-0000-000000000001",
    count_requested: 15,
    started_at: new Date("2026-05-10T03:00:00Z"),
    age_min: ageMin,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findOrphanedAttempts", () => {
  it("dry-run: SELECT is called once; no UPDATE issued", async () => {
    const rows = [makeAttemptRow("atm-001"), makeAttemptRow("atm-002")];
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({ rows }),
    };

    const result = await findOrphanedAttempts(client, 30);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("atm-001");
    expect(client.query).toHaveBeenCalledTimes(1);
    const [[sql]] = (client.query as ReturnType<typeof vi.fn>).mock.calls as [[string, unknown[]]];
    expect(sql).toMatch(/SELECT/i);
    expect(sql).not.toMatch(/UPDATE/i);
    // Verify the status filter and the interval expression are present
    expect(sql).toMatch(/status\s*=\s*'running'/);
    expect(sql).toMatch(/INTERVAL '1 minute'/);
  });

  it("passes olderThanMinutes as the first parameter", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    };

    await findOrphanedAttempts(client, 60);

    const [[_sql, params]] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls as [[string, unknown[]]];
    expect(params![0]).toBe(60);
  });

  it("empty result set: returns empty array cleanly", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    };

    const result = await findOrphanedAttempts(client, 30);

    expect(result).toHaveLength(0);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("DB query failure: propagates the thrown error", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockRejectedValueOnce(new Error("connection timeout")),
    };

    await expect(findOrphanedAttempts(client, 30)).rejects.toThrow("connection timeout");
  });
});

describe("markAttemptsOrphaned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("--apply: calls UPDATE with correct ids, error_code=ORPHANED, and RETURNING clause", async () => {
    const ids = ["atm-001", "atm-002"];
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: ids.map((id) => ({ id })),
      }),
    };

    const updated = await markAttemptsOrphaned(client, ids, 30);

    expect(updated).toEqual(ids);
    expect(client.query).toHaveBeenCalledTimes(1);
    const [[sql, params]] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls as [[string, unknown[]]];
    expect(sql).toMatch(/UPDATE generation_attempts/i);
    expect(sql).toMatch(/error_code\s*=\s*'ORPHANED'/i);
    expect(sql).toMatch(/status\s*=\s*'failed'/i);
    expect(sql).toMatch(/finished_at\s*=\s*now\(\)/i);
    expect(sql).toMatch(/WHERE id = ANY\(\$1\)/i);
    expect(sql).toMatch(/RETURNING id/i);
    expect(params![0]).toEqual(ids);
  });

  it("error_message contains the olderThanMinutes value", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: "atm-001" }] }),
    };

    await markAttemptsOrphaned(client, ["atm-001"], 45);

    const [[_sql, params]] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls as [[string, unknown[]]];
    const message = params![1] as string;
    expect(message).toContain("45");
    expect(message).toContain("cleanup-orphaned-attempts");
  });

  it("empty ids: returns [] immediately without calling query", async () => {
    const client: MinimalClient = {
      query: vi.fn(),
    };

    const updated = await markAttemptsOrphaned(client, [], 30);

    expect(updated).toHaveLength(0);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("idempotent: second call with already-cleaned ids returns [] from 0-row RETURNING", async () => {
    // Simulate 0 rows returned — the attempt was already marked failed.
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    };

    const updated = await markAttemptsOrphaned(client, ["atm-already-done"], 30);

    expect(updated).toHaveLength(0);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("DB query failure: propagates the thrown error", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockRejectedValueOnce(new Error("lock timeout")),
    };

    await expect(markAttemptsOrphaned(client, ["atm-001"], 30)).rejects.toThrow("lock timeout");
  });
});
