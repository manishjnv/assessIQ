/**
 * POST /api/me/attempts/:id/position (recordPosition): who may call it.
 * Another user's attempt, another tenant's attempt, a submitted attempt and a question
 * that is not in the attempt are all refused. DB-backed (testcontainers Postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { startAttempt, recordTakeConsent, recordPosition } from "../service.js";
import { AE_ERROR_CODES } from "../types.js";

let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const otherTenant = randomUUID();
const admin = randomUUID();
const pack = randomUUID();
const level = randomUUID();
const domain = randomUUID();
const cat = randomUUID();
const qids = [randomUUID(), randomUUID()];
const owner = randomUUID();
const stranger = randomUUID();
const assessmentId = randomUUID();

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_authz" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_authz`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-authz','T'),($2,'t-ae-authz2','T2')`, [tenant, otherTenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1),($2) ON CONFLICT DO NOTHING`, [tenant, otherTenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@authz.test','A','admin','active')`, [admin, tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active'),($4,$2,$5,'S','candidate','active')`,
      [owner, tenant, `o-${owner}@authz.test`, stranger, `s-${stranger}@authz.test`],
    );
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p-authz','P','soc','published',$3)`, [pack, tenant, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,2,60)`, [level, pack]);
    await c.query(`INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1,$2,'apt','Aptitude')`, [domain, tenant]);
    await c.query(`INSERT INTO categories (id, tenant_id, domain_id, slug, name) VALUES ($1,$2,$3,'x','X')`, [cat, tenant, domain]);
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, settings, created_by)
       VALUES ($1,$2,$3,$4,1,'A','active',2,false,'{}'::jsonb,$5)`,
      [assessmentId, tenant, pack, level, admin],
    );
    await c.query(
      `INSERT INTO assessment_invitations (assessment_id, user_id, token_hash, expires_at, invited_by)
       VALUES ($1,$2,$3, now() + interval '7 days', $4)`,
      [assessmentId, owner, `h-${owner}`, admin],
    );
    const content = JSON.stringify({ question: "q", options: ["a", "b"], correct: 1, rationale: "r" });
    for (const q of qids) {
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by, domain_id, category_id)
         VALUES ($1,$2,$3,'mcq','t',1,'active',$4::jsonb,1,$5,$6,$7)`,
        [q, pack, level, content, admin, domain, cat],
      );
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [q, content, admin]);
    }
  });
  await setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

async function startOwnAttempt(): Promise<string> {
  await recordTakeConsent(tenant, { userId: owner, ip: null, userAgent: null });
  const attempt = await startAttempt(tenant, { assessmentId, userId: owner });
  return attempt.id;
}

describe("recordPosition authorisation", () => {
  it("the owner can record a position on an in-progress attempt (control)", async () => {
    const attemptId = await startOwnAttempt();
    const res = await recordPosition(tenant, owner, attemptId, { question_id: qids[0] as string });
    expect(res).toEqual({ question_ends_at: null });
  });

  it("refuses another user's attempt", async () => {
    const attemptId = await startOwnAttempt();
    await expect(recordPosition(tenant, stranger, attemptId, { question_id: qids[0] as string })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.NOT_OWNED_BY_USER },
    });
  });

  it("finds nothing for another tenant's attempt", async () => {
    const attemptId = await startOwnAttempt();
    await expect(recordPosition(otherTenant, owner, attemptId, { question_id: qids[0] as string })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
    });
  });

  it("refuses a question that is not in the attempt", async () => {
    const attemptId = await startOwnAttempt();
    await expect(recordPosition(tenant, owner, attemptId, { question_id: randomUUID() })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.UNKNOWN_QUESTION },
    });
  });

  it("refuses a submitted attempt", async () => {
    const attemptId = await startOwnAttempt();
    await sup((c) => c.query(`UPDATE attempts SET status = 'submitted', submitted_at = now() WHERE id = $1`, [attemptId]));
    await expect(recordPosition(tenant, owner, attemptId, { question_id: qids[0] as string })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.WRITES_LOCKED },
    });
  });
});
