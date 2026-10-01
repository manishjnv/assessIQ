/**
 * releaseAttemptInTx (SP2) — the one shared "publish a finished result" core.
 * Integration (testcontainers Postgres, real audit_log + certificates, RLS on).
 *
 * Covers: erased gate (422), not-ready gate (409), exactly one grading.released audit
 * row with the right actor/trigger, certificate issued only here (>=70%), system actor
 * (audit actor_kind 'system', actor_user_id NULL), and the SAVEPOINT guarantee: a
 * certificate failure (JS error OR SQL error) never rolls the release back.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readFile as readSrc } from "node:fs/promises";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { CERT_SIGNING_SECRET_ENV } from "@assessiq/certification";
import { ACTION_CATALOG } from "@assessiq/audit-log";
import { releaseAttemptInTx, type ReleaseActor } from "../release.js";

const toFsPath = (url: URL): string => url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const MODULES_ROOT = join(THIS_DIR, "..", "..", "..");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["14-audit-log", undefined],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined],
  ["07-ai-grading", ["0040_gradings.sql", "0041_tenant_grading_budgets.sql", "0100_attempts_ai_proposals_cache.sql"]],
  ["09-scoring", undefined],
  ["18-certification", undefined],
  ["20-data-rights", ["0102_users_erased_at.sql"]],
];

let container: StartedTestContainer;
let url: string;
let tenant: string;
let admin: string;
const SECRET = "release-test-signing-secret";

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_release" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_release`;

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

  tenant = randomUUID();
  admin = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-rel','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@rel.test','Admin','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(() => {
  process.env[CERT_SIGNING_SECRET_ENV] = SECRET;
});
afterEach(() => {
  process.env[CERT_SIGNING_SECRET_ENV] = SECRET;
});

interface Opts {
  status?: string;
  evalReleased?: boolean;
  pct?: number;
  erased?: boolean;
}

/** One-question attempt with an attempt_scores row at `pct` percent (out of 100). */
async function seed(o: Opts = {}): Promise<{ attemptId: string; candidateId: string }> {
  const pack = randomUUID();
  const level = randomUUID();
  const assessment = randomUUID();
  const cand = randomUUID();
  const attemptId = randomUUID();
  const pct = o.pct ?? 80;
  await sup(async (c) => {
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`,
      [pack, tenant, `p-${randomUUID().slice(0, 8)}`, admin],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`,
      [level, pack],
    );
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'SOC Analyst L1','active',1,$5)`,
      [assessment, tenant, pack, level, admin],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status, erased_at) VALUES ($1,$2,$3,'Priya Sharma','candidate','active',$4)`,
      [cand, tenant, `c-${randomUUID().slice(0, 6)}@rel.test`, o.erased === true ? new Date() : null],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds, evaluation_released_at)
       VALUES ($1,$2,$3,$4,$5, now() - interval '30 minutes', now(), 3600, $6)`,
      [attemptId, tenant, assessment, cand, o.status ?? "graded", o.evalReleased === false ? null : new Date()],
    );
    await c.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review) VALUES ($1,$2,$3,100,$3,false)`,
      [attemptId, tenant, pct],
    );
  });
  return { attemptId, candidateId: cand };
}

const release = (attemptId: string, actor: ReleaseActor, trigger?: "manual" | "auto") =>
  withTenant(tenant, (c) =>
    releaseAttemptInTx(c, { tenantId: tenant, attemptId, actor, ...(trigger !== undefined ? { trigger } : {}) }),
  );
const userActor = (): ReleaseActor => ({ kind: "user", userId: admin });
const status = (id: string) => sup((c) => c.query(`SELECT status FROM attempts WHERE id=$1`, [id]).then((r) => r.rows[0].status as string));
const audits = (id: string, action: string) =>
  sup((c) =>
    c
      .query(`SELECT actor_kind, actor_user_id::text, before, after FROM audit_log WHERE entity_id=$1 AND action=$2`, [id, action])
      .then((r) => r.rows as Array<{ actor_kind: string; actor_user_id: string | null; before: Record<string, unknown>; after: Record<string, unknown> }>),
  );
const certs = (attemptId: string) =>
  sup((c) => c.query(`SELECT tier, credential_id FROM certificates WHERE attempt_id=$1`, [attemptId]).then((r) => r.rows as Array<{ tier: string; credential_id: string }>));
const certAudits = (attemptId: string) =>
  sup((c) =>
    c
      .query(
        `SELECT al.action, al.actor_kind, al.actor_user_id::text
           FROM audit_log al JOIN certificates ce ON ce.id = al.entity_id
          WHERE ce.attempt_id = $1 AND al.action LIKE 'certification.cert.%'`,
        [attemptId],
      )
      .then((r) => r.rows as Array<{ action: string; actor_kind: string; actor_user_id: string | null }>),
  );

describe("releaseAttemptInTx — happy path", () => {
  it("publishes: status released, ONE grading.released audit row (user actor, trigger manual), certificate issued at >=70%", async () => {
    const { attemptId } = await seed({ pct: 80 });
    expect(await release(attemptId, userActor())).toEqual({ released: true });
    expect(await status(attemptId)).toBe("released");

    const rows = await audits(attemptId, "grading.released");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "user",
      actor_user_id: admin,
      before: { attempt_status: "graded" },
      after: { attempt_status: "released", trigger: "manual" },
    });

    const cs = await certs(attemptId);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.tier).toBe("completion");
    expect(await certAudits(attemptId)).toEqual([{ action: "certification.cert.issue", actor_kind: "user", actor_user_id: admin }]);
  });

  it(">=90% issues a 'distinction' certificate; <70% releases without any certificate", async () => {
    const hi = await seed({ pct: 95 });
    await release(hi.attemptId, userActor());
    expect((await certs(hi.attemptId))[0]!.tier).toBe("distinction");

    const low = await seed({ pct: 55 });
    await release(low.attemptId, userActor());
    expect(await status(low.attemptId)).toBe("released");
    expect(await certs(low.attemptId)).toHaveLength(0);
  });
});

describe("releaseAttemptInTx — system actor (auto-release)", () => {
  it("system actor: audit rows have actor_kind 'system' and actor_user_id NULL; trigger defaults to 'auto'", async () => {
    const { attemptId } = await seed({ pct: 80 });
    await release(attemptId, { kind: "system" });
    const [row] = await audits(attemptId, "grading.released");
    expect(row).toMatchObject({ actor_kind: "system", actor_user_id: null, after: { attempt_status: "released", trigger: "auto" } });
    expect(await certAudits(attemptId)).toEqual([{ action: "certification.cert.issue", actor_kind: "system", actor_user_id: null }]);
  });

  it("a user actor with an explicit 'auto' trigger (sweep attributing to the evaluator) keeps the user but records auto", async () => {
    const { attemptId } = await seed();
    await release(attemptId, userActor(), "auto");
    const [row] = await audits(attemptId, "grading.released");
    expect(row).toMatchObject({ actor_kind: "user", actor_user_id: admin, after: { trigger: "auto" } });
  });
});

describe("releaseAttemptInTx — gates", () => {
  it("erased candidate -> 422 AIG_ATTEMPT_NOT_RELEASABLE_ERASED; nothing changes (no flip, no audit, no certificate)", async () => {
    const { attemptId } = await seed({ erased: true });
    await expect(release(attemptId, userActor())).rejects.toMatchObject({ code: "AIG_ATTEMPT_NOT_RELEASABLE_ERASED", status: 422 });
    expect(await status(attemptId)).toBe("graded");
    expect(await audits(attemptId, "grading.released")).toHaveLength(0);
    expect(await certs(attemptId)).toHaveLength(0);
  });

  it.each([
    ["not graded yet (submitted)", { status: "submitted" }],
    ["pending_admin_grading", { status: "pending_admin_grading" }],
    ["graded but the evaluation is not released to the tenant", { evalReleased: false }],
    ["already released", { status: "released" }],
  ])("409 RESULT_NOT_READY when %s; nothing changes", async (_label, opts) => {
    const { attemptId } = await seed(opts as Opts);
    const before = await status(attemptId);
    await expect(release(attemptId, userActor())).rejects.toMatchObject({ code: "RESULT_NOT_READY", status: 409 });
    expect(await status(attemptId)).toBe(before);
    expect(await audits(attemptId, "grading.released")).toHaveLength(0);
  });

  it("404 for an unknown attempt (and for another tenant's attempt under RLS)", async () => {
    await expect(release(randomUUID(), userActor())).rejects.toMatchObject({ code: "AIG_ATTEMPT_NOT_FOUND", status: 404 });
    const otherTenant = randomUUID();
    await sup(async (c) => {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,'O')`, [otherTenant, `o-${otherTenant.slice(0, 8)}`]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [otherTenant]);
    });
    const { attemptId } = await seed();
    await expect(
      withTenant(otherTenant, (c) => releaseAttemptInTx(c, { tenantId: otherTenant, attemptId, actor: { kind: "system" } })),
    ).rejects.toMatchObject({ code: "AIG_ATTEMPT_NOT_FOUND" });
    expect(await status(attemptId)).toBe("graded");
  });

  it("two concurrent releases: exactly one wins (one audit row, one certificate), the other gets 409", async () => {
    const { attemptId } = await seed({ pct: 85 });
    const res = await Promise.allSettled([release(attemptId, userActor()), release(attemptId, { kind: "system" })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "RESULT_NOT_READY", status: 409 });
    expect(await audits(attemptId, "grading.released")).toHaveLength(1);
    expect(await certs(attemptId)).toHaveLength(1);
  });
});

describe("releaseAttemptInTx — a certificate failure never rolls the release back (SAVEPOINT)", () => {
  it("JS error inside certificate issuance (signing secret missing): release + audit commit, no certificate", async () => {
    const { attemptId } = await seed({ pct: 85 });
    delete process.env[CERT_SIGNING_SECRET_ENV];
    await release(attemptId, userActor());
    expect(await status(attemptId)).toBe("released");
    expect(await audits(attemptId, "grading.released")).toHaveLength(1);
    expect(await certs(attemptId)).toHaveLength(0);
  });

  it("SQL error inside certificate issuance (aborted tx state): rolled back to the savepoint, release still commits", async () => {
    const { attemptId } = await seed({ pct: 85 });
    await sup((c) =>
      c.query(`CREATE OR REPLACE FUNCTION t_cert_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cert insert blocked'; END $$;
               CREATE TRIGGER t_cert_fail BEFORE INSERT ON certificates FOR EACH ROW EXECUTE FUNCTION t_cert_fail()`),
    );
    try {
      await release(attemptId, userActor());
    } finally {
      await sup((c) => c.query(`DROP TRIGGER t_cert_fail ON certificates`));
    }
    expect(await status(attemptId)).toBe("released");
    expect(await audits(attemptId, "grading.released")).toHaveLength(1);
    expect(await certs(attemptId)).toHaveLength(0);
  });
});

describe("releaseAttemptInTx — atomicity + structure", () => {
  it("an audit INSERT failure rolls the whole release back (no half-published result)", async () => {
    const { attemptId } = await seed({ pct: 85 });
    await sup((c) => c.query(`ALTER TABLE audit_log ADD CONSTRAINT _t_rel_atomic CHECK (false) NOT VALID`));
    try {
      await expect(release(attemptId, userActor())).rejects.toThrow();
    } finally {
      await sup((c) => c.query(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS _t_rel_atomic`));
    }
    expect(await status(attemptId)).toBe("graded");
    expect(await certs(attemptId)).toHaveLength(0);
  });

  it("release.ts has exactly one auditInTx call site, 'grading.released' (in ACTION_CATALOG), no `new Function`", async () => {
    const src = await readSrc(join(THIS_DIR, "..", "release.ts"), "utf-8");
    expect((src.match(/auditInTx\s*\(/g) ?? []).length).toBe(1);
    expect(src).toMatch(/["']grading\.released["']/);
    expect(ACTION_CATALOG).toContain("grading.released");
    expect(src).not.toMatch(/new\s+Function/);
    expect(src).not.toMatch(/from\s+["']@assessiq\/notifications["']/); // no email inside the release tx
  });
});
