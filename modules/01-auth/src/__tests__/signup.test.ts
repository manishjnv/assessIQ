/**
 * Z-71 / Z-81: self-serve sign-up core (requestSignup / verifySignup / signup-otp).
 * Live Postgres + Redis. sendEmail and the Turnstile fetch are mocked.
 *
 * Covers: happy path with a real session, parallel verify (one tenant), atomic Lua take,
 * wrong-code burn, separate key space from the admin sign-in code, Turnstile fail / action /
 * hostname / replay / timeout, IP and email caps, preconditions, neutral answers and the
 * 800 ms floor, existing admin cannot take over, super-admin and block list, daily cap,
 * rollback on a failing step, DPA version carried from the request, and no audit row for
 * requests that fail the bot check or a limit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { config } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, signupEmailKey } from "@assessiq/tenancy";
import { setRedisForTesting, closeRedis, getRedis } from "../redis.js";

const { sent } = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; template: string; vars: Record<string, unknown>; tenantId?: string; redactLogBody?: boolean }>,
}));
vi.mock("@assessiq/notifications", () => ({
  sendEmail: vi.fn(async (i: (typeof sent)[number]) => {
    sent.push(i);
  }),
  handleAuditFanout: vi.fn(async () => undefined), // audit-log webhook fanout (post-commit), not under test
}));

import { requestSignup, verifySignup, signupAvailable, signupPublicConfig, SIGNUP_IP_MAX_PER_DAY, SIGNUP_EMAIL_MAX_PER_DAY, SIGNUP_GLOBAL_MAX_PER_DAY } from "../signup.js";
import { signupOtpKey, storeSignupCode, takeSignupCode, SIGNUP_OTP_MAX_ATTEMPTS } from "../signup-otp.js";
import { requestEmailOtp, verifyEmailOtp } from "../email-otp.js";
import { sessions } from "../sessions.js";
import { DPA_VERSION, TERMS_VERSION } from "../signup-legal.js";
import { sha256Hex } from "../crypto-util.js";

const cfg = config as unknown as Record<string, unknown>;
const ORIGINAL = { ...cfg };
const PLATFORM = "00000000-0000-7000-0000-000000000001";
const HOST = "signup.assessiq.test";

let pg: StartedTestContainer;
let rd: StartedTestContainer;
let db: Client;
let pgUrl: string;

// ---- Turnstile + fetch mock ---------------------------------------------------------------
type Verdict = { status?: number; body?: Record<string, unknown>; throws?: boolean };
let verdict: Verdict = {};
const okVerdict = (): Verdict => ({ body: { success: true, action: "signup-request", hostname: HOST } });
vi.stubGlobal(
  "fetch",
  vi.fn(async () => {
    if (verdict.throws === true) throw new Error("network down");
    const status = verdict.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => verdict.body ?? {} };
  }),
);

let tokenN = 0;
let ipN = 0;
const nextToken = (): string => `ts-token-${++tokenN}`;
const nextIp = (): string => `198.51.100.${++ipN}`;
const nextEmail = (tag = "new"): string => `${tag}-${randomUUID().slice(0, 8)}@school.test`;

function reqInput(over: Partial<Parameters<typeof requestSignup>[0]> = {}): Parameters<typeof requestSignup>[0] {
  return {
    orgName: "Bright Future Academy",
    adminName: "Asha Rao",
    email: nextEmail(),
    turnstileToken: nextToken(),
    dpaVersion: DPA_VERSION,
    termsVersion: TERMS_VERSION,
    ip: nextIp(),
    ua: "vitest-ua",
    ...over,
  };
}

/** The 6-digit code the mocked mailer received for an address. */
const codeFor = (email: string): string => {
  const m = [...sent].reverse().find((s) => s.to === email && s.template === "signup_code");
  if (m === undefined) throw new Error(`no signup_code mail for ${email}`);
  return m.vars["code"] as string;
};
const mailsTo = (email: string) => sent.filter((s) => s.to === email);

const provisionStub = async (client: import("pg").PoolClient, ctx: { tenantId: string }): Promise<{ plan: string }> => {
  await client.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1,'free',25)`, [ctx.tenantId]);
  await client.query(
    `INSERT INTO credit_grants (tenant_id, source, credits, remaining, expires_at) VALUES ($1,'free_monthly',20,20, now() + interval '12 months')`,
    [ctx.tenantId],
  );
  return { plan: "free" };
};

const count = async (sql: string, args: unknown[] = []): Promise<number> => Number((await db.query(sql, args)).rows[0].n);

beforeAll(async () => {
  [pg, rd] = await Promise.all([
    new GenericContainer("postgres:16-alpine")
      .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_test" })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(60_000)
      .start(),
    new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(60_000)
      .start(),
  ]);
  pgUrl = `postgres://test:test@${pg.getHost()}:${pg.getMappedPort(5432)}/aiq_test`;
  db = new Client({ connectionString: pgUrl });
  await db.connect();
  await applyAllMigrations(db);
  await db.query(
    `INSERT INTO tenants (id, slug, name, status) VALUES ($1,'platform','AssessIQ Platform','active') ON CONFLICT DO NOTHING`,
    [PLATFORM],
  );
  await db.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [PLATFORM]);
  await setPoolForTesting(pgUrl);
  await setRedisForTesting(`redis://${rd.getHost()}:${rd.getMappedPort(6379)}`);
}, 120_000);

afterAll(async () => {
  Object.assign(cfg, ORIGINAL);
  await closePool();
  await closeRedis();
  await db?.end();
  await Promise.all([pg?.stop(), rd?.stop()]);
});

beforeEach(() => {
  Object.assign(cfg, ORIGINAL, {
    PLAN_TIERS_ENFORCED: true,
    SIGNUP_ENABLED: true,
    TURNSTILE_SECRET: "test-secret",
    TURNSTILE_SITE_KEY: "test-site-key",
    SIGNUP_TURNSTILE_HOSTNAMES: [HOST],
    MFA_REQUIRED: false,
    PLATFORM_TENANT_ID: PLATFORM,
    SUPER_ADMIN_EMAILS: "boss@platform.test",
  });
  verdict = okVerdict();
  sent.length = 0;
});

// ---------------------------------------------------------------------------------------------

describe("preconditions (checked on every call)", () => {
  it("open only when PLAN_TIERS_ENFORCED, SIGNUP_ENABLED, both Turnstile keys and Redis hold", async () => {
    expect(await signupAvailable()).toBe(true);
    expect(await signupPublicConfig()).toEqual({ open: true, turnstileSiteKey: "test-site-key", dpaVersion: "1.0" });

    for (const [k, v] of [
      ["PLAN_TIERS_ENFORCED", false],
      ["SIGNUP_ENABLED", false],
      ["TURNSTILE_SECRET", undefined],
      ["TURNSTILE_SITE_KEY", undefined],
    ] as const) {
      cfg[k] = v;
      expect(await signupAvailable(), k).toBe(false);
      expect((await signupPublicConfig()).turnstileSiteKey).toBeNull();
      beforeEachReset();
    }
  });

  it("Redis unreachable closes it", async () => {
    await setRedisForTesting("redis://127.0.0.1:1");
    expect(await signupAvailable()).toBe(false);
    await setRedisForTesting(`redis://${rd.getHost()}:${rd.getMappedPort(6379)}`);
    expect(await signupAvailable()).toBe(true);
  });
});

function beforeEachReset(): void {
  Object.assign(cfg, { PLAN_TIERS_ENFORCED: true, SIGNUP_ENABLED: true, TURNSTILE_SECRET: "test-secret", TURNSTILE_SITE_KEY: "test-site-key" });
}

describe("happy path", () => {
  it("request -> mail with code (not logged) -> verify creates org, admin, plan, acceptance, audit and a session", async () => {
    const email = nextEmail("happy");
    const ip = nextIp();
    const r = await requestSignup(reqInput({ email, ip, orgName: "Happy Path School" }));
    expect(r).toEqual({ status: "accepted" });

    const mail = mailsTo(email);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ template: "signup_code", tenantId: PLATFORM, redactLogBody: true });
    const code = codeFor(email);
    expect(code).toMatch(/^\d{6}$/);
    // Redis holds an HMAC, never the code.
    const h = await getRedis().hget(signupOtpKey(email), "h");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(code);

    const out = await verifySignup({ email, code, ip: "203.0.113.50", ua: "browser-ua" }, { provision: provisionStub });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.redirectTo).toBe("/admin");

    const t = (await db.query(`SELECT slug, status, self_registered FROM tenants WHERE id=$1`, [out.tenantId])).rows[0];
    expect(t).toEqual({ slug: "happy-path-school", status: "active", self_registered: true });
    const u = (await db.query(`SELECT email, name, role, status FROM users WHERE tenant_id=$1`, [out.tenantId])).rows;
    expect(u).toEqual([{ email, name: "Asha Rao", role: "admin", status: "active" }]);
    expect(await count(`SELECT count(*) n FROM tenant_plans WHERE tenant_id=$1 AND tier='free'`, [out.tenantId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM credit_grants WHERE tenant_id=$1 AND source='free_monthly'`, [out.tenantId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM tenant_legal_acceptances WHERE tenant_id=$1`, [out.tenantId])).toBe(2);
    const audit = await db.query(`SELECT action FROM audit_log WHERE tenant_id=$1 ORDER BY id`, [out.tenantId]);
    expect(audit.rows.map((a) => a.action)).toEqual(["tenant.provisioned", "signup.completed"]);

    // A NEW session for the new admin: admin role, this tenant, MFA flag follows MFA_REQUIRED=false.
    const s = await sessions.get(out.sessionToken);
    expect(s).toMatchObject({ userId: out.userId, tenantId: out.tenantId, role: "admin", totpVerified: true });
    expect(await getRedis().get(`aiq:rl:signup:day:${new Date().toISOString().slice(0, 10)}`)).toBe("1");
    // The code is single-use.
    expect(await getRedis().exists(signupOtpKey(email))).toBe(0);
  });

  it("with MFA_REQUIRED the session starts unverified and the redirect is /admin/mfa", async () => {
    cfg["MFA_REQUIRED"] = true;
    const email = nextEmail("mfa");
    await requestSignup(reqInput({ email, orgName: "Mfa Required School" }));
    const out = await verifySignup({ email, code: codeFor(email), ip: "203.0.113.51", ua: "ua" }, { provision: provisionStub });
    expect(out.ok && out.redirectTo).toBe("/admin/mfa");
    if (out.ok) expect(await sessions.get(out.sessionToken)).toMatchObject({ role: "admin", totpVerified: false });
  });

  it("the acceptance rows keep the versions and request IP / UA the visitor ticked, as hashes", async () => {
    const email = nextEmail("legal");
    await requestSignup(reqInput({ email, ip: "192.0.2.77", ua: "tick-ua", dpaVersion: "1.0", termsVersion: "1.0", orgName: "Legal Record School" }));
    const out = await verifySignup({ email, code: codeFor(email), ip: "203.0.113.52", ua: "other-ua" }, { provision: provisionStub });
    if (!out.ok) throw new Error("setup");
    const rows = (await db.query(`SELECT document, version, ip_hash, user_agent_hash FROM tenant_legal_acceptances WHERE tenant_id=$1 ORDER BY document`, [out.tenantId])).rows;
    expect(rows.map((r) => [r.document, r.version])).toEqual([["dpa", "1.0"], ["terms", "1.0"]]);
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain("192.0.2.77");
    expect(JSON.stringify(rows)).not.toContain("tick-ua");
  });
});

describe("code take is atomic and single-use", () => {
  it("two parallel correct verifies: exactly one tenant", async () => {
    const email = nextEmail("race");
    await requestSignup(reqInput({ email, orgName: "Race School" }));
    const code = codeFor(email);
    const results = await Promise.all([
      verifySignup({ email, code, ip: "203.0.113.60", ua: "a" }, { provision: provisionStub }),
      verifySignup({ email, code, ip: "203.0.113.61", ua: "b" }, { provision: provisionStub }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await count(`SELECT count(*) n FROM tenants WHERE name='Race School'`)).toBe(1);
    expect(await count(`SELECT count(*) n FROM users WHERE email=$1`, [email])).toBe(1);
  });

  it("the Lua take lets only one of many simultaneous callers see the record", async () => {
    const email = nextEmail("lua");
    const rec = { orgName: "Lua School", adminName: "L U", dpaVersion: "1.0", termsVersion: "1.0", ip: "1.1.1.1", ua: "u" };
    expect(await storeSignupCode(email, "123456", rec)).toBe(true);
    const takes = await Promise.all(Array.from({ length: 8 }, () => takeSignupCode(email, "123456")));
    expect(takes.filter((t) => t !== null)).toHaveLength(1);
    expect(takes.find((t) => t !== null)).toEqual(rec);
  });

  it("5 wrong codes burn the record; the right code then fails too", async () => {
    const email = nextEmail("burn");
    const rec = { orgName: "Burn School", adminName: "B S", dpaVersion: "1.0", termsVersion: "1.0", ip: "1.1.1.1", ua: "u" };
    await storeSignupCode(email, "111111", rec);
    for (let i = 0; i < SIGNUP_OTP_MAX_ATTEMPTS; i++) expect(await takeSignupCode(email, "000000")).toBeNull();
    expect(await getRedis().exists(signupOtpKey(email))).toBe(0);
    expect(await takeSignupCode(email, "111111")).toBeNull();
  });

  it("a code for one address cannot finish a sign-up for another", async () => {
    const a = nextEmail("alpha");
    const b = nextEmail("beta");
    await requestSignup(reqInput({ email: a, orgName: "Alpha School" }));
    const out = await verifySignup({ email: b, code: codeFor(a), ip: "203.0.113.62", ua: "u" }, { provision: provisionStub });
    expect(out.ok).toBe(false);
  });
});

describe("separate key space from the admin sign-in code", () => {
  it("one address can hold both codes; neither finishes the other flow", async () => {
    const email = "admin@example.com";
    await db.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1,'keyspace-co','Keyspace Co') ON CONFLICT DO NOTHING`,
      [randomUUID()],
    );
    const tid = (await db.query(`SELECT id FROM tenants WHERE slug='keyspace-co'`)).rows[0].id as string;
    await db.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tid]);
    await db.query(`INSERT INTO users (tenant_id, email, name, role, status) VALUES ($1,$2,'Adm','admin','active') ON CONFLICT DO NOTHING`, [tid, email]);

    // Admin sign-in code for the address (real requestEmailOtp), then a sign-up code written for the same address.
    await requestEmailOtp({ email, ip: "10.9.9.9", ua: "ua" });
    const adminCode = sent.find((s) => s.template === "admin_email_otp")?.vars["code"] as string;
    expect(adminCode).toMatch(/^\d{6}$/);
    const rec = { orgName: "Key Space School", adminName: "K S", dpaVersion: "1.0", termsVersion: "1.0", ip: "1.1.1.1", ua: "u" };
    expect(await storeSignupCode(email, "654321", rec)).toBe(true);

    const adminKey = `aiq:email-otp:${sha256Hex(email)}`;
    expect(signupOtpKey(email)).not.toBe(adminKey);
    expect(await getRedis().exists(adminKey)).toBe(1);
    expect(await getRedis().exists(signupOtpKey(email))).toBe(1);

    expect(await takeSignupCode(email, adminCode)).toBeNull(); // admin code is useless for sign-up
    await expect(verifyEmailOtp({ email, code: "654321", ip: "10.9.9.9", ua: "ua" })).rejects.toThrow(); // and the reverse
  });
});

describe("Turnstile", () => {
  const noCode = async (email: string): Promise<void> => {
    expect(mailsTo(email)).toHaveLength(0);
    expect(await getRedis().exists(signupOtpKey(email))).toBe(0);
  };

  it("success=false: refused, no code, no mail", async () => {
    verdict = { body: { success: false } };
    const email = nextEmail("tsfail");
    expect(await requestSignup(reqInput({ email }))).toEqual({ status: "turnstile_failed" });
    await noCode(email);
  });

  it("wrong action, wrong hostname, non-200 and a network error all fail closed", async () => {
    for (const v of [
      { body: { success: true, action: "contact", hostname: HOST } },
      { body: { success: true, action: "signup-request", hostname: "evil.example" } },
      { body: { success: true, action: "signup-request" } },
      { status: 500, body: { success: true, action: "signup-request", hostname: HOST } },
      { throws: true },
    ] as Verdict[]) {
      verdict = v;
      const email = nextEmail("tsbad");
      expect(await requestSignup(reqInput({ email }))).toEqual({ status: "turnstile_failed" });
      await noCode(email);
    }
  });

  it("a token that passed once cannot be replayed", async () => {
    const token = nextToken();
    const first = nextEmail("replay1");
    const second = nextEmail("replay2");
    expect(await requestSignup(reqInput({ email: first, turnstileToken: token }))).toEqual({ status: "accepted" });
    expect(await requestSignup(reqInput({ email: second, turnstileToken: token }))).toEqual({ status: "turnstile_failed" });
    await noCode(second);
  });

  it("a request that fails the bot check or a limit writes no audit row", async () => {
    const before = await count(`SELECT count(*) n FROM audit_log WHERE action IN ('signup.rejected','signup.completed')`);
    verdict = { body: { success: false } };
    await requestSignup(reqInput());
    verdict = okVerdict();
    const ip = nextIp();
    for (let i = 0; i <= SIGNUP_IP_MAX_PER_DAY; i++) await requestSignup(reqInput({ ip }));
    expect(await count(`SELECT count(*) n FROM audit_log WHERE action IN ('signup.rejected','signup.completed')`)).toBe(before);
  });
});

describe("rate limits (one bucket per scope)", () => {
  it("IP: 5 a day, the 6th is refused with scope signup_ip", async () => {
    const ip = nextIp();
    for (let i = 0; i < SIGNUP_IP_MAX_PER_DAY; i++) expect((await requestSignup(reqInput({ ip }))).status).toBe("accepted");
    const sixth = await requestSignup(reqInput({ ip }));
    expect(sixth).toMatchObject({ status: "rate_limited", scope: "signup_ip" });
    expect((sixth as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("email: 3 a day (plus-tag and dot aliases share the bucket), the 4th is refused with scope signup_email", async () => {
    const base = `cap${randomUUID().slice(0, 6)}`;
    const variants = [`${base}@gmail.com`, `${base}+a@gmail.com`, `${base.slice(0, 3)}.${base.slice(3)}@gmail.com`];
    for (const email of variants) expect((await requestSignup(reqInput({ email }))).status).toBe("accepted");
    expect(await requestSignup(reqInput({ email: `${base}+z@gmail.com` }))).toMatchObject({ status: "rate_limited", scope: "signup_email" });
    expect(SIGNUP_EMAIL_MAX_PER_DAY).toBe(3);
  });

  it("an IP that cannot be determined is refused (fail closed)", async () => {
    const email = nextEmail("noip");
    expect(await requestSignup(reqInput({ email, ip: null }))).toMatchObject({ status: "rate_limited", scope: "signup_ip" });
    expect(mailsTo(email)).toHaveLength(0);
  });

  it("both mails count against the address cap", async () => {
    const owner = "existing@school.test";
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'cap-existing','Cap Existing') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const tid = (await db.query(`SELECT id FROM tenants WHERE slug='cap-existing'`)).rows[0].id as string;
    await db.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tid]);
    await db.query(`INSERT INTO users (tenant_id, email, name, role, status) VALUES ($1,$2,'E','admin','active') ON CONFLICT DO NOTHING`, [tid, owner]);
    for (let i = 0; i < SIGNUP_EMAIL_MAX_PER_DAY; i++) await requestSignup(reqInput({ email: owner }));
    expect(mailsTo(owner)).toHaveLength(3);
    expect(await requestSignup(reqInput({ email: owner }))).toMatchObject({ status: "rate_limited", scope: "signup_email" });
    expect(mailsTo(owner)).toHaveLength(3);
  });
});

describe("neutral answers (no enumeration)", () => {
  it("new and existing addresses give the same result in about the same time; existing gets the notice, no code", async () => {
    const existing = "taken@school.test";
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'neutral-co','Neutral Co') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const tid = (await db.query(`SELECT id FROM tenants WHERE slug='neutral-co'`)).rows[0].id as string;
    await db.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tid]);
    await db.query(`INSERT INTO users (tenant_id, email, name, role, status) VALUES ($1,$2,'T','admin','active') ON CONFLICT DO NOTHING`, [tid, existing]);

    const fresh = nextEmail("fresh");
    const t0 = Date.now();
    const a = await requestSignup(reqInput({ email: fresh }));
    const dNew = Date.now() - t0;
    const t1 = Date.now();
    const b = await requestSignup(reqInput({ email: existing }));
    const dOld = Date.now() - t1;

    expect(a).toEqual({ status: "accepted" });
    expect(b).toEqual(a);
    expect(dNew).toBeGreaterThanOrEqual(780);
    expect(dOld).toBeGreaterThanOrEqual(780);
    expect(Math.abs(dNew - dOld)).toBeLessThan(500);

    expect(mailsTo(fresh).map((m) => m.template)).toEqual(["signup_code"]);
    expect(mailsTo(existing).map((m) => m.template)).toEqual(["signup_existing_account"]);
    expect(JSON.stringify(mailsTo(existing))).not.toMatch(/"code"/);
    expect(await getRedis().exists(signupOtpKey(existing))).toBe(0);
  });

  it("an existing admin cannot take over: no code exists, a guessed code fails, no new organisation", async () => {
    const victim = "victim.admin@school.test";
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'victim-co','Victim Co') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const tid = (await db.query(`SELECT id FROM tenants WHERE slug='victim-co'`)).rows[0].id as string;
    await db.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tid]);
    await db.query(`INSERT INTO users (tenant_id, email, name, role, status) VALUES ($1,$2,'V','admin','active') ON CONFLICT DO NOTHING`, [tid, victim]);
    const tenantsBefore = await count(`SELECT count(*) n FROM tenants`);

    await requestSignup(reqInput({ email: victim, orgName: "Hijack Attempt" }));
    const out = await verifySignup({ email: victim, code: "000000", ip: "203.0.113.70", ua: "u" }, { provision: provisionStub });
    expect(out.ok).toBe(false);
    expect(await count(`SELECT count(*) n FROM tenants`)).toBe(tenantsBefore);
    expect(await count(`SELECT count(*) n FROM users WHERE tenant_id=$1`, [tid])).toBe(1);
  });

  it("bad code and a claim conflict answer identically (ok:false) after the 800 ms floor", async () => {
    const email = nextEmail("claimed");
    await requestSignup(reqInput({ email, orgName: "First Claim School" }));
    const code = codeFor(email);
    await verifySignup({ email, code, ip: "203.0.113.71", ua: "u" }, { provision: provisionStub }); // wins the claim
    // A second record for the same folded address, as if a code had been issued before the claim existed.
    await storeSignupCode(email, "222222", { orgName: "Second Claim School", adminName: "S C", dpaVersion: "1.0", termsVersion: "1.0", ip: "1.1.1.1", ua: "u" });
    const t0 = Date.now();
    const conflict = await verifySignup({ email, code: "222222", ip: "203.0.113.72", ua: "u" }, { provision: provisionStub });
    const bad = await verifySignup({ email: nextEmail("nocode"), code: "999999", ip: "203.0.113.73", ua: "u" }, { provision: provisionStub });
    expect(conflict).toEqual({ ok: false });
    expect(bad).toEqual({ ok: false });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
    expect(await count(`SELECT count(*) n FROM tenants WHERE name='Second Claim School'`)).toBe(0);
  });
});

describe("super-admin, block list, daily cap", () => {
  it("a super-admin address (and a Gmail alias of it) gets no mail; one signup.rejected row a day", async () => {
    cfg["SUPER_ADMIN_EMAILS"] = "root.owner@gmail.com";
    const before = await count(`SELECT count(*) n FROM audit_log WHERE action='signup.rejected'`);
    for (const email of ["root.owner@gmail.com", "rootowner+x@gmail.com", "root.owner@gmail.com"]) {
      expect(await requestSignup(reqInput({ email }))).toEqual({ status: "accepted" });
      expect(mailsTo(email)).toHaveLength(0);
    }
    expect(sent).toHaveLength(0);
    const rows = await db.query(
      `SELECT tenant_id, ip, user_agent, after FROM audit_log WHERE action='signup.rejected' ORDER BY id DESC LIMIT 5`,
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    // The two aliases fold to one key: exactly one new row for three requests.
    expect(await count(`SELECT count(*) n FROM audit_log WHERE action='signup.rejected'`)).toBe(before + 1);
    expect(rows.rows[0]).toMatchObject({ tenant_id: PLATFORM, ip: null, user_agent: null });
    expect(rows.rows[0].after).toEqual({ reason: "super_admin_email", email_hmac: signupEmailKey("root.owner@gmail.com") });
  });

  it("blocked mail hosts and brand names: neutral answer, nothing sent", async () => {
    const a = nextEmail("blk").replace("school.test", "mailinator.com");
    expect(await requestSignup(reqInput({ email: a }))).toEqual({ status: "accepted" });
    const b = nextEmail("brand");
    expect(await requestSignup(reqInput({ email: b, orgName: "Google Classes" }))).toEqual({ status: "accepted" });
    expect(sent).toHaveLength(0);
  });

  it("at the daily cap: request sends nothing; verify refuses without burning the code", async () => {
    const email = nextEmail("cap");
    await requestSignup(reqInput({ email, orgName: "Cap Day School" }));
    const code = codeFor(email);
    const key = `aiq:rl:signup:day:${new Date().toISOString().slice(0, 10)}`;
    const before = await getRedis().get(key);
    await getRedis().set(key, String(SIGNUP_GLOBAL_MAX_PER_DAY));
    try {
      const other = nextEmail("capmail");
      expect(await requestSignup(reqInput({ email: other }))).toEqual({ status: "accepted" });
      expect(mailsTo(other)).toHaveLength(0);
      expect(await verifySignup({ email, code, ip: "203.0.113.80", ua: "u" }, { provision: provisionStub })).toEqual({ ok: false });
      expect(await getRedis().exists(signupOtpKey(email))).toBe(1); // not burnt
    } finally {
      if (before === null) await getRedis().del(key);
      else await getRedis().set(key, before);
    }
    expect((await verifySignup({ email, code, ip: "203.0.113.81", ua: "u" }, { provision: provisionStub })).ok).toBe(true);
  });
});

describe("rollback and versions", () => {
  it("a failing step leaves no tenant, no user and no claim", async () => {
    const email = nextEmail("fail");
    await requestSignup(reqInput({ email, orgName: "Failing Step School" }));
    await expect(
      verifySignup({ email, code: codeFor(email), ip: "203.0.113.90", ua: "u" }, { provision: async () => { throw new Error("billing down"); } }),
    ).rejects.toThrow("billing down");
    expect(await count(`SELECT count(*) n FROM tenants WHERE name='Failing Step School'`)).toBe(0);
    expect(await count(`SELECT count(*) n FROM users WHERE email=$1`, [email])).toBe(0);
    expect(await count(`SELECT count(*) n FROM signup_claims WHERE email_key=$1`, [signupEmailKey(email)])).toBe(0);
  });

  it("a taxonomy hook that fails after commit does not undo the organisation", async () => {
    const email = nextEmail("seedfail");
    await requestSignup(reqInput({ email, orgName: "Seed Failure School" }));
    const out = await verifySignup(
      { email, code: codeFor(email), ip: "203.0.113.91", ua: "u" },
      { provision: provisionStub, afterCommit: async () => { throw new Error("seed down"); } },
    );
    expect(out.ok).toBe(true);
    expect(await count(`SELECT count(*) n FROM tenants WHERE name='Seed Failure School' AND status='active'`)).toBe(1);
  });

  it("a dpaVersion on verify that differs from the stored one is refused", async () => {
    const email = nextEmail("dpa");
    await requestSignup(reqInput({ email, orgName: "Dpa Version School" }));
    expect(await verifySignup({ email, code: codeFor(email), dpaVersion: "0.9", ip: "203.0.113.92", ua: "u" }, { provision: provisionStub })).toEqual({ ok: false });
  });

  it("a malformed code is refused", async () => {
    expect(await verifySignup({ email: nextEmail("mal"), code: "12ab56", ip: "203.0.113.93", ua: "u" })).toEqual({ ok: false });
  });
});
