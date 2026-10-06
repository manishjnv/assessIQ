/**
 * SP2 — manual release + bulk "release all ready" (testcontainers, real audit_log + certificates).
 *
 * handleAdminReleaseAttempt delegates to module 09 releaseAttemptInTx and sends the
 * result email only AFTER the release transaction commits (best-effort). The bulk
 * handler releases every ready result of an assessment, each in its own tx.
 * Module 13's sendResultReleasedEmail is mocked (covered by 13's own tests).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("../runtime-selector.js", () => ({ gradeSubjective: vi.fn() }));
const emailMock = vi.fn();
vi.mock("@assessiq/notifications", () => ({ emitAttemptEventAfterCommit: vi.fn(async () => undefined),
  notifyEvaluationReadyAfterCommit: vi.fn(async () => undefined),
  sendResultReleasedEmail: (...a: unknown[]) => emailMock(...a),
}));

import { AppError } from "@assessiq/core";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { handleAdminReleaseAttempt } from "../handlers/admin-claim-release.js";
import { handleAdminReleaseAll } from "../handlers/admin-release-all.js";
import { registerGradingRoutes } from "../routes.js";

// modules/18-certification crypto.ts CERT_SIGNING_SECRET_ENV (07 does not depend on 18; 09 does)
const CERT_SIGNING_SECRET_ENV = "CERT_SIGNING_SECRET";

const toFsPath = (url: URL): string => url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const THIS_DIR = toFsPath(new URL(".", import.meta.url));

let container: StartedTestContainer;
let url: string;
let tenant: string;
let otherTenant: string;
let admin: string;
let otherAdmin: string;

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
  process.env[CERT_SIGNING_SECRET_ENV] = "release-flow-test-secret";
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_relflow" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_relflow`;

  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  });
  await setPoolForTesting(url);

  tenant = randomUUID();
  otherTenant = randomUUID();
  admin = randomUUID();
  otherAdmin = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-rf','T'),($2,'t-rf-o','O')`, [tenant, otherTenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1),($2) ON CONFLICT DO NOTHING`, [tenant, otherTenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@rf.test','Admin','admin','active'),($3,$4,'b@rf.test','AdminB','admin','active')`,
      [admin, tenant, otherAdmin, otherTenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(() => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  process.env[CERT_SIGNING_SECRET_ENV] = "release-flow-test-secret";
});

/** A pack + level + assessment in `tid`; attempts are added with addAttempt(). */
async function seedAssessment(tid = tenant, adminId = admin): Promise<string> {
  const pack = randomUUID();
  const level = randomUUID();
  const assessment = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`,
      [pack, tid, `p-${randomUUID().slice(0, 8)}`, adminId],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`,
      [level, pack],
    );
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'A','active',1,$5)`,
      [assessment, tid, pack, level, adminId],
    );
  });
  return assessment;
}

interface Opts {
  status?: string;
  evalReleased?: boolean;
  erased?: boolean;
  pct?: number;
  /** minutes ago the evaluation was released (orders the bulk release) */
  evalAgoMin?: number;
  /** the newest effective grade is review_needed (AI failure after a re-run) */
  flagged?: boolean;
}

async function addAttempt(assessment: string, o: Opts = {}, tid = tenant): Promise<string> {
  const cand = randomUUID();
  const attemptId = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status, erased_at) VALUES ($1,$2,$3,'Cand','candidate','active',$4)`,
      [cand, tid, `c-${randomUUID().slice(0, 6)}@rf.test`, o.erased === true ? new Date() : null],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds, evaluation_released_at)
       VALUES ($1,$2,$3,$4,$5, now() - interval '30 minutes', now(), 3600, ${o.evalReleased === false ? "NULL" : `now() - interval '${o.evalAgoMin ?? 0} minutes'`})`,
      [attemptId, tid, assessment, cand, o.status ?? "graded"],
    );
    await c.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review) VALUES ($1,$2,$3,100,$3,false)`,
      [attemptId, tid, o.pct ?? 80],
    );
    if (o.flagged === true) {
      const qid = randomUUID();
      const asm = await c.query<{ pack_id: string; level_id: string; created_by: string }>(`SELECT pack_id, level_id, created_by FROM assessments WHERE id=$1`, [assessment]);
      const a = asm.rows[0]!;
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,'subjective','t',10,'active','{"question":"q"}'::jsonb,1,$4)`,
        [qid, a.pack_id, a.level_id, a.created_by],
      );
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,1,1)`, [attemptId, qid]);
      await c.query(
        `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model)
         VALUES ($1,$2,$3,'ai',0,10,'review_needed','error:no-sha','error','none')`,
        [tid, attemptId, qid],
      );
    }
  });
  return attemptId;
}

const status = (id: string) => sup((c) => c.query(`SELECT status FROM attempts WHERE id=$1`, [id]).then((r) => r.rows[0].status as string));
const count = (sql: string, id: string) => sup((c) => c.query(sql, [id]).then((r) => Number(r.rows[0].n)));
const releasedAudits = (id: string) => count(`SELECT COUNT(*) n FROM audit_log WHERE entity_id=$1 AND action='grading.released'`, id);
const certCount = (id: string) => count(`SELECT COUNT(*) n FROM certificates WHERE attempt_id=$1`, id);
const emailedIds = () => emailMock.mock.calls.map((c) => (c[0] as { attemptId: string }).attemptId);

describe("handleAdminReleaseAttempt (manual Release)", () => {
  it("publishes, writes ONE audit row, issues the certificate, then emails AFTER the tx has committed", async () => {
    const attemptId = await addAttempt(await seedAssessment(), { pct: 85 });
    let statusWhenEmailed: string | undefined;
    emailMock.mockImplementation(async () => {
      statusWhenEmailed = await status(attemptId); // visible to another connection => committed
    });

    const r = await handleAdminReleaseAttempt({ tenantId: tenant, userId: admin, attemptId });
    expect(r).toEqual({ attempt: { id: attemptId, status: "released" } });
    expect(await status(attemptId)).toBe("released");
    expect(await releasedAudits(attemptId)).toBe(1);
    expect(await certCount(attemptId)).toBe(1);
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(emailMock).toHaveBeenCalledWith({ tenantId: tenant, attemptId });
    expect(statusWhenEmailed).toBe("released");
  });

  it("is refused (no state change, NO email) when the result is not ready", async () => {
    const a = await addAttempt(await seedAssessment(), { evalReleased: false });
    await expect(handleAdminReleaseAttempt({ tenantId: tenant, userId: admin, attemptId: a })).rejects.toMatchObject({ code: "RESULT_NOT_READY", status: 409 });
    const b = await addAttempt(await seedAssessment(), { status: "submitted" });
    await expect(handleAdminReleaseAttempt({ tenantId: tenant, userId: admin, attemptId: b })).rejects.toMatchObject({ code: "RESULT_NOT_READY", status: 409 });
    expect(await status(a)).toBe("graded");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("erased candidate -> 422, nothing released, nothing emailed; unknown attempt -> 404", async () => {
    const a = await addAttempt(await seedAssessment(), { erased: true });
    await expect(handleAdminReleaseAttempt({ tenantId: tenant, userId: admin, attemptId: a })).rejects.toMatchObject({ code: "AIG_ATTEMPT_NOT_RELEASABLE_ERASED", status: 422 });
    expect(await status(a)).toBe("graded");
    await expect(handleAdminReleaseAttempt({ tenantId: tenant, userId: admin, attemptId: randomUUID() })).rejects.toMatchObject({ code: "AIG_ATTEMPT_NOT_FOUND", status: 404 });
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("a failing email never fails a committed release", async () => {
    const attemptId = await addAttempt(await seedAssessment());
    emailMock.mockRejectedValue(new Error("brevo down"));
    await expect(handleAdminReleaseAttempt({ tenantId: tenant, userId: admin, attemptId })).resolves.toMatchObject({ attempt: { status: "released" } });
    expect(await status(attemptId)).toBe("released");
  });

  it("a certificate failure never fails the release (SAVEPOINT in 09)", async () => {
    const attemptId = await addAttempt(await seedAssessment(), { pct: 85 });
    delete process.env[CERT_SIGNING_SECRET_ENV];
    await expect(handleAdminReleaseAttempt({ tenantId: tenant, userId: admin, attemptId })).resolves.toMatchObject({ attempt: { status: "released" } });
    expect(await certCount(attemptId)).toBe(0);
    expect(await releasedAudits(attemptId)).toBe(1);
  });

  it("another tenant's admin cannot release it (RLS -> 404)", async () => {
    const attemptId = await addAttempt(await seedAssessment());
    await expect(handleAdminReleaseAttempt({ tenantId: otherTenant, userId: otherAdmin, attemptId })).rejects.toMatchObject({ status: 404 });
    expect(await status(attemptId)).toBe("graded");
  });
});

describe("handleAdminReleaseAll (bulk 'release all ready')", () => {
  it("releases exactly the ready, non-erased results (oldest evaluation first), one audit row + one email each", async () => {
    const asm = await seedAssessment();
    const ready1 = await addAttempt(asm, { evalAgoMin: 30 });
    const ready2 = await addAttempt(asm, { evalAgoMin: 20, pct: 95 });
    const ready3 = await addAttempt(asm, { evalAgoMin: 10 });
    const notEvaluated = await addAttempt(asm, { evalReleased: false });
    const erased = await addAttempt(asm, { erased: true });
    const submitted = await addAttempt(asm, { status: "submitted" });
    const already = await addAttempt(asm, { status: "released" });
    const otherAsm = await seedAssessment();
    const elsewhere = await addAttempt(otherAsm); // ready, but a DIFFERENT assessment

    const out = await handleAdminReleaseAll({ tenantId: tenant, userId: admin, assessmentId: asm });
    expect(out).toEqual({ released: [ready1, ready2, ready3], skipped: [] });
    for (const id of [ready1, ready2, ready3]) {
      expect(await status(id)).toBe("released");
      expect(await releasedAudits(id)).toBe(1);
    }
    expect(await certCount(ready2)).toBe(1); // 95% -> distinction certificate
    expect(emailedIds()).toEqual([ready1, ready2, ready3]);

    // untouched
    expect(await status(notEvaluated)).toBe("graded");
    expect(await status(erased)).toBe("graded");
    expect(await status(submitted)).toBe("submitted");
    expect(await status(already)).toBe("released");
    expect(await status(elsewhere)).toBe("graded");
    expect(await releasedAudits(erased)).toBe(0);

    // idempotent: nothing left to release
    emailMock.mockClear();
    expect(await handleAdminReleaseAll({ tenantId: tenant, userId: admin, assessmentId: asm })).toEqual({ released: [], skipped: [] });
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("one failing attempt is skipped (own tx) without blocking the others; no email for it", async () => {
    const asm = await seedAssessment();
    const a = await addAttempt(asm, { evalAgoMin: 5 });
    const bad = await addAttempt(asm, { evalAgoMin: 4 });
    const c = await addAttempt(asm, { evalAgoMin: 3 });
    await sup((cl) =>
      cl.query(`CREATE OR REPLACE FUNCTION t_rf_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${bad}' AND NEW.status = 'released' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$;
                CREATE TRIGGER t_rf_fail BEFORE UPDATE ON attempts FOR EACH ROW EXECUTE FUNCTION t_rf_fail()`),
    );
    try {
      const out = await handleAdminReleaseAll({ tenantId: tenant, userId: admin, assessmentId: asm });
      expect(out.released).toEqual([a, c]);
      expect(out.skipped).toEqual([{ id: bad, code: "RELEASE_FAILED" }]);
    } finally {
      await sup((cl) => cl.query(`DROP TRIGGER t_rf_fail ON attempts`));
    }
    expect(await status(bad)).toBe("graded");
    expect(await releasedAudits(bad)).toBe(0);
    expect(emailedIds()).toEqual([a, c]);
  });

  it("P1: a ready attempt whose grade is flagged review_needed is skipped with RESULT_NOT_READY (never published), the rest are released", async () => {
    const asm = await seedAssessment();
    const ok = await addAttempt(asm, { evalAgoMin: 5 });
    const flagged = await addAttempt(asm, { evalAgoMin: 4, flagged: true });
    const out = await handleAdminReleaseAll({ tenantId: tenant, userId: admin, assessmentId: asm });
    expect(out).toEqual({ released: [ok], skipped: [{ id: flagged, code: "RESULT_NOT_READY" }] });
    expect(await status(flagged)).toBe("graded");
    expect(emailedIds()).toEqual([ok]);
  });

  it("unknown assessment and another tenant's assessment -> 404", async () => {
    await expect(handleAdminReleaseAll({ tenantId: tenant, userId: admin, assessmentId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    const foreign = await seedAssessment(otherTenant, otherAdmin);
    await addAttempt(foreign, {}, otherTenant);
    await expect(handleAdminReleaseAll({ tenantId: tenant, userId: admin, assessmentId: foreign })).rejects.toMatchObject({ status: 404 });
  });
});

describe("release routes", () => {
  async function buildApp() {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: err.toJson() });
      return reply.code(500).send({ error: { code: "INTERNAL", message: String(err) } });
    });
    const session = async (req: { session?: unknown }) => {
      req.session = { tenantId: tenant, userId: admin, lastSeenAt: new Date().toISOString() };
    };
    await registerGradingRoutes(app, { adminOnly: [session as never], adminFreshMfa: [session as never] });
    return app;
  }

  it("POST /api/admin/assessments/:id/release-all -> 200 { released, skipped }", async () => {
    const app = await buildApp();
    const asm = await seedAssessment();
    const id = await addAttempt(asm);
    const res = await app.inject({ method: "POST", url: `/api/admin/assessments/${asm}/release-all` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ released: [id], skipped: [] });
    await app.close();
  });

  it("release-all: 400 for a non-UUID id; 404 for an unknown assessment", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "POST", url: "/api/admin/assessments/nope/release-all" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/admin/assessments/${randomUUID()}/release-all` })).statusCode).toBe(404);
    await app.close();
  });

  it("POST /api/admin/attempts/:id/release keeps its response shape; 409 RESULT_NOT_READY when not ready", async () => {
    const app = await buildApp();
    const asm = await seedAssessment();
    const ok = await addAttempt(asm);
    const res = await app.inject({ method: "POST", url: `/api/admin/attempts/${ok}/release` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ attempt: { id: ok, status: "released" } });
    const notReady = await addAttempt(asm, { evalReleased: false });
    const res2 = await app.inject({ method: "POST", url: `/api/admin/attempts/${notReady}/release` });
    expect(res2.statusCode).toBe(409);
    expect(res2.json()).toMatchObject({ error: { code: "RESULT_NOT_READY" } });
    await app.close();
  });
});

describe("structure", () => {
  it("07 release handlers use static imports — no `new Function` dynamic-import tricks", async () => {
    for (const f of ["admin-claim-release.ts", "admin-release-all.ts"]) {
      const src = await readFile(join(THIS_DIR, "..", "handlers", f), "utf-8");
      expect(src, f).not.toMatch(/new\s+Function/);
    }
  });
});
