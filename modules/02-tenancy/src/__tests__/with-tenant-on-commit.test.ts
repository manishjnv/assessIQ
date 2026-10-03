/**
 * FR2 / FU-B5 — withTenant post-commit hooks (onCommit). Fake pool, no Docker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";

const state = vi.hoisted(() => ({
  log: [] as string[],
  released: 0,
}));

function fakeClient(): PoolClient {
  return {
    query: vi.fn(async (sql: string) => {
      state.log.push(sql.split(" ")[0]!);
      return { rows: [] };
    }),
    release: vi.fn(() => {
      state.released += 1;
      state.log.push("release");
    }),
  } as unknown as PoolClient;
}

vi.mock("../pool.js", () => ({
  getPool: () => ({ connect: async () => fakeClient() }),
}));

const { withTenant, onCommit } = await import("../with-tenant.js");

const T = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  state.log = [];
  state.released = 0;
});

describe("onCommit", () => {
  it("runs the hook after COMMIT and after the client is released", async () => {
    const out = await withTenant(T, async (client) => {
      expect(onCommit(client, async () => void state.log.push("hook"))).toBe(true);
      return 42;
    });
    expect(out).toBe(42);
    expect(state.log.slice(-3)).toEqual(["COMMIT", "release", "hook"]);
  });

  it("does not run the hook on rollback", async () => {
    await expect(
      withTenant(T, async (client) => {
        onCommit(client, async () => void state.log.push("hook"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(state.log).toContain("ROLLBACK");
    expect(state.log).not.toContain("hook");
  });

  it("refuses a client that is not inside withTenant, also after a withTenant ended", async () => {
    let leaked: PoolClient | undefined;
    await withTenant(T, async (client) => {
      leaked = client;
    });
    expect(onCommit(leaked!, async () => undefined)).toBe(false);
    expect(onCommit(fakeClient(), async () => undefined)).toBe(false);
  });

  it("a throwing hook does not change the committed result and later hooks still run", async () => {
    const out = await withTenant(T, async (client) => {
      onCommit(client, async () => {
        throw new Error("hook failed");
      });
      onCommit(client, () => {
        throw new Error("sync throw");
      });
      onCommit(client, async () => void state.log.push("hook3"));
      return "ok";
    });
    expect(out).toBe("ok");
    expect(state.log).toContain("hook3");
    expect(state.log).not.toContain("ROLLBACK");
    expect(state.released).toBe(1);
  });
});
