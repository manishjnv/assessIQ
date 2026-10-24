/**
 * Z-147 / Z-152 - invite credit hold. Real Postgres (testcontainers).
 *
 * A finite-credit tenant may not invite more students than its free credits cover
 * (free = grant balance minus credits held by open invitations, computed live).
 * Locks: credit_hold per tenant FIRST, invite_limit per assessment second.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
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
import {
  createAssessment,
  publishAssessment,
  inviteUsers,
  resendInvitation,
  revokeInvitation,
  reopenInvitationForRetake,
  precheckInvites,
} from "../service.js";
import { setRevokeAttemptSubmitter } from "../service/revoke-submitter.js";
import { AL_ERROR_CODES } from "../types.js";
import { createPack, addLevel, createQuestion, publishPack } from "../../../04-question-bank/src/service.js";

let container: StartedTestContainer;
let containerUrl: string;

interface Org { tenantId: string; adminId: string; packId: string; levelId: string }
let orgU: Org; // internal tier: unlimited credits

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

async function makeOrg(slug: string, tier: "free" | "internal", credits: number): Promise<Org> {
  const tenantId = randomUUID();
  const adminId = randomUUID();
  await sql(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [tenantId, slug, `Org ${slug}`]);
  await sql(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenantId]);
  await sql(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Admin Person', 'admin', 'active')`, [adminId, tenantId, `admin-${slug}@example.com`]);
  await sql(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, $2, $3)`, [tenantId, tier, tier === "internal" ? null : 2500]);
  if (credits > 0) {
    await sql(`INSERT INTO credit_grants (tenant_id, source, credits, remaining, expires_at) VALUES ($1, 'purchase', $2, $2, now() + interval '300 days')`, [tenantId, credits]);
  }
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

setRevokeAttemptSubmitter(async (client, _tenantId, attemptId) => {
  await client.query(`UPDATE attempts SET status = 'submitted', submitted_at = now() WHERE id = $1`, [attemptId]);
});

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_credithold_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_credithold_test`;
  await withSuperClient(async (client) => {
    await applyAllMigrations(client);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_system`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(containerUrl);
  orgU = await makeOrg("hold-u", "internal", 0);
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

const newOrg = (credits: number): Promise<Org> => makeOrg(`h-${randomUUID().slice(0, 8)}`, "free", credits);

async function seedInvitation(org: Org, assessmentId: string, status: string): Promise<{ id: string; userId: string }> {
  const [userId] = await newCandidates(org, 1);
  const id = randomUUID();
  await sql(
    `INSERT INTO assessment_invitations (id, assessment_id, user_id, token_hash, expires_at, status, invited_by)
     VALUES ($1, $2, $3, $4, now() + interval '7 days', $5, $6)`,
    [id, assessmentId, userId, randomUUID() + randomUUID(), status, org.adminId],
  );
  return { id, userId: userId! };
}

const countInvitations = async (assessmentId: string): Promise<number> =>
  parseInt(((await sql(`SELECT count(*) AS n FROM assessment_invitations WHERE assessment_id = $1`, [assessmentId]))[0] as { n: string }).n, 10);

const statusOf = async (id: string): Promise<string> =>
  ((await sql(`SELECT status FROM assessment_invitations WHERE id = $1`, [id]))[0] as { status: string }).status;

async function creditsError(p: Promise<unknown>): Promise<ConflictError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictError);
    return e as ConflictError;
  }
  throw new Error("expected CREDITS_INSUFFICIENT");
}

beforeEach(() => {
  sendInvitationEmail.mockReset();
  sendInvitationEmail.mockResolvedValue(undefined);
  notifyInviteLimitBlocked.mockReset();
  notifyInviteLimitBlocked.mockResolvedValue(true);
});

describe("credit hold on invite", () => {
  it("refuses a batch over the free credits with the exact code, details and message; inserts and mails nothing", async () => {
    const org = await newOrg(50); // real cost 20: room for 2
    const a = await newAssessment(org, "Over");
    const err = await creditsError(inviteUsers(org.tenantId, a, await newCandidates(org, 3), org.adminId));
    expect(err.status).toBe(409);
    expect(err.details).toMatchObject({ code: AL_ERROR_CODES.CREDITS_INSUFFICIENT, need: 60, available: 50, canInvite: 2, cost: 20 });
    expect(err.message).toBe("You need 60 credits. You have 50 available. Buy credits or invite up to 2 student(s) now.");
    expect(await countInvitations(a)).toBe(0);
    expect(sendInvitationEmail).not.toHaveBeenCalled();
  });

  it("allows exactly the free credits; the next one is refused without the invite-up-to clause", async () => {
    const org = await newOrg(40);
    const a = await newAssessment(org, "Boundary");
    const [u1, u2, u3] = await newCandidates(org, 3);
    expect((await inviteUsers(org.tenantId, a, [u1!, u2!], org.adminId)).invited).toHaveLength(2);
    const err = await creditsError(inviteUsers(org.tenantId, a, [u3!], org.adminId));
    expect(err.message).toBe("You need 20 credits. You have 0 available. Buy credits.");
    expect(err.details).toMatchObject({ need: 20, available: 0, canInvite: 0, cost: 20 });
    expect(await countInvitations(a)).toBe(2);
  });

  it("the hold is per tenant across assessments, and two parallel batches at the boundary cannot both pass", async () => {
    const org = await newOrg(20); // room for exactly one
    const a1 = await newAssessment(org, "Race one");
    const a2 = await newAssessment(org, "Race two");
    const [u1, u2] = await newCandidates(org, 2);
    const results = await Promise.allSettled([
      inviteUsers(org.tenantId, a1, [u1!], org.adminId),
      inviteUsers(org.tenantId, a2, [u2!], org.adminId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await countInvitations(a1)) + (await countInvitations(a2))).toBe(1);
  });

  it("revoke releases the hold; resending the revoked row holds it again and is refused when the credits went", async () => {
    const org = await newOrg(20);
    const a = await newAssessment(org, "Revoke");
    const first = await inviteUsers(org.tenantId, a, await newCandidates(org, 1), org.adminId);
    const invId = first.invited[0]!.id;
    await creditsError(inviteUsers(org.tenantId, a, await newCandidates(org, 1), org.adminId)); // full
    await revokeInvitation(org.tenantId, invId, org.adminId);
    // the credits are free again: someone else takes them
    await inviteUsers(org.tenantId, a, await newCandidates(org, 1), org.adminId);
    // the revoked row cannot come back: the hold is gone
    const err = await creditsError(resendInvitation(org.tenantId, invId, org.adminId));
    expect(err.details?.["code"]).toBe(AL_ERROR_CODES.CREDITS_INSUFFICIENT);
    expect(await statusOf(invId)).toBe("expired");
  });

  it("a resend of a revoked row succeeds while credits are free; a resend of a live row needs none", async () => {
    const org = await newOrg(20);
    const a = await newAssessment(org, "Resend ok");
    const live = await inviteUsers(org.tenantId, a, await newCandidates(org, 1), org.adminId);
    const id = live.invited[0]!.id;
    await resendInvitation(org.tenantId, id, org.adminId); // pending row: no new hold, no check
    await revokeInvitation(org.tenantId, id, org.adminId);
    const back = await resendInvitation(org.tenantId, id, org.adminId);
    expect(back.status).toBe("pending");
  });

  it("a reopen holds again: refused when the credits went, allowed when free", async () => {
    const org = await newOrg(20);
    const a = await newAssessment(org, "Reopen");
    await sql(`UPDATE assessments SET max_attempts = 2 WHERE id = $1`, [a]);
    const sub = await seedInvitation(org, a, "submitted");
    await sql(
      `INSERT INTO attempts (id, tenant_id, user_id, assessment_id, status, delivery_mode, camera_enabled) VALUES ($1, $2, $3, $4, 'submitted', 'real', false)`,
      [randomUUID(), org.tenantId, sub.userId, a],
    );
    await inviteUsers(org.tenantId, a, await newCandidates(org, 1), org.adminId); // takes the only 20 credits
    await creditsError(reopenInvitationForRetake(org.tenantId, sub.id, org.adminId));
    expect(await statusOf(sub.id)).toBe("submitted");
    await sql(`INSERT INTO credit_grants (tenant_id, source, credits, remaining, expires_at) VALUES ($1, 'bonus', 20, 20, now() + interval '300 days')`, [org.tenantId]);
    expect((await reopenInvitationForRetake(org.tenantId, sub.id, org.adminId)).status).toBe("pending");
  });

  it("submitted and revoked invitations hold nothing; a viewed one holds", async () => {
    const org = await newOrg(40);
    const a = await newAssessment(org, "Statuses");
    await seedInvitation(org, a, "submitted");
    await seedInvitation(org, a, "expired");
    await seedInvitation(org, a, "viewed"); // holds 20
    expect((await inviteUsers(org.tenantId, a, await newCandidates(org, 1), org.adminId)).invited).toHaveLength(1);
    await creditsError(inviteUsers(org.tenantId, a, await newCandidates(org, 1), org.adminId));
  });

  it("the type sets the cost: a mock holds 10", async () => {
    const org = await newOrg(25);
    const a = await newAssessment(org, "Mock");
    await sql(`UPDATE assessments SET delivery_mode = 'mock' WHERE id = $1`, [a]);
    expect((await inviteUsers(org.tenantId, a, await newCandidates(org, 2), org.adminId)).invited).toHaveLength(2); // 20 <= 25
    const err = await creditsError(inviteUsers(org.tenantId, a, await newCandidates(org, 1), org.adminId)); // 10 > 5
    expect(err.details).toMatchObject({ need: 10, available: 5, canInvite: 0, cost: 10 });
  });

  it("super admin and unlimited plans skip the check", async () => {
    const org = await newOrg(0); // finite plan, no credits at all
    const a = await newAssessment(org, "Super");
    await creditsError(inviteUsers(org.tenantId, a, await newCandidates(org, 1), org.adminId));
    expect((await inviteUsers(org.tenantId, a, await newCandidates(org, 2), org.adminId, true)).invited).toHaveLength(2);
    const u = await newAssessment(orgU, "Unlimited");
    expect((await inviteUsers(orgU.tenantId, u, await newCandidates(orgU, 25), orgU.adminId)).invited).toHaveLength(25);
  });

  it("tenant isolation: the credits and holds of another tenant never count", async () => {
    const rich = await newOrg(1000);
    const poor = await newOrg(0);
    const ar = await newAssessment(rich, "Rich");
    await inviteUsers(rich.tenantId, ar, await newCandidates(rich, 5), rich.adminId);
    const ap = await newAssessment(poor, "Poor");
    await creditsError(inviteUsers(poor.tenantId, ap, await newCandidates(poor, 1), poor.adminId));
  });
});

describe("precheckInvites (Z-152)", () => {
  it("is read-only: refuses over the credits and over the cap, passes inside, inserts nothing", async () => {
    const org = await newOrg(50);
    const a = await newAssessment(org, "Pre");
    await precheckInvites(org.tenantId, { assessmentId: a, candidates: 2 }, org.adminId);
    const err = await creditsError(precheckInvites(org.tenantId, { assessmentId: a, candidates: 3 }, org.adminId));
    expect(err.details).toMatchObject({ need: 60, available: 50, canInvite: 2 });
    expect(await countInvitations(a)).toBe(0);
    // no assessment yet: the type comes from the caller (real + camera = 30 each)
    await creditsError(precheckInvites(org.tenantId, { candidates: 2, deliveryMode: "real", cameraRequired: true }, org.adminId));
    await precheckInvites(org.tenantId, { candidates: 5, deliveryMode: "mock" }, org.adminId);
    // the cap with no assessment yet
    await sql(`UPDATE tenant_plans SET max_invited_per_assessment = 3 WHERE tenant_id = $1`, [org.tenantId]);
    await expect(precheckInvites(org.tenantId, { candidates: 4, deliveryMode: "mock" }, org.adminId)).rejects.toMatchObject({
      details: { code: AL_ERROR_CODES.INVITE_LIMIT_EXCEEDED },
    });
  });

  it("another tenant's assessment id is a 404", async () => {
    const org = await newOrg(50);
    const other = await newOrg(50);
    const a = await newAssessment(other, "Theirs");
    await expect(precheckInvites(org.tenantId, { assessmentId: a, candidates: 1 }, org.adminId)).rejects.toMatchObject({ status: 404 });
  });

  it("super admin skips the credit check", async () => {
    const org = await newOrg(0);
    await expect(precheckInvites(org.tenantId, { candidates: 3, deliveryMode: "real" }, org.adminId, true)).resolves.toBeUndefined();
    await expect(precheckInvites(orgU.tenantId, { candidates: 3, deliveryMode: "real" }, orgU.adminId)).resolves.toBeUndefined();
  });
});
