/**
 * RW-41 — gradings.cli_version / gradings.stage_inputs round-trip through
 * insertGrading (postgres:16 testcontainer, all migrations applied).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { insertGrading, type InsertGradingInput } from "../repository.js";
import { handleAdminAccept } from "../handlers/admin-accept.js";

let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const admin = randomUUID();
let attemptId: string;
let questionId: string;
let assessmentId: string;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const base = (): InsertGradingInput => ({
  attempt_id: attemptId,
  question_id: questionId,
  grader: "ai",
  score_earned: 5,
  score_max: 10,
  status: "partial",
  anchor_hits: null,
  reasoning_band: 2,
  ai_justification: null,
  error_class: null,
  prompt_version_sha: `anchors:11111111;band:bbbbbbbb;escalate:-`,
  prompt_version_label: "v1",
  model: "m",
  escalation_chosen_stage: "2",
  graded_by: admin,
  override_of: null,
  override_reason: null,
});

const readBack = (id: string) =>
  sup((c) =>
    c
      .query(`SELECT cli_version, stage_inputs FROM gradings WHERE id=$1`, [id])
      .then((r) => r.rows[0] as { cli_version: string | null; stage_inputs: unknown }),
  );

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_prov" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_prov`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'prov','prov')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@x.test','A','admin','active')`, [admin, tenant]);
    const [pack, level, assessment, cand] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    assessmentId = assessment;
    attemptId = randomUUID();
    questionId = randomUUID();
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p','P','soc','published',$3)`, [pack, tenant, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [level, pack]);
    await c.query(`INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'T','active',1,$5)`, [assessment, tenant, pack, level, admin]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'c@x.test','C','candidate','active')`, [cand, tenant]);
    await c.query(`INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds) VALUES ($1,$2,$3,$4,'graded', now() - interval '2 hours', now() - interval '1 hour', 3600)`, [attemptId, tenant, assessment, cand]);
    await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,'subjective','t',10,'active','{"question":"q"}'::jsonb,1,$4)`, [questionId, pack, level, admin]);
  });
  await setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("gradings provenance columns (RW-41)", () => {
  it("stores cli_version and stage_inputs", async () => {
    const stage_inputs = { anchors: { a: 1 }, band: { b: 2 }, escalate: null };
    const row = await withTenant(tenant, (c) =>
      insertGrading(c, tenant, { ...base(), cli_version: "test-1.2.3", stage_inputs }),
    );
    expect(await readBack(row.id)).toEqual({ cli_version: "test-1.2.3", stage_inputs });
  });

  it("leaves both NULL when omitted", async () => {
    const row = await withTenant(tenant, (c) =>
      insertGrading(c, tenant, { ...base(), prompt_version_sha: "anchors:22222222;band:bbbbbbbb;escalate:-" }),
    );
    expect(await readBack(row.id)).toEqual({ cli_version: null, stage_inputs: null });
  });
});

describe("admin-accept takes provenance from the server cache, not the client (RW-41)", () => {
  async function acceptWith(cache: unknown[] | null, clientVersion: string): Promise<{ cli_version: string | null; stage_inputs: unknown }> {
    const id = randomUUID();
    const cand = randomUUID();
    await sup(async (c) => {
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`, [cand, tenant, `c-${cand.slice(0, 8)}@x.test`]);
      await c.query(`INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds, ai_proposals) VALUES ($1,$2,$3,$4,'submitted', now() - interval '30 minutes', now(), 3600, $5::jsonb)`, [id, tenant, assessmentId, cand, cache === null ? null : JSON.stringify(cache)]);
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,'{"question":"q"}'::jsonb,$2) ON CONFLICT DO NOTHING`, [questionId, admin]);
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,1,1)`, [id, questionId]);
      await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,'{"response":"x"}'::jsonb)`, [id, questionId]);
    });
    await handleAdminAccept({
      tenantId: tenant,
      userId: admin,
      attemptId: id,
      proposals: [
        {
          attempt_id: id,
          question_id: questionId,
          anchors: [],
          band: { reasoning_band: 2, ai_justification: "ok", error_class: null, needs_escalation: false },
          score_earned: 5,
          score_max: 10,
          prompt_version_sha: `anchors:${id.slice(0, 8)};band:bbbbbbbb;escalate:-`,
          prompt_version_label: "v1;v1;-",
          model: "m",
          escalation_chosen_stage: "2",
          generated_at: new Date().toISOString(),
          cli_version: clientVersion,
          stage_inputs: { anchors: "spoofed", band: null, escalate: null },
        },
      ],
    });
    return sup((c) =>
      c
        .query(`SELECT cli_version, stage_inputs FROM gradings WHERE attempt_id=$1`, [id])
        .then((r) => r.rows[0] as { cli_version: string | null; stage_inputs: unknown }),
    );
  }

  it("uses the cached cli_version/stage_inputs and ignores the client's", async () => {
    const real = { anchors: { r: 1 }, band: { r: 2 }, escalate: null };
    const row = await acceptWith([{ question_id: questionId, cli_version: "real-1.0", stage_inputs: real }], "spoofed");
    expect(row).toEqual({ cli_version: "real-1.0", stage_inputs: real });
  });

  it("writes NULL when the cache has no entry", async () => {
    expect(await acceptWith([], "spoofed")).toEqual({ cli_version: null, stage_inputs: null });
    expect(await acceptWith(null, "spoofed")).toEqual({ cli_version: null, stage_inputs: null });
  });
});
