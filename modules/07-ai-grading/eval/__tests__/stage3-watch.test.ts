/**
 * Unit tests for tools/stage3-watch.ts
 *
 * Exercises the exported functions with a mocked pg client and mocked
 * fs.appendFileSync. No real DB, no Docker, no DATABASE_URL required.
 *
 * Test cases:
 *   queryWatchMetrics
 *     1. Returns correct aggregates from a mock client response.
 *     2. chunks_failed_rate is null when chunks_planned_total = 0.
 *     3. Uses "1 hour" interval for window="1h".
 *     4. Uses "24 hours" interval for window="24h".
 *     5. Propagates DB query failure.
 *
 *   evaluateBreach
 *     6. No breach when all metrics are within threshold.
 *     7. Breach on chunks_failed_rate > 0.25.
 *     8. Breach on citation_dropped_total > 0.
 *     9. Breach on both conditions simultaneously.
 *    10. No breach when chunks_planned_total = 0 (null rate → no rate breach).
 *    11. Breach reason includes percentage string.
 *
 *   formatLogEntry
 *    12. Output is valid JSON with expected keys.
 *    13. Ends with newline.
 *
 *   appendToWatchLog (integration: appendFileSync)
 *    14. Calls mkdirSync + appendFileSync with correct path and content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  queryWatchMetrics,
  evaluateBreach,
  formatLogEntry,
  appendToWatchLog,
  type MinimalClient,
  type WatchMetrics,
} from "../../../../tools/stage3-watch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetrics(overrides: Partial<WatchMetrics> = {}): WatchMetrics {
  return {
    window: "1h",
    total_attempts: 5,
    chunks_failed_total: 0,
    chunks_planned_total: 20,
    citation_dropped_total: 0,
    chunks_failed_rate: 0,
    ...overrides,
  };
}

function makeAggRow(
  total = "5",
  failed = "0",
  planned = "20",
  citation = "0",
) {
  return {
    total_attempts: total,
    chunks_failed_total: failed,
    chunks_planned_total: planned,
    citation_dropped_total: citation,
  };
}

// ---------------------------------------------------------------------------
// queryWatchMetrics
// ---------------------------------------------------------------------------

describe("queryWatchMetrics", () => {
  it("returns correct aggregates from mock client", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [makeAggRow("3", "2", "10", "1")] }),
    };

    const metrics = await queryWatchMetrics(client, "1h");

    expect(metrics.total_attempts).toBe(3);
    expect(metrics.chunks_failed_total).toBe(2);
    expect(metrics.chunks_planned_total).toBe(10);
    expect(metrics.citation_dropped_total).toBe(1);
    expect(metrics.chunks_failed_rate).toBeCloseTo(0.2);
  });

  it("chunks_failed_rate is null when chunks_planned_total = 0", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [makeAggRow("0", "0", "0", "0")] }),
    };

    const metrics = await queryWatchMetrics(client, "1h");

    expect(metrics.chunks_failed_rate).toBeNull();
  });

  it("passes '1 hour' interval for window 1h", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [makeAggRow()] }),
    };

    await queryWatchMetrics(client, "1h");

    const [[_sql, params]] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls as [[string, unknown[]]];
    expect(params![0]).toBe("1 hour");
  });

  it("passes '24 hours' interval for window 24h", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [makeAggRow()] }),
    };

    await queryWatchMetrics(client, "24h");

    const [[_sql, params]] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls as [[string, unknown[]]];
    expect(params![0]).toBe("24 hours");
  });

  it("propagates DB query failure", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockRejectedValueOnce(new Error("connection reset")),
    };

    await expect(queryWatchMetrics(client, "1h")).rejects.toThrow("connection reset");
  });

  it("query is SELECT-only (no writes)", async () => {
    const client: MinimalClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [makeAggRow()] }),
    };

    await queryWatchMetrics(client, "1h");

    const [[sql]] = (client.query as ReturnType<typeof vi.fn>).mock.calls as [[string]];
    expect(sql).toMatch(/SELECT/i);
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE|SET\s/i);
  });
});

// ---------------------------------------------------------------------------
// evaluateBreach
// ---------------------------------------------------------------------------

describe("evaluateBreach", () => {
  it("no breach when all metrics are within threshold", () => {
    const result = evaluateBreach(makeMetrics({
      chunks_failed_rate: 0.1,
      citation_dropped_total: 0,
    }));
    expect(result.breach).toBe(false);
    expect(result.breach_reasons).toHaveLength(0);
  });

  it("breach on chunks_failed_rate > 0.25", () => {
    const result = evaluateBreach(makeMetrics({
      chunks_failed_total: 3,
      chunks_planned_total: 10,
      chunks_failed_rate: 0.3,
      citation_dropped_total: 0,
    }));
    expect(result.breach).toBe(true);
    expect(result.breach_reasons).toHaveLength(1);
    expect(result.breach_reasons[0]).toMatch(/chunks_failed_rate/);
  });

  it("breach on citation_dropped_total > 0", () => {
    const result = evaluateBreach(makeMetrics({
      chunks_failed_rate: 0.0,
      citation_dropped_total: 2,
    }));
    expect(result.breach).toBe(true);
    expect(result.breach_reasons).toHaveLength(1);
    expect(result.breach_reasons[0]).toMatch(/citation_dropped_total=2/);
  });

  it("breach on both conditions: two reasons reported", () => {
    const result = evaluateBreach(makeMetrics({
      chunks_failed_total: 6,
      chunks_planned_total: 10,
      chunks_failed_rate: 0.6,
      citation_dropped_total: 5,
    }));
    expect(result.breach).toBe(true);
    expect(result.breach_reasons).toHaveLength(2);
  });

  it("no breach when chunks_failed_rate is exactly 0.25 (boundary: threshold is strict >)", () => {
    const result = evaluateBreach(makeMetrics({
      chunks_failed_total: 5,
      chunks_planned_total: 20,
      chunks_failed_rate: 0.25,
      citation_dropped_total: 0,
    }));
    expect(result.breach).toBe(false);
  });

  it("no breach when chunks_planned_total = 0 (null rate — no sharded attempts)", () => {
    const result = evaluateBreach(makeMetrics({
      total_attempts: 0,
      chunks_failed_total: 0,
      chunks_planned_total: 0,
      citation_dropped_total: 0,
      chunks_failed_rate: null,
    }));
    expect(result.breach).toBe(false);
  });

  it("breach reason includes percentage string for rate breach", () => {
    const result = evaluateBreach(makeMetrics({
      chunks_failed_total: 3,
      chunks_planned_total: 10,
      chunks_failed_rate: 0.3,
      citation_dropped_total: 0,
    }));
    expect(result.breach_reasons[0]).toContain("30.0%");
    expect(result.breach_reasons[0]).toContain("3/10");
  });
});

// ---------------------------------------------------------------------------
// formatLogEntry
// ---------------------------------------------------------------------------

describe("formatLogEntry", () => {
  it("output is valid JSON with expected top-level keys", () => {
    const result = evaluateBreach(makeMetrics({
      chunks_failed_total: 3,
      chunks_planned_total: 10,
      chunks_failed_rate: 0.3,
      citation_dropped_total: 0,
    }));

    const entry = formatLogEntry(result);
    const parsed = JSON.parse(entry.trim()) as Record<string, unknown>;

    expect(parsed).toHaveProperty("ts");
    expect(parsed).toHaveProperty("headline");
    expect(parsed).toHaveProperty("metrics");
  });

  it("entry ends with a newline", () => {
    const result = evaluateBreach(makeMetrics());
    const entry = formatLogEntry(result);
    expect(entry.endsWith("\n")).toBe(true);
  });

  it("headline describes the breach reason", () => {
    const result = evaluateBreach(makeMetrics({
      chunks_failed_rate: 0.5,
      chunks_failed_total: 5,
      chunks_planned_total: 10,
      citation_dropped_total: 0,
    }));
    const entry = formatLogEntry(result);
    const parsed = JSON.parse(entry.trim()) as { headline: string };
    expect(parsed.headline).toMatch(/chunks_failed_rate/);
  });

  it("ts is an ISO 8601 timestamp", () => {
    const before = new Date();
    const result = evaluateBreach(makeMetrics());
    const entry = formatLogEntry(result);
    const parsed = JSON.parse(entry.trim()) as { ts: string };
    const ts = new Date(parsed.ts);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime() - 50);
    expect(ts.getTime()).toBeLessThanOrEqual(Date.now() + 50);
  });
});

// ---------------------------------------------------------------------------
// appendToWatchLog
// ---------------------------------------------------------------------------

describe("appendToWatchLog", () => {
  beforeEach(() => {
    vi.mock("node:fs", () => ({
      appendFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls mkdirSync with the log directory and appendFileSync with correct args", async () => {
    const { appendFileSync, mkdirSync } = await import("node:fs");
    const appendSpy = vi.mocked(appendFileSync);
    const mkdirSpy = vi.mocked(mkdirSync);

    const logPath = "/var/log/assessiq/stage3-watch.log";
    const entry = '{"ts":"2026-05-10T00:00:00.000Z","headline":"test","metrics":{}}\n';

    appendToWatchLog(logPath, entry);

    expect(mkdirSpy).toHaveBeenCalledWith("/var/log/assessiq", { recursive: true });
    expect(appendSpy).toHaveBeenCalledWith(logPath, entry, "utf8");
  });
});
