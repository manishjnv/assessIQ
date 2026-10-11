/**
 * RW-54b: the live question-type CHECK constraints equal the registry.
 * Real Postgres (testcontainers), every migration applied, then pg_constraint is read.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { QUESTION_TYPES } from "@assessiq/question-types";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";

let container: StartedTestContainer;
let client: Client;

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  client = new Client({
    connectionString: `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`,
  });
  await client.connect();
  await applyAllMigrations(client);
}, 180_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe("question-type CHECK constraints equal QUESTION_TYPES", () => {
  it.each([
    ["questions", "questions_type_check"],
    ["question_versions", "question_versions_type_check"],
  ])("%s.%s", async (table, name) => {
    const { rows } = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = $1 AND conrelid = $2::regclass`,
      [name, table],
    );
    expect(rows).toHaveLength(1);
    const allowed = [...rows[0]!.def.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(new Set(allowed)).toEqual(new Set(QUESTION_TYPES));
  });
});
