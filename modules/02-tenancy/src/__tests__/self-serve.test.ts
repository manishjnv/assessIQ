/**
 * Z-71 / Z-81: createSelfServeTenant + the sign-up helpers. Live Postgres (all migrations).
 *
 * Covers: happy path (tenant, admin, claim, acceptance, audit), one claim per folded address,
 * parallel creates, existing-address and super-admin refusals with nothing left behind, a
 * failing cross-module step rolling everything back, slug rules, and the RLS / grant rules of
 * tenant_legal_acceptances and signup_claims.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { config } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../pool.js";
import { withTenant } from "../with-tenant.js";
import {
  createSelfServeTenant,
  foldSignupEmail,
  isFoldExemptEmail,
  isValidAdminName,
  isValidOrgName,
  signupEmailKey,
  signupEmailTaken,
  signupHmac,
  slugFromName,
  RESERVED_SLUGS,
} from "../self-serve.js";

let container: StartedTestContainer;
let db: Client;
const mutableConfig = config as { SUPER_ADMIN_EMAILS: string; SIGNUP_FOLD_EXEMPT_EMAILS: string };
const ORIGINAL_SUPER = config.SUPER_ADMIN_EMAILS;

const base = (over: Partial<Parameters<typeof createSelfServeTenant>[0]> = {}): Parameters<typeof createSelfServeTenant>[0] => ({
  orgName: "Acme Coaching",
  adminName: "Asha Admin",
  email: `owner-${randomUUID().slice(0, 8)}@acme.test`,
  dpaVersion: "1.0",
  termsVersion: "1.0",
  ip: "203.0.113.7",
  userAgent: "vitest-agent",
  // Stand-in for the 19-billing step that apps/api passes in.
  provision: async (client, ctx) => {
    await client.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1,'free',250)`, [ctx.tenantId]);
    return { plan: "free" };
  },
  ...over,
});

const count = async (sql: string, args: unknown[] = []): Promise<number> =>
  Number((await db.query(sql, args)).rows[0].n);

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "assessiq", POSTGRES_PASSWORD: "pw", POSTGRES_DB: "assessiq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  const url = `postgres://assessiq:pw@${container.getHost()}:${container.getMappedPort(5432)}/assessiq`;
  db = new Client({ connectionString: url });
  await db.connect();
  await applyAllMigrations(db);
  setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  mutableConfig.SUPER_ADMIN_EMAILS = ORIGINAL_SUPER;
  await closePool();
  await db?.end();
  if (container !== undefined) await container.stop();
});

describe("pure helpers", () => {
  it("folds plus-tags for every domain and dots / googlemail for Gmail only", () => {
    expect(foldSignupEmail("  Jo.Hn+promo@Gmail.com ")).toBe("john@gmail.com");
    expect(foldSignupEmail("j.o.h.n@googlemail.com")).toBe("john@gmail.com");
    expect(foldSignupEmail("jo.hn+x@corp.example")).toBe("jo.hn@corp.example");
    expect(signupEmailKey("a.b+1@gmail.com")).toBe(signupEmailKey("ab@gmail.com"));
    expect(signupEmailKey("a.b@corp.example")).not.toBe(signupEmailKey("ab@corp.example"));
  });

  it("keys are keyed hashes: not a plain sha256, and purpose-separated", () => {
    expect(signupEmailKey("x@y.test")).toMatch(/^[0-9a-f]{64}$/);
    expect(signupHmac("ip", "1.2.3.4")).not.toBe(signupHmac("ua", "1.2.3.4"));
  });

  it("slug: ASCII, 3-40 chars, reserved names flagged", () => {
    expect(slugFromName("Café Léon & Sons!")).toBe("cafe-leon-sons");
    expect(slugFromName("संस्था")).toBe("org");
    expect(slugFromName("ab")).toBe("ab-org");
    expect(slugFromName("x".repeat(80)).length).toBeLessThanOrEqual(40);
    for (const r of ["admin", "api", "signup", "billing", "question-bank", "platform"]) expect(RESERVED_SLUGS.has(r)).toBe(true);
  });

  it("org and admin name rules", () => {
    expect(isValidOrgName("Acme Coaching")).toBe(true);
    expect(isValidOrgName("St. Mary's & Sons-3")).toBe(true);
    expect(isValidOrgName("ab")).toBe(false);
    expect(isValidOrgName("<script>x</script>")).toBe(false);
    expect(isValidOrgName("x".repeat(81))).toBe(false);
    expect(isValidAdminName("Al")).toBe(true);
    expect(isValidAdminName("A")).toBe(false);
    expect(isValidAdminName("Bad <b>")).toBe(false);
  });
});


describe("fold exemption for tester addresses (Z-101)", () => {
  const ORIGINAL_EXEMPT = mutableConfig.SIGNUP_FOLD_EXEMPT_EMAILS;
  afterEach(() => { mutableConfig.SIGNUP_FOLD_EXEMPT_EMAILS = ORIGINAL_EXEMPT; });

  it("empty list: no exemption, a Gmail dot variant is still the same mailbox", () => {
    mutableConfig.SIGNUP_FOLD_EXEMPT_EMAILS = "";
    expect(isFoldExemptEmail("aastest3@gmail.com")).toBe(false);
    expect(signupEmailKey("aas.test3@gmail.com")).toBe(signupEmailKey("aastest3@gmail.com"));
  });

  it("a listed address and its dot, plus and googlemail variants are exempt with separate keys", () => {
    mutableConfig.SIGNUP_FOLD_EXEMPT_EMAILS = " , AASTest3@Gmail.com ,";
    const variants = ["aastest3@gmail.com", "aas.test3@gmail.com", "a.a.s.test3@gmail.com", "aastest3+x@gmail.com", "aastest3@googlemail.com"];
    for (const v of variants) expect(isFoldExemptEmail(v)).toBe(true);
    const keys = new Set(variants.map((v) => signupEmailKey(v)));
    expect(keys.size).toBe(variants.length);
    // create and lookup use the same helper, so the key is stable for one address
    expect(signupEmailKey("aas.test3@gmail.com")).toBe(signupEmailKey(" AAS.test3@gmail.com "));
  });

  it("a normal Gmail dot variant and other domains are unaffected", () => {
    mutableConfig.SIGNUP_FOLD_EXEMPT_EMAILS = "aastest3@gmail.com";
    expect(isFoldExemptEmail("someone.else@gmail.com")).toBe(false);
    expect(signupEmailKey("some.one@gmail.com")).toBe(signupEmailKey("someone@gmail.com"));
    expect(isFoldExemptEmail("aastest3@corp.example")).toBe(false);
    expect(signupEmailKey("a.b@corp.example")).not.toBe(signupEmailKey("ab@corp.example"));
  });
});

describe("createSelfServeTenant", () => {
  it("happy path: tenant + admin + claim + acceptance + audit in one go", async () => {
    const input = base({ orgName: "Happy Path Academy" });
    const r = await createSelfServeTenant(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const t = (await db.query(`SELECT slug, name, status, self_registered FROM tenants WHERE id=$1`, [r.tenantId])).rows[0];
    expect(t).toMatchObject({ slug: "happy-path-academy", name: "Happy Path Academy", status: "active", self_registered: true });
    expect(await count(`SELECT count(*) n FROM tenant_settings WHERE tenant_id=$1`, [r.tenantId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM tenant_plans WHERE tenant_id=$1 AND tier='free'`, [r.tenantId])).toBe(1);

    const users = (await db.query(`SELECT id, email, role, status FROM users WHERE tenant_id=$1`, [r.tenantId])).rows;
    expect(users).toEqual([{ id: r.adminUserId, email: input.email, role: "admin", status: "active" }]);

    const claim = (await db.query(`SELECT claimed_tenant_id FROM signup_claims WHERE email_key=$1`, [signupEmailKey(input.email)])).rows[0];
    expect(claim.claimed_tenant_id).toBe(r.tenantId);

    const acc = (await db.query(
      `SELECT document, version, ip_hash, user_agent_hash, user_id FROM tenant_legal_acceptances WHERE tenant_id=$1 ORDER BY document`,
      [r.tenantId],
    )).rows;
    expect(acc.map((a) => [a.document, a.version])).toEqual([["dpa", "1.0"], ["terms", "1.0"]]);
    for (const a of acc) {
      expect(a.user_id).toBe(r.adminUserId);
      expect(a.ip_hash).toBe(signupHmac("ip", "203.0.113.7"));
      expect(a.ip_hash).not.toContain("203.0.113.7");
      expect(a.user_agent_hash).toBe(signupHmac("ua", "vitest-agent"));
    }

    const audit = (await db.query(`SELECT action, actor_kind, ip, user_agent, after FROM audit_log WHERE tenant_id=$1 ORDER BY id`, [r.tenantId])).rows;
    expect(audit.map((a) => a.action)).toEqual(["tenant.provisioned", "signup.completed"]);
    for (const a of audit) {
      expect(a.actor_kind).toBe("system");
      expect(a.ip).toBeNull();
      expect(a.user_agent).toBeNull();
      expect(JSON.stringify(a.after)).not.toContain(input.email);
    }
    expect(audit[1].after).toMatchObject({ plan: "free", dpa_version: "1.0", terms_version: "1.0" });
  });

  it("one organisation per folded address: a plus / dot alias is refused, nothing new is created", async () => {
    const first = base({ orgName: "Alias Org One", email: "ali.as+one@gmail.com" });
    expect((await createSelfServeTenant(first)).ok).toBe(true);
    const before = await count(`SELECT count(*) n FROM tenants`);
    const again = await createSelfServeTenant(base({ orgName: "Alias Org Two", email: "alias+two@gmail.com" }));
    expect(again).toEqual({ ok: false, reason: "claim_exists" });
    expect(await count(`SELECT count(*) n FROM tenants`)).toBe(before);
  });

  it("parallel creates for one address make exactly one tenant", async () => {
    const email = "race@parallel.test";
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createSelfServeTenant(base({ orgName: `Parallel Org ${i}`, email }))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "claim_exists")).toBe(true);
    expect(await count(`SELECT count(*) n FROM tenants WHERE name LIKE 'Parallel Org %'`)).toBe(1);
    expect(await count(`SELECT count(*) n FROM users WHERE email=$1`, [email])).toBe(1);
  });

  it("an address that already has a user in any tenant gets no organisation and burns no claim", async () => {
    const victim = await createSelfServeTenant(base({ orgName: "Victim Org", email: "boss@victim.test" }));
    expect(victim.ok).toBe(true);
    // Another tenant's candidate address.
    const t = randomUUID();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'other-co','Other Co')`, [t]);
    await db.query(`INSERT INTO users (tenant_id, email, name, role) VALUES ($1,'cand@other.test','C','candidate')`, [t]);

    expect(await signupEmailTaken("boss@victim.test")).toBe(true);
    expect(await signupEmailTaken("CAND@other.test")).toBe(true);
    expect(await signupEmailTaken("free@nobody.test")).toBe(false);

    const r = await createSelfServeTenant(base({ orgName: "Takeover Attempt", email: "cand@other.test" }));
    expect(r).toEqual({ ok: false, reason: "email_in_use" });
    expect(await count(`SELECT count(*) n FROM tenants WHERE name='Takeover Attempt'`)).toBe(0);
    expect(await count(`SELECT count(*) n FROM signup_claims WHERE email_key=$1`, [signupEmailKey("cand@other.test")])).toBe(0);
    // The existing admin's tenant is untouched: still exactly one admin there.
    expect(await count(`SELECT count(*) n FROM users WHERE tenant_id=$1`, [victim.ok ? victim.tenantId : ""])).toBe(1);
  });

  it("a super-admin address (also its Gmail alias) is refused and leaves nothing", async () => {
    mutableConfig.SUPER_ADMIN_EMAILS = "root.admin@gmail.com";
    for (const email of ["root.admin@gmail.com", "rootadmin+x@gmail.com"]) {
      const r = await createSelfServeTenant(base({ orgName: "Super Grab", email }));
      expect(r).toEqual({ ok: false, reason: "super_admin_email" });
    }
    expect(await count(`SELECT count(*) n FROM tenants WHERE name='Super Grab'`)).toBe(0);
    expect(await count(`SELECT count(*) n FROM users WHERE email IN ('root.admin@gmail.com','rootadmin+x@gmail.com')`)).toBe(0);
    mutableConfig.SUPER_ADMIN_EMAILS = ORIGINAL_SUPER;
  });

  it("a failing cross-module step rolls everything back (no half-made tenant, claim not burnt)", async () => {
    const email = "rollback@fail.test";
    await expect(
      createSelfServeTenant(base({ orgName: "Rollback Org", email, provision: async () => { throw new Error("boom"); } })),
    ).rejects.toThrow("boom");
    expect(await count(`SELECT count(*) n FROM tenants WHERE name='Rollback Org'`)).toBe(0);
    expect(await count(`SELECT count(*) n FROM users WHERE email=$1`, [email])).toBe(0);
    expect(await count(`SELECT count(*) n FROM signup_claims WHERE email_key=$1`, [signupEmailKey(email)])).toBe(0);
    expect(await count(`SELECT count(*) n FROM tenant_legal_acceptances WHERE user_id NOT IN (SELECT id FROM users)`)).toBe(0);
    // And the address can still sign up afterwards.
    expect((await createSelfServeTenant(base({ orgName: "Rollback Org", email }))).ok).toBe(true);
  });

  it("slug: a reserved name gets a random suffix; a taken slug is never revealed, the next org still succeeds", async () => {
    const reserved = await createSelfServeTenant(base({ orgName: "Admin" }));
    expect(reserved.ok && reserved.slug).toMatch(/^admin-[a-z0-9]{6}$/);

    const a = await createSelfServeTenant(base({ orgName: "Twin Name School" }));
    const b = await createSelfServeTenant(base({ orgName: "Twin Name School" }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.slug).toBe("twin-name-school");
      expect(b.slug).toMatch(/^twin-name-school-[a-z0-9]{6}$/);
    }
  });

  it("direct callers cannot skip the input rules", async () => {
    await expect(createSelfServeTenant(base({ orgName: "<b>x</b>" }))).rejects.toThrow("invalid input");
    await expect(createSelfServeTenant(base({ email: "not-an-email" }))).rejects.toThrow("invalid input");
  });
});

describe("RLS and grants", () => {
  it("acceptance rows are tenant-isolated; the app role cannot update, delete or insert for another tenant", async () => {
    const a = await createSelfServeTenant(base({ orgName: "Rls Org A" }));
    const b = await createSelfServeTenant(base({ orgName: "Rls Org B" }));
    if (!a.ok || !b.ok) throw new Error("setup");

    const seenByA = await withTenant(a.tenantId, (c) => c.query(`SELECT DISTINCT tenant_id FROM tenant_legal_acceptances`));
    expect(seenByA.rows.map((r) => r.tenant_id)).toEqual([a.tenantId]);
    const crossRead = await withTenant(a.tenantId, (c) =>
      c.query(`SELECT 1 FROM tenant_legal_acceptances WHERE tenant_id=$1`, [b.tenantId]),
    );
    expect(crossRead.rowCount).toBe(0);

    // No UPDATE / DELETE policy: RLS denies (0 rows). In production the grants are revoked too
    // (permission denied); the test role inherits the system role's grants, so accept either.
    const denied = async (sql: string): Promise<void> => {
      const n = await withTenant(a.tenantId, (c) => c.query(sql, [a.tenantId]).then((r) => r.rowCount ?? 0)).catch(() => 0);
      expect(n).toBe(0);
    };
    await denied(`UPDATE tenant_legal_acceptances SET version='9' WHERE tenant_id=$1`);
    await denied(`DELETE FROM tenant_legal_acceptances WHERE tenant_id=$1`);
    expect(await count(`SELECT count(*) n FROM tenant_legal_acceptances WHERE tenant_id=$1 AND version='1.0'`, [a.tenantId])).toBe(2);
    await expect(
      withTenant(a.tenantId, (c) =>
        c.query(
          `INSERT INTO tenant_legal_acceptances (tenant_id, user_id, document, version) VALUES ($1,$2,'dpa','7')`,
          [b.tenantId, b.adminUserId],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/);
  });

  it("signup_claims is invisible to the application role (RLS on, no policy)", async () => {
    const a = await createSelfServeTenant(base({ orgName: "Claims Hidden Org" }));
    if (!a.ok) throw new Error("setup");
    expect(await count(`SELECT count(*) n FROM signup_claims`)).toBeGreaterThan(0);
    const seen = await withTenant(a.tenantId, (c) => c.query(`SELECT * FROM signup_claims`)).then((r) => r.rowCount ?? 0).catch(() => 0);
    expect(seen).toBe(0);
  });
});
