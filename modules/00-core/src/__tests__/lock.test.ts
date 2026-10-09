import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Redis } from "ioredis";
import { setRedisForTesting, closeRedis } from "../redis.js";
import { acquireLock, refreshLock, releaseLock, peekLock } from "../lock.js";

let container: StartedTestContainer;
let url: string;
let other: Redis; // second independent client ("another process")

beforeAll(async () => {
  container = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  await setRedisForTesting(url);
  other = new Redis(url);
}, 60_000);

afterAll(async () => {
  other.disconnect();
  await closeRedis();
  await container.stop();
}, 30_000);

describe("redis lock", () => {
  it("a: second client cannot acquire until the first releases", async () => {
    const a = await acquireLock("k:a", 5000);
    expect(a).not.toBeNull();
    // Second client simulates another process: same SET NX semantics on the shared server.
    expect(await other.set("k:a", "b-token", "PX", 5000, "NX")).toBeNull();
    expect(await acquireLock("k:a", 5000)).toBeNull();
    expect(await releaseLock("k:a", a!)).toBe(true);
    expect(await other.set("k:a", "b-token", "PX", 5000, "NX")).toBe("OK");
    await other.del("k:a");
  });

  it("b: TTL expiry frees the lock", async () => {
    expect(await acquireLock("k:b", 200)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(await acquireLock("k:b", 200)).not.toBeNull();
  });

  it("c: wrong token cannot release or refresh", async () => {
    const t = await acquireLock("k:c", 5000);
    expect(await releaseLock("k:c", "wrong")).toBe(false);
    expect(await refreshLock("k:c", "wrong", 5000)).toBe(false);
    expect(await peekLock("k:c")).toBe(t);
    expect(await refreshLock("k:c", t!, 5000)).toBe(true);
    expect(await releaseLock("k:c", t!)).toBe(true);
    expect(await peekLock("k:c")).toBeNull();
  });
});
