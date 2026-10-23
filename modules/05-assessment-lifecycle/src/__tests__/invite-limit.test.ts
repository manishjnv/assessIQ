/**
 * EXP-37 — capacity limit of INVITED students per assessment.
 *
 * Real Postgres (testcontainers): the limit lives in tenant_plans.max_invited_per_assessment
 * (migration 0249), is counted over ACTIVE invitations (pending, viewed, started) of ONE assessment
 * and is enforced inside the invite transaction under an advisory lock.
 * The email shim and the super-admin notice are mocked (the notice has its own test in module 13).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";

const { sendInvitationEmail, notifyInviteLimitBlocked } = vi.hoisted(() => ({
  sendInvitationEmail: vi.fn(),
  notifyInviteLimitBlocked: vi.fn(),
}));
vi.mock("../email.js", () => ({ sendInvitationEmail, resolveCameraRequired: vi.fn(async () => false) }));
vi.mock("@assessiq/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyInviteLimitBlocked,
}));

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { ConflictError } from "@assessiq/core";
import { createAssessment, publishAssessment, inviteUsers, resendInvitation, revokeInvitation } from "../service.js";
import { setRevokeAttemptSubmitter } from "../service/revoke-submitter.js";
import { AL_ERROR_CODES } from "../types.js";
import { createPack, addLevel, createQuestion, publishPack } from "../../../04-question-bank/src/service.js";

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "19-billing", "migrations", "0249_tenant_plans_max_invited_per_assessment.sql");

let container: StartedTestContainer;
let containerUrl: string;

interface Org { tenantId: string; adminId: string; packId: string; levelId: string }
let orgA: Org; // tier free, limit set to 5 below
let orgB: Org; // tier free, default limit 150 (never touched)
let orgC: Org; // tier internal, unlimited (NULL)

async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
const sql = (text: string, params: unknown[] = []) => withSuperClient((c) => c.query(text, params)).then((r) => r.rows);

async function makeOrg(slug: string, tier: "free" | "internal", limit: number | null | "default"): Promise<Org> {
  const tenantId = randomUUID();
  const adminId = randomUUID();
  await sql(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [tenantId, slug, `Org ${slug}`]);
  await sql(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenantId]);
  await sql(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Admin Person', 'admin', 'active')`, [adminId, tenantId, `admin-${slug}@example.com`]);
  await sql(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, $2, $3)`, [tenantId, tier, tier === "internal" ? null : 2500]);
  if (limit !== "default") await sql(`UPDATE tenant_plans SET max_invited_per_assessment = $2 WHERE tenant_id = $1`, [tenantId, limit]);
  if (tier !== "internal") await sql(`INSERT INTO tenant_entitlements (tenant_id, scope_type, scope_id) VALUES ($1, 'domain', 'soc')`, [tenantId]);
  const pack = await createPack(tenantId, { slug: `p-${slug}`, name: `Pack ${slug}`, domain: "soc" }, adminId);
  const level = await addLevel(tenantId, pack.id, { position: 1, label: "L1", duration_minutes: 30, default_question_count: 3 }, adminId);
  for (let i = 0; i < 3; i++) {
    await createQuestion(
      tenantId,
      { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `q-${i}`, points: 5, content: { question: `Q${i}?`, options: ["A", "B", "C", "D"], correct: 0, rationale: "A." } },
      adminId,
    );
  }
  await publishPack(tenantId, pack.id, adminId);
  await sql(`UPDATE questions SET status = 'active', review_state = 'verified' WHERE pack_id = $1`, [pack.id]);
  return { tenantId, adminId, packId: pack.id, levelId: level.id };
}

async function newAssessment(org: Org, name: string): Promise<string> {
  const a = await createAssessment(
    org.tenantId,
    { pack_id: org.packId, level_id: org.levelId, name, question_count: 3, opens_at: new Date(Date.now() + 3_600_000) },
    org.adminId,
  );
  await publishAssessment(org.tenantId, a.id, org.adminId);
  return a.id;
}

async function newCandidates(org: Org, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => randomUUID());
  for (const id of ids) {
    await sql(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Cand', 'candidate', 'active')`, [id, org.tenantId, `c-${id.slice(0, 8)}@example.com`]);
  }
  return ids;
}

/** Put `n` invitations straight into the table with the given status (fast set-up of the active count). */
async function seedInvitations(org: Org, assessmentId: string, n: number, status: string): Promise<void> {
  for (const userId of await newCandidates(org, n)) {
    await sql(
      `INSERT INTO assessment_invitations (id, assessment_id, user_id, token_hash, expires_at, status, invited_by)
       VALUES ($1, $2, $3, $4, now() + interval '7 days', $5, $6)`,
      [randomUUID(), assessmentId, userId, randomUUID() + randomUUID(), status, org.adminId],
    );
  }
}

const countInvitations = async (assessmentId: string): Promise<number> =>
  parseInt(((await sql(`SELECT count(*) AS n FROM assessment_invitations WHERE assessment_id = $1`, [assessmentId]))[0] as { n: string }).n, 10);

async function limitError(p: Promise<unknown>): Promise<ConflictError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictError);
    return e as ConflictError;
  }
  throw new Error("expected INVITE_LIMIT_EXCEEDED");
}

const blockedAuditRows = (tenantId: string) =>
  sql(`SELECT entity_id::text, after FROM audit_log WHERE tenant_id = $1 AND action = 'assessment.invite_limit_blocked' ORDER BY at`, [tenantId]);

setRevokeAttemptSubmitter(async (client, _tenantId, attemptId) => {
  await client.query(`UPDATE attempts SET status = 'submitted', submitted_at = now() WHERE id = $1`, [attemptId]);
});

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_invlimit_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_invlimit_test`;
  await withSuperClient(async (client) => {
    await applyAllMigrations(client);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_system`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(containerUrl);
  orgA = await makeOrg("lim-a", "free", 5);
  orgB = await makeOrg("lim-b", "free", "default");
  orgC = await makeOrg("lim-c", "internal", null);
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

beforeEach(() => {
  sendInvitationEmail.mockReset();
  sendInvitationEmail.mockResolvedValue(undefined);
  notifyInviteLimitBlocked.mockReset();
  notifyInviteLimitBlocked.mockResolvedValue(true);
});

describe("invite limit", () => {
  it("allows exactly the limit, blocks one over with the exact code and message, inserts nothing", async () => {
    const a = await newAssessment(orgA, "At the limit");
    const users = await newCandidates(orgA, 6);
    const ok = await inviteUsers(orgA.tenantId, a, users.slice(0, 5), orgA.adminId);
    expect(ok.invited).toHaveLength(5);

    const sent = sendInvitationEmail.mock.calls.length;
    const err = await limitError(inviteUsers(orgA.tenantId, a, [users[5]!], orgA.adminId));
    expect(err.status).toBe(409);
    expect(err.details?.["code"]).toBe(AL_ERROR_CODES.INVITE_LIMIT_EXCEEDED);
    expect(err.details).toMatchObject({ limit: 5, active: 5, adding: 1 });
    expect(err.message).toBe(
      "This setup supports up to 5 students for one assessment. Split the group into two assessments at different times, or contact support to raise the limit.",
    );
    expect(await countInvitations(a)).toBe(5);
    expect(sendInvitationEmail.mock.calls.length).toBe(sent); // no email for a refused batch
  });

  it("a batch that would pass the limit inserts and mails nothing at all", async () => {
    const a = await newAssessment(orgA, "Batch over");
    await seedInvitations(orgA, a, 3, "pending");
    const users = await newCandidates(orgA, 3); // 3 active + 3 new = 6 > 5
    await limitError(inviteUsers(orgA.tenantId, a, users, orgA.adminId));
    expect(await countInvitations(a)).toBe(3);
    expect(sendInvitationEmail).not.toHaveBeenCalled();
  });

  it("submitted, expired (revoked) invitations do not count; viewed and started do", async () => {
    const a = await newAssessment(orgA, "Statuses");
    await seedInvitations(orgA, a, 2, "submitted");
    await seedInvitations(orgA, a, 2, "expired");
    const users = await newCandidates(orgA, 5);
    expect((await inviteUsers(orgA.tenantId, a, users, orgA.adminId)).invited).toHaveLength(5);

    const b = await newAssessment(orgA, "Viewed and started");
    await seedInvitations(orgA, b, 3, "viewed");
    await seedInvitations(orgA, b, 2, "started");
    await limitError(inviteUsers(orgA.tenantId, b, await newCandidates(orgA, 1), orgA.adminId));
  });

  it("a user who already has an active invitation does not count twice", async () => {
    const a = await newAssessment(orgA, "No double count");
    const users = await newCandidates(orgA, 5);
    await inviteUsers(orgA.tenantId, a, users, orgA.adminId);
    const again = await inviteUsers(orgA.tenantId, a, users, orgA.adminId);
    expect(again.invited).toHaveLength(0);
    expect(again.skipped).toHaveLength(5);
  });

  it("re-inviting a revoked student counts again; resending a revoked invitation counts again", async () => {
    const a = await newAssessment(orgA, "Revoked comes back");
    const users = await newCandidates(orgA, 5);
    const first = await inviteUsers(orgA.tenantId, a, users, orgA.adminId);
    await revokeInvitation(orgA.tenantId, first.invited[0]!.id, orgA.adminId); // 4 active
    await inviteUsers(orgA.tenantId, a, await newCandidates(orgA, 1), orgA.adminId); // 5 active
    // the revoked one now cannot come back through either path
    await limitError(inviteUsers(orgA.tenantId, a, [users[0]!], orgA.adminId));
    await limitError(resendInvitation(orgA.tenantId, first.invited[0]!.id, orgA.adminId));
  });

  it("limit NULL (internal) is unlimited", async () => {
    const a = await newAssessment(orgC, "Unlimited");
    const users = await newCandidates(orgC, 160);
    const res = await inviteUsers(orgC.tenantId, a, users, orgC.adminId);
    expect(res.invited).toHaveLength(160);
    expect(notifyInviteLimitBlocked).not.toHaveBeenCalled();
  });

  it("a raised per-tenant limit allows more, and a lowered one blocks sooner", async () => {
    const a = await newAssessment(orgA, "Raised");
    await seedInvitations(orgA, a, 5, "pending");
    await limitError(inviteUsers(orgA.tenantId, a, await newCandidates(orgA, 1), orgA.adminId));
    await sql(`UPDATE tenant_plans SET max_invited_per_assessment = 8 WHERE tenant_id = $1`, [orgA.tenantId]);
    try {
      expect((await inviteUsers(orgA.tenantId, a, await newCandidates(orgA, 3), orgA.adminId)).invited).toHaveLength(3);
      await limitError(inviteUsers(orgA.tenantId, a, await newCandidates(orgA, 1), orgA.adminId));
    } finally {
      await sql(`UPDATE tenant_plans SET max_invited_per_assessment = 5 WHERE tenant_id = $1`, [orgA.tenantId]);
    }
  });

  it("the limit of tenant A never affects tenant B (default 150)", async () => {
    const a = await newAssessment(orgB, "Other org");
    const res = await inviteUsers(orgB.tenantId, a, await newCandidates(orgB, 12), orgB.adminId);
    expect(res.invited).toHaveLength(12);
    expect(((await sql(`SELECT max_invited_per_assessment AS m FROM tenant_plans WHERE tenant_id = $1`, [orgB.tenantId]))[0] as { m: number }).m).toBe(150);
  });

  it("two parallel invites at the boundary cannot both pass", async () => {
    const a = await newAssessment(orgA, "Race");
    await seedInvitations(orgA, a, 4, "pending");
    const [u1, u2] = await newCandidates(orgA, 2);
    const results = await Promise.allSettled([
      inviteUsers(orgA.tenantId, a, [u1!], orgA.adminId),
      inviteUsers(orgA.tenantId, a, [u2!], orgA.adminId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await countInvitations(a)).toBe(5);
  });
});

describe("blocked try", () => {
  it("writes an audit row every time (ids and counts only) and calls the notice with the facts", async () => {
    const a = await newAssessment(orgA, "Blocked audit");
    await seedInvitations(orgA, a, 5, "pending");
    const before = (await blockedAuditRows(orgA.tenantId)).length;
    const [u1, u2] = await newCandidates(orgA, 2);
    await limitError(inviteUsers(orgA.tenantId, a, [u1!], orgA.adminId));
    await limitError(inviteUsers(orgA.tenantId, a, [u2!], orgA.adminId));

    const rows = (await blockedAuditRows(orgA.tenantId)).slice(before);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.entity_id).toBe(a);
    expect(rows[0]!.after).toEqual({ assessment_id: a, limit: 5, active: 5, adding: 1 });
    expect(JSON.stringify(rows[0]!.after)).not.toMatch(/@|Admin Person/);

    expect(notifyInviteLimitBlocked).toHaveBeenCalledTimes(2); // throttling lives inside the notice (module 13 test)
    expect(notifyInviteLimitBlocked).toHaveBeenCalledWith({
      tenantId: orgA.tenantId,
      assessmentId: a,
      orgName: "Org lim-a",
      adminName: "Admin Person",
      adminEmail: "admin-lim-a@example.com",
      assessmentName: "Blocked audit",
      tried: 6,
      limit: 5,
    });
  });

  it("a failing notice does not change the 409 the admin sees", async () => {
    notifyInviteLimitBlocked.mockRejectedValue(new Error("redis down"));
    const a = await newAssessment(orgA, "Notice fails");
    await seedInvitations(orgA, a, 5, "pending");
    const err = await limitError(inviteUsers(orgA.tenantId, a, await newCandidates(orgA, 1), orgA.adminId));
    expect(err.details?.["code"]).toBe(AL_ERROR_CODES.INVITE_LIMIT_EXCEEDED);
  });
});

describe("migration 0249", () => {
  it("re-running keeps a value the super admin set; the backfill runs only when it adds the column", async () => {
    const text = await readFile(MIGRATION, "utf8");
    await sql(`UPDATE tenant_plans SET max_invited_per_assessment = 42 WHERE tenant_id = $1`, [orgB.tenantId]);
    await sql(text);
    await sql(text);
    const m = async (t: string) => ((await sql(`SELECT max_invited_per_assessment AS m FROM tenant_plans WHERE tenant_id = $1`, [t]))[0] as { m: number | null }).m;
    expect(await m(orgB.tenantId)).toBe(42);
    expect(await m(orgC.tenantId)).toBeNull();

    // First run on a table without the column: existing rows get 150, internal rows NULL.
    await withSuperClient(async (c) => {
      await c.query("ALTER TABLE tenant_plans DROP COLUMN max_invited_per_assessment");
      await c.query(text);
    });
    expect(await m(orgA.tenantId)).toBe(150);
    expect(await m(orgB.tenantId)).toBe(150);
    expect(await m(orgC.tenantId)).toBeNull();
    await sql(`UPDATE tenant_plans SET max_invited_per_assessment = 5 WHERE tenant_id = $1`, [orgA.tenantId]);
    await expect(sql(`UPDATE tenant_plans SET max_invited_per_assessment = 0 WHERE tenant_id = $1`, [orgA.tenantId])).rejects.toThrow();
  });
});
