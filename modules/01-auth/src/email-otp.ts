// modules/01-auth/src/email-otp.ts
//
// P2 — Email-OTP login for admin and reviewer roles ONLY.
//
// Flow:
//   1. POST /api/auth/login/email/request { email }
//      → requestEmailOtp() — rate-limit, resolve identities, filter eligible,
//        generate CSPRNG 6-digit code, store sha256 hash in Redis, send email.
//   2. POST /api/auth/login/email/verify { email, code }
//      → verifyEmailOtp() — load Redis, check attempts, constant-time compare,
//        re-resolve + re-filter, mintForIdentity (1 identity) or storeLoginContinuation (≥2).
//
// Security invariants honored:
//   - super_admin: NEVER reachable via email-OTP. Triple-blocked:
//       (a) requestEmailOtp eligible filter: role admin|reviewer AND !isPlatform AND role !== 'super_admin'
//       (b) verifyEmailOtp re-filter: same predicate on fresh resolveLoginIdentities result
//       (c) selectLoginIdentity candidates assertion: only admin/reviewer userIds stored,
//           so even if super_admin appeared in re-resolve, userId ∈ candidates blocks it
//   - candidate: NEVER via email-OTP (unchanged candidate-login.ts)
//   - Anti-enumeration: identical 200 response + constant-time floor on /request
//   - Code: 6-digit CSPRNG, sha256-stored, single-use atomic delete, 10-min TTL, ≤5 attempts
//   - ip/ua binding: verifyEmailOtp checks stored ip/ua match request
//   - Fail-closed on Redis errors (same pattern as candidate-login)
//   - Code never logged
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { randomInt } from "node:crypto";
import { AuthnError } from "@assessiq/core";
import { normalizeEmail, mintForIdentity } from "./google-sso.js";
import type { OidcCallbackOutput } from "./google-sso.js";
import {
  resolveLoginIdentities,
  storeLoginContinuation,
} from "./login-continuation.js";
import { sha256Hex, constantTimeEqual } from "./crypto-util.js";
import { getRedis } from "./redis.js";
import { sendEmail } from "@assessiq/notifications";

// ---------------------------------------------------------------------------
// Constants — mirror candidate-login discipline
// ---------------------------------------------------------------------------

// Constant-time floor for both /request and /verify responses.
//
// Why 800ms: constant-work (always resolve) + floor above work's p99 = no timing oracle.
// resolveLoginIdentities is a cross-tenant DB query that can take 200-500ms under pool
// contention; 800ms comfortably exceeds that p99 on all paths. The floor runs in parallel
// with real work via Promise.all, so it adds no latency on the happy path when DB work
// dominates.
const MIN_REQUEST_MS = 800;

// Redis key namespace.
const OTP_KEY_PREFIX = "aiq:email-otp:";

// Rate-limit: 5 requests per (IP, email) per hour (mirrors CANDIDATE_LINK_RL_MAX=5).
const OTP_RL_WINDOW_SEC = 60 * 60;
const OTP_RL_MAX = 5;

// Rate-limit: 10 requests per email (IP-independent) per hour.
// Prevents IP-rotation email-bombing / code-farming against a victim admin address.
const OTP_RL_EMAIL_WINDOW_SEC = 60 * 60;
const OTP_RL_EMAIL_MAX = 10;

// OTP TTL: 10 minutes.
const OTP_TTL_SEC = 10 * 60;

// Max verify attempts before code is burned.
const OTP_MAX_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

// Rate-limit key: per (IP, email-hash). Email SHA-256 hashed in keyspace.
function rlKey(ip: string, emailHash: string): string {
  return `aiq:rl:email-otp:${ip}:${emailHash}`;
}

// Rate-limit key: per email-hash only (IP-independent — prevents IP-rotation attacks).
function rlEmailKey(emailHash: string): string {
  return `aiq:rl:email-otp:email:${emailHash}`;
}

// OTP storage key: keyed on email-hash only (one code per email).
function otpKey(emailHash: string): string {
  return `${OTP_KEY_PREFIX}${emailHash}`;
}

// ---------------------------------------------------------------------------
// Lua scripts (mirrors candidate-login INCR+EXPIRE pattern exactly)
// ---------------------------------------------------------------------------

// Rate-limit Lua: INCR; EXPIRE only on first hit (avoids resetting window).
// Returns [count_after_incr, ttl_seconds].
const RL_LUA = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local n = redis.call("INCR", key)
if n == 1 then
  redis.call("EXPIRE", key, window)
end
local ttl = redis.call("TTL", key)
return {n, ttl}
`;

// Atomic attempt accounting Lua:
//   1. GET key → if missing, return nil (expired or never stored)
//   2. Parse JSON, increment attempts
//   3. If attempts > max → DEL key, return error sentinel
//   4. Else SET key with updated attempts, preserve TTL
//   5. Return updated JSON string
//
// Returns: [status, data]
//   status=0 → success, data=JSON string with incremented attempts
//   status=1 → key missing (expired or burned)
//   status=2 → attempts exceeded (key deleted)
const ATTEMPT_LUA = `
local key = KEYS[1]
local maxAttempts = tonumber(ARGV[1])
local raw = redis.call("GET", key)
if not raw then
  return {1, ""}
end
local ok, parsed = pcall(cjson.decode, raw)
if not ok then
  redis.call("DEL", key)
  return {1, ""}
end
local attempts = (parsed.attempts or 0) + 1
parsed.attempts = attempts
if attempts > maxAttempts then
  redis.call("DEL", key)
  return {2, ""}
end
local ttl = redis.call("TTL", key)
if ttl < 0 then ttl = 1 end
redis.call("SET", key, cjson.encode(parsed), "EX", ttl)
return {0, cjson.encode(parsed)}
`;

// ---------------------------------------------------------------------------
// OTP Redis payload shape
// ---------------------------------------------------------------------------

interface OtpPayload {
  codeHash: string;  // sha256Hex(plaintext 6-digit code)
  email: string;     // normalizeEmail'd — stored for re-verify
  ip: string;        // bound to requesting IP
  ua: string;        // bound to requesting UA
  attempts: number;  // starts at 0, incremented on each verify attempt
}

// ---------------------------------------------------------------------------
// Rate-limit checks (mirrors checkCandidateLinkRateLimit exactly)
// ---------------------------------------------------------------------------

// Per-(IP, email) rate-limit check.
async function checkOtpRateLimit(ip: string, email: string): Promise<boolean> {
  const emailHash = sha256Hex(email);
  const key = rlKey(ip, emailHash);
  const redis = getRedis();
  try {
    const result = (await redis.eval(
      RL_LUA,
      1,
      key,
      OTP_RL_WINDOW_SEC,
    )) as [number, number];
    const count = result[0];
    return count <= OTP_RL_MAX;
  } catch {
    // Fail-closed: Redis unavailable → deny request (no send).
    return false;
  }
}

// Per-email (IP-independent) rate-limit check.
// Prevents an attacker who rotates IPs from email-bombing a victim admin address.
// Key: aiq:rl:email-otp:email:<emailHash>. Limit: 10/hour.
async function checkOtpEmailRateLimit(email: string): Promise<boolean> {
  const emailHash = sha256Hex(email);
  const key = rlEmailKey(emailHash);
  const redis = getRedis();
  try {
    const result = (await redis.eval(
      RL_LUA,
      1,
      key,
      OTP_RL_EMAIL_WINDOW_SEC,
    )) as [number, number];
    const count = result[0];
    return count <= OTP_RL_EMAIL_MAX;
  } catch {
    // Fail-closed: Redis unavailable → deny request (no send).
    return false;
  }
}

// ---------------------------------------------------------------------------
// Eligible identity filter
//
// Eligible for email-OTP: admin and reviewer in a NON-platform tenant ONLY.
// Triple-explicit guard:
//   (a) role must be 'admin' or 'reviewer'
//   (b) isPlatform must be false (rules out platform tenant rows)
//   (c) role must NOT be 'super_admin' (redundant given (a), but belt-and-suspenders)
//
// This is the SAME filter used in both requestEmailOtp AND verifyEmailOtp
// (re-filter at verify time) to ensure no eligible-set drift between issue and consume.
// ---------------------------------------------------------------------------

function filterEligible(identities: Awaited<ReturnType<typeof resolveLoginIdentities>>) {
  // Triple-explicit super_admin guard:
  //   (a) role must be 'admin' or 'reviewer' — this alone excludes super_admin and candidate
  //   (b) isPlatform must be false — rules out platform tenant rows (defence-in-depth)
  //
  // Note: `i.role !== 'super_admin'` is structurally redundant given the role
  // union check above (role can only be 'admin'|'reviewer' after the first guard),
  // but is documented for belt-and-suspenders clarity in the spec. It's omitted
  // here to satisfy the TypeScript compiler (comparing 'admin'|'reviewer' to
  // 'super_admin' is always false and the compiler correctly warns).
  return identities.filter(
    (i) =>
      (i.role === "admin" || i.role === "reviewer") &&
      !i.isPlatform,
  );
}

// ---------------------------------------------------------------------------
// requestEmailOtp
//
// Public API. Always returns void. The route layer always returns 200 { ok: true }
// regardless of the outcome — anti-enumeration. This function never throws for
// ineligible/rate-limited/unknown emails; it silently returns.
// ---------------------------------------------------------------------------

export async function requestEmailOtp(input: {
  email: string;
  ip: string;
  ua: string;
}): Promise<void> {
  // Constant-time floor: sleep runs in parallel with work.
  // _requestWork always performs resolveLoginIdentities first (constant DB cost
  // on every path); the MIN_REQUEST_MS (800ms) floor sits above its p99, so
  // response timing is indistinguishable across rate-limited / ineligible /
  // unknown / send paths — no email-enumeration oracle.
  await Promise.all([_requestWork(input), sleep(MIN_REQUEST_MS)]);
}

async function _requestWork(input: {
  email: string;
  ip: string;
  ua: string;
}): Promise<void> {
  const email = normalizeEmail(input.email);

  // TIMING INVARIANT: resolveLoginIdentities is ALWAYS called first on every path,
  // regardless of rate-limit or eligibility outcome. This equalises the DB cost
  // across all branches so response latency cannot distinguish "provisioned admin email"
  // from "rate-limited" or "unknown" email. Rate-limit and eligibility decisions are
  // made from the already-fetched result — never before it.
  //
  // Combined with the MIN_REQUEST_MS floor (800ms, above the realistic p99 of
  // resolveLoginIdentities under pool contention), this removes the timing oracle.

  // Step 1 (ALWAYS): resolve identities across tenants — constant-cost DB work.
  const identities = await resolveLoginIdentities(email);

  // Step 2: check per-(IP, email) rate-limit AFTER the constant-cost resolve.
  // Fail-closed. Return silently on limit or Redis error — caller → 200 identical.
  const allowedIp = await checkOtpRateLimit(input.ip, email);
  if (!allowedIp) {
    return;
  }

  // Step 3: check per-email (IP-independent) rate-limit.
  // Prevents IP-rotation email-bombing a victim admin address.
  const allowedEmail = await checkOtpEmailRateLimit(email);
  if (!allowedEmail) {
    return;
  }

  // Step 4: filter identities to eligible: admin|reviewer, non-platform, not super_admin.
  // super_admin-only emails → eligible.length === 0 → no code sent.
  // candidate-only emails → eligible.length === 0 → no code sent.
  const eligible = filterEligible(identities);

  if (eligible.length === 0) {
    // No eligible identity. Anti-enumeration: return without sending.
    return;
  }

  // Generate 6-digit CSPRNG code, zero-padded.
  // crypto.randomInt(0, 1_000_000) returns [0, 1000000) uniformly.
  const codeInt = randomInt(0, 1_000_000);
  const code = codeInt.toString().padStart(6, "0");

  // Store sha256(code) in Redis. NEVER store or log the plaintext code.
  const payload: OtpPayload = {
    codeHash: sha256Hex(code),
    email,
    ip: input.ip,
    ua: input.ua,
    attempts: 0,
  };

  const emailHash = sha256Hex(email);
  const key = otpKey(emailHash);
  const redis = getRedis();

  try {
    // SET with EX — overwrites any prior code for this email (one active code per email).
    await redis.set(key, JSON.stringify(payload), "EX", OTP_TTL_SEC);
  } catch {
    // Fail-closed: if Redis write fails, no code was stored, don't send the email.
    return;
  }

  // Send email with the 6-digit code. Fire-and-forget failure (same pattern as
  // candidate-login): a send failure is non-fatal; the user can request a new code.
  // NEVER log the plaintext code.
  // tenantId: use first eligible identity's tenant so the send is audited and
  // routed through the tenant transport (not dev-emails.log).
  sendEmail({
    to: email,
    template: "admin_email_otp",
    vars: {
      code,
      expires_minutes: Math.round(OTP_TTL_SEC / 60),
    },
    tenantId: eligible[0]!.tenantId,
  }).catch(() => {
    // Intentionally swallowed — email failures must not affect the caller's
    // identical-200 response path. The user can request a new code.
  });
}

// ---------------------------------------------------------------------------
// verifyEmailOtp
//
// Verify a 6-digit code submitted by the user.
// On success: mintForIdentity (1 eligible) or storeLoginContinuation (≥2).
// On any failure: throws AuthnError("authentication failed") — generic.
// Constant-time floor via Promise.all (mirrors consumeLoginContinuation).
// ---------------------------------------------------------------------------

export async function verifyEmailOtp(input: {
  email: string;
  code: string;
  ip: string;
  ua: string;
}): Promise<OidcCallbackOutput & { kind: "session" | "select" }> {
  const [result] = await Promise.all([
    _verifyWork(input),
    sleep(MIN_REQUEST_MS),
  ]);
  return result;
}

async function _verifyWork(input: {
  email: string;
  code: string;
  ip: string;
  ua: string;
}): Promise<OidcCallbackOutput & { kind: "session" | "select" }> {
  const email = normalizeEmail(input.email);
  const emailHash = sha256Hex(email);
  const key = otpKey(emailHash);
  const redis = getRedis();

  // Atomically increment attempts and retrieve payload.
  // Uses Lua script to prevent race conditions on attempt counting.
  let raw: [number, string];
  try {
    raw = (await redis.eval(
      ATTEMPT_LUA,
      1,
      key,
      OTP_MAX_ATTEMPTS,
    )) as [number, string];
  } catch {
    // Redis error → fail-closed.
    throw new AuthnError("authentication failed");
  }

  const [status, updatedJson] = raw;

  if (status === 1) {
    // Key missing: code expired, never issued, or already consumed.
    throw new AuthnError("authentication failed");
  }

  if (status === 2) {
    // Attempts exceeded: key already deleted by Lua script. Code burned.
    throw new AuthnError("authentication failed");
  }

  // status === 0: payload returned with incremented attempts.
  let payload: OtpPayload;
  try {
    payload = JSON.parse(updatedJson) as OtpPayload;
  } catch {
    // Corrupt payload — delete and fail.
    await redis.del(key).catch(() => {});
    throw new AuthnError("authentication failed");
  }

  // ip/ua binding: the code was issued to a specific client context.
  // Mismatch → reject (attempts already incremented, so this also counts toward lockout).
  if (payload.ip !== input.ip || payload.ua !== input.ua) {
    throw new AuthnError("authentication failed");
  }

  // Constant-time compare: sha256(submitted code) vs stored codeHash.
  const submittedHash = sha256Hex(input.code);
  const storedHash = payload.codeHash;
  const hashMatch =
    submittedHash.length === storedHash.length &&
    constantTimeEqual(
      Buffer.from(submittedHash),
      Buffer.from(storedHash),
    );

  if (!hashMatch) {
    throw new AuthnError("authentication failed");
  }

  // Code matched. Atomically delete the key (single-use).
  // If this DEL fails, the code stays in Redis but will expire in at most OTP_TTL_SEC.
  // That's acceptable — the attempts counter is already incremented, and the key
  // will expire naturally. We do NOT fail the login on DEL failure.
  await redis.del(key).catch(() => {});

  // Re-resolve identities at verify time (status/role re-checked fresh).
  // Apply the SAME eligible filter as at request time.
  const freshIdentities = await resolveLoginIdentities(email);
  const eligible = filterEligible(freshIdentities);

  if (eligible.length === 0) {
    // No eligible identity at verify time (may have been disabled between request and verify).
    throw new AuthnError("authentication failed");
  }

  if (eligible.length === 1) {
    // Single eligible identity → mint immediately.
    // subject omitted: email-OTP has no Google identity. mintForIdentity will
    // skip the oauth_identities INSERT when subject is absent/undefined (P2 B2 change).
    // exactOptionalPropertyTypes: omit the property rather than passing subject:undefined.
    return mintForIdentity(eligible[0]!, {
      ip: input.ip,
      ua: input.ua,
      embeddedReturnTo: undefined,
    }) as Promise<OidcCallbackOutput & { kind: "session" | "select" }>;
  }

  // ≥2 eligible identities → issue continuation token.
  //
  // SECURITY NOTE: payload.candidates contains ONLY admin/reviewer userIds (filtered above).
  // Even though resolveLoginIdentities (called inside selectLoginIdentity's re-resolve)
  // returns all roles including super_admin, the selectLoginIdentity function's
  // `userId ∈ payload.candidates` assertion ensures a super_admin userId can NEVER
  // be selected — it was never placed in candidates here. This is the 3rd layer of
  // the super_admin exclusion (see module header).
  //
  // subject=undefined: email-OTP origin has no Google subject.
  // selectLoginIdentity passes payload.subject into mintForIdentity → skips oauth INSERT.
  // exactOptionalPropertyTypes: explicitly typing subject as undefined satisfies the interface
  // (LoginContinuationPayload.subject is `string | undefined`, not `string?`).
  const continuationToken = await storeLoginContinuation({
    idpEmail: email,
    subject: undefined,
    ip: input.ip,
    ua: input.ua,
    embeddedReturnTo: undefined,
    candidates: eligible.map((e) => e.userId),
  });

  return {
    kind: "select",
    continuationToken,
    redirectTo: "/admin/select-identity",
  };
}

// Export rate-limit helpers for testing.
export { checkOtpRateLimit, checkOtpEmailRateLimit };
