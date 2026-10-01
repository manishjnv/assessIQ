/**
 * Auto-release sweep (worker job `result.auto_release`, SP2) — testcontainers Postgres.
 *
 * The sweep publishes finished results for tenants in result_release_mode='auto', but
 * ONLY results that became ready after the tenant switched to auto; a manual tenant's
 * queue is never touched. Module 13's email is mocked (covered by 13's own tests).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const emailMock = vi.fn();
vi.mock("@assessiq/notifications", () => ({
  sendResultReleasedEmail: (...a: unknown[]) => emailMock(...a),
  // the worker module also imports these at top level
  processEmailSendJob: vi.fn(),
  processWebhookDeliverJob: vi.fn(),
  webhookBackoffStrategy: vi.fn(),
}));

import { setPoolForTesting, closePool, updateResultReleaseMode } from "@assessiq/tenancy";
import { CERT_SIGNING_SECRET_ENV } from "@assessiq/certification";
import {
  AUTO_RELEASE_BATCH,
  AUTO_RELEASE_JOB_NAME,
  processAutoReleaseTick,
  resetAutoReleaseCooldownForTesting,
} from "../jobs/auto-release.js";
import { JOB_RETRY_POLICY } from "../worker.js";

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
  process.env[CERT_SIGNING_SECRET_ENV] = "auto-release-test-secret";
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_autorel" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_autorel`;

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

interface T {
  id: string;
  admin: string;
  assessment: string;
}

/** A tenant with an assessment. mode 'auto' => result_release_auto_since = `sinceMinAgo` minutes ago (default 60). */
async function seedTenant(opts: { mode?: "manual" | "auto"; sinceMinAgo?: number | null; status?: string } = {}): Promise<T> {
  const id = randomUUID();
  const admin = randomUUID();
  const pack = randomUUID();
  const level = randomUUID();
  const assessment = randomUUID();
  const mode = opts.mode ?? "auto";
  const since = mode === "auto" ? (opts.sinceMinAgo === undefined ? 60 : opts.sinceMinAgo) : null;
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name, status) VALUES ($1,$2,'T',$3)`, [id, `t-${id.slice(0, 8)}`, opts.status ?? "active"]);
    await c.query(
      `INSERT INTO tenant_settings (tenant_id, result_release_mode, result_release_auto_since)
       VALUES ($1,$2, ${since === null ? "NULL" : `now() - interval '${since} minutes'`})`,
      [id, mode],
    );
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [admin, id, `a-${id.slice(0, 6)}@ar.test`]);
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`,
      [pack, id, `p-${pack.slice(0, 8)}`, admin],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`,
      [level, pack],
    );
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'A','active',1,$5)`,
      [assessment, id, pack, level, admin],
    );
  });
  return { id, admin, assessment };
}

interface A {
  status?: string;
  /** minutes ago the evaluation was released; null => never */
  evalAgoMin?: number | null;
  erased?: boolean;
  embed?: boolean;
  pct?: number;
  evaluator?: string; // evaluation_released_by
  /** the newest effective grade is review_needed (e.g. an AI failure after a re-run) */
  flagged?: boolean;
}

async function addAttempt(t: T, o: A = {}): Promise<string> {
  const cand = randomUUID();
  const attemptId = randomUUID();
  const evalAgo = o.evalAgoMin === undefined ? 0 : o.evalAgoMin;
  await sup(async (c) => {
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status, erased_at) VALUES ($1,$2,$3,'Cand','candidate','active',$4)`,
      [cand, t.id, `c-${randomUUID().slice(0, 8)}@ar.test`, o.erased === true ? new Date() : null],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds, embed_origin, evaluation_released_at, evaluation_released_by)
       VALUES ($1,$2,$3,$4,$5, now() - interval '2 hours', now() - interval '1 hour', 3600, $6,
               ${evalAgo === null ? "NULL" : `now() - interval '${evalAgo} minutes'`}, $7)`,
      [attemptId, t.id, t.assessment, cand, o.status ?? "graded", o.embed === true, o.evaluator ?? null],
    );
    await c.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review) VALUES ($1,$2,$3,100,$3,false)`,
      [attemptId, t.id, o.pct ?? 80],
    );
    if (o.flagged === true) {
      const qid = randomUUID();
      const asm = await c.query<{ pack_id: string; level_id: string }>(`SELECT pack_id, level_id FROM assessments WHERE id=$1`, [t.assessment]);
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,'subjective','t',10,'active','{"question":"q"}'::jsonb,1,$4)`,
        [qid, asm.rows[0]!.pack_id, asm.rows[0]!.level_id, t.admin],
      );
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,1,1)`, [attemptId, qid]);
      await c.query(
        `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model)
         VALUES ($1,$2,$3,'ai',0,10,'review_needed','error:no-sha','error','none')`,
        [t.id, attemptId, qid],
      );
    }
  });
  return attemptId;
}

const status = (id: string) => sup((c) => c.query(`SELECT status FROM attempts WHERE id=$1`, [id]).then((r) => r.rows[0].status as string));
const releasedAudit = (id: string) =>
  sup((c) =>
    c
      .query(`SELECT actor_kind, actor_user_id::text, after FROM audit_log WHERE entity_id=$1 AND action='grading.released'`, [id])
      .then((r) => r.rows as Array<{ actor_kind: string; actor_user_id: string | null; after: Record<string, unknown> }>),
  );
const emailed = () => emailMock.mock.calls.map((c) => (c[0] as { attemptId: string }).attemptId);
/** Sweep until a tick finds nothing (other tests' leftovers are drained first by unique tenants anyway). */
const tick = () => processAutoReleaseTick();

describe("auto-release sweep", () => {
  it("publishes a finished result of an auto tenant: status released, ONE audit row (system, trigger auto), certificate, email after commit", async () => {
    const t = await seedTenant({ mode: "auto", sinceMinAgo: 60 });
    const id = await addAttempt(t, { evalAgoMin: 1, pct: 85 });
    let statusWhenEmailed: string | undefined;
    emailMock.mockImplementation(async () => {
      statusWhenEmailed = await status(id);
    });

    const r = await tick();
    expect(r.released).toBeGreaterThanOrEqual(1);
    expect(await status(id)).toBe("released");
    const audit = await releasedAudit(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: "system", actor_user_id: null, after: { attempt_status: "released", trigger: "auto" } });
    expect(await sup((c) => c.query(`SELECT COUNT(*)::int n FROM certificates WHERE attempt_id=$1`, [id]).then((x) => x.rows[0].n))).toBe(1);
    expect(emailed()).toEqual([id]);
    expect(emailMock).toHaveBeenCalledWith({ tenantId: t.id, attemptId: id });
    expect(statusWhenEmailed).toBe("released"); // emailed only after the release tx committed

    // idempotent: nothing left for this tenant
    emailMock.mockClear();
    await tick();
    expect(emailMock).not.toHaveBeenCalled();
    expect((await releasedAudit(id)).length).toBe(1);
  });

  it("ONLY results that became ready AFTER the switch: an older ready result of the same auto tenant stays graded", async () => {
    const t = await seedTenant({ mode: "auto", sinceMinAgo: 30 });
    const before = await addAttempt(t, { evalAgoMin: 45 }); // ready 45 min ago, switched 30 min ago
    const after = await addAttempt(t, { evalAgoMin: 5 });
    await tick();
    expect(await status(before)).toBe("graded");
    expect(await releasedAudit(before)).toHaveLength(0);
    expect(await status(after)).toBe("released");
    expect(emailed()).toEqual([after]);
  });

  it("end-to-end through the real setting: results already waiting when the tenant switches to auto stay graded; one made ready AFTER the switch is released", async () => {
    const t = await seedTenant({ mode: "manual" });
    const waiting1 = await addAttempt(t, { evalAgoMin: 120 });
    const waiting2 = await addAttempt(t, { evalAgoMin: 10 });

    // manual tenant: the sweep never touches the queue
    await tick();
    expect(await status(waiting1)).toBe("graded");
    expect(await status(waiting2)).toBe("graded");

    // admin switches to auto (the real 02 service: stamps result_release_auto_since = now())
    await updateResultReleaseMode(t.admin, t.id, "auto");
    await tick();
    expect(await status(waiting1)).toBe("graded");
    expect(await status(waiting2)).toBe("graded");

    // a result completes AFTER the switch -> released by the sweep
    await sup((c) => c.query(`SELECT pg_sleep(0.05)`)); // strictly after the stamp
    const fresh = await addAttempt(t, { evalAgoMin: 0 });
    await tick();
    expect(await status(fresh)).toBe("released");
    expect(await status(waiting1)).toBe("graded");
    expect(await status(waiting2)).toBe("graded");
    expect(emailed()).toEqual([fresh]);

    // back to manual then auto again: the boundary moves to the NEW switch moment
    await updateResultReleaseMode(t.admin, t.id, "manual");
    const midManual = await addAttempt(t, { evalAgoMin: 0 });
    await sup((c) => c.query(`SELECT pg_sleep(0.05)`));
    await updateResultReleaseMode(t.admin, t.id, "auto");
    await tick();
    expect(await status(midManual)).toBe("graded"); // became ready while manual -> still waits for an explicit release
  });

  it("a manual tenant is untouched; so is an 'auto' tenant that has no result_release_auto_since", async () => {
    const manual = await seedTenant({ mode: "manual" });
    const inconsistent = await seedTenant({ mode: "auto", sinceMinAgo: null });
    const m = await addAttempt(manual, { evalAgoMin: 1 });
    const i = await addAttempt(inconsistent, { evalAgoMin: 1 });
    await tick();
    expect(await status(m)).toBe("graded");
    expect(await status(i)).toBe("graded");
    expect(emailed()).not.toContain(m);
    expect(emailed()).not.toContain(i);
  });

  it("never releases: erased candidates, embed attempts, suspended tenants, not-yet-graded, evaluation-not-released", async () => {
    const t = await seedTenant({ mode: "auto", sinceMinAgo: 60 });
    const suspended = await seedTenant({ mode: "auto", sinceMinAgo: 60, status: "suspended" });
    const erased = await addAttempt(t, { evalAgoMin: 1, erased: true });
    const embed = await addAttempt(t, { evalAgoMin: 1, embed: true });
    const submitted = await addAttempt(t, { evalAgoMin: 1, status: "submitted" });
    const notEvaluated = await addAttempt(t, { evalAgoMin: null });
    const inSuspended = await addAttempt(suspended, { evalAgoMin: 1 });
    await tick();
    expect(await status(erased)).toBe("graded");
    expect(await status(embed)).toBe("graded");
    expect(await status(submitted)).toBe("submitted");
    expect(await status(notEvaluated)).toBe("graded");
    expect(await status(inSuspended)).toBe("graded");
    for (const id of [erased, embed, submitted, notEvaluated, inSuspended]) {
      expect(await releasedAudit(id)).toHaveLength(0);
      expect(emailed()).not.toContain(id);
    }
  });

  it("attributes the release to the user who released the evaluation when there is one (trigger stays 'auto')", async () => {
    const t = await seedTenant({ mode: "auto", sinceMinAgo: 60 });
    const id = await addAttempt(t, { evalAgoMin: 1, evaluator: t.admin });
    await tick();
    const [row] = await releasedAudit(id);
    expect(row).toMatchObject({ actor_kind: "user", actor_user_id: t.admin, after: { trigger: "auto" } });
  });

  it("an email failure never undoes a published result", async () => {
    const t = await seedTenant({ mode: "auto", sinceMinAgo: 60 });
    const id = await addAttempt(t, { evalAgoMin: 1 });
    emailMock.mockRejectedValue(new Error("brevo down"));
    const r = await tick();
    expect(r.failed).toBe(0);
    expect(await status(id)).toBe("released");
  });

  it(`releases at most ${AUTO_RELEASE_BATCH} per tick, oldest first; the rest on the next tick`, async () => {
    const t = await seedTenant({ mode: "auto", sinceMinAgo: 600 });
    const ids: string[] = [];
    for (let i = 0; i < AUTO_RELEASE_BATCH + 2; i++) ids.push(await addAttempt(t, { evalAgoMin: 500 - i })); // ids[0] oldest
    const first = await tick();
    expect(first.candidates).toBe(AUTO_RELEASE_BATCH);
    expect(await status(ids[0]!)).toBe("released");
    expect(await status(ids[AUTO_RELEASE_BATCH]!)).toBe("graded");
    expect(await status(ids[AUTO_RELEASE_BATCH + 1]!)).toBe("graded");
    await tick();
    expect(await status(ids[AUTO_RELEASE_BATCH]!)).toBe("released");
    expect(await status(ids[AUTO_RELEASE_BATCH + 1]!)).toBe("released");
  });

  it("a poison attempt is logged, cooled down (not retried every tick), does not block the others, and is retried after the cooldown", async () => {
    const t = await seedTenant({ mode: "auto", sinceMinAgo: 60 });
    const a = await addAttempt(t, { evalAgoMin: 5 });
    const bad = await addAttempt(t, { evalAgoMin: 4 });
    const c = await addAttempt(t, { evalAgoMin: 3 });
    await sup((cl) =>
      cl.query(`CREATE OR REPLACE FUNCTION t_ar_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${bad}' AND NEW.status = 'released' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$;
                CREATE TRIGGER t_ar_fail BEFORE UPDATE ON attempts FOR EACH ROW EXECUTE FUNCTION t_ar_fail()`),
    );
    const t0 = Date.now();
    try {
      const r1 = await processAutoReleaseTick(t0);
      expect(r1).toMatchObject({ failed: 1 });
      expect(await status(a)).toBe("released");
      expect(await status(c)).toBe("released");
      expect(await status(bad)).toBe("graded");

      // next tick inside the cooldown: the poison attempt is not even selected
      const r2 = await processAutoReleaseTick(t0 + 15_000);
      expect(r2).toMatchObject({ candidates: 0, failed: 0 });
    } finally {
      await sup((cl) => cl.query(`DROP TRIGGER t_ar_fail ON attempts`));
    }
    // after the cooldown it is retried (and now succeeds)
    const r3 = await processAutoReleaseTick(t0 + 11 * 60_000);
    expect(r3).toMatchObject({ released: 1 });
    expect(await status(bad)).toBe("released");
  });

  it("P1: an attempt whose effective grade is flagged review_needed is NOT published; it is cooled down (not re-selected every tick)", async () => {
    const t = await seedTenant({ mode: "auto", sinceMinAgo: 60 });
    const flagged = await addAttempt(t, { evalAgoMin: 5, flagged: true });
    const ok = await addAttempt(t, { evalAgoMin: 4 });
    const t0 = Date.now();
    const r1 = await processAutoReleaseTick(t0);
    expect(r1).toMatchObject({ candidates: 2, released: 1, skipped: 1, failed: 0 });
    expect(await status(flagged)).toBe("graded");
    expect(await releasedAudit(flagged)).toHaveLength(0);
    expect(await status(ok)).toBe("released");
    expect(emailed()).toEqual([ok]);

    // inside the cooldown it is not even selected again (no hot loop, no starvation)
    const r2 = await processAutoReleaseTick(t0 + 15_000);
    expect(r2).toMatchObject({ candidates: 0, released: 0, skipped: 0 });

    // once the grade is resolved (override) and the cooldown has passed it is published
    await sup((c) =>
      c.query(
        `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model)
         SELECT tenant_id, attempt_id, question_id, 'admin_override', 8, 10, 'correct', 'sha-ov', 'v1', 'm' FROM gradings WHERE attempt_id=$1 LIMIT 1`,
        [flagged],
      ),
    );
    const r3 = await processAutoReleaseTick(t0 + 11 * 60_000);
    expect(r3).toMatchObject({ released: 1 });
    expect(await status(flagged)).toBe("released");
  });

  it("two overlapping ticks release each attempt exactly once (one audit row, one email each)", async () => {
    const t = await seedTenant({ mode: "auto", sinceMinAgo: 60 });
    const ids = [await addAttempt(t, { evalAgoMin: 3 }), await addAttempt(t, { evalAgoMin: 2 }), await addAttempt(t, { evalAgoMin: 1 })];
    await Promise.all([tick(), tick()]);
    for (const id of ids) {
      expect(await status(id)).toBe("released");
      expect(await releasedAudit(id)).toHaveLength(1);
    }
    expect(emailed().filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort());
  });

  it("never throws: a broken candidate query is logged and the tick returns zeros", async () => {
    await sup((c) => c.query(`ALTER TABLE tenant_settings RENAME COLUMN result_release_mode TO result_release_mode_x`));
    try {
      await expect(processAutoReleaseTick()).resolves.toEqual({ candidates: 0, released: 0, skipped: 0, failed: 0 });
    } finally {
      await sup((c) => c.query(`ALTER TABLE tenant_settings RENAME COLUMN result_release_mode_x TO result_release_mode`));
    }
  });
});

describe("worker wiring", () => {
  it("result.auto_release has a retry policy: attempts 1 (the 15 s repeat is the retry)", () => {
    expect(AUTO_RELEASE_JOB_NAME).toBe("result.auto_release");
    expect(JOB_RETRY_POLICY[AUTO_RELEASE_JOB_NAME]?.attempts).toBe(1);
  });

  it("the worker module does not import @assessiq/ai-grading (no AI on the worker path)", async () => {
    const src = (await readFile(join(MODULES_ROOT, "..", "apps", "api", "src", "worker.ts"), "utf-8")) +
      (await readFile(join(MODULES_ROOT, "..", "apps", "api", "src", "jobs", "auto-release.ts"), "utf-8"));
    expect(src).not.toMatch(/from\s+["']@assessiq\/ai-grading["']|import\(\s*["']@assessiq\/ai-grading["']\s*\)/);
  });
});
