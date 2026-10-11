/**
 * RW-39 — the boundary tick and the timer sweep find their tenants with ONE
 * cross-tenant query (withSystemRole) instead of looping over every active tenant.
 *
 * Live Postgres (Testcontainers), no mocks. Drives the real processBoundaryTick /
 * processTimerSweepTick exported from worker.ts. Redis is not needed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { processBoundaryTick, processTimerSweepTick } from "../worker.js";

const THIS_DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MODULES_ROOT = join(THIS_DIR, "..", "..", "..", "..", "modules");

let pg: StartedTestContainer;
let pgUrl: string;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: pgUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function applyDir(c: Client, dir: string, only?: string[]): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of only ? files.filter((x) => only.includes(x)) : files) {
    await c.query(await readFile(join(dir, f), "utf8"));
  }
}

beforeAll(async () => {
  pg = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "assessiq", POSTGRES_PASSWORD: "assessiq_test_pw", POSTGRES_DB: "assessiq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  pgUrl = `postgres://assessiq:assessiq_test_pw@${pg.getHost()}:${pg.getMappedPort(5432)}/assessiq`;
  await sup(async (c) => {
    await applyDir(c, join(MODULES_ROOT, "02-tenancy", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "03-users", "migrations"), ["020_users.sql"]);
    await applyDir(c, join(MODULES_ROOT, "04-question-bank", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "05-assessment-lifecycle", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "06-attempt-engine", "migrations"));
  });
  setPoolForTesting(pgUrl);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (pg !== undefined) await pg.stop();
}, 30_000);

interface Seed {
  tenant: string;
  admin: string;
  user: string;
  pack: string;
  level: string;
}

async function seedTenant(status: "active" | "suspended" = "active", tenant: string = randomUUID()): Promise<Seed> {
  const s: Seed = { tenant, admin: randomUUID(), user: randomUUID(), pack: randomUUID(), level: randomUUID() };
  const slug = `t-${tenant.slice(0, 8)}`;
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name, status) VALUES ($1,$2,'T',$3)`, [tenant, slug, status]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'A','admin','active'), ($4,$2,$5,'C','candidate','active')`,
      [s.admin, tenant, `a@${slug}.test`, s.user, `c@${slug}.test`],
    );
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p','P','soc','published',$3)`,
      [s.pack, tenant, s.admin],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`,
      [s.level, s.pack],
    );
  });
  return s;
}

async function addAssessment(s: Seed, status: string, opensAt: string | null, closesAt: string | null): Promise<string> {
  const id = randomUUID();
  await sup((c) =>
    c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, opens_at, closes_at, created_by)
       VALUES ($1,$2,$3,$4,1,'A',$5,1, ${opensAt ?? "NULL"}, ${closesAt ?? "NULL"}, $6)`,
      [id, s.tenant, s.pack, s.level, status, s.admin],
    ),
  );
  return id;
}

const PAST = "now() - interval '1 hour'";
const LONG_PAST = "now() - interval '2 hours'";
const FUTURE = "now() + interval '1 day'";

const statusOf = async (id: string): Promise<string> =>
  sup(async (c) => (await c.query(`SELECT status FROM assessments WHERE id = $1`, [id])).rows[0].status as string);

describe("boundary tick — cross-tenant discovery", () => {
  it("flips due assessments in both tenants, leaves not-due and suspended-tenant rows, visits exactly the 2 due tenants", async () => {
    const t1 = await seedTenant();
    const t2 = await seedTenant();
    const t3 = await seedTenant(); // active tenant, nothing due
    const dead = await seedTenant("suspended"); // due row, but tenant not active
    const due1 = await addAssessment(t1, "published", PAST, null);
    const notDue1 = await addAssessment(t1, "published", FUTURE, null);
    const due2 = await addAssessment(t2, "active", LONG_PAST, PAST); // active -> closed
    const notDue2 = await addAssessment(t2, "published", FUTURE, null);
    const notDue3 = await addAssessment(t3, "published", FUTURE, null);
    const deadDue = await addAssessment(dead, "published", PAST, null);

    const out = await processBoundaryTick();

    expect(out.tenants).toBe(2);
    expect(out.activated).toBe(1);
    expect(out.closed).toBe(1);
    expect(await statusOf(due1)).toBe("active");
    expect(await statusOf(due2)).toBe("closed");
    expect(await statusOf(notDue1)).toBe("published");
    expect(await statusOf(notDue2)).toBe("published");
    expect(await statusOf(notDue3)).toBe("published");
    expect(await statusOf(deadDue)).toBe("published");

    // Idempotent steady state: nothing due now, so zero tenants are visited.
    expect((await processBoundaryTick()).tenants).toBe(0);
  });

  it("a failure for tenant A does not stop tenant B", async () => {
    const [idA, idB] = [randomUUID() as string, randomUUID() as string].sort() as [string, string]; // A sorts first, so it runs first
    const a = await seedTenant("active", idA);
    const b = await seedTenant("active", idB);
    const dueA = await addAssessment(a, "published", PAST, null);
    const dueB = await addAssessment(b, "published", PAST, null);
    await sup(async (c) => {
      await c.query(
        `CREATE FUNCTION test_fail_a() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure for tenant A'; END $$`,
      );
      await c.query(
        `CREATE TRIGGER test_fail_a BEFORE UPDATE ON assessments FOR EACH ROW WHEN (NEW.tenant_id = '${idA}') EXECUTE FUNCTION test_fail_a()`,
      );
    });
    try {
      const out = await processBoundaryTick();
      expect(out.tenants).toBe(2);
      expect(out.activated).toBe(1); // only B
      expect(await statusOf(dueA)).toBe("published");
      expect(await statusOf(dueB)).toBe("active");
    } finally {
      await sup((c) => c.query(`DROP TRIGGER test_fail_a ON assessments; DROP FUNCTION test_fail_a()`));
    }
  });
});

describe("timer sweep — cross-tenant discovery", () => {
  it("auto-submits expired attempts in both tenants, leaves a live attempt, visits exactly the 2 due tenants", async () => {
    const mk = async (endsAt: string): Promise<{ s: Seed; attempt: string }> => {
      const s = await seedTenant();
      const assessment = await addAssessment(s, "active", PAST, FUTURE);
      const attempt = randomUUID();
      await sup((c) =>
        c.query(
          `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, duration_seconds)
           VALUES ($1,$2,$3,$4,'in_progress', now() - interval '2 hours', ${endsAt}, 3600)`,
          [attempt, s.tenant, assessment, s.user],
        ),
      );
      return { s, attempt };
    };
    const one = await mk(PAST);
    const two = await mk(PAST);
    const live = await mk(FUTURE);

    const out = await processTimerSweepTick();

    expect(out.tenants).toBe(2);
    expect(out.autoSubmitted).toBe(2);
    const st = async (id: string): Promise<string> =>
      sup(async (c) => (await c.query(`SELECT status FROM attempts WHERE id = $1`, [id])).rows[0].status as string);
    expect(await st(one.attempt)).toBe("auto_submitted");
    expect(await st(two.attempt)).toBe("auto_submitted");
    expect(await st(live.attempt)).toBe("in_progress");

    expect((await processTimerSweepTick()).tenants).toBe(0);
  });
});
