/**
 * Z-172 - the organisation switch for the candidate answer key (testcontainers Postgres).
 * Covers: default off, the switch can only hide more, Mock/Real/embed, release gate, owner check,
 * cross-tenant isolation (RLS), the toggle race (flag and level read in one statement), the audit row,
 * FUT-2 for candidates (licensed content shows no expected answer or explanation), and the rule that
 * the key never appears in the attempt or submit payloads.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";

import { setPoolForTesting, closePool, withTenant, updateCandidateAnswerKey, getCandidateAnswerKey } from "@assessiq/tenancy";
import { getCandidateFeedback } from "../feedback.js";
import { getCandidateResult, listCandidateResults } from "../result.js";
import { getAttemptForCandidate, submitAttempt } from "../service.js";

let container: StartedTestContainer;
let url: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_z172" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_z172`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(url);

  tenantA = randomUUID();
  tenantB = randomUUID();
  adminA = randomUUID();
  adminB = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'z172-a','Org A'),($2,'z172-b','Org B')`, [tenantA, tenantB]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1),($2) ON CONFLICT DO NOTHING`, [tenantA, tenantB]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@z172.test','A','admin','active'),($3,$4,'b@z172.test','B','admin','active')`,
      [adminA, tenantA, adminB, tenantB],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const setSwitch = (tenant: string, on: boolean) =>
  sup((c) => c.query(`UPDATE tenant_settings SET candidate_answer_key = $2 WHERE tenant_id = $1`, [tenant, on]));

interface Seeded { attemptId: string; userId: string; own: string; licensed: string }

/** A Mock (default) attempt with one own MCQ and one licensed (cloned) MCQ. */
async function seed(
  tenant: string,
  owner: string,
  opts: { status?: string; mode?: "real" | "mock"; embed?: boolean; level?: string } = {},
): Promise<Seeded> {
  const pack = randomUUID(); const level = randomUUID(); const asm = randomUUID();
  const userId = randomUUID(); const attemptId = randomUUID();
  const own = randomUUID(); const base = randomUUID(); const licensed = randomUUID();
  const status = opts.status ?? "released";
  await sup(async (c) => {
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`, [pack, tenant, `p-${randomUUID().slice(0, 8)}`, owner]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [level, pack]);
    await c.query(`INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by, settings) VALUES ($1,$2,$3,$4,1,'A','active',2,$5,$6::jsonb)`, [asm, tenant, pack, level, owner, JSON.stringify({ feedback_level: opts.level ?? "with_expected_answer" })]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`, [userId, tenant, `c-${userId.slice(0, 6)}@z172.test`]);
    const live = status === "in_progress";
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds, delivery_mode, embed_origin)
       VALUES ($1,$2,$3,$4,$5, now() - interval '20 minutes', now() + interval '40 minutes', ${live ? "NULL" : "now()"}, 3600, $6, $7)`,
      [attemptId, tenant, asm, userId, status, opts.mode ?? "mock", opts.embed === true],
    );
    const content = JSON.stringify({ question: "Which is private?", options: ["8.8.8.8", "10.0.0.1", "1.1.1.1", "9.9.9.9"], correct: 1, rationale: "SECRETRATIONALE" });
    let pos = 1;
    for (const [qid, src] of [[own, null], [base, null], [licensed, base]] as const) {
      await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by, source_question_id) VALUES ($1,$2,$3,'mcq','t',10,'active',$4::jsonb,1,$5,$6)`, [qid, pack, level, content, owner, src]);
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, owner]);
      if (qid === base) continue; // the base only exists so the clone has a source
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,$3,1)`, [attemptId, qid, pos++]);
      await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [attemptId, qid, JSON.stringify({ selected: 1 })]);
      if (!live) {
        await c.query(`INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model) VALUES ($1,$2,$3,'deterministic',10,10,'correct','sha','lbl','m')`, [tenant, attemptId, qid]);
      }
    }
    if (!live) await c.query(`INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, pass_mark_pct) VALUES ($1,$2,20,20,100,false,60)`, [attemptId, tenant]);
  });
  return { attemptId, userId, own, licensed };
}

const levelOfResult = async (tenant: string, s: Seeded): Promise<string> => {
  const v = await getCandidateResult(tenant, s.userId, s.attemptId);
  if (v.status !== "released") throw new Error(`expected released, got ${v.status}`);
  return v.feedback_level;
};

describe("Z-172 organisation switch", () => {
  it("default is off: a new tenant_settings row has candidate_answer_key = false", async () => {
    const t = randomUUID();
    await sup(async (c) => {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,'D')`, [t, `d-${t.slice(0, 8)}`]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [t]);
    });
    expect(await getCandidateAnswerKey(t)).toBe(false);
  });

  it("OFF: no items, and the result view and list say none, even at the highest assessment level", async () => {
    await setSwitch(tenantA, false);
    const s = await seed(tenantA, adminA, { level: "with_ai_justification" });
    expect(await getCandidateFeedback(tenantA, s.userId, s.attemptId)).toEqual({ level: "none", items: [] });
    expect(await levelOfResult(tenantA, s)).toBe("none");
    expect((await listCandidateResults(tenantA, s.userId)).items.find((i) => i.attempt_id === s.attemptId)?.feedback_level).toBe("none");
  });

  it("ON + Mock + released + assessment level: the key shows; the assessment level still hides more", async () => {
    await setSwitch(tenantA, true);
    const s = await seed(tenantA, adminA, { level: "with_expected_answer" });
    const r = await getCandidateFeedback(tenantA, s.userId, s.attemptId);
    expect(r.level).toBe("with_expected_answer");
    expect(r.items.find((i) => i.question_id === s.own)).toMatchObject({ your_answer: "10.0.0.1", outcome: "correct", expected_answer: "10.0.0.1" });
    expect(await levelOfResult(tenantA, s)).toBe("with_expected_answer");
    // switch ON but the assessment level is none: still none (the switch cannot show more)
    const none = await seed(tenantA, adminA, { level: "none" });
    expect(await getCandidateFeedback(tenantA, none.userId, none.attemptId)).toEqual({ level: "none", items: [] });
  });

  it("ON: Real and embed attempts still get none", async () => {
    await setSwitch(tenantA, true);
    for (const o of [{ mode: "real" as const }, { embed: true }]) {
      const s = await seed(tenantA, adminA, o);
      expect(await getCandidateFeedback(tenantA, s.userId, s.attemptId)).toEqual({ level: "none", items: [] });
      expect(await levelOfResult(tenantA, s)).toBe("none");
    }
  });

  it("ON but the result is not released: 409 RESULT_NOT_READY; another candidate: 404", async () => {
    await setSwitch(tenantA, true);
    const s = await seed(tenantA, adminA, { status: "submitted" });
    await expect(getCandidateFeedback(tenantA, s.userId, s.attemptId)).rejects.toMatchObject({ status: 409 });
    const done = await seed(tenantA, adminA);
    await expect(getCandidateFeedback(tenantA, randomUUID(), done.attemptId)).rejects.toMatchObject({ status: 404 });
  });

  it("licensed content (FUT-2): candidate sees right or wrong and own answer, never the expected answer or explanation", async () => {
    await setSwitch(tenantA, true);
    const s = await seed(tenantA, adminA, { level: "with_ai_justification" });
    const items = (await getCandidateFeedback(tenantA, s.userId, s.attemptId)).items;
    const own = items.find((i) => i.question_id === s.own)!;
    const lic = items.find((i) => i.question_id === s.licensed)!;
    expect(own.expected_answer).toBe("10.0.0.1");
    expect(lic).toMatchObject({ outcome: "correct", your_answer: "10.0.0.1", expected_answer: null, explanation: null });
    expect(JSON.stringify(items)).not.toContain("SECRETRATIONALE");
  });
});

describe("Z-172 cross-tenant isolation", () => {
  it("tenant A switch ON does not change tenant B candidates", async () => {
    await setSwitch(tenantA, true);
    await setSwitch(tenantB, false);
    const b = await seed(tenantB, adminB);
    expect(await getCandidateFeedback(tenantB, b.userId, b.attemptId)).toEqual({ level: "none", items: [] });
    const a = await seed(tenantA, adminA);
    expect((await getCandidateFeedback(tenantA, a.userId, a.attemptId)).level).toBe("with_expected_answer");
  });

  it("RLS: inside tenant B only B's row is visible and A's cannot be changed", async () => {
    await setSwitch(tenantA, false);
    const seen = await withTenant(tenantB, async (c) => {
      const rows = await c.query(`SELECT tenant_id FROM tenant_settings`);
      const upd = await c.query(`UPDATE tenant_settings SET candidate_answer_key = true WHERE tenant_id = $1`, [tenantA]);
      return { tenants: rows.rows.map((r) => r.tenant_id), updated: upd.rowCount };
    });
    expect(seen).toEqual({ tenants: [tenantB], updated: 0 });
    expect(await getCandidateAnswerKey(tenantA)).toBe(false);
  });

  it("a tenant B candidate asking for a tenant A attempt gets 404", async () => {
    await setSwitch(tenantA, true);
    const a = await seed(tenantA, adminA);
    await expect(getCandidateFeedback(tenantB, a.userId, a.attemptId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("Z-172 toggle race", () => {
  it("an uncommitted toggle is not seen; the committed value is used; the next read sees the change at once", async () => {
    await setSwitch(tenantA, true);
    const s = await seed(tenantA, adminA);
    const writer = new Client({ connectionString: url });
    await writer.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(`UPDATE tenant_settings SET candidate_answer_key = false WHERE tenant_id = $1`, [tenantA]);
      // the reader does not wait and does not see the uncommitted OFF: flag and level come from one snapshot
      expect((await getCandidateFeedback(tenantA, s.userId, s.attemptId)).items.length).toBe(2);
      await writer.query("COMMIT");
    } finally {
      await writer.end();
    }
    expect(await getCandidateFeedback(tenantA, s.userId, s.attemptId)).toEqual({ level: "none", items: [] });
    await setSwitch(tenantA, true);
    expect((await getCandidateFeedback(tenantA, s.userId, s.attemptId)).items.length).toBe(2);
  });
});

describe("Z-172 setting service", () => {
  it("writes one audit row in the same transaction; a no-op writes none; a non-boolean is refused", async () => {
    await setSwitch(tenantB, false);
    const before = await sup((c) => c.query(`SELECT count(*)::int n FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.settings.updated'`, [tenantB]));
    const r = await updateCandidateAnswerKey(adminB, tenantB, true);
    expect(r).toMatchObject({ candidate_answer_key: true, previous: false });
    expect(r.auditId).not.toBeNull();
    const row = await sup((c) => c.query(`SELECT actor_user_id, before, after FROM audit_log WHERE id = $1`, [r.auditId]));
    expect(row.rows[0]).toMatchObject({ actor_user_id: adminB, before: { candidate_answer_shown: false }, after: { candidate_answer_shown: true } });
    const same = await updateCandidateAnswerKey(adminB, tenantB, true);
    expect(same.auditId).toBeNull();
    const after = await sup((c) => c.query(`SELECT count(*)::int n FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.settings.updated'`, [tenantB]));
    expect(after.rows[0].n - before.rows[0].n).toBe(1);
    await expect(updateCandidateAnswerKey(adminB, tenantB, "yes")).rejects.toMatchObject({ status: 400 });
    await setSwitch(tenantB, false);
  });
});

describe("Z-172 payloads never hold the key", () => {
  const KEY_FIELDS = /"(correct|correct_order|rationale|expected_answer|explanation|answer_key|items)"|SECRETRATIONALE/;

  it("the live attempt payload and the submit response carry no answer key, switch ON", async () => {
    await setSwitch(tenantA, true);
    const s = await seed(tenantA, adminA, { status: "in_progress" });
    const live = await getAttemptForCandidate(tenantA, s.attemptId, s.userId);
    expect(JSON.stringify(live)).not.toMatch(KEY_FIELDS);
    const sub = await submitAttempt(tenantA, s.userId, s.attemptId);
    expect(JSON.stringify(sub)).not.toMatch(KEY_FIELDS);
  });

  it("the take routes only return the attempt view (no feedback import in routes.take.ts)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const take = readFileSync(join(here, "..", "routes.take.ts"), "utf-8");
    expect(take).not.toMatch(/getCandidateFeedback|feedback\.js/);
  });
});

describe("Z-172 admin redaction does not depend on the switch", () => {
  it("no admin or question-bank source reads candidate_answer_key", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        if (f === "__tests__" || f === "node_modules") return [];
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    for (const mod of ["04-question-bank", "05-assessment-lifecycle"]) {
      for (const f of walk(join(here, "..", "..", "..", mod, "src"))) {
        expect(readFileSync(f, "utf-8"), f).not.toContain("candidate_answer_key");
      }
    }
  });
});
