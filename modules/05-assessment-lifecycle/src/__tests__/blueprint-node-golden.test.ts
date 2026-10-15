/**
 * RW-55 part B golden test: a blueprint written with node_id criteria must be
 * indistinguishable (after resolution) from the equivalent category_id blueprint:
 * same stored blueprint, same count / preview, same live draw pool, same frozen pool.
 * Also covers the 400s: unknown node, non-unit node, node/category mismatch.
 *
 * Testcontainers (postgres:16-alpine), full RLS stack. Pattern mirrors lifecycle.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
const admin = randomUUID();
const domainId = randomUUID();
const cat1 = randomUUID();
const cat2 = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** 0169 is re-runnable; run it again so the seeded domain/categories get node_id. */
async function rerun0169(): Promise<void> {
  // jsdom environment: the global URL is not Node's, so resolve via node:path.
  const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../../04-question-bank/migrations/0169_curriculum_frameworks.sql");
  const sql = await readFile(file, "utf8");
  await sup((c) => c.query(sql).then(() => undefined));
}

const opens = () => new Date(Date.now() + 60_000);
const CRITERIA = [
  { cat: () => cat1, type: "mcq" as const, count: 2 },
  { cat: () => cat1, type: "subjective" as const, count: 1 },
  { cat: () => cat2, type: "mcq" as const, count: 2 },
];

let nodeOf: Record<string, string>;
let X: Awaited<ReturnType<typeof createAssessment>>;
let Y: Awaited<ReturnType<typeof createAssessment>>;

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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'bp-node', 'BP Node')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@example.com','Admin','admin','active')`,
      [admin, tenant],
    );
    await c.query(
      `INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1,'internal',NULL) ON CONFLICT DO NOTHING`,
      [tenant],
    );
    await c.query(`INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1,$2,'dom','Dom')`, [domainId, tenant]);
    await c.query(
      `INSERT INTO categories (id, tenant_id, domain_id, slug, name) VALUES ($1,$2,$3,'c1','C1'),($4,$2,$3,'c2','C2')`,
      [cat1, tenant, domainId, cat2],
    );
  });
  await setPoolForTesting(url);

  // X: category_id criteria. Its resolver auto-creates the (pack, level) for the domain.
  X = await createAssessment(
    tenant,
    {
      name: "X",
      pack_id: randomUUID(),
      level_id: randomUUID(),
      question_count: 1,
      opens_at: opens(),
      settings: {
        blueprint: {
          domain_id: domainId,
          level: "L1",
          criteria: CRITERIA.map((c) => ({ category_id: c.cat(), type: c.type, count: c.count })),
        },
      },
    },
    admin,
  );

  // 7 questions in that pack/level: cat1 = 3 mcq + 2 subjective, cat2 = 2 mcq.
  const plan: Array<[string, string]> = [
    [cat1, "mcq"], [cat1, "mcq"], [cat1, "mcq"], [cat1, "subjective"], [cat1, "subjective"],
    [cat2, "mcq"], [cat2, "mcq"],
  ];
  for (const [i, [cat, type]] of plan.entries()) {
    const q = await createQuestion(
      tenant,
      {
        pack_id: X.pack_id,
        level_id: X.level_id,
        type: "mcq",
        topic: `t${i}`,
        points: 5,
        content: { question: `Q${i}?`, options: ["A", "B", "C", "D"], correct: 0, rationale: "A" },
      },
      admin,
    );
    await sup(async (c) => {
      await c.query(`UPDATE questions SET type=$2, domain_id=$3, category_id=$4, status='active' WHERE id=$1`, [
        q.id, type, domainId, cat,
      ]);
      // question_versions are written by publishPack in production; snapshot v1 directly here.
      await c.query(
        `INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by, type)
         SELECT gen_random_uuid(), id, 1, content, rubric, $2, type FROM questions WHERE id = $1`,
        [q.id, admin],
      );
    });
  }

  await rerun0169();
  nodeOf = await sup(async (c) => {
    const r = await c.query<{ id: string; node_id: string }>(
      `SELECT id, node_id FROM categories WHERE tenant_id=$1`,
      [tenant],
    );
    return Object.fromEntries(r.rows.map((x) => [x.id, x.node_id]));
  });

  // Y: node_id criteria only, no blueprint domain_id.
  Y = await createAssessment(
    tenant,
    {
      name: "Y",
      pack_id: randomUUID(),
      level_id: randomUUID(),
      question_count: 1,
      opens_at: opens(),
      settings: {
        blueprint: {
          level: "L1",
          criteria: CRITERIA.map((c) => ({ node_id: nodeOf[c.cat()]!, type: c.type, count: c.count })),
        },
      },
    },
    admin,
  );
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

type CriterionType = Parameters<typeof listActiveQuestionPoolForCriterion>[5];
type BpCriterion = { node_id?: string; category_id: string; type: CriterionType; [k: string]: unknown };
type Bp = { domain_id: string; criteria: BpCriterion[]; [k: string]: unknown };
const bpOf = (a: typeof X): Bp => (a.settings as unknown as { blueprint: Bp }).blueprint;

describe("RW-55 blueprint node_id golden", () => {
  it("node blueprint stores the same resolved blueprint (only node_id differs)", () => {
    expect(nodeOf[cat1]).toBeTruthy();
    const bx = bpOf(X);
    const by = bpOf(Y);
    expect(by.criteria.every((c) => typeof c.node_id === "string")).toBe(true);
    const strip = (b: Bp) => ({
      ...b,
      criteria: b.criteria.map(({ node_id: _n, ...rest }) => rest),
    });
    expect(strip(by)).toEqual(strip(bx));
    expect(Y.pack_id).toBe(X.pack_id);
    expect(Y.level_id).toBe(X.level_id);
    expect(Y.question_count).toBe(X.question_count);
  });

  it("preview per criterion is equal", async () => {
    const px = await previewAssessment(tenant, X.id);
    const py = await previewAssessment(tenant, Y.id);
    expect(py.blueprint_criteria).toEqual(px.blueprint_criteria);
    expect(px.blueprint_criteria!.length).toBe(3);
  });

  it("live draw pool is equal for every criterion", async () => {
    await withTenant(tenant, async (client) => {
      for (const c of CRITERIA) {
        const a = await listActiveQuestionPoolForCriterion(client, X.pack_id, X.level_id, domainId, c.cat(), c.type);
        const bBp = bpOf(Y);
        const crit = bBp.criteria[CRITERIA.indexOf(c)]!;
        const b = await listActiveQuestionPoolForCriterion(client, Y.pack_id, Y.level_id, bBp.domain_id, crit.category_id, crit.type);
        expect(b).toEqual(a);
        expect(a.length, `${c.type}`).toBeGreaterThan(0);
      }
    });
  });

  it("frozen draw pool is equal after publish of both", async () => {
    await publishAssessment(tenant, X.id, admin);
    await publishAssessment(tenant, Y.id, admin);
    await withTenant(tenant, async (client) => {
      const bBp = bpOf(Y);
      for (const [i, c] of CRITERIA.entries()) {
        const a = await listFrozenPoolForCriterion(client, X.id, domainId, c.cat(), c.type);
        const b = await listFrozenPoolForCriterion(client, Y.id, bBp.domain_id, bBp.criteria[i]!.category_id, c.type);
        expect(b).toEqual(a);
        expect(a.length, `${c.type}`).toBeGreaterThan(0);
      }
    });
    expect((await getAssessment(tenant, Y.id)).status).toBe("published");
  });

  const mk = (criteria: unknown[]) =>
    createAssessment(
      tenant,
      {
        name: "bad",
        pack_id: randomUUID(),
        level_id: randomUUID(),
        question_count: 1,
        opens_at: opens(),
        settings: { blueprint: { level: "L1", criteria } },
      } as unknown as Parameters<typeof createAssessment>[1],
      admin,
    );

  it("unknown node -> 400 BLUEPRINT_NODE_UNRESOLVED", async () => {
    const e = await mk([{ node_id: randomUUID(), type: "mcq", count: 1 }]).catch((x) => x);
    expect(code(e)).toBe(AL_ERROR_CODES.BLUEPRINT_NODE_UNRESOLVED);
    expect((e as ValidationError).status).toBe(400);
  });

  it("outcome-kind node -> 400 BLUEPRINT_NODE_KIND_UNSUPPORTED", async () => {
    const outcomeId = await sup(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label)
         SELECT NULL, framework_id, id, 'outcome', 'o1', 'Outcome 1' FROM taxonomy_nodes WHERE id = $1
         RETURNING id`,
        [nodeOf[cat1]],
      );
      return r.rows[0]!.id;
    });
    const e = await mk([{ node_id: outcomeId, type: "mcq", count: 1 }]).catch((x) => x);
    expect(code(e)).toBe(AL_ERROR_CODES.BLUEPRINT_NODE_KIND_UNSUPPORTED);
  });

  it("node/category mismatch -> 400 BLUEPRINT_NODE_MISMATCH", async () => {
    const e = await mk([{ node_id: nodeOf[cat1], category_id: cat2, type: "mcq", count: 1 }]).catch((x) => x);
    expect(code(e)).toBe(AL_ERROR_CODES.BLUEPRINT_NODE_MISMATCH);
  });

  it("criterion with neither category_id nor node_id is rejected by the schema", async () => {
    const e = await mk([{ type: "mcq", count: 1 }]).catch((x) => x);
    expect(code(e)).toBe(AL_ERROR_CODES.BLUEPRINT_INVALID);
  });
});
