/**
 * E3 — server-side erased-candidate guards (testcontainers Postgres, real RLS).
 *
 * Every admin action that touches a candidate must refuse when users.erased_at IS NOT NULL
 * (409 CANDIDATE_ERASED), not merely be hidden in the UI:
 *   05 resendInvitation (single)  -> 409; inviteUsers (bulk/re-invite) -> skipped CANDIDATE_ERASED
 *   07 manual score + override    -> 409
 *   18 reissue certificate        -> 409; issueCertificateOnRelease -> null (no cert minted)
 *   20 candidate data export      -> 409
 * Release / publish are already guarded (09 release.ts, 07 release-to-tenant) and covered by
 * release-flow.test.ts / super-evaluation.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

vi.mock("@assessiq/notifications", () => ({ emitAttemptEventAfterCommit: vi.fn(async () => undefined),
  sendResultReleasedEmail: vi.fn(),
  sendAssessmentInvitationEmail: vi.fn(),
  sendEmail: vi.fn(),
  processEmailSendJob: vi.fn(),
  processWebhookDeliverJob: vi.fn(),
  webhookBackoffStrategy: vi.fn(),
}));

import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { resendInvitation, inviteUsers } from "@assessiq/assessment-lifecycle";
import { handleAdminManualScore, handleAdminOverride } from "@assessiq/ai-grading";
import { issueCertificate, reissue, issueCertificateOnRelease, CERT_SIGNING_SECRET_ENV } from "@assessiq/certification";
import { exportCandidateData } from "@assessiq/data-rights";

const toFsPath = (u: URL): string => u.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MODULES_ROOT = join(toFsPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "modules");
// Same module set / order as result-flow.test.ts (fresh-DB dependency order).
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
  ["18-certification", undefined],
  ["19-billing", undefined],
  ["20-data-rights", ["0102_users_erased_at.sql"]],
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

beforeAll(async () => {
  process.env[CERT_SIGNING_SECRET_ENV] = "erased-guard-test-secret";
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_erased" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_erased`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    for (const r of ["assessiq_app", "assessiq_system"]) {
      const bypass = r === "assessiq_system" ? " BYPASSRLS" : "";
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN CREATE ROLE ${r}${bypass}; END IF; END $$;`);
      await c.query(`GRANT ${r} TO test`);
    }
    for (const [mod, only] of DIRS) {
      const dir = join(MODULES_ROOT, mod, "migrations");
      const files = (await readdir(dir)).filter((f) => f.endsWith(".sql") && (only === undefined || only.includes(f))).sort();
      for (const f of files) await c.query(await readFile(join(dir, f), "utf-8"));
    }
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  });
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

interface Seed {
  tenant: string;
  admin: string;
  assessment: string;
  /** erased candidate, with an invitation, a submitted attempt (KQL, one AI grading), a certificate */
  erased: { userId: string; invitationId: string; attemptId: string; qid: string; gradingId: string; credentialId: string };
  /** live (not erased) candidate with a submitted KQL attempt — the control */
  live: { userId: string; attemptId: string; qid: string };
}

async function seed(): Promise<Seed> {
  const tenant = randomUUID();
  const admin = randomUUID();
  const pack = randomUUID();
  const level = randomUUID();
  const assessment = randomUUID();
  const erasedUser = randomUUID();
  const liveUser = randomUUID();
  const invitationId = randomUUID();
  const noAttemptErased = randomUUID(); // erased, never started: the resend guard (not "already started") must answer
  const mk = async (c: Client, userId: string, erased: boolean) => {
    const attemptId = randomUUID();
    const qid = randomUUID();
    const content = JSON.stringify({ question: "q" });
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status, erased_at) VALUES ($1,$2,$3,'Cand','candidate','active',$4)`,
      [userId, tenant, `c-${userId.slice(0, 8)}@erased.test`, erased ? new Date() : null],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'submitted', now() - interval '20 minutes', now() + interval '40 minutes', now(), 3600)`,
      [attemptId, tenant, assessment, userId],
    );
    await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,'kql','t',10,'active',$4::jsonb,1,$5)`, [qid, pack, level, content, admin]);
    await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, admin]);
    await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version, points) VALUES ($1,$2,1,1,10)`, [attemptId, qid]);
    return { attemptId, qid };
  };
  return sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,'Erased Test College')`, [tenant, `t-${tenant.slice(0, 8)}`]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [admin, tenant, `a-${tenant.slice(0, 6)}@erased.test`]);
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`, [pack, tenant, `p-${pack.slice(0, 8)}`, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [level, pack]);
    await c.query(`INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'Assess','active',1,$5)`, [assessment, tenant, pack, level, admin]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status, erased_at) VALUES ($1,$2,$3,'Cand','candidate','active',now())`, [noAttemptErased, tenant, `c-${noAttemptErased.slice(0, 8)}@erased.test`]);
    const e = await mk(c, erasedUser, true);
    const l = await mk(c, liveUser, false);
    await c.query(
      `INSERT INTO assessment_invitations (id, assessment_id, user_id, token_hash, expires_at, status, invited_by) VALUES ($1,$2,$3,$4,now() + interval '1 day','pending',$5)`,
      [invitationId, assessment, noAttemptErased, randomUUID().replace(/-/g, ""), admin],
    );
    const g = await c.query<{ id: string }>(
      `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model)
       VALUES ($1,$2,$3,'ai',5,10,'correct','sha-x','v1','m') RETURNING id`,
      [tenant, e.attemptId, e.qid],
    );
    return {
      tenant,
      admin,
      assessment,
      erased: { userId: erasedUser, invitationId, attemptId: e.attemptId, qid: e.qid, gradingId: g.rows[0]!.id, credentialId: "" },
      live: { userId: liveUser, attemptId: l.attemptId, qid: l.qid },
    };
  });
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "no-error",
    (e: { code?: string; details?: { code?: string } }) => e.details?.code ?? e.code ?? "unknown",
  );

describe("E3 erased-candidate guards", () => {
  it("05: single resend -> CANDIDATE_ERASED; bulk invite of an erased user -> skipped", async () => {
    const s = await seed();
    expect(await code(resendInvitation(s.tenant, s.erased.invitationId, s.admin))).toBe("CANDIDATE_ERASED");
    const r = await inviteUsers(s.tenant, s.assessment, [s.erased.userId], s.admin);
    expect(r.skipped).toEqual([{ userId: s.erased.userId, reason: "CANDIDATE_ERASED" }]);
  });

  it("07: manual score refuses an erased candidate (live candidate control still scores)", async () => {
    const s = await seed();
    const base = { tenantId: s.tenant, userId: s.admin, scoreEarned: 5, reason: "manual" };
    expect(await code(handleAdminManualScore({ ...base, attemptId: s.erased.attemptId, questionId: s.erased.qid }))).toBe("CANDIDATE_ERASED");
    expect(await code(handleAdminManualScore({ ...base, attemptId: s.live.attemptId, questionId: s.live.qid }))).toBe("no-error");
  });

  it("07: override refuses an erased candidate's grading", async () => {
    const s = await seed();
    const err = await code(handleAdminOverride({ tenantId: s.tenant, userId: s.admin, gradingId: s.erased.gradingId, override: { score_earned: 9, reason: "r" } }));
    expect(err).toBe("CANDIDATE_ERASED");
  });

  it("18: reissue refuses once the candidate is erased; no certificate is minted on release", async () => {
    const s = await seed();
    // issue while the candidate is still live, then erase
    const liveCert = await withTenant(s.tenant, async (client) => {
      await client.query("SELECT txid_current()"); // assign an xid: issueCertificate insists on an open write tx
      return issueCertificate(client, {
        tenant_id: s.tenant,
        attempt_id: s.live.attemptId,
        candidate_id: s.live.userId,
        template_key: "aiq-standard",
        display_name: "Cand",
        course_title: "Assess",
        level: "L1",
        tier: "completion",
        actor_user_id: s.admin,
      });
    });
    expect(await code(reissue(s.tenant, liveCert.credential_id, "New Name", s.admin))).toBe("no-error");
    await sup((c) => c.query(`UPDATE users SET erased_at = now() WHERE id = $1`, [s.live.userId]));
    expect(await code(reissue(s.tenant, liveCert.credential_id, "Another", s.admin))).toBe("CANDIDATE_ERASED");

    await sup((c) => c.query(`INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct) VALUES ($1,$2,10,10,100)`, [s.erased.attemptId, s.tenant]));
    const minted = await withTenant(s.tenant, (client) => issueCertificateOnRelease(client, { tenantId: s.tenant, attemptId: s.erased.attemptId, actorUserId: s.admin }));
    expect(minted).toBeNull();
  });

  it("20: candidate data export refuses an erased candidate", async () => {
    const s = await seed();
    expect(await code(exportCandidateData(s.tenant, s.erased.userId))).toBe("CANDIDATE_ERASED");
  });
});
