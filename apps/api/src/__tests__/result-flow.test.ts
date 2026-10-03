/**
 * Phase I result flow, end to end across modules (testcontainers Postgres, real RLS):
 *
 *   candidate submit (06) -> MCQ finalize (09) -> [auto tenant] worker sweep release (apps/api + 09)
 *                                              -> [manual tenant] admin Release (07 + 09)
 *   -> candidate GET /result (06)  — and the email hook (13, mocked) after the release commit.
 *
 * Unit-level coverage of each piece lives in the module test suites; this file proves the
 * seams line up: the submit promise matches what the sweep then does, a manual tenant is
 * never auto-released, and the candidate sees only the complete result after release (P1).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const emailMock = vi.fn();
vi.mock("@assessiq/notifications", () => ({ emitAttemptEventAfterCommit: vi.fn(async () => undefined), handleAuditFanout: vi.fn(async () => undefined),
  sendResultReleasedEmail: (...a: unknown[]) => emailMock(...a),
  processEmailSendJob: vi.fn(),
  processWebhookDeliverJob: vi.fn(),
  webhookBackoffStrategy: vi.fn(),
}));

import { AppError } from "@assessiq/core";
import { setPoolForTesting, closePool, updateResultReleaseMode } from "@assessiq/tenancy";
import { CERT_SIGNING_SECRET_ENV } from "@assessiq/certification";
import { registerAttemptCandidateRoutes } from "@assessiq/attempt-engine";
import { handleAdminReleaseAttempt } from "@assessiq/ai-grading";
import { processAutoReleaseTick, resetAutoReleaseCooldownForTesting } from "../jobs/auto-release.js";

const toFsPath = (url: URL): string => url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MODULES_ROOT = join(toFsPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "modules");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["14-audit-log", undefined],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined],
  ["12-embed-sdk", ["0073_attempt_embed_origin.sql"]],
  ["07-ai-grading", ["0040_gradings.sql", "0041_tenant_grading_budgets.sql", "0100_attempts_ai_proposals_cache.sql"]],
  ["09-scoring", undefined],
  ["18-certification", undefined],
  ["19-billing", undefined],
  ["20-data-rights", ["0102_users_erased_at.sql"]],
];

let container: StartedTestContainer;
let url: string;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  process.env[CERT_SIGNING_SECRET_ENV] = "result-flow-test-secret";
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_flow" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_flow`;

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
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  });
  await setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(() => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  resetAutoReleaseCooldownForTesting();
});

interface Tenant {
  id: string;
  admin: string;
}

async function seedTenant(mode: "manual" | "auto"): Promise<Tenant> {
  const id = randomUUID();
  const admin = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)`, [id, `t-${id.slice(0, 8)}`, mode === "auto" ? "Auto University" : "Manual College"]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [admin, id, `a-${id.slice(0, 6)}@flow.test`]);
  });
  const t = { id, admin };
  if (mode === "auto") await updateResultReleaseMode(admin, id, "auto"); // the real switch
  return t;
}

/** An in_progress attempt: `mcq` MCQ questions (the candidate picked the right answer for `correct` of them) + optional KQL. */
async function startedAttempt(t: Tenant, o: { mcq: number; correct: number; kql?: boolean }): Promise<{ attemptId: string; userId: string; email: string }> {
  const pack = randomUUID();
  const level = randomUUID();
  const assessment = randomUUID();
  const userId = randomUUID();
  const attemptId = randomUUID();
  const email = `riya.sharma-${randomUUID().slice(0, 6)}@gmail.com`;
  await sup(async (c) => {
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`, [pack, t.id, `p-${pack.slice(0, 8)}`, t.admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [level, pack]);
    await c.query(`INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'SOC Analyst L1','active',$5,$6)`, [assessment, t.id, pack, level, o.mcq + (o.kql === true ? 1 : 0), t.admin]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Riya Sharma','candidate','active')`, [userId, t.id, email]);
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, duration_seconds) VALUES ($1,$2,$3,$4,'in_progress', now() - interval '20 minutes', now() + interval '40 minutes', 3600)`,
      [attemptId, t.id, assessment, userId],
    );
    const types = [...Array.from({ length: o.mcq }, () => "mcq" as const), ...(o.kql === true ? (["kql"] as const) : [])];
    let pos = 1;
    for (const type of types) {
      const qid = randomUUID();
      const content = JSON.stringify(type === "mcq" ? { question: "q", options: ["a", "b", "c", "d"], correct: 1, rationale: "r" } : { question: "q" });
      await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'t',10,'active',$5::jsonb,1,$6)`, [qid, pack, level, type, content, t.admin]);
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, t.admin]);
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,$3,1)`, [attemptId, qid, pos]);
      if (type === "mcq") {
        await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [attemptId, qid, JSON.stringify({ selected: pos <= o.correct ? 1 : 0 })]);
      }
      pos++;
    }
  });
  return { attemptId, userId, email };
}

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.toJson() });
    return reply.code(500).send({ error: { code: "INTERNAL", message: String(err) } });
  });
  const candidateOnly = async (req: { headers: Record<string, string | string[] | undefined>; session?: unknown }) => {
    req.session = { tenantId: String(req.headers["x-tenant"]), userId: String(req.headers["x-user"]) };
  };
  await registerAttemptCandidateRoutes(app, { candidateOnly: [candidateOnly as never] });
  return app;
}

const h = (t: Tenant, userId: string) => ({ "x-tenant": t.id, "x-user": userId });
const status = (id: string) => sup((c) => c.query(`SELECT status FROM attempts WHERE id=$1`, [id]).then((r) => r.rows[0].status as string));

describe("auto tenant, MCQ-only: submit -> sweep -> result on screen", () => {
  it("promises 'soon', is released by the sweep within a tick, and the candidate then sees the complete result", async () => {
    const app = await buildApp();
    const t = await seedTenant("auto");
    const a = await startedAttempt(t, { mcq: 4, correct: 3 }); // 30 / 40 = 75% -> passed (60)

    const submit = await app.inject({ method: "POST", url: `/api/me/attempts/${a.attemptId}/submit`, headers: h(t, a.userId) });
    expect(submit.statusCode).toBe(202);
    expect(submit.json()).toMatchObject({ result_expectation: "soon", release_mode: "auto", estimated_grading_seconds: 60 });
    expect(await status(a.attemptId)).toBe("graded"); // complete at submit (deterministic)

    // P1: before release the candidate only gets the pending promise — no number
    const early = await app.inject({ method: "GET", url: `/api/me/attempts/${a.attemptId}/result`, headers: h(t, a.userId) });
    expect(early.statusCode).toBe(202);
    expect(early.json()).toMatchObject({ status: "pending", release_mode: "auto" });
    expect(early.body).not.toMatch(/total_earned|percent|passed/);
    expect(emailMock).not.toHaveBeenCalled();

    // one worker tick publishes it and emails after the commit
    const tick = await processAutoReleaseTick();
    expect(tick.released).toBeGreaterThanOrEqual(1);
    expect(await status(a.attemptId)).toBe("released");
    expect(emailMock).toHaveBeenCalledWith({ tenantId: t.id, attemptId: a.attemptId });

    const done = await app.inject({ method: "GET", url: `/api/me/attempts/${a.attemptId}/result`, headers: h(t, a.userId) });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({
      status: "released",
      total_earned: 30,
      total_max: 40,
      percent: 75,
      passed: true,
      assessment_name: "SOC Analyst L1",
      certificate: { credential_id: expect.stringMatching(/^AIQ-/) },
    });

    // and it is listed in the portal
    const list = await app.inject({ method: "GET", url: "/api/me/results", headers: h(t, a.userId) });
    expect(list.json().items.map((i: { attempt_id: string }) => i.attempt_id)).toEqual([a.attemptId]);
    await app.close();
  });

  it("an attempt with KQL is promised by email, stays 'pending_admin_grading'-side (never auto-released) until scored", async () => {
    const app = await buildApp();
    const t = await seedTenant("auto");
    const a = await startedAttempt(t, { mcq: 2, correct: 2, kql: true });
    const submit = await app.inject({ method: "POST", url: `/api/me/attempts/${a.attemptId}/submit`, headers: h(t, a.userId) });
    expect(submit.json()).toMatchObject({ result_expectation: "email", release_mode: "auto", estimated_grading_seconds: null });
    expect(await status(a.attemptId)).toBe("submitted"); // KQL ungraded -> not complete

    await processAutoReleaseTick();
    expect(await status(a.attemptId)).toBe("submitted");
    expect((await app.inject({ method: "GET", url: `/api/me/attempts/${a.attemptId}/result`, headers: h(t, a.userId) })).statusCode).toBe(202);
    await app.close();
  });
});

describe("manual tenant: nothing is published until the admin releases", () => {
  it("the sweep never touches it; admin Release publishes it; then the candidate sees the result", async () => {
    const app = await buildApp();
    const t = await seedTenant("manual");
    const a = await startedAttempt(t, { mcq: 2, correct: 1 }); // 10 / 20 = 50% -> not passed

    const submit = await app.inject({ method: "POST", url: `/api/me/attempts/${a.attemptId}/submit`, headers: h(t, a.userId) });
    expect(submit.json()).toMatchObject({ result_expectation: "email", release_mode: "manual", estimated_grading_seconds: null });
    expect(await status(a.attemptId)).toBe("graded");

    await processAutoReleaseTick();
    expect(await status(a.attemptId)).toBe("graded"); // the sweep ignores manual tenants
    expect((await app.inject({ method: "GET", url: `/api/me/attempts/${a.attemptId}/result`, headers: h(t, a.userId) })).json()).toMatchObject({
      status: "pending",
      release_mode: "manual",
      tenant_name: "Manual College",
    });

    const rel = await handleAdminReleaseAttempt({ tenantId: t.id, userId: t.admin, attemptId: a.attemptId });
    expect(rel.attempt.status).toBe("released");
    expect(emailMock).toHaveBeenCalledWith({ tenantId: t.id, attemptId: a.attemptId });

    const done = await app.inject({ method: "GET", url: `/api/me/attempts/${a.attemptId}/result`, headers: h(t, a.userId) });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "released", total_earned: 10, total_max: 20, percent: 50, passed: false, certificate: null });
    await app.close();
  });

  it("switching a manual tenant to auto does NOT release the result that was already waiting", async () => {
    const t = await seedTenant("manual");
    const a = await startedAttempt(t, { mcq: 1, correct: 1 });
    const app = await buildApp();
    await app.inject({ method: "POST", url: `/api/me/attempts/${a.attemptId}/submit`, headers: h(t, a.userId) });
    expect(await status(a.attemptId)).toBe("graded");

    await sup((c) => c.query(`SELECT pg_sleep(0.05)`));
    await updateResultReleaseMode(t.admin, t.id, "auto");
    await processAutoReleaseTick();
    expect(await status(a.attemptId)).toBe("graded");
    await app.close();
  });
});
