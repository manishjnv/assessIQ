/**
 * Camera settings (Batch A): defaults, setTenantIsSchool / updateCameraSettings / confirmCameraNotice
 * each write one audit row in the same tx, and a bad value is refused before any write.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../pool.js";
import { getCameraTenantSettings, setTenantIsSchool, updateCameraSettings, confirmCameraNotice } from "../camera.js";

const ACTOR = "00000000-0000-0000-0000-000000000002";

let container: StartedTestContainer;
let url: string;
let A: string;

async function sql<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, p)).rows as T[];
  } finally {
    await c.end();
  }
}

const audits = () =>
  sql<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
    `SELECT before, after FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.settings.updated' ORDER BY at`,
    [A],
  );

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
  await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  await c.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  await c.end();

  setPoolForTesting(url);
  A = randomUUID();
  await sql(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Acme Corp')`, [A, `acme-${A.slice(0, 8)}`]);
  await sql(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [A]);
  await sql(`INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1, $2, 'admin@acme.test', 'Acme Admin', 'admin')`, [ACTOR, A]);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(async () => {
  await sql(`UPDATE tenants SET is_school = false WHERE id = $1`, [A]);
  await sql(
    `UPDATE tenant_settings SET camera_enabled = false, camera_photos_enabled = false,
            camera_notice_confirmed_version = NULL, camera_notice_confirmed_at = NULL, camera_notice_confirmed_by = NULL
      WHERE tenant_id = $1`,
    [A],
  );
  await sql(`DELETE FROM audit_log WHERE tenant_id = $1`, [A]);
});

describe("camera tenant settings", () => {
  it("defaults are all off and the notice is not confirmed", async () => {
    expect(await getCameraTenantSettings(A)).toEqual({
      isSchool: false,
      cameraEnabled: false,
      photosEnabled: false,
      noticeConfirmedVersion: null,
    });
  });

  it("setTenantIsSchool flips the flag and writes one audit row with before/after", async () => {
    await setTenantIsSchool(A, true, ACTOR);
    expect((await getCameraTenantSettings(A)).isSchool).toBe(true);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toEqual({ is_school: false });
    expect(rows[0]!.after).toEqual({ is_school: true });
  });

  it("updateCameraSettings changes only the given fields and writes one audit row", async () => {
    await updateCameraSettings(A, { cameraEnabled: true }, ACTOR);
    await updateCameraSettings(A, { photosEnabled: true }, ACTOR);
    const s = await getCameraTenantSettings(A);
    expect(s.cameraEnabled).toBe(true);
    expect(s.photosEnabled).toBe(true);
    expect(await audits()).toHaveLength(2);
  });

  it("confirmCameraNotice stores the version, who and when, and writes one audit row", async () => {
    await confirmCameraNotice(A, "2026-10-20.v1", ACTOR);
    expect((await getCameraTenantSettings(A)).noticeConfirmedVersion).toBe("2026-10-20.v1");
    const row = (await sql<{ by: string; at: Date | null }>(
      `SELECT camera_notice_confirmed_by AS by, camera_notice_confirmed_at AS at FROM tenant_settings WHERE tenant_id = $1`,
      [A],
    ))[0]!;
    expect(row.by).toBe(ACTOR);
    expect(row.at).not.toBeNull();
    expect(await audits()).toHaveLength(1);
  });

  it("a bad value is refused with no write and no audit row", async () => {
    await expect(setTenantIsSchool(A, "yes" as unknown as boolean, ACTOR)).rejects.toThrow();
    await expect(confirmCameraNotice(A, "  ", ACTOR)).rejects.toThrow();
    expect(await audits()).toHaveLength(0);
  });
});
