/**
 * Optional time limit per assessment (assessments.duration_minutes).
 * Effective time = the assessment's limit, else the level time. Real services on a real schema;
 * only the session mint and the rate limit of /take/start are stubbed (as in attempt-engine.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";

const routeCtx = vi.hoisted(() => ({ session: null as { userId: string; tenantId: string } | null }));
vi.mock("@assessiq/auth", async (orig) => ({
  ...(await orig<typeof import("@assessiq/auth")>()),
  mintCandidateSession: vi.fn(async () => ({ id: "sess-1", token: "sess-token" })),
  consumeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 60 })),
}));

import { startAttempt as rawStartAttempt, recordTakeConsent } from "../service.js";
import { registerAttemptTakeRoutes } from "../routes.take.js";
import { registerAttemptCandidateRoutes } from "../routes.candidate.js";
import { createPack, addLevel, createQuestion, publishPack } from "../../../04-question-bank/src/service.js";
import {
  createAssessment,
  publishAssessment,
  inviteUsers,
  updateAssessmentDuration,
  resolveInvitationToken,
} from "../../../05-assessment-lifecycle/src/service.js";
import { hashInvitationToken } from "../../../05-assessment-lifecycle/src/tokens.js";
import { ValidationError } from "@assessiq/core";

const THIS_DIR = dirname(fileURLToPath(import.meta.url)) + sep;
const MODULES_ROOT = join(THIS_DIR, "..", "..", "..");

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let adminA: string;

async function sup<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function applyDir(client: Client, dir: string, only?: string[]): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of only !== undefined ? files.filter((x) => only.includes(x)) : files) {
    await client.query(await readFile(join(dir, f), "utf8"));
  }
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "assessiq", POSTGRES_PASSWORD: "assessiq_test_pw", POSTGRES_DB: "assessiq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerUrl = `postgres://assessiq:assessiq_test_pw@${container.getHost()}:${container.getMappedPort(5432)}/assessiq`;

  await sup(async (c) => {
    await applyDir(c, join(MODULES_ROOT, "02-tenancy", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "03-users", "migrations"), ["020_users.sql"]);
    await applyDir(c, join(MODULES_ROOT, "04-question-bank", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "05-assessment-lifecycle", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "06-attempt-engine", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "12-embed-sdk", "migrations"), ["0073_attempt_embed_origin.sql"]);
    await applyDir(c, join(MODULES_ROOT, "14-audit-log", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "13-notifications", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "19-billing", "migrations"), [
      "0078_tenant_plans.sql",
      "0079_billing_events.sql",
      "0081_tenant_entitlements.sql",
    ]);
    await applyDir(c, join(MODULES_ROOT, "07-ai-grading", "migrations"), [
      "0040_gradings.sql",
      "0100_attempts_ai_proposals_cache.sql",
    ]);
    await applyDir(c, join(MODULES_ROOT, "09-scoring", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "18-certification", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "20-data-rights", "migrations"), [
      "0101_consent_events.sql",
      "0102_users_erased_at.sql",
    ]);
  });
  setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  adminA = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'ta', 'Tenant ta')`, [tenantA]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenantA]);
    await c.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, 'internal', NULL)`, [tenantA]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, 'a@t.local', 'Admin', 'admin', 'active')`, [adminA, tenantA]);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

async function start(userId: string, assessmentId: string) {
  await recordTakeConsent(tenantA, { userId, ip: null, userAgent: null });
  return rawStartAttempt(tenantA, { userId, assessmentId });
}

const LEVEL_MINUTES = 30;

/** An active assessment (level time 30) with N invited candidates, each with a known token. */
async function setup(opts: { durationMinutes?: number | null; mode?: "real" | "mock"; candidates?: number } = {}) {
  const pack = await createPack(tenantA, { slug: `p-${randomUUID().slice(0, 8)}`, name: "P", domain: "soc" }, adminA);
  const level = await addLevel(tenantA, pack.id, { position: 1, label: "L1", duration_minutes: LEVEL_MINUTES, default_question_count: 2 }, adminA);
  for (let i = 0; i < 2; i++) {
    await createQuestion(
      tenantA,
      { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `t${i}`, points: 5, content: { question: `Q${i}?`, options: ["A", "B", "C", "D"], correct: 0, rationale: "A" } },
      adminA,
    );
  }
  await publishPack(tenantA, pack.id, adminA);
  await sup((c) => c.query(`UPDATE questions SET status = 'active', review_state = 'verified' WHERE pack_id = $1`, [pack.id]));
  const assessment = await createAssessment(
    tenantA,
    {
      pack_id: pack.id,
      level_id: level.id,
      name: "Time limit test",
      question_count: 2,
      opens_at: new Date(Date.now() + 60_000),
      ...(opts.durationMinutes !== undefined ? { duration_minutes: opts.durationMinutes } : {}),
      ...(opts.mode !== undefined ? { delivery_mode: opts.mode } : {}),
    },
    adminA,
  );
  await publishAssessment(tenantA, assessment.id, adminA);
  await sup((c) => c.query(`UPDATE assessments SET status = 'active', opens_at = now() - interval '1 minute' WHERE id = $1`, [assessment.id]));
  const people: { id: string; token: string }[] = [];
  for (let i = 0; i < (opts.candidates ?? 1); i++) {
    const id = randomUUID();
    await sup((c) =>
      c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Cand', 'candidate', 'active')`, [id, tenantA, `c-${id}@x.com`]),
    );
    await inviteUsers(tenantA, assessment.id, [id], adminA);
    const token = `tok_${randomUUID().replace(/-/g, "")}`;
    await sup((c) =>
      c.query(`UPDATE assessment_invitations SET token_hash = $3 WHERE assessment_id = $1 AND user_id = $2`, [assessment.id, id, hashInvitationToken(token)]),
    );
    people.push({ id, token });
  }
  return { assessmentId: assessment.id, people };
}

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { status?: number; toJson?: () => unknown };
    if (typeof e.toJson === "function") return reply.code(e.status ?? 500).send({ error: e.toJson() });
    return reply.code(500).send({ error: { code: "INTERNAL" } });
  });
  await registerAttemptTakeRoutes(app, { publicChain: [] });
  await registerAttemptCandidateRoutes(app, {
    candidateOnly: async (req) => {
      (req as unknown as { session: unknown }).session = routeCtx.session;
    },
  });
  return app;
}

/** The time three readers show: invitation preview, /take/start preview, and the invited list. */
async function shownMinutes(person: { id: string; token: string }) {
  const resolved = await resolveInvitationToken(person.token);
  routeCtx.session = { userId: person.id, tenantId: tenantA };
  const app = await buildApp();
  const take = await app.inject({ method: "POST", url: "/take/start", payload: { token: person.token, preview: true } });
  const list = await app.inject({ method: "GET", url: "/api/me/assessments" });
  return {
    resolved: resolved!.level.effective_duration_minutes,
    resolvedLevel: resolved!.level.duration_minutes,
    take: take.json().assessment.duration_seconds / 60,
    list: list.json().items[0].duration_seconds / 60,
  };
}

describe("assessment time limit", () => {
  it("20 minutes: the preview, take-start and invited list all show 20; the level time stays 30", async () => {
    const { people } = await setup({ durationMinutes: 20 });
    expect(await shownMinutes(people[0]!)).toEqual({ resolved: 20, resolvedLevel: 30, take: 20, list: 20 });
  });

  it("no limit (null): the level time shows everywhere", async () => {
    const { people } = await setup({ durationMinutes: null });
    expect(await shownMinutes(people[0]!)).toEqual({ resolved: 30, resolvedLevel: 30, take: 30, list: 30 });
  });

  it("0, 601 and 1.5 are refused on create and on edit; 1 and 600 are accepted", async () => {
    for (const bad of [0, 601, 1.5]) {
      await expect(setup({ durationMinutes: bad })).rejects.toBeInstanceOf(ValidationError);
    }
    const { assessmentId } = await setup({ durationMinutes: 600 });
    for (const bad of [0, 601, -5]) {
      await expect(updateAssessmentDuration(tenantA, assessmentId, bad, adminA)).rejects.toMatchObject({
        details: { code: "INVALID_PARAM", param: "duration_minutes" },
      });
    }
    expect((await updateAssessmentDuration(tenantA, assessmentId, 1, adminA)).duration_minutes).toBe(1);
    expect((await updateAssessmentDuration(tenantA, assessmentId, null, adminA)).duration_minutes).toBeNull();
  });

  it("a sectioned test or a whole-test timer refuses a time limit (its time comes from the section minutes)", async () => {
    const { assessmentId } = await setup();
    await sup((c) => c.query(`UPDATE assessments SET settings = jsonb_build_object('whole_test_minutes', 40) WHERE id = $1`, [assessmentId]));
    await expect(updateAssessmentDuration(tenantA, assessmentId, 20, adminA)).rejects.toMatchObject({
      details: { code: "TIME_LIMIT_NOT_ALLOWED" },
    });
    await sup((c) => c.query(`UPDATE assessments SET settings = jsonb_build_object('sections', jsonb_build_array(jsonb_build_object('name','A','minutes',10))) WHERE id = $1`, [assessmentId]));
    await expect(updateAssessmentDuration(tenantA, assessmentId, 20, adminA)).rejects.toMatchObject({
      details: { code: "TIME_LIMIT_NOT_ALLOWED" },
    });
    // clearing the limit is always allowed
    expect((await updateAssessmentDuration(tenantA, assessmentId, null, adminA)).duration_minutes).toBeNull();
  });

  it("a running attempt keeps the time it started with; a later start uses the new time; the audit row has before and after", async () => {
    const { assessmentId, people } = await setup({ durationMinutes: 20, candidates: 2 });
    const first = people[0]!;
    const second = people[1]!;
    const a1 = await start(first.id, assessmentId);
    const row = () => sup((c) => c.query(`SELECT duration_seconds, ends_at FROM attempts WHERE id = $1`, [a1.id])).then((r) => r.rows[0]);
    const before = await row();
    expect(before.duration_seconds).toBe(20 * 60);

    // The assessment is already active: the edit is allowed in any status.
    const updated = await updateAssessmentDuration(tenantA, assessmentId, 30, adminA);
    expect(updated.duration_minutes).toBe(30);
    const after = await row();
    expect(after.duration_seconds).toBe(20 * 60);
    expect(after.ends_at).toEqual(before.ends_at);

    const a2 = await start(second.id, assessmentId);
    const r2 = await sup((c) => c.query(`SELECT duration_seconds FROM attempts WHERE id = $1`, [a2.id]));
    expect(r2.rows[0].duration_seconds).toBe(30 * 60);

    const audit = await sup((c) =>
      c.query(`SELECT before, after FROM audit_log WHERE entity_type = 'assessment' AND entity_id = $1 AND action = 'assessment.updated'`, [assessmentId]),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].before).toEqual({ duration_minutes: 20 });
    expect(audit.rows[0].after).toMatchObject({ duration_minutes: 30 });
  });

  it("a mock test follows the same rule", async () => {
    const { assessmentId, people } = await setup({ durationMinutes: 20, mode: "mock" });
    const a = await start(people[0]!.id, assessmentId);
    const r = await sup((c) => c.query(`SELECT duration_seconds FROM attempts WHERE id = $1`, [a.id]));
    expect(r.rows[0].duration_seconds).toBe(20 * 60);
  });
});
