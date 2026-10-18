/**
 * Z-43: a blueprint criterion may name a taxonomy node (subject, unit or outcome). The draw selects
 * questions linked through question_taxonomy to that node or any descendant, active only, inside an
 * optional difficulty_est range. Existing category_id criteria are covered by blueprint-node-golden.
 *
 * Testcontainers (postgres:16-alpine), full RLS stack. Pattern mirrors blueprint-node-golden.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { withTenant } from "@assessiq/tenancy";
import { ValidationError } from "@assessiq/core";
import { createAssessment, getAssessment, previewAssessment, publishAssessment } from "../service.js";
import { AL_ERROR_CODES } from "../types.js";
import { createQuestion } from "../../../04-question-bank/src/service.js";
import {
  listActiveQuestionPoolForCriterion,
  listFrozenPoolForCriterion,
} from "../../../06-attempt-engine/src/repository.js";

let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const tenantB = randomUUID();
const admin = randomUUID();
const domainId = randomUUID();
const cat1 = randomUUID();

// Nodes: framework F1 = subject S > unit U > outcomes O1, O2 and a childless outcome OE; F2 = subject S2.
const fw1 = randomUUID();
const fw2 = randomUUID();
const S = randomUUID();
const U = randomUUID();
const O1 = randomUUID();
const O2 = randomUUID();
const OE = randomUUID();
const S2 = randomUUID();

let packId: string;
let levelId: string;
const qid: Record<string, string> = {};

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
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
const want = (...names: string[]) => names.map((n) => qid[n]!).sort();
const drawLive = (nodeId: string, difficultyMin?: number, difficultyMax?: number) =>
  withTenant(tenant, (client) =>
    listActiveQuestionPoolForCriterion(client, packId, levelId, domainId, undefined, "mcq", {
      nodeId,
      difficultyMin,
      difficultyMax,
    }),
  );
const mk = (criteria: unknown[], domain: string | null = domainId) =>
  createAssessment(
    tenant,
    {
      name: "tax",
      pack_id: randomUUID(),
      level_id: randomUUID(),
      question_count: 1,
      opens_at: opens(),
      settings: { blueprint: { ...(domain !== null ? { domain_id: domain } : {}), level: "L1", criteria } },
    } as unknown as Parameters<typeof createAssessment>[1],
    admin,
  );
function code(e: unknown): unknown {
  return e instanceof ValidationError ? (e.details as Record<string, unknown>)["code"] : undefined;
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
    for (const [id, slug] of [[tenant, "tax-a"], [tenantB, "tax-b"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(
        `INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1,'internal',NULL) ON CONFLICT DO NOTHING`,
        [id],
      );
    }
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@example.com','Admin','admin','active')`,
      [admin, tenant],
    );
    await c.query(`INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1,$2,'dom','Dom')`, [domainId, tenant]);
    await c.query(`INSERT INTO categories (id, tenant_id, domain_id, slug, name) VALUES ($1,$2,$3,'c1','C1')`, [
      cat1, tenant, domainId,
    ]);
    // Platform-owned (tenant NULL) taxonomy, visible to every tenant under RLS.
    await c.query(
      `INSERT INTO frameworks (id, tenant_id, slug, name) VALUES ($1,NULL,'z43-f1','F1'),($2,NULL,'z43-f2','F2')`,
      [fw1, fw2],
    );
    const node = (id: string, fw: string, parent: string | null, kind: string, code: string) =>
      c.query(
        `INSERT INTO taxonomy_nodes (id, tenant_id, framework_id, parent_id, kind, code, label)
         VALUES ($1,NULL,$2,$3,$4,$5,$5)`,
        [id, fw, parent, kind, code],
      );
    await node(S, fw1, null, "subject", "s");
    await node(U, fw1, S, "unit", "u");
    await node(O1, fw1, U, "outcome", "o1");
    await node(O2, fw1, U, "outcome", "o2");
    await node(OE, fw1, U, "outcome", "oe");
    await node(S2, fw2, null, "subject", "s2");
  });
  await setPoolForTesting(url);

  // The category blueprint only exists to get the domain's (pack, level).
  const base = await createAssessment(
    tenant,
    {
      name: "base",
      pack_id: randomUUID(),
      level_id: randomUUID(),
      question_count: 1,
      opens_at: opens(),
      settings: { blueprint: { domain_id: domainId, level: "L1", criteria: [{ category_id: cat1, type: "mcq", count: 1 }] } },
    },
    admin,
  );
  packId = base.pack_id;
  levelId = base.level_id;

  // name, node, difficulty, status
  const plan: Array<[string, string, number, "active" | "archived"]> = [
    ["q1", O1, 2, "active"],
    ["q2", O2, 3, "active"],
    ["q3", U, 3, "active"], // linked to the unit itself
    ["q4", S2, 2, "active"], // other framework
    ["q5", O1, 2, "archived"], // withdrawn
    ["q6", O1, 5, "active"],
  ];
  for (const [name, nodeId, diff, status] of plan) {
    const q = await createQuestion(
      tenant,
      {
        pack_id: packId,
        level_id: levelId,
        type: "mcq",
        topic: name,
        points: 5,
        content: { question: `${name}?`, options: ["A", "B", "C", "D"], correct: 0, rationale: "A" },
      },
      admin,
    );
    qid[name] = q.id;
    await sup(async (c) => {
      await c.query(`UPDATE questions SET domain_id=$2, category_id=$3, status=$4, difficulty_est=$5 WHERE id=$1`, [
        q.id, domainId, cat1, status, diff,
      ]);
      await c.query(
        `INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by, type)
         SELECT gen_random_uuid(), id, 1, content, rubric, $2, type FROM questions WHERE id = $1`,
        [q.id, admin],
      );
      await c.query(`INSERT INTO question_taxonomy (question_id, node_id) VALUES ($1,$2)`, [q.id, nodeId]);
    });
  }
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

describe("Z-43 draw by taxonomy node", () => {
  it("a subject node draws the questions of all its descendants", async () => {
    expect(ids(await drawLive(S))).toEqual(want("q1", "q2", "q3", "q6"));
  });

  it("a unit node draws its own and its outcomes' questions", async () => {
    expect(ids(await drawLive(U))).toEqual(want("q1", "q2", "q3", "q6"));
  });

  it("an outcome node draws only its own questions; withdrawn (archived) is excluded", async () => {
    expect(ids(await drawLive(O1))).toEqual(want("q1", "q6"));
    expect(ids(await drawLive(O2))).toEqual(want("q2"));
  });

  it("honours the difficulty_est range", async () => {
    expect(ids(await drawLive(S, 1, 3))).toEqual(want("q1", "q2", "q3"));
    expect(ids(await drawLive(S, 4))).toEqual(want("q6"));
  });

  it("two frameworks do not mix", async () => {
    expect(ids(await drawLive(S2))).toEqual(want("q4"));
    expect(ids(await drawLive(S))).not.toContain(qid["q4"]);
  });

  it("another tenant draws nothing from this tenant's pool (RLS)", async () => {
    const rows = await withTenant(tenantB, (client) =>
      listActiveQuestionPoolForCriterion(client, packId, levelId, domainId, undefined, "mcq", { nodeId: S }),
    );
    expect(rows).toEqual([]);
  });

  it("write time: an empty node is a clear 400 BLUEPRINT_NODE_EMPTY", async () => {
    const e = await mk([{ node_id: OE, type: "mcq", count: 1 }]).catch((x) => x);
    expect(code(e)).toBe(AL_ERROR_CODES.BLUEPRINT_NODE_EMPTY);
    expect((e as ValidationError).status).toBe(400);
  });

  it("write time: node-only blueprints need a domain_id", async () => {
    const e = await mk([{ node_id: S, type: "mcq", count: 1 }], null).catch((x) => x);
    expect(code(e)).toBe(AL_ERROR_CODES.BLUEPRINT_DOMAIN_REQUIRED);
  });

  it("create, preview, publish and frozen draw all follow the node", async () => {
    const a = await mk([{ node_id: S, type: "mcq", count: 2, difficulty_max: 3 }]);
    const stored = (a.settings as unknown as { blueprint: { criteria: Array<Record<string, unknown>> } }).blueprint;
    expect(stored.criteria[0]).toEqual({ node_id: S, type: "mcq", count: 2, difficulty_max: 3 });
    expect(a.pack_id).toBe(packId);

    const live = await previewAssessment(tenant, a.id);
    expect(live.blueprint_criteria![0]!.available).toBe(3);

    await publishAssessment(tenant, a.id, admin);
    expect((await getAssessment(tenant, a.id)).status).toBe("published");
    const frozen = await previewAssessment(tenant, a.id);
    expect(frozen.frozen).toBe(true);
    expect(frozen.blueprint_criteria![0]!.available).toBe(3);

    const pool = await withTenant(tenant, (client) =>
      listFrozenPoolForCriterion(client, a.id, domainId, undefined, "mcq", { nodeId: S, difficultyMax: 3 }),
    );
    expect(ids(pool)).toEqual(want("q1", "q2", "q3"));
  });

  it("write time: difficulty_min greater than difficulty_max is rejected", async () => {
    const e = await mk([{ node_id: S, type: "mcq", count: 1, difficulty_min: 4, difficulty_max: 2 }]).catch((x) => x);
    expect(code(e)).toBe(AL_ERROR_CODES.BLUEPRINT_DIFFICULTY_INVALID);
  });

  it("write time: a range on a category-backed unit or category criterion is rejected, not dropped", async () => {
    const UC = randomUUID();
    await sup(async (c) => {
      await c.query(
        `INSERT INTO taxonomy_nodes (id, tenant_id, framework_id, parent_id, kind, code, label)
         VALUES ($1,NULL,$2,$3,'unit','uc','uc')`,
        [UC, fw1, S],
      );
      await c.query(`UPDATE categories SET node_id = $2 WHERE id = $1`, [cat1, UC]);
    });
    const e1 = await mk([{ node_id: UC, type: "mcq", count: 1, difficulty_min: 2 }]).catch((x) => x);
    expect(code(e1)).toBe(AL_ERROR_CODES.BLUEPRINT_DIFFICULTY_INVALID);
    const e2 = await mk([{ category_id: cat1, type: "mcq", count: 1, difficulty_max: 3 }]).catch((x) => x);
    expect(code(e2)).toBe(AL_ERROR_CODES.BLUEPRINT_DIFFICULTY_INVALID);
  });

  it("publish pre-flight rejects a node pool smaller than count", async () => {
    const a = await mk([{ node_id: O2, type: "mcq", count: 2 }]);
    const e = await publishAssessment(tenant, a.id, admin).catch((x) => x);
    expect(code(e)).toBe(AL_ERROR_CODES.POOL_TOO_SMALL_CRITERION);
  });
});
