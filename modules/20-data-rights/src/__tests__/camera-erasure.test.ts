/**
 * Erasure of camera data (Batch A): eraseCandidatePii removes the user's camera_files rows AND disk
 * files, camera_consents and camera_attempt_reviews. A disk delete that fails is not silent: the
 * erasure throws and nothing is committed, so the job retries.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, buildCameraRelativePath } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { eraseCandidatePii } from "../erasure.js";

let container: StartedTestContainer;
let url: string;
let dir: string;
let T: string;
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
const onDisk = (rel: string) => stat(join(dir, rel)).then(() => true, () => false);

async function seedCandidate() {
  const user = randomUUID();
  const attempt = randomUUID();
  const fileId = randomUUID();
  const rel = buildCameraRelativePath(T, attempt, fileId, "photo");
  await sup(`INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1, $2, $3, 'Cand Idate', 'candidate')`, [user, T, `c-${user}@x.test`]);
  await sup(`INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status) VALUES ($1, $2, $3, $4, 'submitted')`, [attempt, T, randomUUID(), user]);
  await mkdir(join(dir, T, attempt), { recursive: true });
  await writeFile(join(dir, rel), "x");
  await sup(
    `INSERT INTO camera_files (id, tenant_id, attempt_id, user_id, kind, storage_path, size_bytes, taken_at, expires_at)
     VALUES ($1, $2, $3, $4, 'photo', $5, 10, now(), now() + interval '7 days')`,
    [fileId, T, attempt, user, rel],
  );
  await sup(
    `INSERT INTO camera_consents (tenant_id, invitation_id, attempt_id, user_id, decision, notice_version, ip_hash, device_type)
     VALUES ($1, $2, $3, $4, 'agreed', 'v1', 'h', 'desktop')`,
    [T, randomUUID(), attempt, user],
  );
  await sup(`INSERT INTO camera_attempt_reviews (tenant_id, attempt_id) VALUES ($1, $2)`, [T, attempt]);
  return { user, attempt, fileId, rel };
}
const count = async (table: string, col: string, id: string) =>
  (await sup<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [id]))[0]!.n;

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
  await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
  await c.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  await c.end();
  setPoolForTesting(url);

  dir = await mkdtemp(join(tmpdir(), "aiq-camera-era-"));
  (config as { CAMERA_STORAGE_DIR: string }).CAMERA_STORAGE_DIR = dir;
  T = randomUUID();
  await sup(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Acme')`, [T, `acme-${T.slice(0, 8)}`]);
  await sup(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [T]);
}, 120_000);

afterAll(async () => {
  (config as { CAMERA_STORAGE_DIR: string }).CAMERA_STORAGE_DIR = prevDir;
  await rm(dir, { recursive: true, force: true });
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("eraseCandidatePii camera data", () => {
  it("removes files from disk and the camera rows of the erased user only", async () => {
    const a = await seedCandidate();
    const b = await seedCandidate();
    await eraseCandidatePii(T, a.user, "test", null, "system");
    expect(await onDisk(a.rel)).toBe(false);
    expect(await count("camera_files", "user_id", a.user)).toBe(0);
    expect(await count("camera_consents", "user_id", a.user)).toBe(0);
    expect(await count("camera_attempt_reviews", "attempt_id", a.attempt)).toBe(0);
    // the other candidate is untouched
    expect(await onDisk(b.rel)).toBe(true);
    expect(await count("camera_files", "user_id", b.user)).toBe(1);
    expect(await count("camera_consents", "user_id", b.user)).toBe(1);
  });

  it("a failed disk delete throws and commits nothing, so the job retries", async () => {
    const a = await seedCandidate();
    await rm(join(dir, a.rel));
    await mkdir(join(dir, a.rel)); // unlink on a directory fails with a non-ENOENT error
    await expect(eraseCandidatePii(T, a.user, "test", null, "system")).rejects.toThrow();
    expect(await count("camera_files", "user_id", a.user)).toBe(1);
    expect((await sup<{ erased_at: string | null }>(`SELECT erased_at FROM users WHERE id = $1`, [a.user]))[0]!.erased_at).toBeNull();
    await rm(join(dir, a.rel), { recursive: true });
    await eraseCandidatePii(T, a.user, "test", null, "system"); // ENOENT counts as gone
    expect(await count("camera_files", "user_id", a.user)).toBe(0);
  });
});
