/**
 * SP3 — candidate result contract (testcontainers Postgres + Fastify inject).
 *
 * Owner rules: P1 a candidate sees only a COMPLETE, FINAL score (never partial /
 * provisional, never per-question data); P2 if it will not be ready within about a
 * minute, say so at submit and point to the email.
 *
 *   POST /api/me/attempts/:id/submit   → result_expectation, release_mode, email_masked, turnaround_text
 *   GET  /api/me/attempts/:id/result   → 200 released | 202 pending
 *   GET  /api/me/results               → released attempts only, newest first
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { AppError, config } from "@assessiq/core";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import {
  getCandidateResult,
  getSubmitExpectation,
  listCandidateResults,
  maskEmail,
  resultPercent,
} from "../result.js";
import { registerAttemptCandidateRoutes } from "../routes.candidate.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url)) + sep;
const MODULES_ROOT = join(THIS_DIR, "..", "..", "..");
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
];

type QType = "mcq" | "subjective" | "kql";

let container: StartedTestContainer;
let url: string;
let tenant: string; // auto tenant (switched on)
let manualTenant: string;
let otherTenant: string;
let admin: string;
let manualAdmin: string;

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
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_cres" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_cres`;

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
  });
  await setPoolForTesting(url);

  tenant = randomUUID();
  manualTenant = randomUUID();
  otherTenant = randomUUID();
  admin = randomUUID();
  manualAdmin = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1,'t-auto','Acme University'),($2,'t-manual','Manual College'),($3,'t-other','Other')`,
      [tenant, manualTenant, otherTenant],
    );
    await c.query(
      `INSERT INTO tenant_settings (tenant_id, result_release_mode, result_release_auto_since) VALUES ($1,'auto', now() - interval '1 hour')`,
      [tenant],
    );
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1),($2)`, [manualTenant, otherTenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@x.test','Admin','admin','active'),($3,$4,'b@x.test','Admin2','admin','active')`,
      [admin, tenant, manualAdmin, manualTenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

interface Seeded {
  attemptId: string;
  userId: string;
  assessmentId: string;
  email: string;
}

interface Opts {
  tid?: string;
  adminId?: string;
  types?: QType[];
  status?: string;
  embed?: boolean;
  email?: string;
  earned?: number | null; // attempt_scores row; null = none
  max?: number;
  passing?: number;
  /** insert the grading.released audit row at this ISO time */
  releasedAt?: string;
  cert?: string;
  userId?: string;
}

async function seed(o: Opts = {}): Promise<Seeded> {
  const tid = o.tid ?? tenant;
  const adm = o.adminId ?? (tid === manualTenant ? manualAdmin : admin);
  const pack = randomUUID();
  const level = randomUUID();
  const assessmentId = randomUUID();
  const userId = o.userId ?? randomUUID();
  const attemptId = randomUUID();
  const email = o.email ?? `riya.sharma-${randomUUID().slice(0, 6)}@gmail.com`;
  const types = o.types ?? ["mcq", "mcq"];
  await sup(async (c) => {
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`,
      [pack, tid, `p-${randomUUID().slice(0, 8)}`, adm],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,$3)`,
      [level, pack, o.passing ?? 60],
    );
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'SOC Analyst L1','active',$5,$6)`,
      [assessmentId, tid, pack, level, Math.max(1, types.length), adm],
    );
    if (o.userId === undefined) {
      await c.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Riya Sharma','candidate','active')`,
        [userId, tid, email],
      );
    }
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds, embed_origin)
       VALUES ($1,$2,$3,$4,$5, now() - interval '20 minutes', now() + interval '40 minutes', ${o.status === "in_progress" ? "NULL" : "now()"}, 3600, $6)`,
      [attemptId, tid, assessmentId, userId, o.status ?? "submitted", o.embed === true],
    );
    let pos = 1;
    for (const type of types) {
      const qid = randomUUID();
      const content = JSON.stringify(
        type === "mcq" ? { question: "q", options: ["a", "b", "c", "d"], correct: 1, rationale: "r" } : { question: "q" },
      );
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'t',10,'active',$5::jsonb,1,$6)`,
        [qid, pack, level, type, content, adm],
      );
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, adm]);
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,$3,1)`, [attemptId, qid, pos++]);
      if (type === "mcq") {
        await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [attemptId, qid, JSON.stringify({ selected: 1 })]);
      }
    }
    if (o.earned !== null && o.earned !== undefined) {
      await c.query(
        `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review) VALUES ($1,$2,$3,$4,$5,false)`,
        [attemptId, tid, o.earned, o.max ?? 60, (o.earned / (o.max ?? 60)) * 100],
      );
    }
    if (o.releasedAt !== undefined) {
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_kind, action, entity_type, entity_id, after, at) VALUES ($1,'system','grading.released','attempt',$2,'{}'::jsonb,$3)`,
        [tid, attemptId, o.releasedAt],
      );
    }
    if (o.cert !== undefined) {
      await c.query(
        `INSERT INTO certificates (tenant_id, attempt_id, candidate_id, template_key, credential_id, tier, display_name, course_title, level, signed_hash)
         VALUES ($1,$2,$3,'standard',$4,'completion','Riya Sharma','SOC Analyst L1','L1','sig')`,
        [tid, attemptId, userId, o.cert],
      );
    }
  });
  return { attemptId, userId, assessmentId, email };
}

describe("pure helpers", () => {
  it("maskEmail keeps the first character and the domain, hides the rest of the local part", () => {
    expect(maskEmail("riya.sharma@gmail.com")).toBe("r***@gmail.com");
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
    expect(maskEmail("Éva@exemple.fr")).toBe("É***@exemple.fr");
    expect(maskEmail("weird@local@host.org")).toBe("w***@host.org"); // last @ separates the domain
    expect(maskEmail("no-at-sign")).toBe("***");
    expect(maskEmail("@nolocal.com")).toBe("***");
    expect(maskEmail("")).toBe("***");
  });

  it("resultPercent is 0-100 with one decimal and 0 when there is no maximum", () => {
    expect(resultPercent(42, 60)).toBe(70);
    expect(resultPercent(41.5, 60)).toBe(69.2);
    expect(resultPercent(1, 3)).toBe(33.3);
    expect(resultPercent(60, 60)).toBe(100);
    expect(resultPercent(0, 0)).toBe(0);
  });
});

describe("getSubmitExpectation (P2: promise the right thing at submit)", () => {
  it("'soon' only for: auto tenant (switched on) + MCQ-only + not embed", async () => {
    const s = await seed({ types: ["mcq", "mcq"] });
    const e = await getSubmitExpectation(tenant, s.userId, s.attemptId);
    expect(e).toEqual({
      result_expectation: "soon",
      release_mode: "auto",
      email_masked: maskEmail(s.email),
      turnaround_text: config.EVALUATION_TURNAROUND_TEXT,
    });
    expect(e.email_masked).toMatch(/^r\*\*\*@gmail\.com$/);
  });

  it.each([
    ["written answers present (subjective)", { types: ["mcq", "subjective"] as QType[] }],
    ["KQL present", { types: ["mcq", "kql"] as QType[] }],
    ["embed attempt", { embed: true }],
  ])("'email' when %s — even for an auto tenant", async (_label, opts) => {
    const s = await seed(opts);
    const e = await getSubmitExpectation(tenant, s.userId, s.attemptId);
    expect(e.result_expectation).toBe("email");
    expect(e.release_mode).toBe("auto");
  });

  it("'email' for a manual tenant (MCQ-only) and it carries release_mode 'manual'", async () => {
    const s = await seed({ tid: manualTenant, types: ["mcq"] });
    const e = await getSubmitExpectation(manualTenant, s.userId, s.attemptId);
    expect(e).toMatchObject({ result_expectation: "email", release_mode: "manual" });
  });

  it("'email' for an auto tenant whose auto switch is not stamped (never promise a wait the sweep will not honour)", async () => {
    const t = randomUUID();
    await sup(async (c) => {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,'Inconsistent')`, [t, `inc-${t.slice(0, 8)}`]);
      await c.query(`INSERT INTO tenant_settings (tenant_id, result_release_mode) VALUES ($1,'auto')`, [t]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'i@x.test','I','admin','active')`, [randomUUID(), t]);
    });
    const adminId = await sup((c) => c.query(`SELECT id FROM users WHERE tenant_id=$1`, [t]).then((r) => r.rows[0].id as string));
    const s = await seed({ tid: t, adminId, types: ["mcq"] });
    expect((await getSubmitExpectation(t, s.userId, s.attemptId)).result_expectation).toBe("email");
  });

  it("never throws: another candidate's / unknown attempt falls back to the conservative email promise with NO address", async () => {
    const s = await seed();
    const e = await getSubmitExpectation(tenant, randomUUID(), s.attemptId);
    expect(e).toEqual({ result_expectation: "email", release_mode: "manual", email_masked: "", turnaround_text: config.EVALUATION_TURNAROUND_TEXT });
    expect((await getSubmitExpectation(tenant, s.userId, randomUUID())).email_masked).toBe("");
  });
});

describe("getCandidateResult (P1: complete + final only, after release)", () => {
  it.each(["submitted", "auto_submitted", "pending_admin_grading", "graded"])(
    "%s -> pending with the email promise and NO score data — even when a partial rollup exists",
    async (status) => {
      const s = await seed({ status, earned: 33, max: 60 }); // a provisional rollup row exists
      const v = await getCandidateResult(tenant, s.userId, s.attemptId);
      expect(v).toEqual({
        status: "pending",
        result_expectation: "soon",
        release_mode: "auto",
        email_masked: maskEmail(s.email),
        turnaround_text: config.EVALUATION_TURNAROUND_TEXT,
        tenant_name: "Acme University",
      });
      expect(Object.keys(v).sort()).toEqual( // no score-bearing key at all
        ["email_masked", "release_mode", "result_expectation", "status", "tenant_name", "turnaround_text"],
      );
    },
  );

  it("pending body for a manual tenant says release_mode 'manual' and names the organisation", async () => {
    const s = await seed({ tid: manualTenant, status: "graded", earned: 50 });
    const v = await getCandidateResult(manualTenant, s.userId, s.attemptId);
    expect(v).toMatchObject({ status: "pending", release_mode: "manual", result_expectation: "email", tenant_name: "Manual College" });
  });

  it("released -> the final result: total, percent (1 dp), passed, assessment, released_at, certificate null", async () => {
    const s = await seed({ status: "released", earned: 42, max: 60, passing: 60, releasedAt: "2026-10-01T10:00:00.000Z" });
    const v = await getCandidateResult(tenant, s.userId, s.attemptId);
    expect(v).toEqual({
      status: "released",
      total_earned: 42,
      total_max: 60,
      percent: 70,
      passed: true,
      assessment_name: "SOC Analyst L1",
      released_at: "2026-10-01T10:00:00.000Z",
      certificate: null,
    });
  });

  it("released with a certificate -> { credential_id, verify_url }; a revoked one is not shown", async () => {
    const s = await seed({ status: "released", earned: 55, max: 60, releasedAt: "2026-10-01T10:00:00.000Z", cert: "AIQ-2026-10-ABC123" });
    const v = await getCandidateResult(tenant, s.userId, s.attemptId);
    expect(v).toMatchObject({ status: "released", percent: 91.7, certificate: { credential_id: "AIQ-2026-10-ABC123" } });
    expect(new URL((v as { certificate: { verify_url: string } }).certificate.verify_url).pathname).toBe("/verify/AIQ-2026-10-ABC123");

    await sup((c) => c.query(`UPDATE certificates SET revoked_at = now() WHERE attempt_id = $1`, [s.attemptId]));
    expect((await getCandidateResult(tenant, s.userId, s.attemptId) as { certificate: unknown }).certificate).toBeNull();
  });

  it("passed uses the level's passing score: inclusive at the boundary, false below", async () => {
    const at = await seed({ status: "released", earned: 36, max: 60, passing: 60, releasedAt: "2026-10-01T10:00:00.000Z" });
    expect(await getCandidateResult(tenant, at.userId, at.attemptId)).toMatchObject({ percent: 60, passed: true });
    const below = await seed({ status: "released", earned: 35, max: 60, passing: 60, releasedAt: "2026-10-01T10:00:00.000Z" });
    expect(await getCandidateResult(tenant, below.userId, below.attemptId)).toMatchObject({ percent: 58.3, passed: false });
  });

  it("released_at falls back to the score computation time when no release audit row exists", async () => {
    const s = await seed({ status: "released", earned: 40 });
    const v = (await getCandidateResult(tenant, s.userId, s.attemptId)) as { released_at: string };
    expect(Number.isNaN(Date.parse(v.released_at))).toBe(false);
  });

  it("a 'released' attempt WITHOUT a score row never shows a score: it stays pending", async () => {
    const s = await seed({ status: "released", earned: null });
    expect((await getCandidateResult(tenant, s.userId, s.attemptId)).status).toBe("pending");
  });

  it("only the owner can read it: another candidate / unknown id / another tenant -> 404", async () => {
    const s = await seed({ status: "released", earned: 42, releasedAt: "2026-10-01T10:00:00.000Z" });
    await expect(getCandidateResult(tenant, randomUUID(), s.attemptId)).rejects.toMatchObject({ status: 404 });
    await expect(getCandidateResult(tenant, s.userId, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(getCandidateResult(otherTenant, s.userId, s.attemptId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("listCandidateResults", () => {
  it("returns this candidate's RELEASED results only, newest release first", async () => {
    const userId = randomUUID();
    await sup((c) => c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Multi','candidate','active')`, [userId, tenant, `multi-${userId.slice(0, 6)}@x.test`]));
    const older = await seed({ userId, status: "released", earned: 30, max: 60, releasedAt: "2026-09-01T10:00:00.000Z" });
    const newer = await seed({ userId, status: "released", earned: 54, max: 60, releasedAt: "2026-10-01T10:00:00.000Z", cert: "AIQ-2026-10-NEW001" });
    await seed({ userId, status: "graded", earned: 59 }); // provisional: must not appear
    await seed({ userId, status: "submitted" });
    const other = await seed({ status: "released", earned: 60, releasedAt: "2026-10-02T10:00:00.000Z" }); // someone else's

    const { items } = await listCandidateResults(tenant, userId);
    expect(items.map((i) => i.attempt_id)).toEqual([newer.attemptId, older.attemptId]);
    expect(items[0]).toMatchObject({
      assessment_name: "SOC Analyst L1",
      released_at: "2026-10-01T10:00:00.000Z",
      total_earned: 54,
      total_max: 60,
      percent: 90,
      passed: true,
      certificate: { credential_id: "AIQ-2026-10-NEW001" },
    });
    expect(items[1]).toMatchObject({ percent: 50, passed: false, certificate: null });
    expect(items.map((i) => i.attempt_id)).not.toContain(other.attemptId);
    expect(items.map((i) => i.total_earned)).not.toContain(59); // the provisional 'graded' score never appears
    expect(Object.keys(items[0]!).sort()).toEqual( // nothing per-question, no bands / justifications
      ["assessment_name", "attempt_id", "certificate", "passed", "percent", "released_at", "total_earned", "total_max"],
    );
  });

  it("a candidate with nothing released gets an empty list", async () => {
    const s = await seed({ status: "graded", earned: 50 });
    expect(await listCandidateResults(tenant, s.userId)).toEqual({ items: [] });
  });
});

describe("candidate routes", () => {
  async function buildApp() {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: err.toJson() });
      return reply.code(500).send({ error: { code: "INTERNAL", message: String(err) } });
    });
    // fake candidate chain: tenant from x-tenant, user from x-user (the real chain sets req.session)
    const candidateOnly = async (req: { headers: Record<string, string | string[] | undefined>; session?: unknown }) => {
      req.session = { tenantId: String(req.headers["x-tenant"]), userId: String(req.headers["x-user"]) };
    };
    await registerAttemptCandidateRoutes(app, { candidateOnly: [candidateOnly as never] });
    return app;
  }
  const h = (tid: string, uid: string) => ({ "x-tenant": tid, "x-user": uid });

  it("POST /submit (auto tenant, MCQ-only): 202 with the expectation fields; finalised + evaluation released at submit", async () => {
    const app = await buildApp();
    const s = await seed({ status: "in_progress", types: ["mcq", "mcq"] });
    const res = await app.inject({ method: "POST", url: `/api/me/attempts/${s.attemptId}/submit`, headers: h(tenant, s.userId) });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      attempt_id: s.attemptId,
      status: "submitted",
      estimated_grading_seconds: 60,
      result_expectation: "soon",
      release_mode: "auto",
      email_masked: maskEmail(s.email),
      turnaround_text: config.EVALUATION_TURNAROUND_TEXT,
    });
    const row = await sup((c) =>
      c.query(`SELECT status, evaluation_released_at IS NOT NULL AS released FROM attempts WHERE id=$1`, [s.attemptId]).then((r) => r.rows[0]),
    );
    expect(row).toEqual({ status: "graded", released: true }); // ready for the auto-release sweep
    await app.close();
  });

  it("POST /submit (manual tenant): 'email', null ETA, release_mode manual; an idempotent re-submit answers the same", async () => {
    const app = await buildApp();
    const s = await seed({ tid: manualTenant, status: "in_progress", types: ["mcq"] });
    const first = await app.inject({ method: "POST", url: `/api/me/attempts/${s.attemptId}/submit`, headers: h(manualTenant, s.userId) });
    expect(first.json()).toMatchObject({ status: "submitted", estimated_grading_seconds: null, result_expectation: "email", release_mode: "manual" });
    const again = await app.inject({ method: "POST", url: `/api/me/attempts/${s.attemptId}/submit`, headers: h(manualTenant, s.userId) });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    await app.close();
  });

  it("POST /submit never leaks a score or correctness", async () => {
    const app = await buildApp();
    const s = await seed({ status: "in_progress", types: ["mcq"] });
    const res = await app.inject({ method: "POST", url: `/api/me/attempts/${s.attemptId}/submit`, headers: h(tenant, s.userId) });
    expect(Object.keys(res.json()).sort()).toEqual(
      ["attempt_id", "email_masked", "estimated_grading_seconds", "release_mode", "result_expectation", "status", "turnaround_text"],
    );
    await app.close();
  });

  it("GET /result: 202 pending while not released, 200 released after", async () => {
    const app = await buildApp();
    const s = await seed({ status: "graded", earned: 42, max: 60, releasedAt: "2026-10-01T10:00:00.000Z" });
    const pending = await app.inject({ method: "GET", url: `/api/me/attempts/${s.attemptId}/result`, headers: h(tenant, s.userId) });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toMatchObject({ status: "pending", tenant_name: "Acme University", release_mode: "auto" });
    expect(pending.body).not.toMatch(/total_|percent|passed/);

    await sup((c) => c.query(`UPDATE attempts SET status='released' WHERE id=$1`, [s.attemptId]));
    const done = await app.inject({ method: "GET", url: `/api/me/attempts/${s.attemptId}/result`, headers: h(tenant, s.userId) });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "released", total_earned: 42, total_max: 60, percent: 70, passed: true, certificate: null });
    await app.close();
  });

  it("GET /result for someone else's attempt -> 404", async () => {
    const app = await buildApp();
    const s = await seed({ status: "released", earned: 42 });
    const res = await app.inject({ method: "GET", url: `/api/me/attempts/${s.attemptId}/result`, headers: h(tenant, randomUUID()) });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /api/me/results -> { items } released only", async () => {
    const app = await buildApp();
    const userId = randomUUID();
    await sup((c) => c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'R','candidate','active')`, [userId, tenant, `r-${userId.slice(0, 6)}@x.test`]));
    const rel = await seed({ userId, status: "released", earned: 48, releasedAt: "2026-10-01T10:00:00.000Z" });
    await seed({ userId, status: "graded", earned: 58 });
    const res = await app.inject({ method: "GET", url: "/api/me/results", headers: h(tenant, userId) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { attempt_id: string }) => i.attempt_id)).toEqual([rel.attemptId]);
    await app.close();
  });
});

describe("structure", () => {
  it("06 result code has no dynamic-import tricks and no grading-runtime references", async () => {
    for (const f of ["result.ts", "routes.candidate.ts"]) {
      const src = await readFile(join(THIS_DIR, "..", f), "utf-8");
      expect(src, f).not.toMatch(/new\s+Function/);
      expect(src, f).not.toMatch(/@assessiq\/ai-grading|gradeSubjective|runClaudeCodeGrading/);
    }
  });
});
