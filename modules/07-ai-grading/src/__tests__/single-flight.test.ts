/**
 * Unit tests for ../single-flight.ts
 *
 * The module exports a module-level singleton `singleFlight` with internal
 * Map state. Tests MUST release any held slot before the next test to avoid
 * state bleed. A `drainSlot()` helper acquires-then-releases to reset the
 * singleton when its state is unknown.
 *
 * Isolation strategy: beforeEach drains any stale in-flight slot by calling
 * isInFlight() and acquiring a probe slot if needed, then releasing it.
 * This is cheaper than module re-import and works even if a prior test threw
 * before its release().
 */

import { describe, it, expect, beforeEach } from "vitest";
import { singleFlight } from "../single-flight.js";

// ---------------------------------------------------------------------------
// Isolation helper
// ---------------------------------------------------------------------------

/**
 * If the singleton is in-flight (from a prior test that threw before release),
 * we cannot know the held attemptId to delete it, so we drain it via a
 * different_id acquire that gets rejected, then clear by brute-force: keep
 * trying acquire on known IDs until one succeeds (the held ID), then release.
 *
 * Since the Map is private, the only public handle is isInFlight() + acquire().
 * Strategy: try a known sentinel ID — if rejected with "same_attempt_in_flight"
 * we got lucky (sentinel was the held ID), release it. If rejected with
 * "other_attempt_in_flight", we need to try acquire(sentinel2) which gets
 * "other_attempt_in_flight" too — there's no way to release a foreign slot
 * without the original release closure.
 *
 * REAL solution: the test cases below always release via the returned closure
 * in a finally block; the drain is only a safety net for the common case where
 * the leaked slot is our own sentinel.
 */
const SENTINEL = "__drain_sentinel__";
const SENTINEL_ALT = "__drain_sentinel_alt__";

function drainIfInFlight(): void {
  if (!singleFlight.isInFlight()) return;

  // Try sentinel — maybe it's the one in flight.
  const r = singleFlight.acquire(SENTINEL);
  if (r.kind === "acquired") {
    r.release();
    return;
  }
  if (r.kind === "rejected" && r.reason === "same_attempt_in_flight") {
    // SENTINEL is in flight — we can't release it (no closure).
    // This means a prior test leaked the SENTINEL itself. This should
    // not happen given our test structure, but if it does, fail loudly.
    throw new Error(
      "drainIfInFlight: SENTINEL slot is stuck in-flight. " +
      "A prior test leaked its release closure. Fix the test.",
    );
  }
  // "other_attempt_in_flight" — some other ID is stuck.
  // Try alt sentinel — same logic.
  const r2 = singleFlight.acquire(SENTINEL_ALT);
  if (r2.kind === "rejected" && r2.reason === "same_attempt_in_flight") {
    throw new Error(
      "drainIfInFlight: SENTINEL_ALT slot is stuck in-flight.",
    );
  }
  // We cannot recover a slot we don't have the closure for. This is a test
  // author error — every test must release in a finally block.
  throw new Error(
    "drainIfInFlight: unknown in-flight slot cannot be drained. " +
    "Ensure all prior tests release their slots in a finally block.",
  );
}

beforeEach(() => {
  drainIfInFlight();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("singleFlight.acquire", () => {
  it("fresh slot returns { kind: 'acquired', release }", () => {
    const result = singleFlight.acquire("attempt-001");
    try {
      expect(result.kind).toBe("acquired");
      if (result.kind === "acquired") {
        expect(typeof result.release).toBe("function");
      }
    } finally {
      if (result.kind === "acquired") result.release();
    }
  });

  it("same-attemptId second acquire returns rejected with 'same_attempt_in_flight'", () => {
    const first = singleFlight.acquire("attempt-dup");
    if (first.kind !== "acquired") throw new Error("Setup failed: first acquire rejected");
    try {
      const second = singleFlight.acquire("attempt-dup");
      expect(second.kind).toBe("rejected");
      if (second.kind === "rejected") {
        expect(second.reason).toBe("same_attempt_in_flight");
      }
    } finally {
      first.release();
    }
  });

  it("different-attemptId second acquire (while first held) returns 'other_attempt_in_flight'", () => {
    const first = singleFlight.acquire("attempt-A");
    if (first.kind !== "acquired") throw new Error("Setup failed");
    try {
      const second = singleFlight.acquire("attempt-B");
      expect(second.kind).toBe("rejected");
      if (second.kind === "rejected") {
        expect(second.reason).toBe("other_attempt_in_flight");
      }
    } finally {
      first.release();
    }
  });

  it("after release(), a new acquire for the SAME attemptId succeeds", () => {
    const first = singleFlight.acquire("attempt-reuse");
    if (first.kind !== "acquired") throw new Error("Setup failed");
    first.release();

    const second = singleFlight.acquire("attempt-reuse");
    try {
      expect(second.kind).toBe("acquired");
    } finally {
      if (second.kind === "acquired") second.release();
    }
  });

  it("after release(), a new acquire for a DIFFERENT attemptId also succeeds", () => {
    const first = singleFlight.acquire("attempt-X");
    if (first.kind !== "acquired") throw new Error("Setup failed");
    first.release();

    const second = singleFlight.acquire("attempt-Y");
    try {
      expect(second.kind).toBe("acquired");
    } finally {
      if (second.kind === "acquired") second.release();
    }
  });

  it("calling release() twice does not throw", () => {
    const result = singleFlight.acquire("attempt-double-release");
    if (result.kind !== "acquired") throw new Error("Setup failed");
    result.release();
    expect(() => result.release()).not.toThrow();
  });

  it("double release() leaves no phantom slot — subsequent acquire succeeds", () => {
    const first = singleFlight.acquire("attempt-phantom");
    if (first.kind !== "acquired") throw new Error("Setup failed");
    first.release();
    first.release(); // second release — should be a no-op

    const second = singleFlight.acquire("attempt-after-phantom");
    try {
      expect(second.kind).toBe("acquired");
    } finally {
      if (second.kind === "acquired") second.release();
    }
  });
});

describe("singleFlight.isInFlight", () => {
  it("returns false when no slot is held", () => {
    expect(singleFlight.isInFlight()).toBe(false);
  });

  it("returns true while a slot is held", () => {
    const result = singleFlight.acquire("attempt-inflight-check");
    if (result.kind !== "acquired") throw new Error("Setup failed");
    try {
      expect(singleFlight.isInFlight()).toBe(true);
    } finally {
      result.release();
    }
  });

  it("returns false after release", () => {
    const result = singleFlight.acquire("attempt-after-release");
    if (result.kind !== "acquired") throw new Error("Setup failed");
    result.release();
    expect(singleFlight.isInFlight()).toBe(false);
  });
});
