// modules/01-auth/src/signup-otp.ts
//
// Z-71: one-time code for the self-serve sign-up. SEPARATE key space from the admin sign-in
// code (email-otp.ts uses `aiq:email-otp:<sha256(email)>`; this file uses
// `aiq:signup:otp:signup:<hmac>`), so one address can hold both codes with no collision and
// a sign-in code can never finish a sign-up (or the other way round).
//
// Redis hash at the key:
//   h      HMAC-SHA256(server key, "signup" + email + code)    (no salt: the key binds it)
//   a      wrong-attempt counter
//   org, admin, dpa, terms, ip, ua   what the visitor submitted with the request; the verify
//          step creates the organisation from THIS record, never from a second body.
//
// ATOMIC TAKE (design S31 finding 1): one Lua script compares and deletes. A match deletes
// the key and returns the record, so only ONE of two parallel correct verifies sees it. A
// miss adds one to `a` and deletes the key at 5. The compare is plain equality on a keyed
// HMAC: the attacker cannot compute the HMAC, so timing leaks nothing usable.
//
// The admin sign-in code path (email-otp.ts) is NOT changed here. Making that verify atomic
// is the separate follow-up FU-OTP-ATOMIC.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { randomInt } from "node:crypto";
import { signupHmac } from "@assessiq/tenancy";
import { getRedis } from "./redis.js";

export const SIGNUP_OTP_TTL_SEC = 10 * 60;
export const SIGNUP_OTP_MAX_ATTEMPTS = 5;

/** What the request step remembers for the verify step. */
export interface SignupRecord {
  orgName: string;
  adminName: string;
  dpaVersion: string;
  termsVersion: string;
  /** Client IP and user agent of the request (where the boxes were ticked). */
  ip: string;
  ua: string;
}

const TAKE_LUA = `
local h = redis.call("HGET", KEYS[1], "h")
if not h then return {0} end
if h == ARGV[1] then
  local v = redis.call("HMGET", KEYS[1], "org", "admin", "dpa", "terms", "ip", "ua")
  redis.call("DEL", KEYS[1])
  return {1, v[1], v[2], v[3], v[4], v[5], v[6]}
end
local n = redis.call("HINCRBY", KEYS[1], "a", 1)
if n >= tonumber(ARGV[2]) then redis.call("DEL", KEYS[1]) end
return {0}
`;

export function signupOtpKey(email: string): string {
  return `aiq:signup:otp:signup:${signupHmac("otp-key", email)}`;
}

export function signupCodeHash(email: string, code: string): string {
  return signupHmac("signup", `${email}\u0000${code}`);
}

/** 6 digits, CSPRNG, zero-padded. */
export function generateSignupCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Replace any earlier code for this address. Returns false on a Redis error (caller sends nothing). */
export async function storeSignupCode(email: string, code: string, rec: SignupRecord): Promise<boolean> {
  const key = signupOtpKey(email);
  try {
    const res = await getRedis()
      .multi()
      .del(key)
      .hset(key, {
        h: signupCodeHash(email, code),
        a: 0,
        org: rec.orgName,
        admin: rec.adminName,
        dpa: rec.dpaVersion,
        terms: rec.termsVersion,
        ip: rec.ip,
        ua: rec.ua,
      })
      .expire(key, SIGNUP_OTP_TTL_SEC)
      .exec();
    return res !== null && res.every(([err]) => err === null);
  } catch {
    return false;
  }
}

/** Compare-and-delete in one step. Null on a wrong, expired, burnt or missing code, or a Redis error. */
export async function takeSignupCode(email: string, code: string): Promise<SignupRecord | null> {
  try {
    const out = (await getRedis().eval(
      TAKE_LUA,
      1,
      signupOtpKey(email),
      signupCodeHash(email, code),
      SIGNUP_OTP_MAX_ATTEMPTS,
    )) as Array<number | string | null>;
    if (out[0] !== 1) return null;
    const [, org, admin, dpa, terms, ip, ua] = out as [number, string, string, string, string, string, string];
    if (![org, admin, dpa, terms, ip, ua].every((v) => typeof v === "string")) return null;
    return { orgName: org, adminName: admin, dpaVersion: dpa, termsVersion: terms, ip, ua };
  } catch {
    return null;
  }
}
