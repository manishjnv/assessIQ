/**
 * Integrity v1: event catalog additions (pure) + getAttemptIntegritySummary and the
 * CandidateAttemptView.integrity switches on a real Postgres (testcontainers).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { EVENT_PAYLOAD_SCHEMAS } from "../types.js";
import { getAttemptForCandidate, getAttemptIntegritySummary } from "../service.js";

describe("integrity event schemas", () => {
  it("accepts fullscreen_enter / fullscreen_exit with an empty payload", () => {
    expect(EVENT_PAYLOAD_SCHEMAS.fullscreen_enter.safeParse({}).success).toBe(true);
    expect(EVENT_PAYLOAD_SCHEMAS.fullscreen_exit.safeParse({}).success).toBe(true);
  });
  it("accepts optional blocked on copy/paste and rejects a non-boolean", () => {
    expect(EVENT_PAYLOAD_SCHEMAS.paste.safeParse({ length: 4, blocked: true }).success).toBe(true);
    expect(EVENT_PAYLOAD_SCHEMAS.copy.safeParse({ length: 4 }).success).toBe(true);
    expect(EVENT_PAYLOAD_SCHEMAS.copy.safeParse({ blocked: "yes" }).success).toBe(false);
  });
});

const MODULES_ROOT = join(dirname(fileURLToPath(import.meta.url)) + sep, "..", "..", "..");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["14-audit-log", undefined],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined],
  ["12-embed-sdk", ["0073_attempt_embed_origin.sql"]],
  ["07-ai-grading", ["0040_gradings.sql", "0041_tenant_grading_budgets.sql", "0100_attempts_ai_proposals_cache.sql"]],
  ["09-scoring", undefined],
  ["19-billing", undefined],
  ["20-data-rights", ["0101_consent_events.sql"]],
];

let container: StartedTestContainer;
let url: string;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

interface Seeded {
  tenant: string;
  user: string;
  attempt: string;
}

async function seed(slug: string, integrity: unknown): Promise<Seeded> {
  const tenant = randomUUID();
  const admin = randomUUID();
  const user = randomUUID();
  const pack = randomUUID();
  const level = randomUUID();
  const assessment = randomUUID();
  const attempt = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,'T')`, [tenant, slug]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'A','admin','active'), ($4,$2,$5,'C','candidate','active')`,
      [admin, tenant, `a@${slug}.test`, user, `c@${slug}.test`],
    );
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p','P','soc','published',$3)`,
      [pack, tenant, admin],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`,
      [level, pack],
    );
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, settings, created_by) VALUES ($1,$2,$3,$4,1,'A','active',1,$5::jsonb,$6)`,
      [assessment, tenant, pack, level, JSON.stringify(integrity === undefined ? {} : { integrity }), admin],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, duration_seconds) VALUES ($1,$2,$3,$4,'in_progress', now(), now() + interval '1 hour', 3600)`,
      [attempt, tenant, assessment, user],
    );
    const ev: Array<[string, unknown]> = [
      ["tab_blur", {}], ["tab_focus", {}], ["tab_blur", {}], ["tab_focus", {}],
      ["copy", { length: 3 }], ["paste", { length: 2 }], ["paste", { length: 5, blocked: true }],
      ["fullscreen_enter", {}], ["fullscreen_exit", {}],
      ["multi_tab_conflict", { incoming_revision: 2, stored_revision: 3 }],
    ];
    for (const [t, p] of ev) {
      await c.query(`INSERT INTO attempt_events (attempt_id, event_type, payload) VALUES ($1,$2,$3::jsonb)`, [attempt, t, JSON.stringify(p)]);
    }
  });
  return { tenant, user, attempt };
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_integrity" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_integrity`;
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
  });
  await setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("getAttemptIntegritySummary + CandidateAttemptView.integrity", () => {
  it("counts events, is RLS-scoped, and reads the integrity switches", async () => {
    const a = await seed("int-a", { fullscreen: true, block_copy_paste: true });
    const b = await seed("int-b", undefined);

    expect(await getAttemptIntegritySummary(a.tenant, a.attempt)).toEqual({
      tab_switches: 2,
      copy: 1,
      paste: 2,
      paste_blocked: 1,
      fullscreen_exits: 1,
      multi_tab_conflicts: 1,
    });

    // Another tenant cannot read it (RLS hides the attempt).
    await expect(getAttemptIntegritySummary(b.tenant, a.attempt)).rejects.toThrow(/not found/i);

    expect((await getAttemptForCandidate(a.tenant, a.attempt, a.user)).integrity).toEqual({
      fullscreen: true,
      block_copy_paste: true,
    });
    // No settings.integrity -> both off.
    expect((await getAttemptForCandidate(b.tenant, b.attempt, b.user)).integrity).toEqual({
      fullscreen: false,
      block_copy_paste: false,
    });
  });
});
