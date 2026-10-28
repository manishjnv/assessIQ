/**
 * Z-174: getAttemptForCandidate returns `candidate_name` and `assessment_name` for the take-page top bar.
 * Only for the caller's own attempt in their tenant; a blank or email-style name is left out.
 * DB-backed (testcontainers Postgres), no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { startAttempt, recordTakeConsent, getAttemptForCandidate } from "../service.js";

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_names" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_names`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-names','T'),($2,'t-ae-names2','T2')`, [tenant, otherTenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1),($2) ON CONFLICT DO NOTHING`, [tenant, otherTenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@names.test','A','admin','active')`, [admin, tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Asha Verma','candidate','active'),($4,$2,$5,'S','candidate','active')`,
      [owner, tenant, `o-${owner}@names.test`, stranger, `s-${stranger}@names.test`],
    );
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p-names','P','soc','published',$3)`, [pack, tenant, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,2,60)`, [level, pack]);
    await c.query(`INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1,$2,'apt','Aptitude')`, [domain, tenant]);
    await c.query(`INSERT INTO categories (id, tenant_id, domain_id, slug, name) VALUES ($1,$2,$3,'x','X')`, [cat, tenant, domain]);
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, settings, created_by)
       VALUES ($1,$2,$3,$4,1,'Long Assessment Title','active',2,false,'{}'::jsonb,$5)`,
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

async function ownAttempt(): Promise<string> {
  await recordTakeConsent(tenant, { userId: owner, ip: null, userAgent: null });
  const attempt = await startAttempt(tenant, { assessmentId, userId: owner });
  return attempt.id;
}

const setName = (name: string): Promise<unknown> => sup((c) => c.query(`UPDATE users SET name = $1 WHERE id = $2`, [name, owner]));

describe("getAttemptForCandidate display names", () => {
  it("returns the candidate name and assessment title for the candidate's own attempt", async () => {
    const view = await getAttemptForCandidate(tenant, await ownAttempt(), owner);
    expect(view.candidate_name).toBe("Asha Verma");
    expect(view.assessment_name).toBe("Long Assessment Title");
  });

  it("gives nothing to another candidate of the same tenant", async () => {
    const attemptId = await ownAttempt();
    await expect(getAttemptForCandidate(tenant, attemptId, stranger)).rejects.toBeDefined();
  });

  it("gives nothing to a candidate asking from another tenant", async () => {
    const attemptId = await ownAttempt();
    await expect(getAttemptForCandidate(otherTenant, attemptId, owner)).rejects.toBeDefined();
  });

  it("leaves out an email-style name and keeps the title", async () => {
    const attemptId = await ownAttempt();
    await setName("asha@names.test");
    try {
      const view = await getAttemptForCandidate(tenant, attemptId, owner);
      expect(view).not.toHaveProperty("candidate_name");
      expect(view.assessment_name).toBe("Long Assessment Title");
    } finally {
      await setName("Asha Verma");
    }
  });

  it("leaves out a blank name", async () => {
    const attemptId = await ownAttempt();
    await setName("   ");
    try {
      const view = await getAttemptForCandidate(tenant, attemptId, owner);
      expect(view).not.toHaveProperty("candidate_name");
    } finally {
      await setName("Asha Verma");
    }
  });
});
