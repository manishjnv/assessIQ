/** A3-1: withheld question stubs (locked blocks and per-question timers). DB-backed (testcontainers Postgres). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { startAttempt, recordTakeConsent, getAttemptForCandidate, recordPosition } from "../service.js";

let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const admin = randomUUID();
const pack = randomUUID();
const level = randomUUID();
const domain = randomUUID();
const catX = randomUUID();
const catY = randomUUID();
const qids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function setup(settings: object): Promise<{ attemptId: string; userId: string }> {
  const assessmentId = randomUUID();
  const userId = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, settings, created_by)
       VALUES ($1,$2,$3,$4,1,'A','active',4,false,$5::jsonb,$6)`,
      [assessmentId, tenant, pack, level, JSON.stringify(settings), admin],
    );
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`, [userId, tenant, `c-${userId}@fut.test`]);
    await c.query(
      `INSERT INTO assessment_invitations (assessment_id, user_id, token_hash, expires_at, invited_by)
       VALUES ($1,$2,$3, now() + interval '7 days', $4)`,
      [assessmentId, userId, `h-${userId}`, admin],
    );
  });
  await recordTakeConsent(tenant, { userId, ip: null, userAgent: null });
  const attempt = await startAttempt(tenant, { assessmentId, userId });
  return { attemptId: attempt.id, userId };
}

// s0 = qids[0..1] (catX, free), s1 = qids[2..3] (catY, locked).
const LOCKED = {
  whole_test_minutes: 10,
  sections: [
    { name: "Free", category_ids: [catX], question_count: 2 },
    { name: "Locked", category_ids: [catY], question_count: 2, locked: true },
  ],
};
const TIMED = {
  whole_test_minutes: 10,
  sections: [
    { name: "Timed", category_ids: [catX], question_count: 2, seconds_per_question: 30 },
    { name: "Free", category_ids: [catY], question_count: 2 },
  ],
};
const PLAIN = {
  whole_test_minutes: 10,
  sections: [
    { name: "A", category_ids: [catX], question_count: 2 },
    { name: "B", category_ids: [catY], question_count: 2 },
  ],
};

const pos = (userId: string, attemptId: string, body: { section_index?: number; question_id?: string }) =>
  recordPosition(tenant, userId, attemptId, body);
const get = async (userId: string, attemptId: string) => (await getAttemptForCandidate(tenant, attemptId, userId)).questions;
const byId = (qs: Awaited<ReturnType<typeof get>>, id: string) => qs.find((q) => q.question_id === id)!;
const isStub = (q: { withheld?: true; content: unknown }) => q.withheld === true && q.content === null;
const LEAK = /"(question|options)"|"q"|"a","b"|"rationale"/;

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_fut" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_fut`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-fut','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@fut.test','A','admin','active')`, [admin, tenant]);
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p-fut','P','soc','published',$3)`, [pack, tenant, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,4,60)`, [level, pack]);
    await c.query(`INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1,$2,'apt','Aptitude')`, [domain, tenant]);
    await c.query(`INSERT INTO categories (id, tenant_id, domain_id, slug, name) VALUES ($1,$2,$3,'x','X'),($4,$2,$3,'y','Y')`, [catX, tenant, domain, catY]);
    const content = JSON.stringify({ question: "q", options: ["a", "b"], correct: 1, rationale: "r" });
    for (const [i, q] of qids.entries()) {
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by, domain_id, category_id)
         VALUES ($1,$2,$3,'mcq','t',1,'active',$4::jsonb,1,$5,$6,$7)`,
        [q, pack, level, content, admin, domain, i < 2 ? catX : catY],
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

describe("A3-1 withheld questions", () => {
  it("locked block is a stub until entered, a stub again once left; position returns the content", async () => {
    const { attemptId, userId } = await setup(LOCKED);
    let qs = await get(userId, attemptId);
    for (const id of [qids[2], qids[3]] as string[]) {
      const q = byId(qs, id);
      expect(isStub(q)).toBe(true);
      expect(q).toMatchObject({ topic: "", answer_guidance: "", section_index: 1, type: "mcq", points: 1 });
      expect("passage" in q).toBe(false);
      expect(JSON.stringify(q)).not.toMatch(LEAK);
    }
    for (const id of [qids[0], qids[1]] as string[]) expect(byId(qs, id).withheld).toBeUndefined();
    expect(JSON.stringify(byId(qs, qids[0] as string))).toMatch(/options/);

    const r = await pos(userId, attemptId, { section_index: 1, question_id: qids[2] as string });
    expect(r.question?.question_id).toBe(qids[2]);
    expect(JSON.stringify(r.question)).toMatch(/options/);
    expect(r.question?.withheld).toBeUndefined();

    // Resume inside the block: entered questions are readable.
    qs = await get(userId, attemptId);
    expect(byId(qs, qids[2] as string).withheld).toBeUndefined();
    expect(byId(qs, qids[3] as string).withheld).toBeUndefined();

    await pos(userId, attemptId, { section_index: 0 });
    qs = await get(userId, attemptId);
    expect(isStub(byId(qs, qids[2] as string))).toBe(true);
    expect(isStub(byId(qs, qids[3] as string))).toBe(true);
    expect(byId(qs, qids[0] as string).withheld).toBeUndefined();
  });

  it("timed section: unviewed questions are stubs; a position call returns content and later GETs show it", async () => {
    const { attemptId, userId } = await setup(TIMED);
    let qs = await get(userId, attemptId);
    expect(isStub(byId(qs, qids[0] as string))).toBe(true);
    expect(isStub(byId(qs, qids[1] as string))).toBe(true);
    expect(byId(qs, qids[2] as string).withheld).toBeUndefined();

    const r = await pos(userId, attemptId, { question_id: qids[0] as string });
    expect(r.question?.question_id).toBe(qids[0]);
    expect(JSON.stringify(r.question)).toMatch(/options/);
    expect(r.question_ends_at).not.toBeNull();

    qs = await get(userId, attemptId);
    expect(byId(qs, qids[0] as string).withheld).toBeUndefined();
    expect(JSON.stringify(byId(qs, qids[0] as string))).toMatch(/options/);
    expect(isStub(byId(qs, qids[1] as string))).toBe(true);
  });

  it("by-id probe of a locked question without entering the block returns no content", async () => {
    const { attemptId, userId } = await setup(LOCKED);
    const r = await pos(userId, attemptId, { question_id: qids[2] as string });
    expect(r.question).toBeUndefined();
    expect(isStub(byId(await get(userId, attemptId), qids[2] as string))).toBe(true);
  });

  it("no locked or timed section: no stubs", async () => {
    const { attemptId, userId } = await setup(PLAIN);
    const qs = await get(userId, attemptId);
    expect(qs).toHaveLength(4);
    for (const q of qs) {
      expect(q.withheld).toBeUndefined();
      expect(q.content).not.toBeNull();
    }
  });
});
