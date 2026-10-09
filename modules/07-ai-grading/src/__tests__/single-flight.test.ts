/**
 * Tests for ../single-flight.ts — Redis-backed global lease (redis:7 testcontainer).
 * Each test releases its slot in a finally block; afterEach force-clears the key.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { getRedis, closeRedis } from "@assessiq/core";
import { setRedisForTesting } from "@assessiq/core/redis";
import { singleFlight, type AcquireResult } from "../single-flight.js";

let redisContainer: StartedTestContainer;
let redisUrl: string;

beforeAll(async () => {
  redisContainer = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  await setRedisForTesting(redisUrl);
}, 60_000);

afterAll(async () => {
  await closeRedis();
  await redisContainer.stop();
}, 30_000);

afterEach(async () => {
  await getRedis().del("aiq:ai:single-flight");
});

async function mustAcquire(key: string): Promise<Extract<AcquireResult, { kind: "acquired" }>> {
  const r = await singleFlight.acquire(key);
  if (r.kind !== "acquired") throw new Error("Setup failed: acquire rejected");
  return r;
}

describe("singleFlight.acquire", () => {
  it("fresh slot returns acquired", async () => {
    const r = await mustAcquire("attempt-001");
    await r.release();
  });

  it("same key while held -> same_attempt_in_flight", async () => {
    const first = await mustAcquire("attempt-dup");
    try {
      expect(await singleFlight.acquire("attempt-dup")).toEqual({ kind: "rejected", reason: "same_attempt_in_flight" });
    } finally {
      await first.release();
    }
  });

  it("different key while held -> other_attempt_in_flight", async () => {
    const first = await mustAcquire("attempt-A");
    try {
      expect(await singleFlight.acquire("attempt-B")).toEqual({ kind: "rejected", reason: "other_attempt_in_flight" });
    } finally {
      await first.release();
    }
  });

  it("after release() a new acquire (same or different key) succeeds", async () => {
    await (await mustAcquire("attempt-reuse")).release();
    await (await mustAcquire("attempt-reuse")).release();
    await (await mustAcquire("attempt-other")).release();
  });

  it("double release() does not throw and does not free another holder's lock", async () => {
    const first = await mustAcquire("attempt-1");
    await first.release();
    const second = await mustAcquire("attempt-2");
    try {
      await expect(first.release()).resolves.toBeUndefined();
      expect(await singleFlight.isInFlight()).toBe(true);
    } finally {
      await second.release();
    }
  });
});

describe("singleFlight.isInFlight", () => {
  it("false when idle, true while held, false after release", async () => {
    expect(await singleFlight.isInFlight()).toBe(false);
    const r = await mustAcquire("attempt-inflight");
    expect(await singleFlight.isInFlight()).toBe(true);
    await r.release();
    expect(await singleFlight.isInFlight()).toBe(false);
  });
});

describe("singleFlight fail-closed", () => {
  it("Redis unreachable -> 503 AIG_LOCK_UNAVAILABLE (no in-process fallback)", async () => {
    await setRedisForTesting("redis://127.0.0.1:1");
    try {
      await expect(singleFlight.acquire("attempt-down")).rejects.toMatchObject({
        status: 503,
        code: "AIG_LOCK_UNAVAILABLE",
      });
    } finally {
      await setRedisForTesting(redisUrl); // restore for afterEach cleanup
    }
  }, 30_000);
});
