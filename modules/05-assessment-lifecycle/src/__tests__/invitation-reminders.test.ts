/**
 * Automatic invitation reminders (2026-10-02) — real Postgres (testcontainers).
 *
 * Covers: eligible invitation gets exactly ONE reminder (second sweep sends none, expiry
 * untouched, link resolves); every ineligible shape gets none; closes_at sooner than the
 * link expiry drives the deadline; tenant isolation; a failed email releases the claim;
 * settings validation + PATCH /api/admin/assessments/:id/reminders merge.
 * The email shim is mocked (13's own tests cover rendering).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const { sendInvitationEmail, sendReminderEmail } = vi.hoisted(() => ({
  sendInvitationEmail: vi.fn(),
  sendReminderEmail: vi.fn(),
}));
vi.mock("../email.js", () => ({ sendInvitationEmail, sendReminderEmail }));

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { AppError } from "@assessiq/core";
import { createAssessment, publishAssessment } from "../service.js";
import { sweepInvitationReminders, assertRemindersSettings } from "../reminders.js";
import { resolveInvitationToken } from "../service.js";
import { registerAssessmentLifecycleRoutes } from "../routes.js";
import { createPack, addLevel, createQuestion, publishPack } from "../../../04-question-bank/src/service.js";

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
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

/** Published assessment of tenant A; reminders on (24 h) unless told otherwise (null = setting absent). */
async function newAssessment(reminders: unknown = { enabled: true, hours_before: 24 }): Promise<string> {
  const a = await createAssessment(
    tenantA,
    { pack_id: packId, level_id: levelId, name: `Rem ${randomUUID().slice(0, 6)}`, question_count: 3, opens_at: new Date(Date.now() + 3_600_000) },
    adminA,
  );
  await publishAssessment(tenantA, a.id, adminA);
  if (reminders !== null) {
    await sql(`UPDATE assessments SET settings = jsonb_set(settings, '{reminders}', $2::jsonb) WHERE id = $1`, [a.id, JSON.stringify(reminders)]);
  }
  return a.id;
}

async function newCandidate(tenantId = tenantA): Promise<string> {
  const id = randomUUID();
  await sql(
    `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Cand', 'candidate', 'active')`,
    [id, tenantId, `c-${id.slice(0, 8)}@example.com`],
  );
  return id;
}

/** Insert an invitation directly. expiresInH hours from now; created `createdAgoH` hours ago. */
async function seedInv(
  assessmentId: string,
  o: { expiresInH?: number; status?: string; createdAgoH?: number; userId?: string } = {},
): Promise<{ id: string; userId: string; hash: string }> {
  const userId = o.userId ?? (await newCandidate());
  const id = randomUUID();
  const hash = `h-${id}`;
  await sql(
    `INSERT INTO assessment_invitations (id, assessment_id, user_id, token_hash, expires_at, status, invited_by, created_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5::int), $6, $7, now() - make_interval(hours => $8::int))`,
    [id, assessmentId, userId, hash, o.expiresInH ?? 10, o.status ?? "pending", adminA, o.createdAgoH ?? 24],
  );
  return { id, userId, hash };
}

const inv = async (id: string) =>
  (await sql(`SELECT token_hash, expires_at, reminded_at, status FROM assessment_invitations WHERE id = $1`, [id]))[0] as {
    token_hash: string;
    expires_at: Date;
    reminded_at: Date | null;
    status: string;
  };

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_reminders_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_reminders_test`;

  await withSuperClient(async (client) => {
    await applyAllMigrations(client);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_system`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  tenantB = randomUUID();
  adminA = randomUUID();
  await withSuperClient(async (client) => {
    for (const [tid, slug] of [[tenantA, "rem-a"], [tenantB, "rem-b"]] as const) {
      await client.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [tid, slug, `Tenant ${slug}`]);
      await client.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tid]);
      await client.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, 'internal', NULL)`, [tid]);
    }
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, 'admin-rem@example.com', 'Admin', 'admin', 'active')`,
      [adminA, tenantA],
    );
  });

  const pack = await createPack(tenantA, { slug: `rem-${randomUUID().slice(0, 8)}`, name: "Rem Pack", domain: "soc" }, adminA);
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

beforeEach(async () => {
  sendReminderEmail.mockReset();
  sendReminderEmail.mockResolvedValue(undefined);
  // Sweeps are global: park every earlier assessment's invitations so tests stay independent.
  await sql(`UPDATE assessments SET settings = jsonb_set(settings, '{reminders}', '{"enabled": false}'::jsonb)`);
});

describe("sweepInvitationReminders", () => {
  it("sends ONE reminder to an eligible invitation; a second sweep sends none; expiry untouched; new link resolves", async () => {
    const a = await newAssessment();
    const { id, hash } = await seedInv(a, { expiresInH: 10 });
    const before = await inv(id);

    const r1 = await sweepInvitationReminders();
    expect(r1).toMatchObject({ candidates: 1, sent: 1, failed: 0 });
    expect(sendReminderEmail).toHaveBeenCalledTimes(1);
    const arg = sendReminderEmail.mock.calls[0]![0] as { invitationLink: string; deadline: Date; tenantId: string; tenantName: string };
    expect(arg.tenantId).toBe(tenantA);
    expect(arg.tenantName).toBe("Tenant rem-a");
    expect(arg.deadline.getTime()).toBe(before.expires_at.getTime());

    const after = await inv(id);
    expect(after.reminded_at).not.toBeNull();
    expect(after.expires_at.getTime()).toBe(before.expires_at.getTime()); // a reminder never extends
    expect(after.token_hash).not.toBe(hash);
    const token = arg.invitationLink.split("/take/")[1]!;
    expect((await resolveInvitationToken(token))?.invitation.id).toBe(id);

    sendReminderEmail.mockClear();
    const r2 = await sweepInvitationReminders();
    expect(r2.sent).toBe(0);
    expect(sendReminderEmail).not.toHaveBeenCalled();
  });

  it("uses closes_at when it is sooner than the link expiry", async () => {
    const a = await newAssessment();
    await sql(`UPDATE assessments SET closes_at = now() + interval '5 hours' WHERE id = $1`, [a]);
    const { id } = await seedInv(a, { expiresInH: 100 }); // link alone would be outside the 24 h window
    const closes = (await sql(`SELECT closes_at FROM assessments WHERE id = $1`, [a]))[0].closes_at as Date;

    expect((await sweepInvitationReminders()).sent).toBe(1);
    const arg = sendReminderEmail.mock.calls[0]![0] as { deadline: Date };
    expect(arg.deadline.getTime()).toBe(closes.getTime());
    expect((await inv(id)).reminded_at).not.toBeNull();
  });

  it("sends nothing for ineligible invitations", async () => {
    const off = await newAssessment({ enabled: false });
    await seedInv(off); // reminders off
    const none = await newAssessment(null);
    await seedInv(none); // setting absent = off

    const a = await newAssessment({ enabled: true, hours_before: 12 });
    await seedInv(a, { expiresInH: 20 }); // outside the 12 h window
    const lapsed = await seedInv(a, { expiresInH: -2 }); // already expired
    await seedInv(a, { status: "expired" }); // revoked
    await seedInv(a, { status: "started" });
    await seedInv(a, { createdAgoH: 1 }); // invite email too recent
    const started = await seedInv(a); // has an attempt
    await sql(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at)
       VALUES ($1, $2, $3, $4, 'in_progress', now(), now() + interval '30 minutes')`,
      [randomUUID(), tenantA, a, started.userId],
    );
    const dead = await newAssessment({ enabled: true });
    await sql(`UPDATE assessments SET status = 'closed' WHERE id = $1`, [dead]);
    await seedInv(dead);

    const r = await sweepInvitationReminders();
    expect(r.sent).toBe(0);
    expect(sendReminderEmail).not.toHaveBeenCalled();
    expect((await inv(lapsed.id)).reminded_at).toBeNull();
  });

  it("is tenant-correct: each tenant's reminder carries its own tenant; a tenant with reminders off gets none", async () => {
    const aOn = await newAssessment();
    const invA = await seedInv(aOn);

    // Tenant B assessment (reminders ON) + another B assessment (OFF), inserted directly.
    const mk = async (settings: unknown): Promise<string> => {
      const id = randomUUID();
      await sql(
        `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, opens_at, settings, created_by)
         VALUES ($1, $2, $3, $4, 1, 'B test', 'published', 3, false, now() - interval '1 hour', $5::jsonb, $6)`,
        [id, tenantB, packId, levelId, JSON.stringify(settings), adminA],
      );
      return id;
    };
    const bOn = await mk({ reminders: { enabled: true } });
    const bOff = await mk({ reminders: { enabled: false } });
    const userB1 = await newCandidate(tenantB);
    const userB2 = await newCandidate(tenantB);
    const invB = await seedInv(bOn, { userId: userB1 });
    const invBoff = await seedInv(bOff, { userId: userB2 });

    const r = await sweepInvitationReminders();
    expect(r.sent).toBe(2);
    const tenants = sendReminderEmail.mock.calls.map((c) => (c[0] as { tenantId: string }).tenantId).sort();
    expect(tenants).toEqual([tenantA, tenantB].sort());
    expect((await inv(invA.id)).reminded_at).not.toBeNull();
    expect((await inv(invB.id)).reminded_at).not.toBeNull();
    expect((await inv(invBoff.id)).reminded_at).toBeNull();
  });

  it("a failed email releases the claim so the next sweep retries", async () => {
    const a = await newAssessment();
    const { id } = await seedInv(a);
    sendReminderEmail.mockRejectedValueOnce(new Error("redis down"));

    const r1 = await sweepInvitationReminders();
    expect(r1).toMatchObject({ sent: 0, failed: 1 });
    expect((await inv(id)).reminded_at).toBeNull();

    const r2 = await sweepInvitationReminders();
    expect(r2.sent).toBe(1);
    expect((await inv(id)).reminded_at).not.toBeNull();
  });
});

describe("reminders settings", () => {
  it("assertRemindersSettings accepts absent / valid and rejects malformed shapes", () => {
    expect(() => assertRemindersSettings(undefined)).not.toThrow();
    expect(() => assertRemindersSettings({})).not.toThrow();
    expect(() => assertRemindersSettings({ reminders: { enabled: true, hours_before: 24 } })).not.toThrow();
    expect(() => assertRemindersSettings({ reminders: { enabled: false } })).not.toThrow();
    for (const bad of [
      { enabled: "yes" },
      { enabled: true, hours_before: 0 },
      { enabled: true, hours_before: 169 },
      { enabled: true, hours_before: 1.5 },
      { enabled: true, extra: 1 },
      {},
      "on",
    ]) {
      expect(() => assertRemindersSettings({ reminders: bad } as never)).toThrow();
    }
  });

  it("PATCH /reminders merges only settings.reminders, audits, and rejects a bad body", async () => {
    const a = await newAssessment(null);
    await sql(`UPDATE assessments SET settings = '{"integrity":{"fullscreen":true}}'::jsonb WHERE id = $1`, [a]);

    const ok = await app.inject({
      method: "PATCH",
      url: `/api/admin/assessments/${a}/reminders`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ enabled: true, hours_before: 48 }),
    });
    expect(ok.statusCode).toBe(200);
    const settings = (await sql(`SELECT settings FROM assessments WHERE id = $1`, [a]))[0].settings;
    expect(settings).toEqual({ integrity: { fullscreen: true }, reminders: { enabled: true, hours_before: 48 } });
    const audit = await sql(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'assessment.updated'`, [a]);
    expect(audit[0].n).toBe(1);

    for (const payload of [{ enabled: true, hours_before: 0 }, { enabled: "x" }, { enabled: true, nope: 1 }]) {
      const bad = await app.inject({
        method: "PATCH",
        url: `/api/admin/assessments/${a}/reminders`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(payload),
      });
      expect(bad.statusCode).toBe(400);
    }
    const missing = await app.inject({
      method: "PATCH",
      url: `/api/admin/assessments/${randomUUID()}/reminders`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ enabled: true }),
    });
    expect(missing.statusCode).toBe(404);
  });
});
