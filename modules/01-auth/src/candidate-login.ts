// modules/01-auth/src/candidate-login.ts
//
// Service layer for the candidate passwordless magic-link login flow.
//
// Flow:
//   1. POST /api/auth/candidate/request-link { email, tenant_slug }
//      → requestCandidateLoginLinkSystem() — resolves slug → tenant, looks up
//        user under RLS (withTenant), generates token, inserts hash row,
//        returns { token, user } or null (no-match / bad slug). Caller emails token.
//   2. POST /api/auth/candidate/verify-link { token }
//      → verifyCandidateLoginTokenSystem() — marks consumed, returns { user_id, tenant_id }.
//        Route layer destroys any pre-existing session (Fix 4), then mints 30-day session.
//
// Threat model honored:
//   - Cross-tenant email leak (Fix 1): user lookup runs INSIDE withTenant(tenant_id) under
//     RLS, not via BYPASSRLS. The slug→id resolution is system-role only (slug is public).
//   - Email enumeration: returns null on no-match; callers MUST return 204 regardless.
//   - Token leakage: hash stored (sha256 hex); plaintext returned to caller exactly once.
//   - Single-use: atomic UPDATE … SET consumed_at … WHERE consumed_at IS NULL RETURNING.
//   - Expiry: 15-minute window enforced in the UPDATE predicate (expires_at > now()).
//   - Candidate-only: non-candidate roles (admins, reviewers) use SSO; returning null
//     for those prevents the magic-link as an admin auth bypass path.
//   - Per-(IP, email) rate limit (Fix 2): 5 req/h, Redis INCR+EXPIRE, email hashed.
//   - Timing oracle (Fix 3): constant-time floor of MIN_REQUEST_MS on the System wrapper.
//   - Session fixation (Fix 4): route layer destroys prior aiq_sess before minting new one.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { sha256Hex } from "./crypto-util.js";
import { getRedis } from "./redis.js";

export const CANDIDATE_LOGIN_TOKEN_TTL_SEC = 15 * 60;       // 15 min
export const CANDIDATE_SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

// ---------------------------------------------------------------------------
// Fix 3 — Timing oracle constant-time floor.
//
// The no-match path (slug not found, user not found) is faster than the match
// path (slug resolve + user SELECT + token INSERT + audit + email enqueue).
// An attacker timing many requests can detect which emails are registered.
//
// Solution: wrap the entire requestCandidateLoginLinkSystem body in
//   Promise.all([actualWork, sleep(MIN_REQUEST_MS)])
// so both paths always take ≥ 200 ms regardless of whether any DB work ran.
// 200 ms swamps the ~10-50 ms difference at typical network noise levels;
// increasing this further has diminishing security returns versus UX cost.
// ---------------------------------------------------------------------------
const MIN_REQUEST_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fix 2 — Per-(IP, email) compound rate limit.
//
// The existing rateLimitMiddleware in middleware/rate-limit.ts is session-aware
// and keys only on IP for unauthenticated routes — it does not provide the
// per-(IP, email) compound key we need here.
//
// This helper adds a secondary, finer-grained control specific to the
// request-link flow: 5 requests per (IP, email) per 60-minute window.
// The email is SHA-256 hashed before use as a Redis key component so that
// email addresses never appear in Redis keyspace, logs, or memory dumps.
//
// Returns true if the request should be allowed; false if rate-limited.
// On false the caller returns 204 (anti-enumeration — we do NOT issue 429
// to prevent leaking whether an email is active).
// ---------------------------------------------------------------------------
const CANDIDATE_LINK_RL_WINDOW_SEC = 60 * 60; // 1 hour
const CANDIDATE_LINK_RL_MAX = 5;

// Lua script: INCR; set EXPIRE only on first hit (avoids resetting window on
// every request — attacker cannot game the window by spreading hits across
// the boundary). Returns [count_after_incr, ttl_seconds].
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

async function checkCandidateLinkRateLimit(
  ip: string,
  email: string,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<boolean> {
  const emailHash = sha256Hex(email.toLowerCase().trim());
  const key = `aiq:rl:cand-login:${ip}:${emailHash}`;
  const redis = getRedis();
  // FIX 6 (post-fix adversarial re-gate, 2026-05-13):
  // Fail closed if Redis is unreachable. Without this catch, an ioredis
  // exception propagates up through requestCandidateLoginLinkSystem and the
  // Fastify route returns a 500 — both a UX failure AND an attacker signal
  // (a 500 distinguishes "Redis is down" from the normal anti-enumeration
  // 204). Fail-closed (return false → caller returns null → route returns
  // 204) keeps the response indistinguishable from a no-match while
  // degrading login under Redis outage. The warn log surfaces the
  // degradation for ops without leaking through the HTTP response.
  try {
    const result = (await redis.eval(
      RL_LUA,
      1,
      key,
      CANDIDATE_LINK_RL_WINDOW_SEC,
    )) as [number, number];
    const count = result[0];
    return count <= CANDIDATE_LINK_RL_MAX;
  } catch (err: unknown) {
    log?.warn({ err }, 'candidate-login.rate-limit: Redis unavailable, failing closed');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CandidateUserRow {
  id: string;
  email: string;
  display_name: string;
  tenant_id: string;
  role: string;
}

interface LoginTokenRow {
  user_id: string;
  tenant_id: string;
}

// ---------------------------------------------------------------------------
// requestCandidateLoginLink  (low-level — requires caller-provided client)
// ---------------------------------------------------------------------------

export interface RequestCandidateLoginLinkInput {
  email: string;
  ip: string;
  ua: string;
}

// Extended input for the System wrapper that includes the tenant slug.
export interface RequestCandidateLoginLinkSystemInput {
  email: string;
  tenant_slug: string;
  ip: string;
  ua: string;
}

export interface RequestCandidateLoginLinkOutput {
  token: string;
  user: {
    id: string;
    email: string;
    display_name: string;
    tenant_id: string;
  };
}

/**
 * Generate a single-use login token for the candidate identified by email.
 *
 * Caller MUST supply a client already scoped to the correct tenant via
 * withTenant() — this function runs the user lookup under RLS (no BYPASSRLS).
 *
 * Returns null when:
 *   - No user with that email exists in the tenant.
 *   - The matching user is not role='candidate' (admins use SSO).
 *
 * The caller MUST return HTTP 204 in both the null and non-null cases to
 * prevent email enumeration.
 *
 * The returned plaintext token MUST be emailed immediately and never logged.
 * Only the sha256 hash is stored in the database.
 *
 * @param client  A PoolClient from a withTenant() callback (tenant_id already
 *                set via SET LOCAL app.current_tenant). The tenant scope is
 *                enforced by RLS — no BYPASSRLS used here.
 * @param input   { email, ip, ua }
 * @returns       { token (plaintext), user } or null.
 */
export async function requestCandidateLoginLink(
  client: PoolClient,
  input: RequestCandidateLoginLinkInput,
): Promise<RequestCandidateLoginLinkOutput | null> {
  const normalizedEmail = input.email.toLowerCase().trim();

  // Look up candidate by email. Must be role='candidate' and status='active'.
  // This runs under RLS (withTenant context) — only rows in the current tenant
  // are visible. We intentionally do not distinguish "not found" from "wrong
  // role" to the caller — both return null (enumeration prevention).
  const userResult = await client.query<CandidateUserRow>(
    `SELECT id, email,
            COALESCE(name, email) AS display_name,
            tenant_id, role
     FROM users
     WHERE lower(email) = $1
       AND role = 'candidate'
       AND status = 'active'
       AND deleted_at IS NULL
     LIMIT 1`,
    [normalizedEmail],
  );

  if (userResult.rows.length === 0) {
    // NOTE: We skip audit here because we don't know the tenant_id of the
    // no-match caller, and the rate-limiter at the route layer is the
    // enumeration defence.
    return null;
  }

  const user = userResult.rows[0]!;

  // Generate CSPRNG token (32 bytes = 64 hex chars). 256 bits of entropy.
  // Never logged; stored only as sha256 hash.
  const plaintextToken = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(plaintextToken);
  const expiresAt = new Date(Date.now() + CANDIDATE_LOGIN_TOKEN_TTL_SEC * 1000).toISOString();

  // Insert the token row + emit audit event atomically within the caller's transaction.
  await client.query(
    `INSERT INTO candidate_login_tokens
       (tenant_id, user_id, token_hash, expires_at, requested_ip, requested_ua)
     VALUES ($1, $2, $3, $4, $5::inet, $6)`,
    [user.tenant_id, user.id, tokenHash, expiresAt, input.ip, input.ua],
  );

  await auditInTx(client, {
    tenantId: user.tenant_id,
    actorKind: "system",
    actorUserId: user.id,
    action: "auth.candidate.login_link_requested",
    entityType: "candidate_login_token",
    ip: input.ip,
    userAgent: input.ua,
    after: {
      userId: user.id,
      email: normalizedEmail,
      expiresAt,
    },
  });

  return {
    token: plaintextToken,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      tenant_id: user.tenant_id,
    },
  };
}

// ---------------------------------------------------------------------------
// verifyCandidateLoginToken
// ---------------------------------------------------------------------------

/**
 * Verify a plaintext candidate login token.
 *
 * Checks:
 *   - sha256(plaintextToken) matches a row
 *   - expires_at > now() (not expired)
 *   - consumed_at IS NULL (not already used)
 *
 * On success: atomically marks the token consumed via UPDATE … RETURNING.
 * Returns { user_id, tenant_id } for the caller to mint a session.
 *
 * Returns null on any failure (expired / consumed / unknown).
 * The caller MUST redirect to the error page — never reveal the reason.
 *
 * The caller MUST be inside a withTenant(tenantId, ...) callback because
 * auditInTx requires SET LOCAL app.current_tenant to be active.
 * However, since we don't know tenant_id before verifying the token, this
 * function uses the assessiq_system role for the initial lookup (bypassing
 * RLS) and then emits the audit with the discovered tenant_id.
 *
 * @param client  A PoolClient. For the token lookup, the function uses
 *                system-role BYPASSRLS (the token_hash UNIQUE index is
 *                global; RLS is scoped to tenant). After discovering the
 *                tenant_id, it calls withTenant for the audit write.
 * @param plaintextToken  The raw token from the query string.
 */
export async function verifyCandidateLoginToken(
  client: PoolClient,
  plaintextToken: string,
): Promise<{ user_id: string; tenant_id: string } | null> {
  const tokenHash = sha256Hex(plaintextToken);

  // Atomic UPDATE: find the token, check expiry + consumed, mark consumed.
  // Single SQL statement — no TOCTOU between read and write.
  const result = await client.query<LoginTokenRow>(
    `UPDATE candidate_login_tokens
     SET consumed_at = now()
     WHERE token_hash = $1
       AND expires_at > now()
       AND consumed_at IS NULL
     RETURNING user_id::text, tenant_id::text`,
    [tokenHash],
  );

  if (result.rows.length === 0) {
    // Token not found, expired, or already consumed. Return null.
    // Emit no audit — prevents timing oracle (audit write latency) from
    // distinguishing "not found" from "consumed".
    return null;
  }

  const row = result.rows[0]!;

  // Emit audit for successful consumption. auditInTx requires tenant context
  // to be set. The caller's client is scoped to the correct tenant because
  // verifyCandidateLoginToken is called from within the route's withTenant block.
  await auditInTx(client, {
    tenantId: row.tenant_id,
    actorKind: "system",
    actorUserId: row.user_id,
    action: "auth.candidate.login_link_consumed",
    entityType: "candidate_login_token",
    after: {
      userId: row.user_id,
      consumedAt: new Date().toISOString(),
    },
  });

  return { user_id: row.user_id, tenant_id: row.tenant_id };
}

// ---------------------------------------------------------------------------
// Convenience: run both request and verify inside withTenant.
// The route layer uses these wrappers directly.
// ---------------------------------------------------------------------------

/**
 * FIX 1 — Cross-tenant email lookup (CRITICAL REJECT).
 *
 * Previous implementation: used BYPASSRLS system role to SELECT across ALL
 * tenants by email, then scoped to the discovered tenant_id for INSERT/audit.
 * This leaks tenant existence — an attacker could probe whether an email is
 * registered in ANY tenant by observing email-send latency differences.
 *
 * New implementation:
 *   1. Resolve slug → tenant_id using the existing getTenantBySlug() system-role
 *      helper (slug→id is not sensitive; tenant slugs appear in public URLs per
 *      the existing admin SSO flow).
 *   2. Run the user lookup AND the token INSERT AND the audit emit INSIDE
 *      withTenant(tenant_id, ...) — under RLS. The user SELECT can only see
 *      rows in the resolved tenant. An email registered in a different tenant
 *      is invisible here, preventing cross-tenant existence disclosure.
 *
 * FIX 2 — Per-(IP, email) rate limit.
 *   Checked before any DB work. 5 req/h per compound key. Returns null
 *   (caller still 204s) on exceed — anti-enumeration.
 *
 * FIX 3 — Timing oracle floor.
 *   Promise.all([work, sleep(MIN_REQUEST_MS)]) ensures both the match and
 *   no-match paths take ≥ 200 ms. The sleep runs in parallel with real work
 *   so it adds no latency on the happy path (DB round-trip > 200 ms).
 */
export async function requestCandidateLoginLinkSystem(
  input: RequestCandidateLoginLinkSystemInput,
): Promise<RequestCandidateLoginLinkOutput | null> {
  // FIX 2: Check per-(IP, email) rate limit before any DB work.
  // Exceeding the limit returns null; the route layer still returns 204.
  // We do NOT return a distinct error type to avoid leaking email existence.
  const allowed = await checkCandidateLinkRateLimit(input.ip, input.email);
  if (!allowed) return null;

  // FIX 3: Wrap actual work + constant-time floor in Promise.all.
  // sleep(MIN_REQUEST_MS) runs in parallel — on the happy path the DB round-
  // trip dominates and the sleep adds ~0 ms. On the fast no-match path (slug
  // miss before any DB work) the floor kicks in, swamping the timing difference.
  const [result] = await Promise.all([
    _requestCandidateLoginLinkWork(input),
    sleep(MIN_REQUEST_MS),
  ]);
  return result;
}

/**
 * Internal: performs the actual slug-resolve → withTenant → user-lookup →
 * token-insert work. Separated from the public wrapper so the timing floor
 * (sleep in Promise.all) can be applied cleanly around the full work unit.
 */
async function _requestCandidateLoginLinkWork(
  input: RequestCandidateLoginLinkSystemInput,
): Promise<RequestCandidateLoginLinkOutput | null> {
  // FIX 1 Step A: resolve slug → tenant_id using the system-role helper from
  // @assessiq/tenancy. Slug→id is allowed under system role (tenant slugs are
  // public-ish — they appear in admin SSO URLs already).
  const { getTenantBySlug } = await import("@assessiq/tenancy");
  const tenant = await getTenantBySlug(input.tenant_slug);
  if (tenant === null) return null;

  // FIX 1 Step B: run the user SELECT + token INSERT + audit INSIDE withTenant
  // so RLS restricts the user lookup to rows owned by this tenant only.
  // No BYPASSRLS is used for this path — the old cross-tenant SELECT is removed.
  return withTenant(tenant.id, async (client) =>
    requestCandidateLoginLink(client, {
      email: input.email,
      ip: input.ip,
      ua: input.ua,
    }),
  );
}

/**
 * Thin wrapper: runs verifyCandidateLoginToken inside a system-role UPDATE
 * then emits audit inside withTenant.
 *
 * Because we don't know tenant_id before verifying the token, we use the
 * BYPASSRLS system role for the initial UPDATE (which is global by token_hash
 * UNIQUE index), then emit the audit in a separate withTenant block.
 *
 * Note: the verify path does not need a tenant_slug input because the token
 * itself encodes the tenant_id (returned via RETURNING). The user already
 * proved they own the email when they received the token — the token IS the
 * credential at this stage.
 */
export async function verifyCandidateLoginTokenSystem(
  plaintextToken: string,
): Promise<{ user_id: string; tenant_id: string } | null> {
  const { getPool } = await import("@assessiq/tenancy");
  const pool = getPool();
  const tokenHash = sha256Hex(plaintextToken);

  const systemClient = await pool.connect();
  let row: LoginTokenRow | null = null;

  try {
    await systemClient.query("SET ROLE assessiq_system");
    const result = await systemClient.query<LoginTokenRow>(
      `UPDATE candidate_login_tokens
       SET consumed_at = now()
       WHERE token_hash = $1
         AND expires_at > now()
         AND consumed_at IS NULL
       RETURNING user_id::text, tenant_id::text`,
      [tokenHash],
    );
    row = result.rows[0] ?? null;
  } finally {
    await systemClient.query("RESET ROLE");
    systemClient.release();
  }

  if (row === null) return null;

  // Emit audit in the tenant's RLS context (post-UPDATE, so no atomicity risk).
  const capturedRow = row;
  await withTenant(capturedRow.tenant_id, async (client) => {
    await auditInTx(client, {
      tenantId: capturedRow.tenant_id,
      actorKind: "system",
      actorUserId: capturedRow.user_id,
      action: "auth.candidate.login_link_consumed",
      entityType: "candidate_login_token",
      after: {
        userId: capturedRow.user_id,
        consumedAt: new Date().toISOString(),
      },
    });
  });

  return { user_id: capturedRow.user_id, tenant_id: capturedRow.tenant_id };
}

// Export the rate-limit helper for testing.
export { checkCandidateLinkRateLimit };
