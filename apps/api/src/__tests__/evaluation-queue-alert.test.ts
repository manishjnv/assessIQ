/**
 * Worker job `evaluation.queue_alert` (Phase II SP11) — the platform owner is emailed when
 * evaluations have waited more than 24 hours, at most once per 24 hours (Redis gate).
 *
 *   - gate logic with a fake Redis (SET NX EX semantics): first tick sends, the next hourly
 *     tick does not; a tick that sends nothing frees the gate; nothing overdue -> no key
 *   - the REAL count query against Postgres (system role): only attempts with a non-MCQ
 *     question that are unevaluated / graded-but-unreleased, older than 24 h, candidate not
 *     erased, tenant active
 * Module 13's mailer is not touched (the sender is injected).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("@assessiq/notifications", () => ({ emitAttemptEventAfterCommit: vi.fn(async () => undefined),
  notifyEvaluationReadyAfterCommit: vi.fn(async () => undefined),
  sendEvaluationQueueAlertEmail: vi.fn(),
  // the worker module also imports these at top level
  sendResultReleasedEmail: vi.fn(),
  processEmailSendJob: vi.fn(),
  processWebhookDeliverJob: vi.fn(),
  webhookBackoffStrategy: vi.fn(),
}));

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import {
  EVAL_QUEUE_ALERT_JOB_NAME,
  EVAL_QUEUE_ALERT_REDIS_KEY,
  countOverdueEvaluations,
  processEvaluationQueueAlertTick,
} from "../jobs/evaluation-queue-alert.js";
import { JOB_RETRY_POLICY } from "../worker.js";

// ---------------------------------------------------------------------------
// Gate logic (no database)
// ---------------------------------------------------------------------------

/** Minimal Redis with SET NX EX semantics (TTL is not simulated: "within 24 h" = the key exists). */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, _mode: "EX", _seconds: number, _nx: "NX") => {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK" as const;
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
}

describe("evaluation.queue_alert — once per 24 h", () => {
  it("emails every recipient with the count + oldest age; the next hourly tick does not send again", async () => {
    const redis = fakeRedis();
    const send = vi.fn(async () => ({ sent: 2 }));
    const deps = {
      countOverdue: async () => ({ count: 3, oldestAgeHours: 41.26 }),
      recipients: ["a@x.test", "b@x.test"],
      send,
    };

    const first = await processEvaluationQueueAlertTick(redis, deps);
    expect(first).toMatchObject({ overdue: 3, alerted: true, sent: 2 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ to: ["a@x.test", "b@x.test"], count: 3, oldestAgeHours: 41.26 });
    expect(redis.set).toHaveBeenCalledWith(EVAL_QUEUE_ALERT_REDIS_KEY, expect.any(String), "EX", 86_400, "NX");

    // an hour later the key is still there (24 h TTL) -> still overdue, but no second email
    const second = await processEvaluationQueueAlertTick(redis, deps);
    expect(second).toMatchObject({ overdue: 3, alerted: false, sent: 0 });
    expect(send).toHaveBeenCalledTimes(1);

    // after the TTL expired the alert fires again
    redis.store.clear();
    expect((await processEvaluationQueueAlertTick(redis, deps)).alerted).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("nothing overdue -> no email and no key", async () => {
    const redis = fakeRedis();
    const send = vi.fn(async () => ({ sent: 1 }));
    const r = await processEvaluationQueueAlertTick(redis, { countOverdue: async () => ({ count: 0, oldestAgeHours: 0 }), recipients: ["a@x.test"], send });
    expect(r).toMatchObject({ overdue: 0, alerted: false });
    expect(send).not.toHaveBeenCalled();
    expect(redis.store.size).toBe(0);
  });

  it("a tick where no email could be sent frees the gate, so the next tick retries", async () => {
    const redis = fakeRedis();
    const send = vi.fn(async () => ({ sent: 0 }));
    const deps = { countOverdue: async () => ({ count: 1, oldestAgeHours: 30 }), recipients: ["a@x.test"], send };
    const r = await processEvaluationQueueAlertTick(redis, deps);
    expect(r).toMatchObject({ alerted: false, sent: 0 });
    expect(redis.store.has(EVAL_QUEUE_ALERT_REDIS_KEY)).toBe(false);

    send.mockResolvedValueOnce({ sent: 1 });
    expect((await processEvaluationQueueAlertTick(redis, deps)).alerted).toBe(true);
  });

  it("no recipients configured -> no email, no key; the job has a one-attempt retry policy", async () => {
    const redis = fakeRedis();
    const send = vi.fn(async () => ({ sent: 1 }));
    const r = await processEvaluationQueueAlertTick(redis, { countOverdue: async () => ({ count: 2, oldestAgeHours: 50 }), recipients: [], send });
    expect(r.alerted).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(redis.store.size).toBe(0);
    expect(JOB_RETRY_POLICY[EVAL_QUEUE_ALERT_JOB_NAME]?.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The real count query (testcontainers Postgres)
// ---------------------------------------------------------------------------

const toFsPath = (url: URL): string => url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MODULES_ROOT = join(toFsPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "modules");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined],
  ["12-embed-sdk", ["0073_attempt_embed_origin.sql"]],
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
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_evalalert" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_evalalert`;

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
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

/** One tenant + assessment, then attempts of a given age/status/question types. */
async function seedTenant(status = "active") {
  const [id, admin, pack, level, assessment] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name, status) VALUES ($1,$2,'T',$3)`, [id, `t-${id.slice(0, 8)}`, status]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [admin, id, `a-${id.slice(0, 6)}@ea.test`]);
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`, [pack, id, `p-${pack.slice(0, 8)}`, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [level, pack]);
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'A','active',1,$5)`,
      [assessment, id, pack, level, admin],
    );
  });
  return { id, admin, pack, level, assessment };
}

async function addAttempt(
  t: Awaited<ReturnType<typeof seedTenant>>,
  o: { status: string; hoursAgo: number; type?: "subjective" | "mcq"; erased?: boolean; released?: boolean },
): Promise<void> {
  const [cand, attemptId, qid] = [randomUUID(), randomUUID(), randomUUID()];
  await sup(async (c) => {
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status, erased_at) VALUES ($1,$2,$3,'Cand','candidate','active',$4)`, [cand, t.id, `c-${cand.slice(0, 8)}@ea.test`, o.erased === true ? new Date() : null]);
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds, evaluation_released_at)
       VALUES ($1,$2,$3,$4,$5, now() - ($6::numeric * interval '1 hour') - interval '1 hour', now() - ($6::numeric * interval '1 hour'), 3600, CASE WHEN $7::boolean THEN now() END)`,
      [attemptId, t.id, t.assessment, cand, o.status, o.hoursAgo, o.released === true],
    );
    await c.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'t',10,'active','{"question":"q"}'::jsonb,1,$5)`,
      [qid, t.pack, t.level, o.type ?? "subjective", t.admin],
    );
    await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,1,1)`, [attemptId, qid]);
  });
}

describe("countOverdueEvaluations — the real query", () => {
  it("counts only unevaluated / graded-unreleased attempts with a non-MCQ question, older than 24 h, non-erased, active tenant", async () => {
    const t = await seedTenant();
    const suspended = await seedTenant("suspended");

    expect(await countOverdueEvaluations()).toEqual({ count: 0, oldestAgeHours: 0 });

    await addAttempt(t, { status: "submitted", hoursAgo: 30 }); // counted — the oldest
    await addAttempt(t, { status: "graded", hoursAgo: 26, released: false }); // counted — evaluated, not yet released
    await addAttempt(t, { status: "pending_admin_grading", hoursAgo: 25 }); // counted
    await addAttempt(t, { status: "submitted", hoursAgo: 2 }); // too fresh
    await addAttempt(t, { status: "submitted", hoursAgo: 40, type: "mcq" }); // MCQ-only: never needs the platform
    await addAttempt(t, { status: "submitted", hoursAgo: 40, erased: true }); // erased candidate
    await addAttempt(t, { status: "graded", hoursAgo: 40, released: true }); // already with the tenant
    await addAttempt(t, { status: "released", hoursAgo: 40, released: true }); // published
    await addAttempt(suspended, { status: "submitted", hoursAgo: 40 }); // suspended tenant

    const r = await countOverdueEvaluations();
    expect(r.count).toBe(3);
    expect(r.oldestAgeHours).toBeGreaterThan(29.9);
    expect(r.oldestAgeHours).toBeLessThan(30.2);
  });
});
