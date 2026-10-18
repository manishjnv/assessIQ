/**
 * EXP-18: review gate on publish. publishAssessment refuses while an active question of the
 * (pack, level) pool has review_state in_review / disputed / needs_fix. NULL (no verification concept)
 * and 'verified' do not block. Covers whole-pool, section, blueprint category and Z-43 node draws,
 * and tenant isolation. Testcontainers (postgres:16-alpine), full RLS stack.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { ValidationError } from "@assessiq/core";
import { createAssessment, getAssessment, publishAssessment } from "../service.js";
import { AL_ERROR_CODES } from "../types.js";
import { createPack, addLevel, createQuestion, publishPack } from "../../../04-question-bank/src/service.js";

let container: StartedTestContainer;
let url: string;
const tenantA = randomUUID();
const tenantB = randomUUID();
const adminA = randomUUID();
const adminB = randomUUID();
const domainId = randomUUID();
const catId = randomUUID();
const fw = randomUUID();
const subject = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const opens = () => new Date(Date.now() + 60_000);

/** Pack + level + n active mcq questions (review_state per index; undefined = NULL). */
async function buildPool(
  tenantId: string,
  adminId: string,
  states: Array<string | undefined>,
  taxonomy = false,
): Promise<{ packId: string; levelId: string; ids: string[] }> {
  let packId: string;
  let levelId: string;
  if (taxonomy) {
    // A domain blueprint resolves its own (pack, level); take them from a throwaway draft.
    const base = await createAssessment(
      tenantId,
      {
        name: "base",
        pack_id: randomUUID(),
        level_id: randomUUID(),
        question_count: 1,
        opens_at: opens(),
        settings: { blueprint: { domain_id: domainId, level: "L1", criteria: [{ category_id: catId, type: "mcq", count: 1 }] } },
      } as unknown as Parameters<typeof createAssessment>[1],
      adminId,
    );
    packId = base.pack_id;
    levelId = base.level_id;
  } else {
    const pack = await createPack(tenantId, { slug: `p-${randomUUID().slice(0, 8)}`, name: "P", domain: "soc" }, adminId);
    const level = await addLevel(tenantId, pack.id, { position: 1, label: "L1", duration_minutes: 30, default_question_count: 1 }, adminId);
    packId = pack.id;
    levelId = level.id;
  }
  const ids: string[] = [];
  for (let i = 0; i < states.length; i++) {
    const q = await createQuestion(
      tenantId,
      {
        pack_id: packId,
        level_id: levelId,
        type: "mcq",
        topic: `t${i}`,
        points: 5,
        content: { question: `q${i}?`, options: ["A", "B", "C", "D"], correct: 0, rationale: "A" },
      },
      adminId,
    );
    ids.push(q.id);
    await sup(async (c) => {
      await c.query(
        `UPDATE questions SET status='active', review_state=$2, domain_id=$3, category_id=$4 WHERE id=$1`,
        [q.id, states[i] ?? null, taxonomy ? domainId : null, taxonomy ? catId : null],
      );
      if (taxonomy) await c.query(`INSERT INTO question_taxonomy (question_id, node_id) VALUES ($1,$2)`, [q.id, subject]);
    });
  }
  if (!taxonomy) await publishPack(tenantId, packId, adminId);
  return { packId, levelId, ids };
}

async function setState(id: string, state: string | null): Promise<void> {
  await sup((c) => c.query(`UPDATE questions SET review_state=$2 WHERE id=$1`, [id, state]).then(() => undefined));
}

function mkLegacy(tenantId: string, adminId: string, p: { packId: string; levelId: string }, settings?: unknown) {
  return createAssessment(
    tenantId,
    {
      name: "gate",
      pack_id: p.packId,
      level_id: p.levelId,
      question_count: 1,
      opens_at: opens(),
      ...(settings !== undefined ? { settings } : {}),
    } as unknown as Parameters<typeof createAssessment>[1],
    adminId,
  );
}

async function blocked(tenantId: string, id: string, adminId: string): Promise<{ count: number; ids: string[] }> {
  const e = await publishAssessment(tenantId, id, adminId).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ValidationError);
  const d = (e as ValidationError).details as Record<string, unknown>;
  expect(d["code"]).toBe(AL_ERROR_CODES.QUESTIONS_NOT_VERIFIED);
  return { count: d["count"] as number, ids: d["question_ids"] as string[] };
}

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
    for (const [id, slug, admin] of [[tenantA, "rg-a", adminA], [tenantB, "rg-b", adminB]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(
        `INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1,'internal',NULL) ON CONFLICT DO NOTHING`,
        [id],
      );
      await c.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`,
        [admin, id, `${slug}@example.com`],
      );
    }
    await c.query(`INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1,$2,'dom','Dom')`, [domainId, tenantA]);
    await c.query(`INSERT INTO categories (id, tenant_id, domain_id, slug, name) VALUES ($1,$2,$3,'c1','C1')`, [
      catId, tenantA, domainId,
    ]);
    await c.query(`INSERT INTO frameworks (id, tenant_id, slug, name) VALUES ($1,NULL,'rg-f','F')`, [fw]);
    await c.query(
      `INSERT INTO taxonomy_nodes (id, tenant_id, framework_id, parent_id, kind, code, label)
       VALUES ($1,NULL,$2,NULL,'subject','s','s')`,
      [subject, fw],
    );
  });
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

describe("EXP-18 publish review gate", () => {
  it("blocks while a pool question is unverified; lists count and ids only; stays draft", async () => {
    const p = await buildPool(tenantA, adminA, ["verified", "in_review", "needs_fix", "disputed"]);
    const a = await mkLegacy(tenantA, adminA, p);
    const r = await blocked(tenantA, a.id, adminA);
    expect(r.count).toBe(3);
    expect([...r.ids].sort()).toEqual([p.ids[1]!, p.ids[2]!, p.ids[3]!].sort());
    expect((await getAssessment(tenantA, a.id)).status).toBe("draft");
  });

  it("allows publish once every question is verified", async () => {
    const p = await buildPool(tenantA, adminA, ["verified", "in_review"]);
    const a = await mkLegacy(tenantA, adminA, p);
    await blocked(tenantA, a.id, adminA);
    await setState(p.ids[1]!, "verified");
    await publishAssessment(tenantA, a.id, adminA);
    expect((await getAssessment(tenantA, a.id)).status).toBe("published");
  });

  it("regression: NULL review_state (no verification concept) publishes as before", async () => {
    const p = await buildPool(tenantA, adminA, [undefined, undefined]);
    const a = await mkLegacy(tenantA, adminA, p);
    await publishAssessment(tenantA, a.id, adminA);
    expect((await getAssessment(tenantA, a.id)).status).toBe("published");
  });

  it("an archived unverified question is outside the pool and does not block", async () => {
    const p = await buildPool(tenantA, adminA, ["verified", "needs_fix"]);
    await sup((c) => c.query(`UPDATE questions SET status='archived' WHERE id=$1`, [p.ids[1]!]).then(() => undefined));
    const a = await mkLegacy(tenantA, adminA, p);
    await publishAssessment(tenantA, a.id, adminA);
    expect((await getAssessment(tenantA, a.id)).status).toBe("published");
  });

  it("section path is gated", async () => {
    const p = await buildPool(tenantA, adminA, ["in_review"]);
    const a = await mkLegacy(tenantA, adminA, p, { sections: [{ name: "S1", question_count: 1, minutes: 10 }] });
    expect((await blocked(tenantA, a.id, adminA)).count).toBe(1);
  });

  it("blueprint category path and Z-43 node path are gated", async () => {
    const p = await buildPool(tenantA, adminA, ["verified", "disputed"], true);
    const bp = (criteria: unknown[]) =>
      createAssessment(
        tenantA,
        {
          name: "bp",
          pack_id: p.packId,
          level_id: p.levelId,
          question_count: 1,
          opens_at: opens(),
          settings: { blueprint: { domain_id: domainId, level: "L1", criteria } },
        } as unknown as Parameters<typeof createAssessment>[1],
        adminA,
      );
    const byCat = await bp([{ category_id: catId, type: "mcq", count: 1 }]);
    const byNode = await bp([{ node_id: subject, type: "mcq", count: 1 }]);
    expect((await blocked(tenantA, byCat.id, adminA)).ids).toEqual([p.ids[1]!]);
    expect((await blocked(tenantA, byNode.id, adminA)).ids).toEqual([p.ids[1]!]);
    await setState(p.ids[1]!, "verified");
    await publishAssessment(tenantA, byCat.id, adminA);
    await publishAssessment(tenantA, byNode.id, adminA);
  });

  it("tenant isolation: another tenant's unverified question neither blocks nor leaks", async () => {
    const pa = await buildPool(tenantA, adminA, ["verified"]);
    const pb = await buildPool(tenantB, adminB, ["in_review"]);
    const a = await mkLegacy(tenantA, adminA, pa);
    const b = await mkLegacy(tenantB, adminB, pb);
    await publishAssessment(tenantA, a.id, adminA);
    const r = await blocked(tenantB, b.id, adminB);
    expect(r.ids).toEqual([pb.ids[0]!]);
    expect(r.count).toBe(1);
  });
});
