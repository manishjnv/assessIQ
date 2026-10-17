/**
 * updateResultFeedbackLevel (RW-80): default none, update + one audit row, no-op, invalid value, CHECK.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../pool.js";
import { withTenant } from "../with-tenant.js";
import { updateResultFeedbackLevel } from "../service.js";
import { findTenantSettings } from "../repository.js";

const ACTOR = "00000000-0000-0000-0000-000000000002";

let container: StartedTestContainer;
let url: string;
let A: string;
let B: string;

async function sql<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, p)).rows as T[];
  } finally {
    await c.end();
  }
}

const levelOf = async (id: string): Promise<string> =>
  (await sql<{ m: string }>(`SELECT result_feedback_level AS m FROM tenant_settings WHERE tenant_id = $1`, [id]))[0]!.m;
const auditRows = (id: string) =>
  sql<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
    `SELECT before, after FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.settings.updated'`,
    [id],
  );

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
  await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
  await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  await c.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  await c.end();

  setPoolForTesting(url);
  A = randomUUID();
  B = randomUUID();
  await sql(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Acme Corp'), ($3, $4, 'Other Co')`,
    [A, `acme-${A.slice(0, 8)}`, B, `other-${B.slice(0, 8)}`],
  );
  await sql(`INSERT INTO tenant_settings (tenant_id) VALUES ($1), ($2)`, [A, B]);
  // audit_log.actor_user_id has an FK to users(id).
  await sql(
    `INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1, $2, 'admin@acme.test', 'Acme Admin', 'admin')`,
    [ACTOR, A],
  );
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(async () => {
  await sql(`UPDATE tenant_settings SET result_feedback_level = 'none' WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
  await sql(`DELETE FROM audit_log WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
});

describe("result_feedback_level setting", () => {
  it("defaults to 'none' and is mapped by findTenantSettings", async () => {
    expect(await levelOf(A)).toBe("none");
    const s = await withTenant(A, (c) => findTenantSettings(c));
    expect(s?.result_feedback_level).toBe("none");
  });

  it("update writes the column and exactly one audit row; same level is a no-op", async () => {
    const r = await updateResultFeedbackLevel(ACTOR, A, "with_expected_answer");
    expect(r).toMatchObject({ result_feedback_level: "with_expected_answer", previous: "none" });
    expect(r.auditId).not.toBeNull();
    expect(await levelOf(A)).toBe("with_expected_answer");
    const rows = await auditRows(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      before: { result_feedback_level: "none" },
      after: { result_feedback_level: "with_expected_answer" },
    });
    const again = await updateResultFeedbackLevel(ACTOR, A, "with_expected_answer");
    expect(again.auditId).toBeNull();
    expect(await auditRows(A)).toHaveLength(1);
    expect(await levelOf(B)).toBe("none");
  });

  it.each([["bogus"], [""], [null], [undefined], [1]])("rejects invalid level %j and does not write", async (input) => {
    await expect(updateResultFeedbackLevel(ACTOR, A, input)).rejects.toMatchObject({ name: "ValidationError" });
    expect(await levelOf(A)).toBe("none");
    expect(await auditRows(A)).toHaveLength(0);
  });

  it("the DB CHECK constraint rejects other values", async () => {
    await expect(
      sql(`UPDATE tenant_settings SET result_feedback_level = 'bogus' WHERE tenant_id = $1`, [A]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
