/**
 * Camera retention sweep + repository + consent immutability (Batch A), against the real schema.
 * Fixtures use session_replication_role = replica so attempts need no assessment/user chain.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { withTenant } from "../../../02-tenancy/src/with-tenant.js";
import {
  runCameraRetentionForTenant,
  buildCameraRelativePath,
  getUsage,
  insertConsent,
  linkConsentToAttempt,
  latestConsentForInvitation,
  hasAgreedConsentForAttempt,
  markReviewed,
  setAppealState,
  isReviewer,
  addReviewer,
  removeReviewer,
} from "../camera/index.js";

const NOW = new Date("2026-10-20T00:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

let container: StartedTestContainer;
let url: string;
let dir: string;
let T: string;
let user: string;
const prevDir = config.CAMERA_STORAGE_DIR;

async function sup<R = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<R[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`SET session_replication_role = replica`);
    return (await c.query(q, p)).rows as R[];
  } finally {
    await c.end();
  }
}

/** Plain superuser query: triggers stay on (unlike sup). */
async function strict(q: string, p: unknown[] = []): Promise<void> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(q, p);
  } finally {
    await c.end();
  }
}

/** One attempt with one file. Returns ids. The file exists on disk. */
async function seedFile(opts: { taken: Date; expires: Date; flagged?: boolean; attempt?: string }) {
  const attempt = opts.attempt ?? randomUUID();
  if (opts.attempt === undefined) {
    await sup(`INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status) VALUES ($1, $2, $3, $4, 'in_progress')`, [
      attempt, T, randomUUID(), user,
    ]);
  }
  const id = randomUUID();
  const rel = buildCameraRelativePath(T, attempt, id, "photo");
  await mkdir(join(dir, T, attempt), { recursive: true });
  await writeFile(join(dir, rel), "x");
  await sup(
    `INSERT INTO camera_files (id, tenant_id, attempt_id, user_id, kind, storage_path, size_bytes, taken_at, expires_at, flagged, flag_reason)
     VALUES ($1, $2, $3, $4, 'photo', $5, 100, $6, $7, $8, $9)`,
    [id, T, attempt, user, rel, opts.taken, opts.expires, opts.flagged ?? false, opts.flagged ? "camera_stopped" : null],
  );
  return { id, attempt, rel };
}
const rowExists = async (id: string) => (await sup(`SELECT 1 FROM camera_files WHERE id = $1`, [id])).length === 1;
const onDisk = (rel: string) => stat(join(dir, rel)).then(() => true, () => false);

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "assessiq", POSTGRES_PASSWORD: "pw", POSTGRES_DB: "assessiq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://assessiq:pw@${container.getHost()}:${container.getMappedPort(5432)}/assessiq`;
  const c = new Client({ connectionString: url });
  await c.connect();
  await applyAllMigrations(c);
  await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app, assessiq_system`);
  await c.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  await c.end();
  setPoolForTesting(url);

  dir = await mkdtemp(join(tmpdir(), "aiq-camera-ret-"));
  (config as { CAMERA_STORAGE_DIR: string }).CAMERA_STORAGE_DIR = dir;
  T = randomUUID();
  user = randomUUID();
  await sup(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Acme')`, [T, `acme-${T.slice(0, 8)}`]);
  await sup(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [T]);
}, 120_000);

afterAll(async () => {
  (config as { CAMERA_STORAGE_DIR: string }).CAMERA_STORAGE_DIR = prevDir;
  await rm(dir, { recursive: true, force: true });
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(async () => {
  await sup(`DELETE FROM camera_files WHERE tenant_id = $1`, [T]);
  await sup(`DELETE FROM camera_attempt_reviews WHERE tenant_id = $1`, [T]);
  await sup(`DELETE FROM audit_log WHERE tenant_id = $1`, [T]);
  await sup(`UPDATE tenants SET is_school = false WHERE id = $1`, [T]);
});

describe("runCameraRetentionForTenant", () => {
  it("deletes expired files (disk and row) and keeps unexpired ones", async () => {
    const old = await seedFile({ taken: days(-100), expires: days(-1) });
    const fresh = await seedFile({ taken: days(-1), expires: days(6) });
    const res = await runCameraRetentionForTenant(T, NOW);
    expect(res).toMatchObject({ scanned: 1, deleted: 1, held: 0, failed: 0 });
    expect(await rowExists(old.id)).toBe(false);
    expect(await onDisk(old.rel)).toBe(false);
    expect(await rowExists(fresh.id)).toBe(true);
    expect(await onDisk(fresh.rel)).toBe(true);
    const audit = await sup<{ after: { deleted: number } }>(`SELECT after FROM audit_log WHERE tenant_id = $1 AND action = 'camera.retention.sweep'`, [T]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after.deleted).toBe(1);
  });

  it("writes no audit row when nothing was deleted", async () => {
    await seedFile({ taken: days(-1), expires: days(6) });
    await runCameraRetentionForTenant(T, NOW);
    expect(await sup(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'camera.retention.sweep'`, [T])).toHaveLength(0);
  });

  it("holds an expired file of a flagged, unreviewed attempt", async () => {
    const f = await seedFile({ taken: days(-10), expires: days(-3), flagged: true });
    expect(await runCameraRetentionForTenant(T, NOW)).toMatchObject({ deleted: 0, held: 1 });
    expect(await rowExists(f.id)).toBe(true);
    expect(await onDisk(f.rel)).toBe(true);
  });

  it("deletes a flagged file once the attempt is reviewed, but holds it again while an appeal is open", async () => {
    const f = await seedFile({ taken: days(-10), expires: days(-3), flagged: true });
    await withTenant(T, async (c) => {
      await markReviewed(c, T, f.attempt, user);
      await setAppealState(c, T, f.attempt, "open");
    });
    expect(await runCameraRetentionForTenant(T, NOW)).toMatchObject({ deleted: 0, held: 1 });
    await withTenant(T, (c) => setAppealState(c, T, f.attempt, "closed"));
    expect(await runCameraRetentionForTenant(T, NOW)).toMatchObject({ deleted: 1, held: 0 });
    expect(await rowExists(f.id)).toBe(false);
  });

  it("deletes a held file once it is older than the max age (365 days other, 90 days school)", async () => {
    const f = await seedFile({ taken: days(-100), expires: days(-90), flagged: true });
    expect(await runCameraRetentionForTenant(T, NOW)).toMatchObject({ deleted: 0, held: 1 }); // other: held up to 365 d
    await sup(`UPDATE tenants SET is_school = true WHERE id = $1`, [T]);
    expect(await runCameraRetentionForTenant(T, NOW)).toMatchObject({ deleted: 1, held: 0 }); // school: 100 d > 90 d
    expect(await rowExists(f.id)).toBe(false);

    const g = await seedFile({ taken: days(-400), expires: days(-390), flagged: true });
    await sup(`UPDATE tenants SET is_school = false WHERE id = $1`, [T]);
    expect(await runCameraRetentionForTenant(T, NOW)).toMatchObject({ deleted: 1 });
    expect(await rowExists(g.id)).toBe(false);
  });

  it("keeps the row when the disk delete fails, so the next run retries", async () => {
    const f = await seedFile({ taken: days(-100), expires: days(-1) });
    // Replace the file with a directory: unlink fails with a non-ENOENT error.
    await rm(join(dir, f.rel));
    await mkdir(join(dir, f.rel));
    expect(await runCameraRetentionForTenant(T, NOW)).toMatchObject({ deleted: 0, failed: 1 });
    expect(await rowExists(f.id)).toBe(true);
    await rm(join(dir, f.rel), { recursive: true });
    expect(await runCameraRetentionForTenant(T, NOW)).toMatchObject({ deleted: 1, failed: 0 }); // ENOENT is fine
  });

  it("holds the files again when a new flag arrives after the review", async () => {
    const f = await seedFile({ taken: days(-10), expires: days(-3), flagged: true });
    await withTenant(T, (c) => markReviewed(c, T, f.attempt, user));
    // a later flagged moment (taken after the review) makes the review stale
    await seedFile({ taken: new Date(Date.now() + 3_600_000), expires: days(-3), flagged: true, attempt: f.attempt });
    expect(await runCameraRetentionForTenant(T, NOW)).toMatchObject({ deleted: 0, held: 2 });
  });

  it("sweeps a suspended tenant but skips an archived one", async () => {
    const f = await seedFile({ taken: days(-100), expires: days(-1) });
    await sup(`UPDATE tenants SET status = 'archived' WHERE id = $1`, [T]);
    try {
      expect(await runCameraRetentionForTenant(T, NOW)).toMatchObject({ scanned: 0, deleted: 0 });
      expect(await rowExists(f.id)).toBe(true);
      await sup(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [T]);
      expect(await runCameraRetentionForTenant(T, NOW)).toMatchObject({ deleted: 1 });
      expect(await rowExists(f.id)).toBe(false);
    } finally {
      await sup(`UPDATE tenants SET status = 'active' WHERE id = $1`, [T]);
    }
  });
});

describe("repository and usage", () => {
  it("getUsage sums size_bytes across tenants", async () => {
    await seedFile({ taken: days(-1), expires: days(6) });
    await seedFile({ taken: days(-1), expires: days(6) });
    expect(await getUsage()).toBe(200);
  });

  it("consent: link to attempt works; every other UPDATE is refused", async () => {
    const inv = randomUUID();
    const att = randomUUID();
    await sup(`INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status) VALUES ($1, $2, $3, $4, 'in_progress')`, [att, T, randomUUID(), user]);
    await withTenant(T, async (c) => {
      await insertConsent(c, { tenantId: T, invitationId: inv, userId: user, decision: "agreed", noticeVersion: "v1", ipHash: "h", deviceType: "desktop" });
      expect((await latestConsentForInvitation(c, inv))?.decision).toBe("agreed");
      expect(await hasAgreedConsentForAttempt(c, att)).toBe(false);
      expect(await linkConsentToAttempt(c, inv, att)).toBe(true);
      expect(await hasAgreedConsentForAttempt(c, att)).toBe(true);
    });
    await expect(strict(`UPDATE camera_consents SET decision = 'declined' WHERE invitation_id = $1`, [inv])).rejects.toThrow(/immutable/);
    await expect(strict(`UPDATE camera_consents SET attempt_id = NULL WHERE invitation_id = $1`, [inv])).rejects.toThrow(/immutable/);
  });

  it("reviewers: add, check, remove", async () => {
    const u = randomUUID();
    await withTenant(T, async (c) => {
      await addReviewer(c, T, u, user);
      expect(await isReviewer(c, u)).toBe(true);
      expect(await removeReviewer(c, u)).toBe(true);
      expect(await isReviewer(c, u)).toBe(false);
    });
  });
});
