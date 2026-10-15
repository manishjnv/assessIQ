/**
 * RW-64: the slot's AbortSignal aborts when the lease is lost (refresh returns
 * false) or after 2 consecutive refresh errors. Redis is mocked and timers are
 * fake, so the 40 s heartbeat runs instantly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@assessiq/core", async () => {
  const actual = await vi.importActual<typeof import("@assessiq/core")>("@assessiq/core");
  return {
    ...actual,
    acquireLock: vi.fn(async (_k: string, _t: number, token: string) => token),
    refreshLock: vi.fn(),
    releaseLock: vi.fn(async () => undefined),
    peekLock: vi.fn(async () => null),
  };
});

import { refreshLock } from "@assessiq/core";
import { singleFlight } from "../single-flight.js";

const mockRefresh = vi.mocked(refreshLock);

beforeEach(() => {
  vi.useFakeTimers();
  mockRefresh.mockReset();
});
afterEach(() => vi.useRealTimers());

async function slot() {
  const r = await singleFlight.acquire("k");
  if (r.kind !== "acquired") throw new Error("setup");
  return r;
}

describe("singleFlight slot.signal (RW-64)", () => {
  it("stays live while refresh succeeds", async () => {
    mockRefresh.mockResolvedValue(true);
    const s = await slot();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(s.signal.aborted).toBe(false);
    await s.release();
  });

  it("aborts when refresh reports the lease gone", async () => {
    mockRefresh.mockResolvedValue(false);
    const s = await slot();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(s.signal.aborted).toBe(true);
    await s.release();
  });

  it("aborts after 2 consecutive refresh errors, not 1", async () => {
    mockRefresh.mockRejectedValue(new Error("redis down"));
    const s = await slot();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(s.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(s.signal.aborted).toBe(true);
    await s.release();
  });

  it("a successful refresh resets the error count", async () => {
    mockRefresh.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("blip"));
    const s = await slot();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.signal.aborted).toBe(false);
    await s.release();
  });
});
