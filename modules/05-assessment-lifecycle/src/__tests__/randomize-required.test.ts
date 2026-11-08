/** 2026-11-08: publish refuses randomize=false for bank draws (sections / exam_blueprint); fixed lists unaffected. */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
vi.mock("../email.js", () => ({ sendInvitationEmail: vi.fn(), resolveCameraRequired: vi.fn(async () => false) }));

import { createAssessment, getAssessment, publishAssessment } from "../service.js";
import { AL_ERROR_CODES } from "../types.js";
import { createPack, addLevel, createQuestion, publishPack } from "../../../04-question-bank/src/service.js";

let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const admin = randomUUID();
let packId: string;
let levelId: string;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const mk = (randomize: boolean, settings?: unknown) =>
  createAssessment(
    tenant,
    {
      name: "rz",
      pack_id: packId,
      level_id: levelId,
      question_count: 1,
      opens_at: new Date(Date.now() + 60_000),
      randomize,
      ...(settings !== undefined ? { settings } : {}),
    } as unknown as Parameters<typeof createAssessment>[1],
    admin,
  );

const expectRequired = async (id: string) => {
  await expect(publishAssessment(tenant, id, admin)).rejects.toMatchObject({
    details: { code: AL_ERROR_CODES.RANDOMIZE_REQUIRED },
  });
  expect((await getAssessment(tenant, id)).status).toBe("draft");
};

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;
  await sup(async (c) => {
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'rz','rz')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenant]);
    await c.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1,'internal',NULL) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'rz@example.com','Admin','admin','active')`, [admin, tenant]);
  });
  await setPoolForTesting(url);
  const pack = await createPack(tenant, { slug: `p-${randomUUID().slice(0, 8)}`, name: "P", domain: "soc" }, admin);
  const level = await addLevel(tenant, pack.id, { position: 1, label: "L1", duration_minutes: 30, default_question_count: 1 }, admin);
  packId = pack.id;
  levelId = level.id;
  const q = await createQuestion(
    tenant,
    { pack_id: packId, level_id: levelId, type: "mcq", topic: "t", points: 5, content: { question: "q?", options: ["A", "B", "C", "D"], correct: 0, rationale: "A" } },
    admin,
  );
  await sup((c) => c.query(`UPDATE questions SET status='active', review_state='verified' WHERE id=$1`, [q.id]));
  await publishPack(tenant, packId, admin);
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

describe("RANDOMIZE_REQUIRED publish guard", () => {
  const sections = [{ name: "S1", question_count: 1, minutes: 10 }];

  it("refuses randomize=false with sections", async () => {
    await expectRequired((await mk(false, { sections })).id);
  });

  it("refuses randomize=false with exam_blueprint", async () => {
    await expectRequired((await mk(false, { sections, exam_blueprint: { id: randomUUID(), edition: "1", verification_status: "unverified" } })).id);
  });

  it("publishes with randomize=true as before", async () => {
    const a = await mk(true, { sections });
    await publishAssessment(tenant, a.id, admin);
    expect((await getAssessment(tenant, a.id)).status).toBe("published");
  });

  it("fixed-list (no draw settings) with randomize=false still publishes", async () => {
    const a = await mk(false);
    await publishAssessment(tenant, a.id, admin);
    expect((await getAssessment(tenant, a.id)).status).toBe("published");
  });
});
