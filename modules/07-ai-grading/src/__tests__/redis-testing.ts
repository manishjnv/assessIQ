import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { setRedisForTesting, closeRedis } from "@assessiq/core/redis";

// Shared redis:7 container for tests that reach singleFlight (Redis-backed lock).
let c: StartedTestContainer | undefined;

export async function startTestRedis(): Promise<void> {
  c = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  await setRedisForTesting(`redis://${c.getHost()}:${c.getMappedPort(6379)}`);
}

export async function stopTestRedis(): Promise<void> {
  await closeRedis();
  if (c !== undefined) await c.stop();
  c = undefined;
}
