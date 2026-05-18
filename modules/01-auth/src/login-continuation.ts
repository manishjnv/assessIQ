// modules/01-auth/src/login-continuation.ts
//
// P1 — Login identity resolver + continuation token service.
//
// Responsible for:
//   1. resolveLoginIdentities — cross-tenant identity lookup AFTER full
//      id_token verification. Runs under assessiq_system (BYPASSRLS).
//   2. storeLoginContinuation / consumeLoginContinuation — short-lived
//      single-use Redis-backed continuation token (mirrors candidate-login
//      discipline: SHA-256 keyed, TTL 300s, ip/ua-bound, fail-closed).
//   3. selectLoginIdentity — select-endpoint service layer: consumes the
//      continuation token, verifies userId anti-tamper, re-resolves
//      identities, mints session via mintForIdentity.
//
// INVARIANT: resolveLoginIdentities MUST only ever be called after the full
// OIDC id_token verification chain (CSRF state, code exchange, JWKS RS256
// verify, nonce check). Calling it on unverified email is a security
// violation — it performs a BYPASSRLS cross-tenant read that should only be
// keyed on a Google-verified email.

import { randomBytes } from "node:crypto";
import { config, AuthnError } from "@assessiq/core";
import { getPool } from "@assessiq/tenancy";
import type { PoolClient } from "pg";
import { normalizeEmail } from "./google-sso.js";
import type { OidcCallbackOutput } from "./google-sso.js";
import { sha256Hex } from "./crypto-util.js";
import { getRedis } from "./redis.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedIdentity {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  role: "admin" | "super_admin" | "reviewer" | "candidate";
  isPlatform: boolean;
}

export interface LoginContinuationPayload {
  idpEmail: string;
  subject: string;
  ip: string;
  ua: string;
  embeddedReturnTo: string | undefined;
  candidates: string[]; // userIds
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTINUATION_TTL_SEC = 300; // 5 minutes — matches cookie Max-Age on route
const MIN_REQUEST_MS = 200; // constant-time floor (mirrors candidate-login)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// withSystemTx — mirrors modules/19-billing/src/service.ts withSystemTx exactly.
//
// BEGIN; SET LOCAL ROLE assessiq_system; fn; COMMIT. On error: ROLLBACK + rethrow.
// Always releases the client.
// ---------------------------------------------------------------------------

async function withSystemTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// resolveLoginIdentities
//
// PRECONDITION (CRITICAL): caller MUST invoke this only after full id_token
// verification (CSRF state, code exchange, JWKS RS256 verify, nonce check).
// This function performs a cross-tenant read under assessiq_system (BYPASSRLS).
// It is safe ONLY because the email is Google-verified at that point.
//
// Gate-2 preservation:
//   A row with role='super_admin' or tenant_id=PLATFORM_TENANT_ID is included
//   ONLY IF normalizeEmail(idpEmail) is in the comma-split SUPER_ADMIN_EMAILS
//   allowlist. Non-allowlisted emails have platform rows filtered OUT entirely
//   — they are never returned, counted, or shown.
// ---------------------------------------------------------------------------

export async function resolveLoginIdentities(
  idpEmail: string,
): Promise<ResolvedIdentity[]> {
  const normalized = normalizeEmail(idpEmail);
  const platformTenantId = config.PLATFORM_TENANT_ID;

  // Gate-2: build the SUPER_ADMIN_EMAILS allowlist.
  const allowlist = (config.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => normalizeEmail(e.trim()))
    .filter((e) => e.length > 0);
  const emailInAllowlist = allowlist.includes(normalized);

  const rows = await withSystemTx(async (client) => {
    const res = await client.query<{
      id: string;
      tenant_id: string;
      slug: string;
      name: string;
      role: "admin" | "super_admin" | "reviewer" | "candidate";
    }>(
      `SELECT u.id, u.tenant_id, t.slug, t.name, u.role
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE lower(u.email) = lower($1)
         AND u.status = 'active'
         AND u.deleted_at IS NULL`,
      [normalized],
    );
    return res.rows;
  });

  // Apply Gate-2 filter: remove platform/super_admin rows if email not in allowlist.
  const filtered = rows.filter((row) => {
    const isPlatformRow =
      row.tenant_id === platformTenantId || row.role === "super_admin";
    if (isPlatformRow && !emailInAllowlist) {
      return false; // filtered OUT — non-allowlisted email must not see platform identity
    }
    return true;
  });

  return filtered.map((row) => ({
    userId: row.id,
    tenantId: row.tenant_id,
    tenantSlug: row.slug,
    tenantName: row.name,
    role: row.role,
    isPlatform: row.tenant_id === platformTenantId,
  }));
}

// ---------------------------------------------------------------------------
// storeLoginContinuation
//
// Stores a continuation payload in Redis under a SHA-256-derived key.
// Returns the random plaintext token (base64url, 32 bytes).
// Fail-closed: if Redis is unavailable → throws AuthnError.
// ---------------------------------------------------------------------------

export async function storeLoginContinuation(
  payload: LoginContinuationPayload,
): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const keyHash = sha256Hex(rawToken);
  const redisKey = `aiq:login-cont:${keyHash}`;

  const redis = getRedis();
  try {
    await redis.set(redisKey, JSON.stringify(payload), "EX", CONTINUATION_TTL_SEC);
  } catch (err) {
    throw new AuthnError("authentication failed", { cause: err });
  }

  return rawToken;
}

// ---------------------------------------------------------------------------
// consumeLoginContinuation
//
// Single-use: atomically GETs and DELetes the token from Redis.
// Verifies ip+ua match (binding, like candidate-login).
// Constant-time floor of MIN_REQUEST_MS on failure path.
// Fail-closed on Redis error.
// ---------------------------------------------------------------------------

export async function consumeLoginContinuation(
  token: string,
  ip: string,
  ua: string,
): Promise<LoginContinuationPayload> {
  const [result] = await Promise.all([
    _consumeWork(token, ip, ua),
    sleep(MIN_REQUEST_MS),
  ]);
  return result;
}

async function _consumeWork(
  token: string,
  ip: string,
  ua: string,
): Promise<LoginContinuationPayload> {
  const keyHash = sha256Hex(token);
  const redisKey = `aiq:login-cont:${keyHash}`;
  const redis = getRedis();

  let raw: string | null;
  try {
    // Atomic single-use: GETDEL — returns the value and deletes in one step.
    raw = await redis.getdel(redisKey);
  } catch (err) {
    throw new AuthnError("authentication failed", { cause: err });
  }

  if (raw === null) {
    throw new AuthnError("authentication failed"); // expired, consumed, or invalid
  }

  let payload: LoginContinuationPayload;
  try {
    payload = JSON.parse(raw) as LoginContinuationPayload;
  } catch {
    throw new AuthnError("authentication failed");
  }

  // ip+ua binding — prevents token use from a different client context.
  if (payload.ip !== ip || payload.ua !== ua) {
    throw new AuthnError("authentication failed");
  }

  return payload;
}

// ---------------------------------------------------------------------------
// peekLoginContinuation
//
// Non-consuming read: GET only (no DEL). Used by GET /api/auth/login/identities
// to return the picker list without invalidating the token for the POST /select.
// Applies the same ip/ua binding and fail-closed behaviour as consume.
// ---------------------------------------------------------------------------

export async function peekLoginContinuation(
  token: string,
  ip: string,
  ua: string,
): Promise<LoginContinuationPayload> {
  const [result] = await Promise.all([
    _peekWork(token, ip, ua),
    sleep(MIN_REQUEST_MS),
  ]);
  return result;
}

async function _peekWork(
  token: string,
  ip: string,
  ua: string,
): Promise<LoginContinuationPayload> {
  const keyHash = sha256Hex(token);
  const redisKey = `aiq:login-cont:${keyHash}`;
  const redis = getRedis();

  let raw: string | null;
  try {
    raw = await redis.get(redisKey);
  } catch (err) {
    throw new AuthnError("authentication failed", { cause: err });
  }

  if (raw === null) {
    throw new AuthnError("authentication failed");
  }

  let payload: LoginContinuationPayload;
  try {
    payload = JSON.parse(raw) as LoginContinuationPayload;
  } catch {
    throw new AuthnError("authentication failed");
  }

  if (payload.ip !== ip || payload.ua !== ua) {
    throw new AuthnError("authentication failed");
  }

  return payload;
}

// ---------------------------------------------------------------------------
// selectLoginIdentity
//
// Select-endpoint service layer:
//   1. consumeLoginContinuation (single-use, ip/ua-bound).
//   2. Assert identityUserId ∈ payload.candidates (anti-tamper — CRITICAL).
//   3. Re-resolve identities so status/role/allowlist are re-checked at mint
//      time (not trusted from the snapshot).
//   4. Assert identityUserId is still in the freshly-resolved set.
//   5. mintForIdentity (imported lazily to avoid circular dep).
// ---------------------------------------------------------------------------

export async function selectLoginIdentity(opts: {
  continuationToken: string;
  identityUserId: string;
  ip: string;
  ua: string;
}): Promise<OidcCallbackOutput & { kind: "session" }> {
  const { continuationToken, identityUserId, ip, ua } = opts;

  const payload = await consumeLoginContinuation(continuationToken, ip, ua);

  // Anti-tamper: identityUserId must be in the recorded candidates list.
  // This prevents a caller from minting an identity the verified email does
  // not own by supplying an arbitrary userId.
  if (!payload.candidates.includes(identityUserId)) {
    throw new AuthnError("authentication failed");
  }

  // Re-resolve at mint time — status/role/allowlist re-checked fresh.
  const freshIdentities = await resolveLoginIdentities(payload.idpEmail);
  const chosen = freshIdentities.find((i) => i.userId === identityUserId);
  if (chosen === undefined) {
    // The chosen identity is no longer valid (disabled, deleted, allowlist removed, etc.)
    throw new AuthnError("authentication failed");
  }

  // Lazy import to avoid circular dependency (google-sso imports this module
  // for resolveLoginIdentities; mintForIdentity is defined in google-sso).
  const { mintForIdentity } = await import("./google-sso.js");

  // No Google id_token claims available at select time — claims omitted.
  // mintForIdentity handles this: raw_profile fields are optional, and the
  // allowlist re-check falls back to the DB-row guard (see mintForIdentity comment).
  return mintForIdentity(chosen, {
    subject: payload.subject,
    ip,
    ua,
    embeddedReturnTo: payload.embeddedReturnTo,
  });
}
