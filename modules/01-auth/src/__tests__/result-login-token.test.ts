/**
 * Z-15 (a): 7-day single-use sign-in token minted for the result email
 * (mintResultLoginToken in @assessiq/notifications), verified by the normal
 * candidate verify path. DB-backed like candidate-login.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { mintResultLoginToken, retireResultLoginLinks, RESULT_LOGIN_TOKEN_TTL_SEC } from "@assessiq/notifications";
import { setRedisForTesting, closeRedis } from "../redis.js";
import {
  verifyCandidateLoginTokenSystem,
  requestCandidateLoginLink,
  CANDIDATE_LOGIN_TOKEN_TTL_SEC,
} from "../candidate-login.js";
import { sha256Hex } from "../crypto-util.js";

let pg: StartedTestContainer;
let redis: StartedTestContainer;
let pgUrl: string;
const tenantId = randomUUID();
const userId = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: pgUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([
    new GenericContainer("postgres:16-alpine")
      .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_test" })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(60_000)
      .start(),
    new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(60_000)
      .start(),
  ]);
  pgUrl = `postgres://test:test@${pg.getHost()}:${pg.getMappedPort(5432)}/aiq_test`;
  await sup((c) => applyAllMigrations(c));
  await setPoolForTesting(pgUrl);
  await setRedisForTesting(`redis://${redis.getHost()}:${redis.getMappedPort(6379)}`);
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'tenant-z15', 'Tenant Z15')`, [tenantId]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenantId]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, 'z15@example.com', 'Z15', 'candidate', 'active')`,
      [userId, tenantId],
    );
  });
}, 120_000);

afterAll(async () => {
  await closeRedis();
  await closePool();
  await Promise.all([pg?.stop(), redis?.stop()]);
});

const mint = () => withTenant(tenantId, (c) => mintResultLoginToken(c, { tenantId, userId }));

describe("result-email sign-in token (Z-15 a)", () => {
  it("signs in once, then rejects the second use", async () => {
    const token = await mint();
    expect(await verifyCandidateLoginTokenSystem(token)).toEqual({ user_id: userId, tenant_id: tenantId });
    expect(await verifyCandidateLoginTokenSystem(token)).toBeNull();
  });

  it("stores only the hash and a 7-day expiry", async () => {
    const token = await mint();
    const row = await sup((c) =>
      c.query<{ secs: string }>(
        `SELECT extract(epoch FROM expires_at - created_at)::text AS secs FROM candidate_login_tokens WHERE token_hash = $1`,
        [sha256Hex(token)],
      ),
    );
    expect(Math.round(Number(row.rows[0]!.secs))).toBe(RESULT_LOGIN_TOKEN_TTL_SEC);
    expect(RESULT_LOGIN_TOKEN_TTL_SEC).toBe(7 * 24 * 3600);
    const plain = await sup((c) => c.query(`SELECT 1 FROM candidate_login_tokens WHERE token_hash = $1`, [token]));
    expect(plain.rows).toHaveLength(0);
  });

  it("rejects a token older than 7 days", async () => {
    const token = await mint();
    await sup((c) =>
      c.query(`UPDATE candidate_login_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha256Hex(token)]),
    );
    expect(await verifyCandidateLoginTokenSystem(token)).toBeNull();
  });

  it("keeps the normal login link at 15 minutes", async () => {
    expect(CANDIDATE_LOGIN_TOKEN_TTL_SEC).toBe(15 * 60);
    const r = await withTenant(tenantId, (c) =>
      requestCandidateLoginLink(c, { email: "z15@example.com", ip: "127.0.0.1", ua: "vitest" }),
    );
    expect(r).not.toBeNull();
    const row = await sup((c) =>
      c.query<{ secs: string }>(
        `SELECT extract(epoch FROM expires_at - created_at)::text AS secs FROM candidate_login_tokens WHERE token_hash = $1`,
        [sha256Hex(r!.token)],
      ),
    );
    expect(Math.round(Number(row.rows[0]!.secs))).toBe(900);
  });

  it("a newer result link retires the older one", async () => {
    const older = await mint();
    const newer = await mint();
    expect(await verifyCandidateLoginTokenSystem(older)).toBeNull();
    expect(await verifyCandidateLoginTokenSystem(newer)).toEqual({ user_id: userId, tenant_id: tenantId });
  });

  it("rejects a token of an erased user", async () => {
    const token = await mint();
    await sup((c) => c.query(`UPDATE users SET erased_at = now() WHERE id = $1`, [userId]));
    try {
      expect(await verifyCandidateLoginTokenSystem(token)).toBeNull();
    } finally {
      await sup((c) => c.query(`UPDATE users SET erased_at = NULL WHERE id = $1`, [userId]));
    }
  });

  it("a withdrawn result retires the link, but not a fresh 15-minute login link", async () => {
    const link = await mint();
    const login = await withTenant(tenantId, (c) =>
      requestCandidateLoginLink(c, { email: "z15@example.com", ip: "127.0.0.2", ua: "vitest" }),
    );
    expect(login).not.toBeNull();
    const n = await withTenant(tenantId, (c) => retireResultLoginLinks(c, userId));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await verifyCandidateLoginTokenSystem(link)).toBeNull();
    expect(await verifyCandidateLoginTokenSystem(login!.token)).toEqual({ user_id: userId, tenant_id: tenantId });
  });
});
