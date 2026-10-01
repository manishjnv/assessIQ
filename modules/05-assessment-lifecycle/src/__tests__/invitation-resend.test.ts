/**
 * Smoke tests — candidate invitations: 7-day links, resend, bulk resend,
 * re-invite after revoke (2026-10-01).
 *
 * Real Postgres (testcontainers) so RLS, the row lock and the UNIQUE
 * (assessment, user) constraint are exercised. The email shim is mocked so we
 * can (a) read the plaintext token out of the link, (b) prove the email is sent
 * AFTER the transaction committed, and (c) count sends.
 *
 * Migration set = lifecycle.test.ts + 06 `0030_attempts` (the started-check
 * reads `attempts`) + 09 `0050_attempt_scores` (the admin list LEFT JOINs it).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const { sendInvitationEmail } = vi.hoisted(() => ({
  sendInvitationEmail: vi.fn(),
}));
vi.mock("../email.js", () => ({ sendInvitationEmail }));

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { AppError, ConflictError, NotFoundError } from "@assessiq/core";
import {
  createAssessment,
  publishAssessment,
  inviteUsers,
  listInvitations,
  resendInvitation,
  resendInvitations,
  resolveInvitationToken,
  revokeInvitation,
} from "../service.js";
import { registerAssessmentLifecycleRoutes } from "../routes.js";
import { DEFAULT_INVITATION_TTL_HOURS } from "../tokens.js";
import { AL_ERROR_CODES } from "../types.js";
import {
  createPack,
  addLevel,
  createQuestion,
  publishPack,
} from "../../../04-question-bank/src/service.js";

// ---------------------------------------------------------------------------
// Paths (Windows-safe, same helper as lifecycle.test.ts)
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}
const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const AL_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(AL_MODULE_ROOT, "..");

const DAY_MS = 86_400_000;
const SEVEN_DAYS_MS = 7 * DAY_MS;

// ---------------------------------------------------------------------------
// Shared state + helpers
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;
let packId: string;
let levelId: string;
let app: FastifyInstance;

async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const sql = (text: string, params: unknown[] = []) =>
  withSuperClient((c) => c.query(text, params)).then((r) => r.rows);

async function applyDir(
  client: Client,
  dir: string,
  only?: (f: string) => boolean,
): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql") && (only?.(f) ?? true)).sort();
  for (const f of files) await client.query(await readFile(join(dir, f), "utf-8"));
}

async function newAssessment(name: string): Promise<string> {
  const a = await createAssessment(
    tenantA,
    { pack_id: packId, level_id: levelId, name, question_count: 3, opens_at: new Date(Date.now() + 3_600_000) },
    adminA,
  );
  await publishAssessment(tenantA, a.id, adminA);
  return a.id;
}

async function newCandidate(tenantId = tenantA): Promise<string> {
  const id = randomUUID();
  await sql(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Cand', 'candidate', 'active')`,
    [id, tenantId, `c-${id.slice(0, 8)}@example.com`],
  );
  return id;
}

/** Invite one candidate and return { invitationId, token } (token read out of the emailed link). */
async function inviteOne(assessmentId: string): Promise<{ invitationId: string; userId: string; token: string }> {
  const userId = await newCandidate();
  const res = await inviteUsers(tenantA, assessmentId, [userId], adminA);
  expect(res.invited).toHaveLength(1);
  return { invitationId: res.invited[0]!.id, userId, token: lastEmailToken() };
}

function tokenFromLink(link: string): string {
  const t = link.split("/take/")[1];
  expect(t).toBeTruthy();
  return t!;
}
function lastEmailToken(): string {
  const call = sendInvitationEmail.mock.calls.at(-1)?.[0] as { invitationLink: string };
  return tokenFromLink(call.invitationLink);
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function invRow(id: string): Promise<{ status: string; expires_at: Date; token_hash: string }> {
  return (await sql(`SELECT status, expires_at, token_hash FROM assessment_invitations WHERE id = $1`, [id]))[0];
}

async function startAttemptFor(assessmentId: string, userId: string, status = "in_progress"): Promise<void> {
  await sql(
    `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, now(), now() + interval '30 minutes')`,
    [randomUUID(), tenantA, assessmentId, userId, status],
  );
}

async function auditRows(entityId: string, action: string): Promise<Array<{ before: any; after: any; actor_user_id: string }>> {
  return sql(
    `SELECT before, after, actor_user_id::text FROM audit_log
      WHERE entity_id = $1 AND action = $2 ORDER BY at`,
    [entityId, action],
  ) as any;
}

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected the promise to reject");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_resend_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_resend_test`;

  await withSuperClient(async (client) => {
    await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_app') THEN CREATE ROLE assessiq_app; END IF; END $$;`);
    await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_system') THEN CREATE ROLE assessiq_system BYPASSRLS; END IF; END $$;`);
    await client.query(`GRANT assessiq_app TO test`);
    await client.query(`GRANT assessiq_system TO test`);

    await applyDir(client, join(MODULES_ROOT, "02-tenancy", "migrations"));
    await applyDir(client, join(MODULES_ROOT, "03-users", "migrations"), (f) => f.startsWith("020_"));
    await applyDir(client, join(MODULES_ROOT, "14-audit-log", "migrations"));
    await applyDir(client, join(MODULES_ROOT, "04-question-bank", "migrations"));
    await applyDir(client, join(AL_MODULE_ROOT, "migrations")); // includes 0117_invitation_last_resent_at
    await applyDir(client, join(MODULES_ROOT, "19-billing", "migrations"), (f) => f === "0078_tenant_plans.sql" || f === "0081_tenant_entitlements.sql");
    await applyDir(client, join(MODULES_ROOT, "06-attempt-engine", "migrations"), (f) => f === "0030_attempts.sql" || f === "0113_attempts_evaluation_release.sql");
    await applyDir(client, join(MODULES_ROOT, "09-scoring", "migrations"), (f) => f === "0050_attempt_scores.sql");

    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_system`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });

  await setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  tenantB = randomUUID();
  adminA = randomUUID();
  adminB = randomUUID();
  await withSuperClient(async (client) => {
    for (const [tid, slug, aid] of [[tenantA, "res-a", adminA], [tenantB, "res-b", adminB]] as const) {
      await client.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [tid, slug, `Tenant ${slug}`]);
      await client.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tid]);
      await client.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
        [aid, tid, `admin-${slug}@example.com`],
      );
      await client.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, 'internal', NULL)`, [tid]);
    }
  });

  // One published pack shared by every assessment in this file.
  const pack = await createPack(tenantA, { slug: `resend-${randomUUID().slice(0, 8)}`, name: "Resend Pack", domain: "soc" }, adminA);
  const level = await addLevel(tenantA, pack.id, { position: 1, label: "L1", duration_minutes: 30, default_question_count: 3 });
  for (let i = 0; i < 3; i++) {
    await createQuestion(
      tenantA,
      { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `q-${i}`, points: 5, content: { question: `Q${i}?`, options: ["A", "B", "C", "D"], correct: 0, rationale: "A." } },
      adminA,
    );
  }
  await publishPack(tenantA, pack.id, adminA);
  await sql(`UPDATE questions SET status = 'active' WHERE pack_id = $1`, [pack.id]);
  packId = pack.id;
  levelId = level.id;

  // Real routes, stubbed admin gate (session = tenant A's admin) + the same
  // AppError → envelope mapping as apps/api/src/server.ts.
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.toJson() });
    return reply.code(500).send({ error: { code: "INTERNAL", message: String(err) } });
  });
  await registerAssessmentLifecycleRoutes(app, {
    adminOnly: async (req) => {
      (req as { session?: unknown }).session = { tenantId: tenantA, userId: adminA };
    },
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closePool();
  if (container !== undefined) await container.stop();
});

beforeEach(() => {
  sendInvitationEmail.mockReset();
  sendInvitationEmail.mockResolvedValue(undefined);
});

// ===========================================================================
// 1. 7-day links
// ===========================================================================

describe("7-day invitation links", () => {
  it("the TTL constant is 168 h and a fresh invitation expires 7 days out", async () => {
    expect(DEFAULT_INVITATION_TTL_HOURS).toBe(168);
    const a = await newAssessment("TTL");
    const { invitationId } = await inviteOne(a);
    const { expires_at } = await invRow(invitationId);
    expect(Math.abs(expires_at.getTime() - (Date.now() + SEVEN_DAYS_MS))).toBeLessThan(60_000);
  });
});

// ===========================================================================
// 2. Resend one invitation
// ===========================================================================

describe("resendInvitation", () => {
  it("issues a NEW token (old link dies, new one resolves), extends to 7 days, resets status, audits once, emails AFTER commit", async () => {
    const a = await newAssessment("Resend happy path");
    const { invitationId, token: oldToken } = await inviteOne(a);
    expect(await resolveInvitationToken(oldToken)).not.toBeNull();

    // Make it look like a student who opened the link long ago.
    await sql(`UPDATE assessment_invitations SET status = 'viewed', expires_at = now() + interval '1 day' WHERE id = $1`, [invitationId]);

    // The email mock reads the DB over a SEPARATE connection at send time: if the
    // email were sent inside the transaction it would still see the old hash.
    sendInvitationEmail.mockClear(); // forget the invite email
    let hashSeenAtSendTime = "";
    sendInvitationEmail.mockImplementationOnce(async () => {
      hashSeenAtSendTime = (await invRow(invitationId)).token_hash;
    });

    const updated = await resendInvitation(tenantA, invitationId, adminA);

    expect(updated.status).toBe("pending");
    expect(Math.abs(updated.expires_at.getTime() - (Date.now() + SEVEN_DAYS_MS))).toBeLessThan(60_000);

    expect(sendInvitationEmail).toHaveBeenCalledTimes(1);
    const email = sendInvitationEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(email).toMatchObject({ tenantId: tenantA, assessmentName: "Resend happy path", tenantName: "Tenant res-a" });
    const newToken = tokenFromLink(email["invitationLink"] as string);
    expect(newToken).not.toBe(oldToken);
    expect(hashSeenAtSendTime).toBe(sha256(newToken)); // committed before the email went out

    expect(await resolveInvitationToken(oldToken)).toBeNull(); // old link is dead
    const resolved = await resolveInvitationToken(newToken);
    expect(resolved?.invitation.id).toBe(invitationId);
    expect((await invRow(invitationId)).token_hash).toBe(sha256(newToken));

    const rows = await auditRows(invitationId, "assessment.invitation.resent");
    expect(rows).toHaveLength(1); // exactly one audit row
    expect(rows[0]!.actor_user_id).toBe(adminA);
    expect(rows[0]!.before.status).toBe("viewed");
    expect(rows[0]!.after).toMatchObject({ kind: "resend", status: "pending", assessment_id: a });
    // Dates must be stored as ISO strings (the audit redactor flattens Date objects to {}).
    expect(typeof rows[0]!.before.expires_at).toBe("string");
    expect(Math.abs(new Date(rows[0]!.after.expires_at).getTime() - (Date.now() + SEVEN_DAYS_MS))).toBeLessThan(60_000);
  });

  it("revives a REVOKED invitation (extend / re-invite) and a LAPSED one", async () => {
    const a = await newAssessment("Resend revoked + lapsed");
    const revoked = await inviteOne(a);
    await revokeInvitation(tenantA, revoked.invitationId, adminA);
    expect(await resolveInvitationToken(revoked.token)).toBeNull();

    const lapsed = await inviteOne(a);
    await sql(`UPDATE assessment_invitations SET expires_at = now() - interval '1 day' WHERE id = $1`, [lapsed.invitationId]);
    expect(await resolveInvitationToken(lapsed.token)).toBeNull();

    for (const inv of [revoked, lapsed]) {
      sendInvitationEmail.mockClear();
      const out = await resendInvitation(tenantA, inv.invitationId, adminA);
      expect(out.status).toBe("pending");
      const fresh = lastEmailToken();
      expect(fresh).not.toBe(inv.token);
      expect((await resolveInvitationToken(fresh))?.invitation.id).toBe(inv.invitationId);
    }
  });

  it("409 INVITATION_ALREADY_STARTED once the candidate started — even if the invitation was revoked afterwards", async () => {
    const a = await newAssessment("Resend after start");
    const started = await inviteOne(a);
    await startAttemptFor(a, started.userId);
    await sql(`UPDATE assessment_invitations SET status = 'started' WHERE id = $1`, [started.invitationId]);

    const revokedAfterStart = await inviteOne(a);
    await startAttemptFor(a, revokedAfterStart.userId);
    await revokeInvitation(tenantA, revokedAfterStart.invitationId, adminA); // status 'expired' but attempt exists

    sendInvitationEmail.mockClear();
    for (const inv of [started, revokedAfterStart]) {
      const before = await invRow(inv.invitationId);
      const err = await rejection(resendInvitation(tenantA, inv.invitationId, adminA));
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.status).toBe(409);
      expect(err.details?.["code"]).toBe(AL_ERROR_CODES.INVITATION_ALREADY_STARTED);
      expect((await invRow(inv.invitationId)).token_hash).toBe(before.token_hash); // untouched
    }
    expect(sendInvitationEmail).not.toHaveBeenCalled();
  });

  it("409 ASSESSMENT_NOT_ACTIVE when the assessment is closed; 404 for an unknown / other-tenant / malformed id", async () => {
    const a = await newAssessment("Resend closed");
    const { invitationId } = await inviteOne(a);

    await sql(`UPDATE assessments SET status = 'closed' WHERE id = $1`, [a]);
    const closed = await rejection(resendInvitation(tenantA, invitationId, adminA));
    expect(closed).toBeInstanceOf(ConflictError);
    expect(closed.details?.["code"]).toBe(AL_ERROR_CODES.ASSESSMENT_NOT_ACTIVE);
    await sql(`UPDATE assessments SET status = 'published' WHERE id = $1`, [a]);

    for (const [tenant, id] of [[tenantA, randomUUID()], [tenantB, invitationId], [tenantA, "not-a-uuid"]] as const) {
      const err = await rejection(resendInvitation(tenant, id, adminA));
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.details?.["code"]).toBe(AL_ERROR_CODES.INVITATION_NOT_FOUND);
    }
  });

  it("is wired as POST /api/admin/invitations/:id/resend with the 200 / 404 / 409 contract", async () => {
    const a = await newAssessment("Resend route");
    const { invitationId, userId, token: oldToken } = await inviteOne(a);

    const ok = await app.inject({ method: "POST", url: `/api/admin/invitations/${invitationId}/resend` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: invitationId, status: "pending" });
    expect(await resolveInvitationToken(oldToken)).toBeNull();

    const missing = await app.inject({ method: "POST", url: `/api/admin/invitations/${randomUUID()}/resend` });
    expect(missing.statusCode).toBe(404);

    await startAttemptFor(a, userId);
    const started = await app.inject({ method: "POST", url: `/api/admin/invitations/${invitationId}/resend` });
    expect(started.statusCode).toBe(409);
    expect(started.json().error.details.code).toBe("INVITATION_ALREADY_STARTED");
  });

  it("if the email cannot be queued the new link is already saved and the admin gets 502 INVITATION_EMAIL_FAILED", async () => {
    const a = await newAssessment("Resend email failure");
    const { invitationId, token: oldToken } = await inviteOne(a);
    sendInvitationEmail.mockRejectedValueOnce(new Error("redis down"));

    const err = await rejection(resendInvitation(tenantA, invitationId, adminA));
    expect(err.status).toBe(502);
    expect(err.details?.["code"]).toBe(AL_ERROR_CODES.INVITATION_EMAIL_FAILED);
    expect(await resolveInvitationToken(oldToken)).toBeNull(); // rotation was committed
  });
});

// ===========================================================================
// 3. Bulk resend
// ===========================================================================

describe("resendInvitations (bulk)", () => {
  it("resends pending + viewed + lapsed, leaves revoked and started alone, and returns the right counts", async () => {
    const a = await newAssessment("Bulk counts");
    const pending = await inviteOne(a);
    const viewed = await inviteOne(a);
    await sql(`UPDATE assessment_invitations SET status = 'viewed' WHERE id = $1`, [viewed.invitationId]);
    const lapsed = await inviteOne(a);
    await sql(`UPDATE assessment_invitations SET expires_at = now() - interval '2 days' WHERE id = $1`, [lapsed.invitationId]);
    const revoked = await inviteOne(a);
    await revokeInvitation(tenantA, revoked.invitationId, adminA);
    const started = await inviteOne(a);
    await startAttemptFor(a, started.userId);
    await sql(`UPDATE assessment_invitations SET status = 'started' WHERE id = $1`, [started.invitationId]);

    // The list endpoint advertises exactly this set.
    const listed = await listInvitations(tenantA, a);
    expect(listed.resendable).toBe(3);
    const canResend = Object.fromEntries(listed.items.map((i) => [i.id, i.can_resend]));
    expect(canResend).toEqual({
      [pending.invitationId]: true,
      [viewed.invitationId]: true,
      [lapsed.invitationId]: true,
      [revoked.invitationId]: true, // single resend revives revoked rows
      [started.invitationId]: false,
    });

    sendInvitationEmail.mockClear();
    const revokedBefore = await invRow(revoked.invitationId);
    const startedBefore = await invRow(started.invitationId);

    const result = await resendInvitations(tenantA, a, adminA);
    expect(result).toEqual({ resent: 3, skipped: [], remaining: 0 });
    expect(sendInvitationEmail).toHaveBeenCalledTimes(3);

    for (const inv of [pending, viewed, lapsed]) {
      const row = await invRow(inv.invitationId);
      expect(row.status).toBe("pending");
      expect(Math.abs(row.expires_at.getTime() - (Date.now() + SEVEN_DAYS_MS))).toBeLessThan(60_000);
      expect(await resolveInvitationToken(inv.token)).toBeNull(); // old links dead
      expect(await auditRows(inv.invitationId, "assessment.invitation.resent")).toHaveLength(1);
    }
    expect((await invRow(revoked.invitationId)).token_hash).toBe(revokedBefore.token_hash);
    expect((await invRow(started.invitationId)).status).toBe(startedBefore.status);

    // Links re-issued a moment ago are left alone — repeat clicks do not re-send.
    sendInvitationEmail.mockClear();
    expect(await resendInvitations(tenantA, a, adminA)).toEqual({ resent: 0, skipped: [], remaining: 0 });
    expect(sendInvitationEmail).not.toHaveBeenCalled();
    expect((await listInvitations(tenantA, a)).resendable).toBe(0);
  });

  it("caps at 200 per call and reports `remaining`; calling again finishes the rest without repeating anyone", async () => {
    const a = await newAssessment("Bulk cap");
    await sql(
      `INSERT INTO users (id, tenant_id, email, name, role, status)
       SELECT gen_random_uuid(), $1, 'cap' || g || '@example.com', 'Cap ' || g, 'candidate', 'active'
         FROM generate_series(1, 205) g`,
      [tenantA],
    );
    await sql(
      `INSERT INTO assessment_invitations (id, assessment_id, user_id, token_hash, expires_at, invited_by)
       SELECT gen_random_uuid(), $2, u.id, encode(sha256(u.id::text::bytea), 'hex'), now() + interval '1 day', $3
         FROM users u WHERE u.tenant_id = $1 AND u.email LIKE 'cap%@example.com'`,
      [tenantA, a, adminA],
    );

    const first = await resendInvitations(tenantA, a, adminA);
    expect(first).toEqual({ resent: 200, skipped: [], remaining: 5 });
    const second = await resendInvitations(tenantA, a, adminA);
    expect(second).toEqual({ resent: 5, skipped: [], remaining: 0 });
    expect(await resendInvitations(tenantA, a, adminA)).toEqual({ resent: 0, skipped: [], remaining: 0 });

    const recipients = sendInvitationEmail.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(recipients).toHaveLength(205);
    expect(new Set(recipients).size).toBe(205); // nobody emailed twice
  });

  it("one failing row does not roll back the others; it is reported in `skipped` with a code", async () => {
    const a = await newAssessment("Bulk partial failure");
    const ok1 = await inviteOne(a);
    const bad = await inviteOne(a);
    const ok2 = await inviteOne(a);
    sendInvitationEmail.mockClear();
    // Fail the 2nd email only (rows are processed oldest-first).
    sendInvitationEmail.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);

    const result = await resendInvitations(tenantA, a, adminA);
    expect(result.resent).toBe(2);
    expect(result.skipped).toEqual([{ id: bad.invitationId, code: AL_ERROR_CODES.INVITATION_EMAIL_FAILED }]);
    for (const inv of [ok1, bad, ok2]) {
      expect(await resolveInvitationToken(inv.token)).toBeNull(); // every row was re-issued in its own committed tx
    }
  });

  it("409 ASSESSMENT_NOT_ACTIVE for a closed assessment, 404 for an unknown one, and the route returns the contract shape", async () => {
    const a = await newAssessment("Bulk route");
    await inviteOne(a);

    const route = await app.inject({ method: "POST", url: `/api/admin/assessments/${a}/invitations/resend` });
    expect(route.statusCode).toBe(200);
    expect(route.json()).toEqual({ resent: 1, skipped: [], remaining: 0 });

    const unknown = await rejection(resendInvitations(tenantA, randomUUID(), adminA));
    expect(unknown).toBeInstanceOf(NotFoundError);

    await sql(`UPDATE assessments SET status = 'closed' WHERE id = $1`, [a]);
    const closed = await app.inject({ method: "POST", url: `/api/admin/assessments/${a}/invitations/resend` });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.details.code).toBe("ASSESSMENT_NOT_ACTIVE");
    const list = await listInvitations(tenantA, a);
    expect(list.resendable).toBe(0);
    expect(list.items.every((i) => i.can_resend === false)).toBe(true);
  });
});

// ===========================================================================
// 4. Re-invite after revoke (invite endpoint + CSV import both call inviteUsers)
// ===========================================================================

describe("inviteUsers — re-invite instead of skipping", () => {
  it("re-activates a REVOKED invitation: fresh token, 7 days, one email, audited as assessment.invite kind=reinvite", async () => {
    const a = await newAssessment("Re-invite revoked");
    const { invitationId, userId, token: oldToken } = await inviteOne(a);
    await revokeInvitation(tenantA, invitationId, adminA);
    sendInvitationEmail.mockClear();

    const res = await inviteUsers(tenantA, a, [userId], adminA);
    expect(res.skipped).toEqual([]);
    expect(res.invited).toHaveLength(1);
    expect(res.invited[0]).toMatchObject({ id: invitationId, status: "pending" }); // same row, revived
    expect(sendInvitationEmail).toHaveBeenCalledTimes(1);

    const fresh = lastEmailToken();
    expect(await resolveInvitationToken(oldToken)).toBeNull();
    expect((await resolveInvitationToken(fresh))?.invitation.id).toBe(invitationId);
    expect(Math.abs((await invRow(invitationId)).expires_at.getTime() - (Date.now() + SEVEN_DAYS_MS))).toBeLessThan(60_000);

    const reinvites = (await auditRows(invitationId, "assessment.invite")).filter((r) => r.after.kind === "reinvite");
    expect(reinvites).toHaveLength(1);
    expect(reinvites[0]!.before.status).toBe("expired");
  });

  it("also re-activates a LAPSED (past 7 days) invitation, but a LIVE one stays 'existing' with no duplicate email", async () => {
    const a = await newAssessment("Re-invite lapsed vs live");
    const live = await inviteOne(a);
    const lapsed = await inviteOne(a);
    await sql(`UPDATE assessment_invitations SET expires_at = now() - interval '1 hour' WHERE id = $1`, [lapsed.invitationId]);
    sendInvitationEmail.mockClear();

    const liveRes = await inviteUsers(tenantA, a, [live.userId], adminA);
    expect(liveRes.invited).toHaveLength(0);
    expect(liveRes.skipped).toEqual([{ userId: live.userId, reason: "INVITATION_EXISTS" }]);
    expect(sendInvitationEmail).not.toHaveBeenCalled();
    expect((await resolveInvitationToken(live.token))?.invitation.id).toBe(live.invitationId); // untouched

    const lapsedRes = await inviteUsers(tenantA, a, [lapsed.userId], adminA);
    expect(lapsedRes.invited).toHaveLength(1);
    expect(sendInvitationEmail).toHaveBeenCalledTimes(1);
  });

  it("does NOT revive an invitation whose candidate already started, even if it was revoked", async () => {
    const a = await newAssessment("Re-invite after start");
    const { invitationId, userId } = await inviteOne(a);
    await startAttemptFor(a, userId);
    await revokeInvitation(tenantA, invitationId, adminA);
    sendInvitationEmail.mockClear();

    const res = await inviteUsers(tenantA, a, [userId], adminA);
    expect(res.invited).toHaveLength(0);
    expect(res.skipped).toEqual([{ userId, reason: "INVITATION_EXISTS" }]);
    expect(sendInvitationEmail).not.toHaveBeenCalled();
    expect((await invRow(invitationId)).status).toBe("expired");
  });
});
