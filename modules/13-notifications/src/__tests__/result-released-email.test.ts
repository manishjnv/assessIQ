/**
 * sendResultReleasedEmail (SP4) — integration against a real Postgres (RLS on).
 * Only sendEmail (render + queue) is mocked: the point is the DATA the email is
 * built from — final score text, pass/fail, portal + certificate links — and the
 * gates (released only, never erased, never embed, never throws).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const sendEmailMock = vi.fn();
vi.mock("../email/index.js", () => ({
  sendEmail: (...a: unknown[]) => sendEmailMock(...a),
  processEmailSendJob: vi.fn(),
}));

import { config } from "@assessiq/core";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { sendResultReleasedEmail } from "../email/result-released.js";

const MODULES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined],
  ["12-embed-sdk", ["0073_attempt_embed_origin.sql"]],
  ["07-ai-grading", ["0040_gradings.sql"]],
  ["09-scoring", undefined],
  ["18-certification", undefined],
  ["20-data-rights", ["0102_users_erased_at.sql"]],
];

let container: StartedTestContainer;
let url: string;
let tenant: string;
let otherTenant: string;
let admin: string;
const SLUG = "acme-uni";

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_rr_email" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_rr_email`;

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

  tenant = randomUUID();
  otherTenant = randomUUID();
  admin = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,'Acme University'),($3,'other','Other')`, [tenant, SLUG, otherTenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1),($2) ON CONFLICT DO NOTHING`, [tenant, otherTenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@acme.test','A','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
});

interface Opts {
  status?: string;
  earned?: number | null;
  max?: number;
  passing?: number;
  erased?: boolean;
  embed?: boolean;
  name?: string;
  cert?: { credentialId: string; revoked?: boolean };
}

async function seed(o: Opts = {}): Promise<{ attemptId: string; email: string }> {
  const pack = randomUUID();
  const level = randomUUID();
  const assessment = randomUUID();
  const cand = randomUUID();
  const attemptId = randomUUID();
  const email = `c-${randomUUID().slice(0, 6)}@acme.test`;
  await sup(async (c) => {
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`,
      [pack, tenant, `p-${randomUUID().slice(0, 8)}`, admin],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,$3)`,
      [level, pack, o.passing ?? 60],
    );
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'SOC Analyst L1','active',1,$5)`,
      [assessment, tenant, pack, level, admin],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status, erased_at) VALUES ($1,$2,$3,$4,'candidate','active',$5)`,
      [cand, tenant, email, o.name ?? "Priya Sharma", o.erased === true ? new Date() : null],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, duration_seconds, embed_origin)
       VALUES ($1,$2,$3,$4,$5, now() - interval '10 minutes', 3600, $6)`,
      [attemptId, tenant, assessment, cand, o.status ?? "released", o.embed === true],
    );
    if (o.earned !== null) {
      await c.query(
        `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review)
         VALUES ($1,$2,$3,$4,$5,false)`,
        [attemptId, tenant, o.earned ?? 42, o.max ?? 60, ((o.earned ?? 42) / (o.max ?? 60)) * 100],
      );
    }
    if (o.cert !== undefined) {
      await c.query(
        `INSERT INTO certificates (tenant_id, attempt_id, candidate_id, template_key, credential_id, tier, display_name, course_title, level, signed_hash, revoked_at)
         VALUES ($1,$2,$3,'standard',$4,'completion','Priya Sharma','SOC Analyst L1','L1','sig',$5)`,
        [tenant, attemptId, cand, o.cert.credentialId, o.cert.revoked === true ? new Date() : null],
      );
    }
  });
  return { attemptId, email };
}

const lastCall = () => sendEmailMock.mock.calls.at(-1)?.[0] as {
  to: string;
  template: string;
  tenantId: string;
  vars: Record<string, unknown>;
};

describe("sendResultReleasedEmail", () => {
  it("sends the final score, pass/fail and portal link for a released attempt", async () => {
    const { attemptId, email } = await seed({ earned: 42, max: 60, passing: 60 });
    await sendResultReleasedEmail({ tenantId: tenant, attemptId });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = lastCall();
    expect(call).toMatchObject({ to: email, template: "result_released", tenantId: tenant });
    expect(call.vars).toMatchObject({
      candidateName: "Priya Sharma",
      assessmentName: "SOC Analyst L1",
      tenantName: "Acme University",
      scoreText: "42 / 60 (70%)",
      resultText: "Passed",
    });
    const portal = new URL(call.vars["portalLink"] as string);
    expect(portal.origin).toBe(new URL(config.ASSESSIQ_BASE_URL).origin);
    expect(portal.pathname).toBe("/candidate/login");
    expect(portal.searchParams.get("tenant")).toBe(SLUG);
    expect(call.vars["certificateLink"]).toBeUndefined();
  });

  it("'Not passed' below the level's passing score; decimals are trimmed to 2 dp, percent to 1 dp", async () => {
    const { attemptId } = await seed({ earned: 41.5, max: 60, passing: 70 });
    await sendResultReleasedEmail({ tenantId: tenant, attemptId });
    expect(lastCall().vars).toMatchObject({ scoreText: "41.5 / 60 (69.2%)", resultText: "Not passed" });
  });

  it("the pass mark is inclusive (percent >= passing_score_pct)", async () => {
    const { attemptId } = await seed({ earned: 36, max: 60, passing: 60 });
    await sendResultReleasedEmail({ tenantId: tenant, attemptId });
    expect(lastCall().vars).toMatchObject({ scoreText: "36 / 60 (60%)", resultText: "Passed" });
  });

  it("includes the certificate verify link only for an active (non-revoked) certificate", async () => {
    const withCert = await seed({ cert: { credentialId: "AIQ-2026-10-TEST01" } });
    await sendResultReleasedEmail({ tenantId: tenant, attemptId: withCert.attemptId });
    expect(new URL(lastCall().vars["certificateLink"] as string).pathname).toBe("/verify/AIQ-2026-10-TEST01");

    sendEmailMock.mockClear();
    const revoked = await seed({ cert: { credentialId: "AIQ-2026-10-TEST02", revoked: true } });
    await sendResultReleasedEmail({ tenantId: tenant, attemptId: revoked.attemptId });
    expect(lastCall().vars["certificateLink"]).toBeUndefined();
  });

  it("falls back to a neutral greeting when the candidate has no name", async () => {
    const { attemptId } = await seed({ name: "   " });
    await sendResultReleasedEmail({ tenantId: tenant, attemptId });
    expect(lastCall().vars["candidateName"]).toBe("there");
  });

  it.each([
    ["graded (not published yet)", { status: "graded" }],
    ["submitted", { status: "submitted" }],
    ["erased candidate (DPDP)", { erased: true }],
    ["embed attempt", { embed: true }],
    ["no score row", { earned: null }],
  ])("sends NOTHING for %s", async (_label, opts) => {
    const { attemptId } = await seed(opts as Opts);
    await sendResultReleasedEmail({ tenantId: tenant, attemptId });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends nothing (and does not throw) for an unknown attempt or another tenant's attempt (RLS)", async () => {
    await expect(sendResultReleasedEmail({ tenantId: tenant, attemptId: randomUUID() })).resolves.toBeUndefined();
    const { attemptId } = await seed();
    await expect(sendResultReleasedEmail({ tenantId: otherTenant, attemptId })).resolves.toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("is best-effort: a failing sendEmail never throws into the release flow", async () => {
    const { attemptId } = await seed();
    sendEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendResultReleasedEmail({ tenantId: tenant, attemptId })).resolves.toBeUndefined();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("is best-effort: a database error (bad id) never throws either", async () => {
    await expect(sendResultReleasedEmail({ tenantId: tenant, attemptId: "not-a-uuid" })).resolves.toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
