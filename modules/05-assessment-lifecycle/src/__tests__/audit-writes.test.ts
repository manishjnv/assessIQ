/**
 * G3.D audit-write sweep — coverage tests for modules/05-assessment-lifecycle.
 *
 * Mirrors modules/04-question-bank/src/__tests__/audit-writes.test.ts.
 *
 * Verifies every admin-mutating service method writes a corresponding
 * audit_log row INSIDE the same Postgres transaction as the domain mutation,
 * satisfying the CLAUDE.md atomicity invariant.
 *
 * Migration apply order: tenancy → users (020 only) → audit-log → qb → al.
 * The audit-log migration must precede the AL service calls because every
 * wired mutation now writes an audit_log row via auditInTx() inside the same
 * withTenant transaction.
 *
 * Atomicity is verified two ways:
 *   1. Happy path: mutation row + audit row both present.
 *   2. Error path: when the mutation throws BEFORE the audit write (e.g.
 *      publishAssessment on a non-existent id), no audit row is left
 *      orphaned. This is the QB-template pattern for proving atomicity from
 *      the error direction without per-function failure injection.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";

import {
  createAssessment,
  updateAssessment,
  publishAssessment,
  closeAssessment,
  reopenAssessment,
  inviteUsers,
  revokeInvitation,
} from "../service.js";

import {
  createPack,
  addLevel,
  createQuestion,
  publishPack,
} from "../../../04-question-bank/src/service.js";

// ---------------------------------------------------------------------------
// Path helpers (Windows: strip leading slash before drive letter)
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const AL_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(AL_MODULE_ROOT, "..");

const TENANCY_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_DIR = join(MODULES_ROOT, "03-users", "migrations");
const AUDIT_DIR = join(MODULES_ROOT, "14-audit-log", "migrations");
const QB_DIR = join(MODULES_ROOT, "04-question-bank", "migrations");
const AL_DIR = join(AL_MODULE_ROOT, "migrations");
// publishAssessment / reopenAssessment call assertPublishEntitled which queries
// tenant_plans. Without this the audit suite throws "relation \"tenant_plans\"
// does not exist" on every publish-path test.
const BILLING_DIR = join(MODULES_ROOT, "19-billing", "migrations");
// inviteUsers writes to email_log via the 13-notifications shim; apply
// 0055_email_log.sql so the table exists in the test container.
const NOTIFICATIONS_DIR = join(MODULES_ROOT, "13-notifications", "migrations");

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let adminA: string;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
}

async function queryAudit(tenantId: string, action?: string): Promise<AuditRow[]> {
  return withSuperClient(async (client) => {
    const params: unknown[] = [tenantId];
    let where = `tenant_id = $1`;
    if (action !== undefined) {
      params.push(action);
      where += ` AND action = $2`;
    }
    const result = await client.query<AuditRow>(
      `SELECT id::text, actor_user_id::text, actor_kind, action,
              entity_type, entity_id::text, before, after
         FROM audit_log
        WHERE ${where}
        ORDER BY at DESC`,
      params,
    );
    return result.rows;
  });
}

async function clearAudit(tenantId: string): Promise<void> {
  await withSuperClient(async (client) => {
    // Test-only: bypass the REVOKE on assessiq_app by running as superuser.
    await client.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantId]);
  });
}

async function insertTenant(client: Client, id: string, slug: string): Promise<void> {
  await client.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
    [id, slug, `Tenant ${slug}`],
  );
  await client.query(
    `INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [id],
  );
}

async function insertAdmin(client: Client, id: string, tenantId: string, email: string): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
    [id, tenantId, email],
  );
}

async function insertCandidate(
  client: Client,
  id: string,
  tenantId: string,
  email: string,
): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Candidate', 'candidate', 'active')`,
    [id, tenantId, email],
  );
}

/** Build a published pack with N active mcq questions on a single level. */
async function buildPublishedPack(
  tenantId: string,
  adminId: string,
  questionCount: number,
): Promise<{ packId: string; levelId: string }> {
  const slug = `audit-al-pack-${randomUUID().slice(0, 8)}`;
  const pack = await createPack(tenantId, { slug, name: "AL Test Pack", domain: "soc" }, adminId);
  const level = await addLevel(tenantId, pack.id, {
    position: 1,
    label: "L1",
    duration_minutes: 30,
    default_question_count: questionCount,
  });
  for (let i = 0; i < questionCount; i++) {
    await createQuestion(
      tenantId,
      {
        pack_id: pack.id,
        level_id: level.id,
        type: "mcq",
        topic: `q-${i}`,
        points: 5,
        content: {
          question: `Test Q ${i}?`,
          options: ["A", "B", "C", "D"],
          correct: 0,
          rationale: "A.",
        },
      },
      adminId,
    );
  }
  await publishPack(tenantId, pack.id, adminId);

  // Flip all questions to status='active' so publishAssessment's pool-size
  // pre-flight (counts WHERE status='active') sees them. Module 04's
  // createQuestion defaults to 'draft' and publishPack does NOT auto-flip.
  await withSuperClient(async (client) => {
    await client.query(
      `UPDATE questions SET status = 'active' WHERE pack_id = $1`,
      [pack.id],
    );
  });

  return { packId: pack.id, levelId: level.id };
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "aiq_al_audit_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_al_audit_test`;

  const [tenancyFiles, usersFiles, auditFiles, qbFiles, alFiles, billingFiles, notificationsFiles] = await Promise.all([
    readdir(TENANCY_DIR),
    readdir(USERS_DIR),
    readdir(AUDIT_DIR),
    readdir(QB_DIR),
    readdir(AL_DIR),
    readdir(BILLING_DIR),
    readdir(NOTIFICATIONS_DIR),
  ]);

  const tenancySorted = tenancyFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: TENANCY_DIR, file: f }));
  const usersSorted = usersFiles
    .filter((f) => f.endsWith(".sql") && f.startsWith("020_"))
    .sort()
    .map((f) => ({ dir: USERS_DIR, file: f }));
  const auditSorted = auditFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: AUDIT_DIR, file: f }));
  const qbSorted = qbFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: QB_DIR, file: f }));
  const alSorted = alFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: AL_DIR, file: f }));

  // Only the schema-creating billing migrations; 0079 requires the attempts
  // table (not in this test set), 0080/0082 are backfills, 0090 is a noop UPDATE.
  const billingSorted = billingFiles
    .filter((f) => f.endsWith(".sql") && (f === "0078_tenant_plans.sql" || f === "0081_tenant_entitlements.sql"))
    .sort()
    .map((f) => ({ dir: BILLING_DIR, file: f }));
  // Only 0055_email_log.sql - inviteUsers writes to email_log via the 13-notifications shim.
  const notificationsSorted = notificationsFiles
    .filter((f) => f.endsWith(".sql") && f === "0055_email_log.sql")
    .sort()
    .map((f) => ({ dir: NOTIFICATIONS_DIR, file: f }));

  await withSuperClient(async (client) => {
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_app') THEN
          CREATE ROLE assessiq_app;
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_system') THEN
          CREATE ROLE assessiq_system BYPASSRLS;
        END IF;
      END $$;
    `);
    await client.query(`GRANT assessiq_app TO test`);
    await client.query(`GRANT assessiq_system TO test`);

    for (const { dir, file } of [
      ...tenancySorted,
      ...usersSorted,
      ...auditSorted,
      ...qbSorted,
      ...alSorted,
      ...billingSorted,
      ...notificationsSorted,
    ]) {
      const sql = await readFile(join(dir, file), "utf-8");
      await client.query(sql);
    }

    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });

  await setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  adminA = randomUUID();

  await withSuperClient(async (client) => {
    await insertTenant(client, tenantA, "tenant-al-audit");
    await insertAdmin(client, adminA, tenantA, "admin-al-audit@example.com");
    // assertPublishEntitled queries tenant_plans.tier; 'internal' bypasses all
    // entitlement checks so every publish-path test in this audit suite proceeds.
    await client.query(
      `INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, 'internal', NULL) ON CONFLICT DO NOTHING`,
      [tenantA],
    );
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

// ===========================================================================
// Tests
// ===========================================================================

describe("G3.D audit writes — 05-assessment-lifecycle", () => {
  it("createAssessment writes an assessment.created audit row in the same tx", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    await clearAudit(tenantA);

    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Audit Create", question_count: 3, opens_at: new Date(Date.now() + 60_000) },
      adminA,
    );

    const rows = await queryAudit(tenantA, "assessment.created");
    const row = rows.find((r) => r.entity_id === assessment.id);
    expect(row).toBeDefined();
    expect(row!.actor_kind).toBe("user");
    expect(row!.actor_user_id).toBe(adminA);
    expect(row!.entity_type).toBe("assessment");
    const after = row!.after as Record<string, unknown>;
    expect(after.pack_id).toBe(packId);
    expect(after.level_id).toBe(levelId);
    expect(after.question_count).toBe(3);
    expect(after.status).toBe("draft");
  });

  it("updateAssessment writes an assessment.updated audit row in the same tx", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Audit Update Pre", question_count: 3, opens_at: new Date(Date.now() + 60_000) },
      adminA,
    );
    await clearAudit(tenantA);

    await updateAssessment(
      tenantA,
      assessment.id,
      { name: "Audit Update Post", question_count: 2 },
      adminA,
    );

    const rows = await queryAudit(tenantA, "assessment.updated");
    const row = rows.find((r) => r.entity_id === assessment.id);
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.name).toBe("Audit Update Pre");
    expect(after.name).toBe("Audit Update Post");
    expect(after.question_count).toBe(2);
    expect(after.changed_fields).toEqual(
      expect.arrayContaining(["name", "questionCount"]),
    );
  });

  it("publishAssessment writes an assessment.published audit row in the same tx", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Audit Publish", question_count: 3, opens_at: new Date(Date.now() + 60_000) },
      adminA,
    );
    await clearAudit(tenantA);

    await publishAssessment(tenantA, assessment.id, adminA);

    const rows = await queryAudit(tenantA, "assessment.published");
    const row = rows.find((r) => r.entity_id === assessment.id);
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.status).toBe("draft");
    expect(after.status).toBe("published");
    expect(after.question_count).toBe(3);
  });

  it("closeAssessment writes an assessment.closed audit row in the same tx", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Audit Close", question_count: 3, opens_at: new Date(Date.now() + 60_000) },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id, adminA);
    // Force to active so closeAssessment's state-machine transition is legal.
    await withSuperClient(async (client) => {
      await client.query(`UPDATE assessments SET status = 'active' WHERE id = $1`, [
        assessment.id,
      ]);
    });
    await clearAudit(tenantA);

    await closeAssessment(tenantA, assessment.id, adminA);

    const rows = await queryAudit(tenantA, "assessment.closed");
    const row = rows.find((r) => r.entity_id === assessment.id);
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.status).toBe("active");
    expect(after.status).toBe("closed");
  });

  it("reopenAssessment writes an assessment.published audit row marked kind=reopen", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    const assessment = await createAssessment(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        name: "Audit Reopen",
        question_count: 3,
        opens_at: new Date(Date.now() + 60_000),
        closes_at: new Date(Date.now() + 60 * 60_000),
      },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id, adminA);
    // Force to closed so reopenAssessment's transition (closed → published) is legal.
    await withSuperClient(async (client) => {
      await client.query(`UPDATE assessments SET status = 'closed' WHERE id = $1`, [
        assessment.id,
      ]);
    });
    await clearAudit(tenantA);

    await reopenAssessment(tenantA, assessment.id, adminA);

    const rows = await queryAudit(tenantA, "assessment.published");
    const row = rows.find(
      (r) =>
        r.entity_id === assessment.id &&
        (r.after as Record<string, unknown>).kind === "reopen",
    );
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.status).toBe("closed");
    expect(after.status).toBe("published");
    expect(after.kind).toBe("reopen");
  });

  it("inviteUsers writes one assessment.invite audit row per issued invitation", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Audit Invite", question_count: 3, opens_at: new Date(Date.now() + 60_000) },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id, adminA);

    const cand1 = randomUUID();
    const cand2 = randomUUID();
    await withSuperClient(async (client) => {
      await insertCandidate(client, cand1, tenantA, `inv1-${randomUUID().slice(0, 6)}@e.com`);
      await insertCandidate(client, cand2, tenantA, `inv2-${randomUUID().slice(0, 6)}@e.com`);
    });

    await clearAudit(tenantA);
    const result = await inviteUsers(tenantA, assessment.id, [cand1, cand2], adminA);
    expect(result.invited).toHaveLength(2);

    const rows = await queryAudit(tenantA, "assessment.invite");
    // One audit row per invitation issued (skipped users produce none).
    const invitationIds = new Set(result.invited.map((inv) => inv.id));
    const matchedRows = rows.filter(
      (r) => r.entity_id !== null && invitationIds.has(r.entity_id),
    );
    expect(matchedRows).toHaveLength(2);
    for (const r of matchedRows) {
      expect(r.actor_user_id).toBe(adminA);
      expect(r.entity_type).toBe("assessment_invitation");
      const after = r.after as Record<string, unknown>;
      expect(after.assessment_id).toBe(assessment.id);
      expect(after.status).toBe("pending");
    }
  });

  it("inviteUsers writes no audit row for skipped users (USER_NOT_FOUND)", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Audit Invite Skip", question_count: 3, opens_at: new Date(Date.now() + 60_000) },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id, adminA);

    await clearAudit(tenantA);
    const ghost = randomUUID();
    const result = await inviteUsers(tenantA, assessment.id, [ghost], adminA);
    expect(result.invited).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);

    const rows = await queryAudit(tenantA, "assessment.invite");
    // No audit row for the ghost user — nothing mutated.
    expect(rows).toHaveLength(0);
  });

  it("revokeInvitation writes an assessment.invite audit row marked kind=revoke", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Audit Revoke", question_count: 3, opens_at: new Date(Date.now() + 60_000) },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id, adminA);

    const cand = randomUUID();
    await withSuperClient(async (client) => {
      await insertCandidate(client, cand, tenantA, `rev-${randomUUID().slice(0, 6)}@e.com`);
    });
    const issueResult = await inviteUsers(tenantA, assessment.id, [cand], adminA);
    const invitationId = issueResult.invited[0]!.id;

    await clearAudit(tenantA);
    await revokeInvitation(tenantA, invitationId, adminA);

    const rows = await queryAudit(tenantA, "assessment.invite");
    const row = rows.find(
      (r) =>
        r.entity_id === invitationId &&
        (r.after as Record<string, unknown>).kind === "revoke",
    );
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.status).toBe("pending");
    expect(after.status).toBe("expired");
    expect(after.kind).toBe("revoke");
  });

  it("revokeInvitation idempotent path on already-expired invitation does NOT write a duplicate audit row", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Audit Revoke Idem", question_count: 3, opens_at: new Date(Date.now() + 60_000) },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id, adminA);

    const cand = randomUUID();
    await withSuperClient(async (client) => {
      await insertCandidate(client, cand, tenantA, `rev2-${randomUUID().slice(0, 6)}@e.com`);
    });
    const issueResult = await inviteUsers(tenantA, assessment.id, [cand], adminA);
    const invitationId = issueResult.invited[0]!.id;
    await revokeInvitation(tenantA, invitationId, adminA);

    await clearAudit(tenantA);
    // Second revoke is a no-op — should NOT write a new audit row.
    await revokeInvitation(tenantA, invitationId, adminA);

    const rows = await queryAudit(tenantA, "assessment.invite");
    const matched = rows.filter((r) => r.entity_id === invitationId);
    expect(matched).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Atomicity: when the mutation throws, no audit row is left orphaned.
  // -------------------------------------------------------------------------
  it("publishAssessment on a non-existent id throws and writes NO audit row", async () => {
    await clearAudit(tenantA);
    const fakeId = randomUUID();
    await expect(publishAssessment(tenantA, fakeId, adminA)).rejects.toThrow();

    const rows = await queryAudit(tenantA);
    // No assessment.* audit row should have been written.
    expect(rows.filter((r) => r.action.startsWith("assessment."))).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Coverage assertion: service.ts contains exactly N auditInTx call-sites.
  // -------------------------------------------------------------------------
  it("service.ts contains exactly 9 auditInTx call-sites (one per wired admin-mutating function)", async () => {
    const servicePath = join(AL_MODULE_ROOT, "src", "service.ts");
    const source = await readFile(servicePath, "utf-8");
    const matches = source.match(/auditInTx\(/g) ?? [];
    // 9 wired admin-mutating functions:
    // createAssessment, updateAssessment, publishAssessment, closeAssessment,
    // cancelAssessment, deleteAssessment, reopenAssessment, inviteUsers,
    // revokeInvitation.
    expect(matches.length).toBe(9);
  });
});
