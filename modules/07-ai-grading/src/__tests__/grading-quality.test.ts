/**
 * E2 Part 2 — grading_override_quality view + GET /api/admin/super/grading-quality.
 * postgres:16 testcontainer with real RLS. No AI, nothing mocked but the runtime import.
 *
 *   - the view pairs each admin override with the AI row it replaced (and nothing else)
 *   - a tenant connection sees only its own pairs (security_invoker -> gradings RLS)
 *   - the endpoint aggregates per original prompt sha across tenants, within the window
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("../runtime-selector.js", () => ({ gradeSubjective: vi.fn() }));

import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { registerSuperEvaluationRoutes } from "../routes-super.js";

const toFsPath = (url: URL): string => url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MODULES_ROOT = join(toFsPath(new URL(".", import.meta.url)), "..", "..", "..");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["14-audit-log", undefined],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined],
  ["12-embed-sdk", ["0073_attempt_embed_origin.sql"]],
  [
    "07-ai-grading",
    ["0040_gradings.sql", "0041_tenant_grading_budgets.sql", "0100_attempts_ai_proposals_cache.sql", "0140_grading_override_quality.sql"],
  ],
  ["09-scoring", undefined],
  ["19-billing", undefined],
  ["20-data-rights", ["0102_users_erased_at.sql"]],
];

let container: StartedTestContainer;
let url: string;
let A: string;
let B: string;
const admin: Record<string, string> = {};

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** One (attempt, question) pair in `tenant`; returns the ids needed for gradings rows. */
async function pair(c: Client, tenant: string): Promise<{ attemptId: string; questionId: string }> {
  const [pack, level, assessment, cand, attemptId, questionId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const by = admin[tenant]!;
  await c.query(
    `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`,
    [pack, tenant, `p-${pack.slice(0, 8)}`, by],
  );
  await c.query(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`,
    [level, pack],
  );
  await c.query(
    `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'T','active',1,$5)`,
    [assessment, tenant, pack, level, by],
  );
  await c.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`,
    [cand, tenant, `c-${cand.slice(0, 8)}@x.test`],
  );
  await c.query(
    `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds)
     VALUES ($1,$2,$3,$4,'graded', now() - interval '2 hours', now() - interval '1 hour', 3600)`,
    [attemptId, tenant, assessment, cand],
  );
  await c.query(
    `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,'subjective','t',10,'active','{"question":"q"}'::jsonb,1,$4)`,
    [questionId, pack, level, by],
  );
  return { attemptId, questionId };
}

/** AI grade (+ optional admin override of it). Returns [aiId, overrideId|null]. */
async function grade(
  tenant: string,
  sha: string,
  ai: { band: number; score: number },
  ov?: { band: number; score: number },
  ageDays = 0,
): Promise<[string, string | null]> {
  return sup(async (c) => {
    const { attemptId, questionId } = await pair(c, tenant);
    const aiRow = await c.query<{ id: string }>(
      `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, reasoning_band,
                             prompt_version_sha, prompt_version_label, model, graded_at)
       VALUES ($1,$2,$3,'ai',$4,10,'partial',$5,$6,'v1','m', now() - $7::int * interval '1 day') RETURNING id`,
      [tenant, attemptId, questionId, ai.score, ai.band, sha, ageDays],
    );
    const aiId = aiRow.rows[0]!.id;
    if (ov === undefined) return [aiId, null];
    const ovRow = await c.query<{ id: string }>(
      `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, reasoning_band,
                             prompt_version_sha, prompt_version_label, model, escalation_chosen_stage, graded_by, override_of, override_reason, graded_at)
       VALUES ($1,$2,$3,'admin_override',$4,10,'partial',$5,$6,'v1','m','manual',$7,$8,'because', now() - $9::int * interval '1 day') RETURNING id`,
      [tenant, attemptId, questionId, ov.score, ov.band, sha, admin[tenant], aiId, ageDays],
    );
    return [aiId, ovRow.rows[0]!.id];
  });
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_quality" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_quality`;

  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    for (const r of ["assessiq_app", "assessiq_system"]) {
      const bypass = r === "assessiq_system" ? " BYPASSRLS" : "";
      await c.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN CREATE ROLE ${r}${bypass}; END IF; END $$;`,
      );
      await c.query(`GRANT ${r} TO test`);
    }
    for (const [mod, only] of DIRS) {
      const dir = join(MODULES_ROOT, mod, "migrations");
      const files = (await readdir(dir))
        .filter((f) => f.endsWith(".sql") && (only === undefined || only.includes(f)))
        .sort();
      for (const f of files) await c.query(await readFile(join(dir, f), "utf-8"));
    }
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
  });
  await setPoolForTesting(url);

  [A, B] = [randomUUID(), randomUUID()];
  await sup(async (c) => {
    for (const [id, slug] of [[A, "t-a"], [B, "t-b"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)`, [id, slug, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
      admin[id] = randomUUID();
      await c.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`,
        [admin[id], id, `admin-${slug}@x.test`],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("grading_override_quality + /api/admin/super/grading-quality", () => {
  const S1 = "anchors:11111111;band:bbbbbbbb;escalate:-";
  const S2 = "anchors:22222222;band:bbbbbbbb;escalate:-";
  let a1Override: string | null;

  beforeAll(async () => {
    // S1: 4 in-window AI grades (A x2, B x2), 2 overrides; plus one 200-day-old pair (outside 90 d).
    [, a1Override] = await grade(A, S1, { band: 3, score: 8 }, { band: 1, score: 4 }); // band d=2, score d=40%
    await grade(A, S1, { band: 2, score: 5 });
    await grade(B, S1, { band: 2, score: 5 }, { band: 3, score: 7 }); // band d=1, score d=20%
    await grade(B, S1, { band: 4, score: 10 });
    await grade(A, S1, { band: 0, score: 0 }, { band: 4, score: 10 }, 200);
    // S2: one AI grade, never overridden.
    await grade(B, S2, { band: 3, score: 8 });
  });

  it("view: pairs override rows with their AI row; a plain AI row never appears", async () => {
    const rows = await sup((c) =>
      c.query(`SELECT * FROM grading_override_quality WHERE tenant_id = $1 ORDER BY override_created_at`, [A]).then((r) => r.rows),
    );
    expect(rows).toHaveLength(2); // in-window + the 200-day-old one
    const r = rows.find((x) => x.override_grading_id === a1Override)!;
    expect(r).toMatchObject({
      original_prompt_version_sha: S1,
      original_model: "m",
      original_reasoning_band: 3,
      override_reasoning_band: 1,
      override_reason: "because",
    });
    expect(Number(r.original_score_earned)).toBe(8);
    expect(Number(r.override_score_earned)).toBe(4);
    expect(Number(r.score_max)).toBe(10);
  });

  it("view: a tenant connection sees only its own pairs (RLS via security_invoker)", async () => {
    const seen = await withTenant(A, (client) =>
      client.query<{ tenant_id: string }>(`SELECT tenant_id FROM grading_override_quality`).then((r) => r.rows),
    );
    expect(seen.length).toBe(2);
    expect(new Set(seen.map((x) => x.tenant_id))).toEqual(new Set([A]));
    const seenB = await withTenant(B, (client) =>
      client.query<{ tenant_id: string }>(`SELECT tenant_id FROM grading_override_quality`).then((r) => r.rows),
    );
    expect(new Set(seenB.map((x) => x.tenant_id))).toEqual(new Set([B]));
  });

  it("endpoint: aggregates per original sha across tenants within the window", async () => {
    const app = Fastify();
    await registerSuperEvaluationRoutes(app, { superAdminOnly: async () => undefined, superAdminFreshMfa: async () => undefined });
    const res = await app.inject({ method: "GET", url: "/api/admin/super/grading-quality?days=90" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: number; items: Array<Record<string, unknown>> };
    expect(body.days).toBe(90);
    const s1 = body.items.find((i) => i.prompt_version_sha === S1)!;
    expect(s1).toMatchObject({ ai_grades: 4, overrides: 2, override_rate: 0.5, mean_abs_band_delta: 1.5, mean_abs_score_delta_pct: 30 });
    const s2 = body.items.find((i) => i.prompt_version_sha === S2)!;
    expect(s2).toMatchObject({ ai_grades: 1, overrides: 0, override_rate: 0, mean_abs_band_delta: null, mean_abs_score_delta_pct: null });

    // A wider window pulls in the 200-day-old pair.
    const wide = (await app.inject({ method: "GET", url: "/api/admin/super/grading-quality?days=365" })).json() as typeof body;
    expect(wide.items.find((i) => i.prompt_version_sha === S1)).toMatchObject({ ai_grades: 5, overrides: 3 });

    // Bad query -> 400.
    expect((await app.inject({ method: "GET", url: "/api/admin/super/grading-quality?days=0" })).statusCode).toBe(400);
    await app.close();
  });
});
