// modules/01-auth/src/signup.ts
//
// Z-71 / Z-81: self-serve organisation sign-up, auth side. LOAD-BEARING. The public routes in
// apps/api/src/routes/public-signup.ts are thin wrappers around the three functions here.
//
//   signupAvailable()  -> preconditions, checked on EVERY request (routes answer 404 if false)
//   requestSignup()    -> Turnstile, rate limits, block list, daily cap, then ONE of two mails.
//                         Always neutral after the checks: the answer never shows whether the
//                         address already has an account.
//   verifySignup()     -> atomic code take, createSelfServeTenant, NEW session for the admin.
//
// Why public routes are safe (docs/04-auth-flows.md "Self-serve sign-up"): no tenant data is
// read or written until the tenant exists; every input is validated; Turnstile + rate limits +
// daily cap + one-claim-per-email (database primary key) bound abuse; the first user is
// role 'admin' only.
//
// Rate-limit scopes (one bucket per scope, 429 names it): signup_ip 5/day, signup_email 3/day
// (keyed by the folded-address HMAC, so plus-tags and Gmail dots do not give extra requests),
// signup_global 50 completed sign-ups/day (read at request, incremented on completion).
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { config, sha256Hex, streamLogger } from "@assessiq/core";
import { auditInTx } from "@assessiq/audit-log";
import {
  createSelfServeTenant,
  isSuperAdminEmail,
  normalizeSignupEmail,
  signupEmailKey,
  signupEmailTaken,
  withTenant,
  type CreateSelfServeTenantInput,
  type SelfServeRefusal,
} from "@assessiq/tenancy";
import { sendEmail } from "@assessiq/notifications";
import { getRedis } from "./redis.js";
import { incrFixedWindow } from "./fixed-window-lua.js";
import { sessions } from "./sessions.js";
import type { RateLimitScope } from "./middleware/rate-limit.js";
import { isBlockedSignup } from "./signup-blocklist.js";
import { DPA_VERSION } from "./signup-legal.js";
import { generateSignupCode, storeSignupCode, takeSignupCode, SIGNUP_OTP_TTL_SEC } from "./signup-otp.js";

const log = streamLogger("auth");

// 800 ms floor on both public steps (same constant-time reasoning as email-otp.ts).
const MIN_REQUEST_MS = 800;
const DAY_SEC = 24 * 60 * 60;

export const SIGNUP_IP_MAX_PER_DAY = 5;
export const SIGNUP_EMAIL_MAX_PER_DAY = 3;
export const SIGNUP_GLOBAL_MAX_PER_DAY = 50;

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const SIGNUP_TURNSTILE_ACTION = "signup-request";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const utcDay = (): string => new Date().toISOString().slice(0, 10);
const globalKey = (): string => `aiq:rl:signup:day:${utcDay()}`;

// ---------------------------------------------------------------------------
// Preconditions (P1-P4 of the design). Fail closed.
// ---------------------------------------------------------------------------

export async function signupAvailable(): Promise<boolean> {
  if (!config.PLAN_TIERS_ENFORCED || !config.SIGNUP_ENABLED) return false;
  if (!config.TURNSTILE_SECRET || !config.TURNSTILE_SITE_KEY) return false;
  try {
    const pong = await Promise.race([
      getRedis().ping(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("redis ping timeout")), 1500).unref?.()),
    ]);
    return pong === "PONG";
  } catch {
    return false;
  }
}

/** Public config for the sign-up page. `open` is the precondition result. */
export async function signupPublicConfig(): Promise<{
  open: boolean;
  turnstileSiteKey: string | null;
  dpaVersion: string;
}> {
  const open = await signupAvailable();
  return { open, turnstileSiteKey: open ? (config.TURNSTILE_SITE_KEY ?? null) : null, dpaVersion: DPA_VERSION };
}

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

function allowedTurnstileHostnames(): string[] {
  if (config.SIGNUP_TURNSTILE_HOSTNAMES.length > 0) return config.SIGNUP_TURNSTILE_HOSTNAMES;
  try {
    return [new URL(config.ASSESSIQ_BASE_URL).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

/**
 * Server-side siteverify. Fails closed on a timeout (3 s), a non-200 answer, success=false, a
 * wrong action, a wrong hostname, or a token already used (Redis SET NX EX 300 on sha256).
 */
async function verifyTurnstile(token: string, ip: string | null): Promise<boolean> {
  const secret = config.TURNSTILE_SECRET;
  if (!secret || token.length === 0) return false;
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip !== null) form.set("remoteip", ip);
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean; action?: string; hostname?: string };
    if (data.success !== true || data.action !== SIGNUP_TURNSTILE_ACTION) return false;
    const host = typeof data.hostname === "string" ? data.hostname.toLowerCase() : "";
    if (host === "" || !allowedTurnstileHostnames().includes(host)) return false;
  } catch (err) {
    log.warn({ err }, "signup.turnstile.verify_error");
    return false;
  }
  try {
    const first = await getRedis().set(`aiq:signup:ts:${sha256Hex(token)}`, "1", "EX", 300, "NX");
    return first === "OK";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rejection audit: later rejects only, once per HMAC(email) per day, platform tenant.
// ---------------------------------------------------------------------------

type RejectReason = "blocked" | "super_admin_email" | "daily_cap" | SelfServeRefusal;

async function auditRejectOnce(reason: RejectReason, emailKey: string): Promise<void> {
  try {
    const first = await getRedis().set(`aiq:signup:rej:${utcDay()}:${emailKey}`, "1", "EX", DAY_SEC, "NX");
    if (first !== "OK") return;
    // auditInTx (not audit()): audit() would fill ip / user_agent from the request context
    // when passed null; here they must stay NULL.
    await withTenant(config.PLATFORM_TENANT_ID, (client) =>
      auditInTx(client, {
        tenantId: config.PLATFORM_TENANT_ID,
        actorKind: "system",
        action: "signup.rejected",
        entityType: "signup",
        ip: null,
        userAgent: null,
        after: { reason, email_hmac: emailKey },
      }),
    );
  } catch (err) {
    // The visitor must still get the neutral answer; the failure is logged for staff.
    log.error({ err, reason }, "signup.rejected audit failed");
  }
}

// ---------------------------------------------------------------------------
// requestSignup
// ---------------------------------------------------------------------------

export interface SignupRequestInput {
  orgName: string;
  adminName: string;
  email: string;
  turnstileToken: string;
  /** The versions the form showed. The route has already required dpaVersion === DPA_VERSION. */
  dpaVersion: string;
  termsVersion: string;
  /** From extractRateLimitClientIp (null = cannot be determined, request is refused). */
  ip: string | null;
  ua: string;
}

export type SignupRequestResult =
  | { status: "accepted" }
  | { status: "turnstile_failed" }
  | { status: "rate_limited"; scope: RateLimitScope; retryAfterSeconds: number };

export async function requestSignup(input: SignupRequestInput): Promise<SignupRequestResult> {
  const [result] = await Promise.all([requestWork(input), sleep(MIN_REQUEST_MS)]);
  return result;
}

async function bucket(key: string, max: number, scope: RateLimitScope): Promise<SignupRequestResult | null> {
  try {
    const { count, ttl } = await incrFixedWindow(getRedis(), key, DAY_SEC);
    return count > max ? { status: "rate_limited", scope, retryAfterSeconds: ttl > 0 ? ttl : DAY_SEC } : null;
  } catch {
    // Redis down: fail closed.
    return { status: "rate_limited", scope, retryAfterSeconds: 60 };
  }
}

async function requestWork(input: SignupRequestInput): Promise<SignupRequestResult> {
  const email = normalizeSignupEmail(input.email);
  const emailKey = signupEmailKey(email);

  // 1. Bot check.
  if (!(await verifyTurnstile(input.turnstileToken, input.ip))) return { status: "turnstile_failed" };

  // 2. Per-source limit. No determinable IP = fail closed.
  if (input.ip === null) return { status: "rate_limited", scope: "signup_ip", retryAfterSeconds: 60 };
  const ipHit = await bucket(`aiq:rl:signup:ip:${input.ip}`, SIGNUP_IP_MAX_PER_DAY, "signup_ip");
  if (ipHit !== null) return ipHit;

  // 3. Per-address limit. Counts requests (both mails), not only sends.
  const emailHit = await bucket(`aiq:rl:signup:email:${emailKey}`, SIGNUP_EMAIL_MAX_PER_DAY, "signup_email");
  if (emailHit !== null) return emailHit;

  // 4. Block list and super-admin addresses: neutral answer, nothing sent.
  if (isSuperAdminEmail(email)) {
    await auditRejectOnce("super_admin_email", emailKey);
    return { status: "accepted" };
  }
  if (isBlockedSignup(email, input.orgName)) {
    await auditRejectOnce("blocked", emailKey);
    return { status: "accepted" };
  }

  // 5. Daily cap of COMPLETED sign-ups: read only. At the cap nothing is sent.
  if (await dailyCapReached()) {
    log.warn({}, "signup.daily_cap_reached: no code sent");
    await auditRejectOnce("daily_cap", emailKey);
    return { status: "accepted" };
  }

  // 6. Same work on both branches: one DB lookup, one code, one Redis write, one mail.
  const taken = await signupEmailTaken(email).catch((err: unknown) => {
    log.error({ err }, "signup.email_lookup_failed");
    return null; // lookup failed: send nothing (fail closed)
  });
  if (taken === null) return { status: "accepted" };

  const code = generateSignupCode();
  const redis = getRedis();
  if (taken) {
    await redis.set(`aiq:signup:decoy:${emailKey}`, "1", "EX", 60).catch(() => undefined); // equalise Redis work
    await sendEmail({
      to: email,
      template: "signup_existing_account",
      vars: { signInLink: new URL("/admin/login", config.ASSESSIQ_BASE_URL).toString() },
      tenantId: config.PLATFORM_TENANT_ID,
      redactLogBody: true,
    }).catch((err: unknown) => log.warn({ err }, "signup.existing_mail_failed"));
  } else {
    const stored = await storeSignupCode(email, code, {
      orgName: input.orgName,
      adminName: input.adminName,
      dpaVersion: input.dpaVersion,
      termsVersion: input.termsVersion,
      ip: input.ip,
      ua: input.ua,
    });
    if (stored) {
      // NEVER log the code. redactLogBody keeps it out of email_log.
      await sendEmail({
        to: email,
        template: "signup_code",
        vars: { code, expires_minutes: Math.round(SIGNUP_OTP_TTL_SEC / 60) },
        tenantId: config.PLATFORM_TENANT_ID,
        redactLogBody: true,
      }).catch((err: unknown) => log.warn({ err }, "signup.code_mail_failed"));
    }
  }
  return { status: "accepted" };
}

async function dailyCapReached(): Promise<boolean> {
  try {
    const n = Number(await getRedis().get(globalKey()));
    return Number.isFinite(n) && n >= SIGNUP_GLOBAL_MAX_PER_DAY;
  } catch {
    return true; // fail closed
  }
}

// ---------------------------------------------------------------------------
// verifySignup
// ---------------------------------------------------------------------------

export interface VerifySignupDeps {
  /** Billing and other cross-module steps that must share the create transaction. */
  provision?: CreateSelfServeTenantInput["provision"];
  /** Runs after commit with the tenant already active (taxonomy seed). Failures are logged only. */
  afterCommit?: (ctx: { tenantId: string; adminUserId: string }) => Promise<void>;
}

export interface VerifySignupInput {
  email: string;
  code: string;
  /** Optional: when present it must equal the version stored with the code. */
  dpaVersion?: string | undefined;
  /** From extractRateLimitClientIp (null = cannot be determined, verify is refused). */
  ip: string | null;
  ua: string;
}

export type VerifySignupResult =
  // sessionToken null: the organisation exists but the session could not be made; the admin signs in with the emailed code.
  | { ok: true; sessionToken: string | null; redirectTo: string; tenantId: string; userId: string }
  | { ok: false };

export async function verifySignup(input: VerifySignupInput, deps: VerifySignupDeps = {}): Promise<VerifySignupResult> {
  const [result] = await Promise.all([verifyWork(input, deps), sleep(MIN_REQUEST_MS)]);
  return result;
}

async function verifyWork(input: VerifySignupInput, deps: VerifySignupDeps): Promise<VerifySignupResult> {
  const email = normalizeSignupEmail(input.email);
  if (!/^\d{6}$/.test(input.code)) return { ok: false };
  const emailKey = signupEmailKey(email);

  // Cap first, so a full day does not burn a code that was already sent. NO audit row here:
  // this step runs before any code check, so an anonymous caller could create one row (and one
  // Redis key) per address. The request path already audits a daily_cap reject.
  if (await dailyCapReached()) return { ok: false };
  // No determinable client IP = fail closed, same rule as the request step.
  if (input.ip === null) return { ok: false };
  const ip = input.ip;

  // Atomic take: only one caller can ever see the record.
  const rec = await takeSignupCode(email, input.code);
  if (rec === null) return { ok: false };
  if (input.dpaVersion !== undefined && input.dpaVersion !== rec.dpaVersion) return { ok: false };

  let created: Awaited<ReturnType<typeof createSelfServeTenant>>;
  try {
    created = await createSelfServeTenant({
      orgName: rec.orgName,
      adminName: rec.adminName,
      email,
      dpaVersion: rec.dpaVersion,
      termsVersion: rec.termsVersion,
      ip: rec.ip,
      userAgent: rec.ua,
      ...(deps.provision !== undefined ? { provision: deps.provision } : {}),
    });
  } catch (err) {
    // Nothing committed (one transaction). Neutral answer; the visitor requests a new code.
    log.error({ err }, "signup.create_failed");
    return { ok: false };
  }
  if (!created.ok) {
    await auditRejectOnce(created.reason, emailKey);
    return { ok: false };
  }

  await incrFixedWindow(getRedis(), globalKey(), 2 * DAY_SEC).catch((err: unknown) =>
    log.error({ err }, "signup.global_counter_failed"),
  );

  if (deps.afterCommit !== undefined) {
    await deps.afterCommit({ tenantId: created.tenantId, adminUserId: created.adminUserId }).catch((err: unknown) =>
      log.error({ err, tenantId: created.tenantId }, "signup.after_commit_failed: tenant is active, finish by hand"),
    );
  }

  // A NEW session for the new admin (never a pre-login cookie). Role admin only; same MFA rule
  // as google-sso.ts mintForIdentity for a tenant admin.
  let token: string;
  try {
    ({ token } = await sessions.create({
      userId: created.adminUserId,
      tenantId: created.tenantId,
      role: "admin",
      totpVerified: !config.MFA_REQUIRED,
      totpFresh: false, // GATE-8 A1-3: the MFA-off bypass is not a real TOTP check
      ip,
      ua: input.ua,
    }));
  } catch (err) {
    // The tenant is committed; the admin can sign in with the emailed admin code.
    log.error({ err, tenantId: created.tenantId }, "signup.session_failed: tenant is active");
    return { ok: true, sessionToken: null, redirectTo: "/admin/login", tenantId: created.tenantId, userId: created.adminUserId };
  }
  return {
    ok: true,
    sessionToken: token,
    redirectTo: config.MFA_REQUIRED ? "/admin/mfa" : "/admin",
    tenantId: created.tenantId,
    userId: created.adminUserId,
  };
}
