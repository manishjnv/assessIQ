// modules/02-tenancy/src/self-serve.ts
//
// Z-71 / Z-81: self-serve organisation creation. LOAD-BEARING: it creates a tenant and its
// first admin from a PUBLIC route. Callers (modules/01-auth/src/signup.ts) must have proved
// control of the email address (one-time code) BEFORE they call createSelfServeTenant.
//
// Design: docs/design/2026-10-18-self-serve-signup-design.md ("S31 review result", binding).
//
// INVARIANTS
//   - ONE transaction (withSystemRole, never nested in withTenant). Any failing step rolls
//     everything back: no half-made tenant, no burnt claim.
//   - signup_claims.email_key (HMAC of the folded address) is the database guard for "one
//     organisation per email". INSERT ... ON CONFLICT DO NOTHING; 0 rows = refuse.
//   - The first user has role 'admin' ONLY. Nothing here can create a super_admin, and an
//     address in SUPER_ADMIN_EMAILS (or one that folds to it) is refused inside the tx.
//   - Status follows createTenant: 'provisioning' on insert, 'active' at the end of the SAME tx.
//   - Audit rows carry no plain email, and ip / user_agent are NULL (explicit nulls).
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import type { PoolClient } from "pg";
import { randomInt } from "node:crypto";
import { config, hmacSha256Hex, streamLogger, uuidv7 } from "@assessiq/core";
import { auditInTx } from "@assessiq/audit-log";
import { withSystemRole } from "./with-tenant.js";

const log = streamLogger("app");

// ---------------------------------------------------------------------------
// Keyed hashes (never a plain hash: a plain sha256 of an email is reversible by dictionary)
// ---------------------------------------------------------------------------

/** Server key for sign-up HMACs, derived from SESSION_SECRET so no new secret is needed. */
function serverKey(): string {
  return hmacSha256Hex(config.SESSION_SECRET, "aiq:signup:hmac-key:v1");
}

/** HMAC-SHA256 with a purpose label, so a value hashed for one use cannot match another. */
export function signupHmac(purpose: string, value: string): string {
  return hmacSha256Hex(serverKey(), `${purpose}\u0000${value}`);
}

/** Lower-case + trim. Same rule as 01-auth normalizeEmail (kept here: tenancy cannot import auth). */
export function normalizeSignupEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Fold an address to the key that guards "one organisation per email": plus-tag removed
 * for every domain, dots removed and googlemail.com folded to gmail.com for Gmail.
 */
export function foldSignupEmail(email: string): string {
  const e = normalizeSignupEmail(email);
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/** email_key column value: HMAC of the folded address. */
export function signupEmailKey(email: string): string {
  return signupHmac("email-key", foldSignupEmail(email));
}

/** True when the address, or an alias that folds to it, is a super-admin address. */
export function isSuperAdminEmail(email: string): boolean {
  const folded = foldSignupEmail(email);
  return (config.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .some((e) => foldSignupEmail(e) === folded);
}

// ---------------------------------------------------------------------------
// Input rules (shared by the route schema and by createSelfServeTenant)
// ---------------------------------------------------------------------------

/** NFKC + collapse whitespace + trim. */
export function normalizeOrgName(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim();
}

const ORG_NAME_RE = /^[\p{L}\p{N} .\-&']{3,80}$/u;

/** 3-80 chars after normalisation; letters, digits, space and . - & ' only. */
export function isValidOrgName(raw: string): boolean {
  return ORG_NAME_RE.test(normalizeOrgName(raw));
}

/** 2-80 chars after trim, no control characters, no angle brackets. */
export function isValidAdminName(raw: string): boolean {
  const n = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  return n.length >= 2 && n.length <= 80 && !/[\p{C}<>]/u.test(n);
}

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

const MODULE_NAMES = [
  "core", "auth", "tenancy", "users", "question-bank", "assessment-lifecycle", "attempt-engine",
  "ai-grading", "rubric-engine", "scoring", "admin-dashboard", "candidate-ui", "embed-sdk",
  "notifications", "audit-log", "analytics", "help-system", "ui-system", "certification",
  "billing", "data-rights",
];

/** Slugs a visitor can never take (design list plus every module name). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin", "api", "www", "assessiq", "app", "take", "verify", "embed", "help", "try", "static",
  "assets", "brand", "candidate", "login", "signup", "support", "mail", "status", "platform",
  ...MODULE_NAMES,
]);

/** Lower-case ASCII slug, 3-40 chars. Unicode is folded, other characters are dropped. */
export function slugFromName(name: string): string {
  let s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (s.length === 0) s = "org";
  else if (s.length < 3) s = `${s}-org`;
  return s;
}

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += SUFFIX_ALPHABET[randomInt(0, SUFFIX_ALPHABET.length)]!;
  return out;
}

const SLUG_TRIES = 5;

/** Candidate slugs in order: the plain slug (unless reserved), then random-suffixed ones. */
function* slugCandidates(base: string): Generator<string> {
  let first = true;
  for (let i = 0; i < SLUG_TRIES; i++) {
    if (first && !RESERVED_SLUGS.has(base)) {
      first = false;
      yield base;
      continue;
    }
    first = false;
    yield `${base.slice(0, 33).replace(/-+$/, "")}-${randomSuffix()}`;
  }
}

// ---------------------------------------------------------------------------
// Existing-address lookup (request path: decides which mail to send)
// ---------------------------------------------------------------------------

/**
 * True when the address already has an account in ANY tenant, or its folded key is already
 * claimed. Runs under the system role: the lookup is cross-tenant by nature. It returns a
 * boolean only; callers must never let the answer reach the visitor (anti-enumeration).
 */
export async function signupEmailTaken(email: string): Promise<boolean> {
  const e = normalizeSignupEmail(email);
  const key = signupEmailKey(e);
  return withSystemRole("self-serve sign-up: address already in use lookup", async (client) => {
    const r = await client.query<{ taken: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM users WHERE lower(email) = $1)
              OR EXISTS (SELECT 1 FROM signup_claims WHERE email_key = $2)) AS taken`,
      [e, key],
    );
    return r.rows[0]?.taken === true;
  });
}

// ---------------------------------------------------------------------------
// createSelfServeTenant
// ---------------------------------------------------------------------------

export interface SelfServeProvisionContext {
  tenantId: string;
  adminUserId: string;
}

export interface CreateSelfServeTenantInput {
  orgName: string;
  adminName: string;
  /** The verified address. Normalised here. */
  email: string;
  dpaVersion: string;
  termsVersion: string;
  /** Raw client IP and user agent. Stored only as HMACs. */
  ip: string;
  userAgent: string;
  /**
   * Steps owned by other modules that must commit or roll back WITH the tenant (the Free
   * plan, the credit grant, the sample-set entitlements live in 19-billing, which depends on
   * this module, so apps/api passes the function in). Runs on the same system-role client.
   * Returns small facts for the audit row (for example the plan name).
   */
  provision?: (client: PoolClient, ctx: SelfServeProvisionContext) => Promise<{ plan?: string } | void>;
}

export type SelfServeRefusal = "claim_exists" | "email_in_use" | "super_admin_email" | "slug_exhausted";

export type CreateSelfServeTenantResult =
  | { ok: true; tenantId: string; adminUserId: string; slug: string }
  | { ok: false; reason: SelfServeRefusal };

class Refuse extends Error {
  constructor(readonly reason: SelfServeRefusal) {
    super(`self-serve sign-up refused: ${reason}`);
  }
}

export async function createSelfServeTenant(
  input: CreateSelfServeTenantInput,
): Promise<CreateSelfServeTenantResult> {
  const email = normalizeSignupEmail(input.email);
  const orgName = normalizeOrgName(input.orgName);
  const adminName = input.adminName.normalize("NFKC").replace(/\s+/g, " ").trim();
  // Defence in depth: the route validated already; a direct caller must not skip the rules.
  if (!isValidOrgName(orgName) || !isValidAdminName(adminName) || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new Error("createSelfServeTenant: invalid input");
  }
  const emailKey = signupEmailKey(email);
  const baseSlug = slugFromName(orgName);
  const tenantId = uuidv7();
  const adminUserId = uuidv7();

  try {
    return await withSystemRole("self-serve sign-up", async (client) => {
      // (1) One claim per folded address. 0 rows = someone claimed it first (or a parallel
      // verify is committing now): stop with nothing created.
      const claim = await client.query(
        `INSERT INTO signup_claims (email_key) VALUES ($1) ON CONFLICT (email_key) DO NOTHING`,
        [emailKey],
      );
      if (claim.rowCount === 0) throw new Refuse("claim_exists");

      // (2) Re-check inside the tx: a super-admin address, or an address that already has a
      // user in any tenant, gets no organisation.
      if (isSuperAdminEmail(email)) throw new Refuse("super_admin_email");
      const used = await client.query(`SELECT 1 FROM users WHERE lower(email) = $1 LIMIT 1`, [email]);
      if ((used.rowCount ?? 0) > 0) throw new Refuse("email_in_use");

      // (3) Tenant at 'provisioning' (as createTenant). ON CONFLICT DO NOTHING keeps the tx
      // alive on a slug clash, so there is no exception to abort it.
      let slug: string | null = null;
      for (const candidate of slugCandidates(baseSlug)) {
        const ins = await client.query(
          `INSERT INTO tenants (id, slug, name, status, self_registered)
           VALUES ($1, $2, $3, 'provisioning', true)
           ON CONFLICT (slug) DO NOTHING
           RETURNING id`,
          [tenantId, candidate, orgName],
        );
        if ((ins.rowCount ?? 0) > 0) {
          slug = candidate;
          break;
        }
      }
      if (slug === null) throw new Refuse("slug_exhausted");
      await client.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenantId]);

      // (4) First admin: role 'admin', active, no password (sign-in is Google or email code).
      await client.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status)
         VALUES ($1, $2, $3, $4, 'admin', 'active')`,
        [adminUserId, tenantId, email, adminName],
      );

      // (5)+(6) Cross-module steps (Free plan, credit grant, sample sets) in this same tx.
      const facts = (await input.provision?.(client, { tenantId, adminUserId })) ?? {};

      // (7) Acceptance record: terms and DPA, versions the form showed. Hashes only.
      const ipHash = signupHmac("ip", input.ip);
      const uaHash = signupHmac("ua", input.userAgent);
      for (const [document, version] of [
        ["terms", input.termsVersion],
        ["dpa", input.dpaVersion],
      ] as const) {
        await client.query(
          `INSERT INTO tenant_legal_acceptances
             (tenant_id, user_id, document, version, ip_hash, user_agent_hash)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantId, adminUserId, document, version, ipHash, uaHash],
        );
      }

      // (8) Audit in the same tx. System actor; no plain email; ip / ua explicitly NULL.
      await auditInTx(client, {
        tenantId,
        actorKind: "system",
        action: "tenant.provisioned",
        entityType: "tenant",
        entityId: tenantId,
        ip: null,
        userAgent: null,
        after: { slug, name: orgName, self_registered: true },
      });
      await auditInTx(client, {
        tenantId,
        actorKind: "system",
        action: "signup.completed",
        entityType: "tenant",
        entityId: tenantId,
        ip: null,
        userAgent: null,
        after: {
          plan: facts.plan ?? "free",
          dpa_version: input.dpaVersion,
          terms_version: input.termsVersion,
          admin_user_id: adminUserId,
        },
      });

      // Flip to 'active' and fill the claim, still in the same tx.
      await client.query(`UPDATE tenants SET status = 'active', updated_at = now() WHERE id = $1`, [tenantId]);
      await client.query(`UPDATE signup_claims SET claimed_tenant_id = $2 WHERE email_key = $1`, [emailKey, tenantId]);

      return { ok: true as const, tenantId, adminUserId, slug };
    });
  } catch (err) {
    if (err instanceof Refuse) {
      log.info({ reason: err.reason }, "createSelfServeTenant: refused, nothing created");
      return { ok: false, reason: err.reason };
    }
    throw err;
  }
}
