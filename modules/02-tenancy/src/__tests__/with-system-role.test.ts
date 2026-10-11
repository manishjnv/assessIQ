/**
 * RW-38: withSystemRole. Live Postgres.
 *
 *   a. runs as assessiq_system, role resets for the next checkout
 *   b. nesting rules: system in system ok, system inside tenant refused before connect
 *   c. onCommit hooks run after commit, never on rollback
 *   d. empty reason is refused
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, getPool } from "../pool.js";
import { withTenant, withSystemRole, onCommit } from "../with-tenant.js";

let container: StartedTestContainer;
let url: string;
let T: string;

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "assessiq", POSTGRES_PASSWORD: "pw", POSTGRES_DB: "assessiq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://assessiq:pw@${container.getHost()}:${container.getMappedPort(5432)}/assessiq`;

  const c = new Client({ connectionString: url });
  await c.connect();
  await applyAllMigrations(c);
  await c.end();

  setPoolForTesting(url);
  T = randomUUID();
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

describe("withSystemRole", () => {
  it("runs as assessiq_system and resets the role afterwards", async () => {
    const inside = await withSystemRole("test: role check", async (client) => {
      const r = await client.query<{ current_user: string }>("SELECT current_user");
      return r.rows[0]!.current_user;
    });
    expect(inside).toBe("assessiq_system");

    const fresh = await getPool().connect();
    try {
      const r = await fresh.query<{ current_user: string }>("SELECT current_user");
      expect(r.rows[0]!.current_user).toBe("assessiq");
    } finally {
      fresh.release();
    }
  });

  it("allows system in system, and tenant inside system", async () => {
    const out = await withSystemRole("test: outer", async () => {
      const a = await withSystemRole("test: inner", async (c) => (await c.query("SELECT 1 AS n")).rows[0]!.n);
      const b = await withTenant(T, async (c) => (await c.query("SELECT 2 AS n")).rows[0]!.n);
      return [a, b];
    });
    expect(out).toEqual([1, 2]);
  });

  it("refuses system inside tenant before acquiring a connection", async () => {
    await withTenant(T, async () => {
      const spy = vi.spyOn(getPool(), "connect");
      try {
        await expect(withSystemRole("test: nested", async () => 1)).rejects.toThrow("SYSTEM_ROLE_INSIDE_TENANT");
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("runs onCommit hooks after commit and not on rollback", async () => {
    const ran: string[] = [];
    await withSystemRole("test: commit", async (client) => {
      expect(onCommit(client, async () => void ran.push("commit"))).toBe(true);
    });
    expect(ran).toEqual(["commit"]);

    await expect(
      withSystemRole("test: rollback", async (client) => {
        onCommit(client, async () => void ran.push("rollback"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(ran).toEqual(["commit"]);
  });

  it("rejects an empty reason", async () => {
    await expect(withSystemRole("", async () => 1)).rejects.toMatchObject({
      details: { code: "INVALID_SYSTEM_ROLE_REASON" },
    });
    await expect(withSystemRole("   ", async () => 1)).rejects.toThrow();
  });
});
