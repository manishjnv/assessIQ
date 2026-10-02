/**
 * Module 20 (data-rights) integration tests — real Postgres (testcontainers) + real RLS.
 *
 * Covers erasure (PII tombstone, metadata roll/branch drop, kept aggregates, tenant
 * isolation, idempotency), export (own data only, refuses erased), retention
 * selection (window / active attempts / dry-run / tenant scope) and the erased list.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import {
  eraseCandidatePii,
  exportCandidateData,
  runRetentionPurgeForTenant,
  listErasedCandidates,
} from "../index.js";

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
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_dr" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_dr`;
  await sup((c) => applyAllMigrations(c));
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface Tenant {
  id: string;
  admin: string;
  pack: string;
  level: string;
  assessment: string;
}

async function seedTenant(): Promise<Tenant> {
  const t: Tenant = {
    id: randomUUID(),
    admin: randomUUID(),
    pack: randomUUID(),
    level: randomUUID(),
    assessment: randomUUID(),
  };
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,'DR Test')`, [t.id, `t-${t.id.slice(0, 8)}`]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [t.id]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`,
      [t.admin, t.id, `a-${t.id.slice(0, 6)}@dr.test`],
    );
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`,
      [t.pack, t.id, `p-${t.pack.slice(0, 8)}`, t.admin],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,2,60)`,
      [t.level, t.pack],
    );
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'Assess','active',2,$5)`,
      [t.assessment, t.id, t.pack, t.level, t.admin],
    );
  });
  return t;
}

interface Cand {
  userId: string;
  email: string;
  attemptId: string;
  mcqQid: string;
  kqlQid: string;
}

/** Candidate with a submitted attempt (one mcq + one kql answer), score, grading, session, cert, consent. */
async function seedCandidate(t: Tenant, opts: { createdDaysAgo?: number } = {}): Promise<Cand> {
  const c0: Cand = {
    userId: randomUUID(),
    email: `cand-${randomUUID().slice(0, 8)}@dr.test`,
    attemptId: randomUUID(),
    mcqQid: randomUUID(),
    kqlQid: randomUUID(),
  };
  await sup(async (c) => {
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status, metadata)
       VALUES ($1,$2,$3,'Riya Sharma','candidate','active',
               '{"roll_number":"R-101","branch":"CSE","cohort":"2026"}'::jsonb)`,
      [c0.userId, t.id, c0.email],
    );
    if (opts.createdDaysAgo !== undefined) {
      await c.query(`UPDATE users SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`, [
        c0.userId,
        opts.createdDaysAgo,
      ]);
    }
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'submitted', now() - interval '20 minutes', now() + interval '40 minutes', now(), 3600)`,
      [c0.attemptId, t.id, t.assessment, c0.userId],
    );
    const content = JSON.stringify({ question: "q" });
    let pos = 1;
    for (const [qid, type] of [[c0.mcqQid, "mcq"], [c0.kqlQid, "kql"]] as const) {
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'t',10,'active',$5::jsonb,1,$6)`,
        [qid, t.pack, t.level, type, content, t.admin],
      );
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, t.admin]);
      await c.query(
        `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version, points) VALUES ($1,$2,$3,1,10)`,
        [c0.attemptId, qid, pos++],
      );
    }
    await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,'{"selected":1}'::jsonb)`, [c0.attemptId, c0.mcqQid]);
    await c.query(
      `INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,'{"text":"my email is riya@example.com"}'::jsonb)`,
      [c0.attemptId, c0.kqlQid],
    );
    await c.query(
      `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct) VALUES ($1,$2,10,20,50)`,
      [c0.attemptId, t.id],
    );
    await c.query(
      `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model)
       VALUES ($1,$2,$3,'ai',5,10,'correct','sha-x','v1','m')`,
      [t.id, c0.attemptId, c0.kqlQid],
    );
    await c.query(
      `INSERT INTO sessions (user_id, tenant_id, role, token_hash, ip, user_agent, expires_at)
       VALUES ($1,$2,'candidate',$3,'10.1.2.3','Mozilla/5.0', now() + interval '1 day')`,
      [c0.userId, t.id, randomUUID().replace(/-/g, "")],
    );
    await c.query(
      `INSERT INTO certificates (tenant_id, attempt_id, candidate_id, template_key, credential_id, tier, display_name, course_title, level, signed_hash)
       VALUES ($1,$2,$3,'standard',$4,'completion','Riya Sharma','SOC Analyst L1','L1','sig')`,
      [t.id, c0.attemptId, c0.userId, `CRED-${randomUUID().slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO consent_events (tenant_id, user_id, purpose, policy_version, granted_at, lawful_basis)
       VALUES ($1,$2,'data_processing','v1',now(),'consent')`,
      [t.id, c0.userId],
    );
  });
  return c0;
}

const one = async <R = Record<string, unknown>>(sql: string, params: unknown[]): Promise<R | undefined> =>
  sup(async (c) => (await c.query(sql, params)).rows[0] as R | undefined);

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

describe("eraseCandidatePii", () => {
  it("tombstones PII + roll/branch, keeps aggregates, redacts free text and sessions", async () => {
    const t = await seedTenant();
    const cand = await seedCandidate(t);

    const receipt = await eraseCandidatePii(t.id, cand.userId, "dsr_request", t.admin);
    expect(receipt.alreadyErased).toBe(false);
    expect(receipt.attemptAnswersErased).toBe(1); // kql only; mcq selection is not PII
    expect(receipt.sessionsRedacted).toBe(1);
    expect(receipt.certificatesPreserved).toBe(1);
    expect(receipt.tombstone.name).toMatch(/^deleted_user_[0-9a-f]{12}$/);
    expect(receipt.tombstone.email).toMatch(/^deleted\+[0-9a-f]{12}@erased\.assessiq\.local$/);

    const u = await one<{ name: string; email: string; metadata: Record<string, string>; erased_at: Date | null; deleted_at: Date | null }>(
      `SELECT name, email, metadata, erased_at, deleted_at FROM users WHERE id = $1`,
      [cand.userId],
    );
    expect(u?.name).toBe(receipt.tombstone.name);
    expect(u?.email).toBe(receipt.tombstone.email);
    expect(u?.erased_at).not.toBeNull();
    expect(u?.metadata).toEqual({ cohort: "2026" }); // roll_number + branch gone, other keys kept

    // free-text answer erased, mcq answer kept
    const answers = await sup(async (c) =>
      (await c.query(`SELECT question_id::text AS q, answer FROM attempt_answers WHERE attempt_id = $1`, [cand.attemptId])).rows,
    );
    const byQ = Object.fromEntries(answers.map((r) => [r.q as string, r.answer]));
    expect(byQ[cand.kqlQid]).toBe("[erased]");
    expect(byQ[cand.mcqQid]).toEqual({ selected: 1 });

    // sessions redacted
    const s = await one<{ ip: string | null; user_agent: string | null }>(`SELECT ip::text, user_agent FROM sessions WHERE user_id = $1`, [cand.userId]);
    expect(s?.ip).toBeNull();
    expect(s?.user_agent).toBeNull();

    // attempt / score / grading / cert survive; cert snapshot untouched (D5)
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM attempts WHERE id = $1`, [cand.attemptId]))?.n).toBe(1);
    expect(Number((await one<{ total_earned: string }>(`SELECT total_earned FROM attempt_scores WHERE attempt_id = $1`, [cand.attemptId]))?.total_earned)).toBe(10);
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM gradings WHERE attempt_id = $1`, [cand.attemptId]))?.n).toBe(1);
    expect((await one<{ display_name: string }>(`SELECT display_name FROM certificates WHERE candidate_id = $1`, [cand.userId]))?.display_name).toBe("Riya Sharma");

    // audit row carries counts only, no PII
    const a = await one<{ actor_user_id: string; actor_kind: string; after: Record<string, unknown> }>(
      `SELECT actor_user_id::text, actor_kind, after FROM audit_log WHERE entity_id = $1 AND action = 'user.pii.erased'`,
      [cand.userId],
    );
    expect(a?.actor_user_id).toBe(t.admin);
    expect(a?.actor_kind).toBe("user");
    expect(a?.after).toMatchObject({ reason: "dsr_request", erased: true, attemptAnswersErased: 1 });
    expect(JSON.stringify(a?.after)).not.toContain(cand.email);
  });

  it("is idempotent: second call is a no-op with no extra audit row", async () => {
    const t = await seedTenant();
    const cand = await seedCandidate(t);
    const first = await eraseCandidatePii(t.id, cand.userId, "r", t.admin);
    const second = await eraseCandidatePii(t.id, cand.userId, "r", t.admin);
    expect(second.alreadyErased).toBe(true);
    expect(second.attemptAnswersErased).toBe(0);
    expect(second.sessionsRedacted).toBe(0);
    expect(second.tombstone).toEqual(first.tombstone);
    expect(second.certificatesPreserved).toBe(1);
    const n = await one<{ n: number }>(`SELECT count(*)::int n FROM audit_log WHERE entity_id = $1 AND action = 'user.pii.erased'`, [cand.userId]);
    expect(n?.n).toBe(1);
  });

  it("is tenant-isolated: another tenant cannot erase (or see) the user", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const cand = await seedCandidate(a);
    await expect(eraseCandidatePii(b.id, cand.userId, "r", b.admin)).rejects.toMatchObject({ status: 404 });
    const u = await one<{ erased_at: Date | null; name: string }>(`SELECT erased_at, name FROM users WHERE id = $1`, [cand.userId]);
    expect(u?.erased_at).toBeNull();
    expect(u?.name).toBe("Riya Sharma");
  });

  it("refuses non-candidates and unknown users", async () => {
    const t = await seedTenant();
    await expect(eraseCandidatePii(t.id, t.admin, "r", t.admin)).rejects.toMatchObject({ details: { code: "ERASE_NOT_CANDIDATE" } });
    await expect(eraseCandidatePii(t.id, randomUUID(), "r", t.admin)).rejects.toMatchObject({ status: 404 });
    expect((await one<{ erased_at: Date | null }>(`SELECT erased_at FROM users WHERE id = $1`, [t.admin]))?.erased_at).toBeNull();
  });

  it("system actor (retention) records actor_kind=system with no actor user", async () => {
    const t = await seedTenant();
    const cand = await seedCandidate(t);
    await eraseCandidatePii(t.id, cand.userId, "retention_purge", null, "system");
    const a = await one<{ actor_user_id: string | null; actor_kind: string }>(
      `SELECT actor_user_id::text, actor_kind FROM audit_log WHERE entity_id = $1 AND action = 'user.pii.erased'`,
      [cand.userId],
    );
    expect(a).toEqual({ actor_user_id: null, actor_kind: "system" });
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("exportCandidateData", () => {
  it("returns only the requested user's own data", async () => {
    const t = await seedTenant();
    const me = await seedCandidate(t);
    const other = await seedCandidate(t);

    const bundle = await exportCandidateData(t.id, me.userId);
    expect(bundle.manifest).toMatchObject({ schemaVersion: 1, userId: me.userId });
    expect(bundle.profile).toMatchObject({ id: me.userId, email: me.email, role: "candidate", erasedAt: null });
    expect(bundle.attempts.map((a) => a["id"])).toEqual([me.attemptId]);
    expect(bundle.answers.map((a) => a["questionId"]).sort()).toEqual([me.kqlQid, me.mcqQid].sort());
    expect(bundle.certificates).toHaveLength(1);
    expect(bundle.consents).toHaveLength(1);
    const blob = JSON.stringify(bundle);
    expect(blob).not.toContain(other.userId);
    expect(blob).not.toContain(other.attemptId);
    expect(blob).not.toContain(other.email);
  });

  it("refuses an erased candidate with 409 CANDIDATE_ERASED", async () => {
    const t = await seedTenant();
    const cand = await seedCandidate(t);
    await eraseCandidatePii(t.id, cand.userId, "r", t.admin);
    await expect(exportCandidateData(t.id, cand.userId)).rejects.toMatchObject({ status: 409, code: "CANDIDATE_ERASED" });
  });

  it("is tenant-isolated and 404s unknown users", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const cand = await seedCandidate(a);
    await expect(exportCandidateData(b.id, cand.userId)).rejects.toMatchObject({ status: 404 });
    await expect(exportCandidateData(a.id, randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe("runRetentionPurgeForTenant", () => {
  it("selects only candidates past the window with no active attempt, in this tenant", async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    await sup((c) => c.query(`UPDATE tenant_settings SET retention_days = 30 WHERE tenant_id = $1 OR tenant_id = $2`, [t.id, other.id]));

    // Candidates: attempt submitted_at = now() in seedCandidate, so age comes from a manual backdate.
    const expired = await seedCandidate(t, { createdDaysAgo: 100 });
    const recentAttempt = await seedCandidate(t, { createdDaysAgo: 100 }); // submitted just now => active recently
    const fresh = await seedCandidate(t); // created now
    const activeAttempt = await seedCandidate(t, { createdDaysAgo: 100 });
    const otherTenantExpired = await seedCandidate(other, { createdDaysAgo: 100 });
    await sup(async (c) => {
      // expired: backdate its only attempt too
      await c.query(`UPDATE attempts SET submitted_at = now() - interval '90 days' WHERE id = $1`, [expired.attemptId]);
      // activeAttempt: one attempt per (assessment,user), so flip it to in_progress (never submitted)
      await c.query(`UPDATE attempts SET status = 'in_progress', submitted_at = NULL WHERE id = $1`, [activeAttempt.attemptId]);
    });

    // dry run: reports but erases nothing
    const dry = await runRetentionPurgeForTenant(t.id, { dryRun: true });
    expect(dry.retentionDays).toBe(30);
    expect(dry.candidatesScanned).toBe(1);
    expect(dry.candidatesErased).toBe(0);
    const stillLive = await one<{ erased_at: Date | null }>(`SELECT erased_at FROM users WHERE id = $1`, [expired.userId]);
    expect(stillLive?.erased_at).toBeNull();

    const report = await runRetentionPurgeForTenant(t.id);
    expect(report).toMatchObject({ candidatesScanned: 1, candidatesErased: 1, candidatesSkipped: 0, dryRun: false });
    expect(report.errors).toEqual([]);

    const erasedAt = async (id: string) => (await one<{ erased_at: Date | null }>(`SELECT erased_at FROM users WHERE id = $1`, [id]))?.erased_at;
    expect(await erasedAt(expired.userId)).not.toBeNull();
    expect(await erasedAt(recentAttempt.userId)).toBeNull();
    expect(await erasedAt(fresh.userId)).toBeNull();
    expect(await erasedAt(activeAttempt.userId)).toBeNull();
    expect(await erasedAt(otherTenantExpired.userId)).toBeNull(); // other tenant untouched
    expect(await erasedAt(t.admin)).toBeNull(); // non-candidates never selected

    // erased by the system actor, and a run-summary audit row exists
    const a = await one<{ actor_kind: string }>(`SELECT actor_kind FROM audit_log WHERE entity_id = $1 AND action = 'user.pii.erased'`, [expired.userId]);
    expect(a?.actor_kind).toBe("system");
    const runs = await one<{ n: number }>(`SELECT count(*)::int n FROM audit_log WHERE tenant_id = $1 AND action = 'system.dsr.retention.run'`, [t.id]);
    expect(runs?.n).toBe(2); // dry run + real run both audited

    // idempotent: nothing left to purge
    const again = await runRetentionPurgeForTenant(t.id);
    expect(again.candidatesScanned).toBe(0);
  });

  it("honours maxPerTenant", async () => {
    const t = await seedTenant();
    await sup((c) => c.query(`UPDATE tenant_settings SET retention_days = 30 WHERE tenant_id = $1`, [t.id]));
    await seedCandidate(t, { createdDaysAgo: 100 });
    await seedCandidate(t, { createdDaysAgo: 100 });
    await sup((c) => c.query(`UPDATE attempts SET submitted_at = now() - interval '90 days' WHERE tenant_id = $1`, [t.id]));
    const r = await runRetentionPurgeForTenant(t.id, { maxPerTenant: 1 });
    expect(r.candidatesScanned).toBe(1);
    expect(r.candidatesErased).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Erased list
// ---------------------------------------------------------------------------

describe("listErasedCandidates", () => {
  it("returns only this tenant's erased candidates, with eraser + reason + kept counts", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const erased1 = await seedCandidate(a);
    const erased2 = await seedCandidate(a);
    const live = await seedCandidate(a);
    const otherTenantErased = await seedCandidate(b);
    await eraseCandidatePii(a.id, erased1.userId, "dsr_request", a.admin);
    await eraseCandidatePii(a.id, erased2.userId, "retention_purge", null, "system");
    await eraseCandidatePii(b.id, otherTenantErased.userId, "dsr_request", b.admin);

    const list = await listErasedCandidates(a.id);
    expect(list.total).toBe(2);
    const ids = list.items.map((i) => i.userId).sort();
    expect(ids).toEqual([erased1.userId, erased2.userId].sort());
    expect(ids).not.toContain(live.userId);
    expect(ids).not.toContain(otherTenantErased.userId);

    const row1 = list.items.find((i) => i.userId === erased1.userId)!;
    expect(row1).toMatchObject({ erasedById: a.admin, reason: "dsr_request", attemptsKept: 1, certsKept: 1 });
    const row2 = list.items.find((i) => i.userId === erased2.userId)!;
    expect(row2).toMatchObject({ erasedById: null, reason: "retention_purge" });

    // adminId filter
    const byAdmin = await listErasedCandidates(a.id, { adminId: a.admin });
    expect(byAdmin.total).toBe(1);
    expect(byAdmin.items[0]?.userId).toBe(erased1.userId);

    // since filter excludes everything erased before it
    const future = await listErasedCandidates(a.id, { since: new Date(Date.now() + 60_000).toISOString() });
    expect(future).toEqual({ items: [], total: 0 });
  });
});
