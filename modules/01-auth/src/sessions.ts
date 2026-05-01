import { uuidv7, nowIso, parseIso } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import type { PoolClient } from "pg";
import { getRedis } from "./redis.js";
import { sha256Hex, randomTokenBase64Url } from "./crypto-util.js";

// Why @assessiq/tenancy is imported here, despite SKILL.md § 9 saying
// "01-auth does not call into 02-tenancy":
//   That rule scopes the request-flow coupling — sessionLoader doesn't call
//   tenantContextMiddleware and vice versa; they communicate via the shared
//   request-decoration field name `tenantId`. The pg.Pool and the
//   `withTenant(tenantId, fn)` helper are shared infrastructure (getPool is
//   a singleton). Both modules must talk to Postgres; duplicating the pool
//   would be wasteful and break connection-limit budgets. The DAG remains
//   acyclic: 02-tenancy still does NOT import from 01-auth.

export type Role = "admin" | "reviewer" | "candidate";

export interface Session {
  id: string;
  userId: string;
  tenantId: string;
  role: Role;
  totpVerified: boolean;
  createdAt: string;        // ISO 8601 UTC
  expiresAt: string;        // ISO 8601 UTC
  lastSeenAt: string;       // ISO 8601 UTC
  lastTotpAt: string | null;
  ip: string;
  ua: string;
}

const SESSION_TTL_SEC = 8 * 60 * 60;          // 8h hard expiry
const USER_INDEX_TTL_SEC = 9 * 60 * 60;       // 9h — outlives the longest session
export const IDLE_EVICTION_MS = 30 * 60 * 1000; // 30 min idle cutoff (sessionLoader uses)

const SESSION_KEY = (hash: string): string => `aiq:sess:${hash}`;
const USER_INDEX_KEY = (userId: string): string => `aiq:user:sessions:${userId}`;

export interface CreateSessionInput {
  userId: string;
  tenantId: string;
  role: Role;
  totpVerified: boolean;
  ip: string;
  ua: string;
}

export interface CreateSessionOutput {
  id: string;
  token: string;            // plaintext; caller sets Set-Cookie with this value
  expiresAt: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  tenant_id: string;
  role: Role;
  token_hash: string;
  totp_verified: boolean;
  last_totp_at: string | null;
  ip: string;
  user_agent: string;
  expires_at: string;
  last_seen_at: string;
  created_at: string;
}

async function insertPostgresMirror(
  client: PoolClient,
  session: Session,
  tokenHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO sessions (
       id, user_id, tenant_id, role, token_hash, totp_verified, last_totp_at,
       ip, user_agent, expires_at, last_seen_at, created_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::inet,$9,$10,$11,$12)`,
    [
      session.id,
      session.userId,
      session.tenantId,
      session.role,
      tokenHash,
      session.totpVerified,
      session.lastTotpAt,
      session.ip,
      session.ua,
      session.expiresAt,
      session.lastSeenAt,
      session.createdAt,
    ],
  );
}

async function createSession(input: CreateSessionInput): Promise<CreateSessionOutput> {
  const id = uuidv7();
  const token = randomTokenBase64Url(32);     // 43-char base64url, 256 bits entropy
  const tokenHash = sha256Hex(token);
  const created = nowIso();
  const expires = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
  const lastTotpAt = input.totpVerified ? created : null;

  const session: Session = {
    id,
    userId: input.userId,
    tenantId: input.tenantId,
    role: input.role,
    totpVerified: input.totpVerified,
    createdAt: created,
    expiresAt: expires,
    lastSeenAt: created,
    lastTotpAt,
    ip: input.ip,
    ua: input.ua,
  };

  // Postgres durable mirror first — RLS-scoped via withTenant. If the insert
  // fails (FK violation, duplicate UUID, etc.) we abort before touching Redis,
  // so we never leak a session that exists only in cache.
  await withTenant(input.tenantId, async (client) => {
    await insertPostgresMirror(client, session, tokenHash);
  });

  // Redis fast-path + per-user index (sweep-on-disable per 03-users carry-forward).
  // The index TTL outlives the session TTL by 1h so a session created near the
  // index's natural expiry doesn't leave a dangling SADD beyond the SET's lifetime.
  const redis = getRedis();
  const tx = redis.multi();
  tx.set(SESSION_KEY(tokenHash), JSON.stringify(session), "EX", SESSION_TTL_SEC);
  tx.sadd(USER_INDEX_KEY(input.userId), tokenHash);
  tx.expire(USER_INDEX_KEY(input.userId), USER_INDEX_TTL_SEC);
  await tx.exec();

  return { id, token, expiresAt: expires };
}

async function getSession(token: string): Promise<Session | null> {
  const tokenHash = sha256Hex(token);
  const redis = getRedis();
  const json = await redis.get(SESSION_KEY(tokenHash));
  if (json === null) return null;
  return JSON.parse(json) as Session;
}

// Idle-eviction predicate. Exposed so sessionLoader can gate the request
// without having to know the cutoff value.
export function isIdleExpired(session: Session, nowMs = Date.now()): boolean {
  return nowMs - parseIso(session.lastSeenAt).getTime() > IDLE_EVICTION_MS;
}

// Sliding refresh: extends expiresAt by SESSION_TTL_SEC and updates lastSeenAt.
// Called from `requireAuth` middleware on every authenticated request that
// passes role/scope checks. NOT called by sessionLoader, /api/auth/whoami
// pre-MFA, or unauthenticated public endpoints — extending lifetime on every
// idle ping would let curl-keepalive defeat the 30-min idle eviction.
async function refreshSession(token: string): Promise<Session | null> {
  const tokenHash = sha256Hex(token);
  const session = await getSession(token);
  if (session === null) return null;
  if (isIdleExpired(session)) {
    await destroyByHash(session.userId, tokenHash, session.tenantId);
    return null;
  }

  const newExpires = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
  const newLastSeen = nowIso();
  session.expiresAt = newExpires;
  session.lastSeenAt = newLastSeen;

  const redis = getRedis();
  await redis.set(SESSION_KEY(tokenHash), JSON.stringify(session), "EX", SESSION_TTL_SEC);

  // Postgres durable update — best-effort. Redis is the hot-path SOR for
  // requests; Postgres is the audit trail and crash-recovery backstop. A
  // dropped Postgres update means a session's `last_seen_at` is slightly
  // stale on disk but correct in cache. We still await to surface failures
  // in tests and observability.
  await withTenant(session.tenantId, async (client) => {
    await client.query(
      `UPDATE sessions SET expires_at = $1, last_seen_at = $2 WHERE token_hash = $3`,
      [newExpires, newLastSeen, tokenHash],
    );
  });

  return session;
}

// Promotes a pre-MFA session to TOTP-verified after `/api/auth/totp/verify`.
// Does NOT extend the TTL — refreshSession handles lifetime separately.
async function markTotpVerified(token: string): Promise<Session | null> {
  const tokenHash = sha256Hex(token);
  const session = await getSession(token);
  if (session === null) return null;

  const now = nowIso();
  session.totpVerified = true;
  session.lastTotpAt = now;

  const redis = getRedis();
  const ttl = await redis.ttl(SESSION_KEY(tokenHash));
  if (ttl <= 0) return null; // expired between get and set
  await redis.set(SESSION_KEY(tokenHash), JSON.stringify(session), "EX", ttl);

  await withTenant(session.tenantId, async (client) => {
    await client.query(
      `UPDATE sessions SET totp_verified = true, last_totp_at = $1 WHERE token_hash = $2`,
      [now, tokenHash],
    );
  });

  return session;
}

async function destroyByToken(token: string): Promise<void> {
  const tokenHash = sha256Hex(token);
  const session = await getSession(token);
  if (session === null) {
    // Try Postgres-only cleanup in case Redis is gone but the durable row
    // exists. Without a session JSON we don't know the tenantId, so this
    // is a best-effort no-op — the row will be cleaned by the expiry sweeper.
    return;
  }
  await destroyByHash(session.userId, tokenHash, session.tenantId);
}

async function destroyByHash(userId: string, tokenHash: string, tenantId: string): Promise<void> {
  const redis = getRedis();
  const tx = redis.multi();
  tx.del(SESSION_KEY(tokenHash));
  tx.srem(USER_INDEX_KEY(userId), tokenHash);
  await tx.exec();

  await withTenant(tenantId, async (client) => {
    await client.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
  });
}

// Sweep-on-disable: 03-users.disableUser() and softDeleteUser() call this
// after the user-status update so all active cookies stop working immediately.
// The per-user Redis SET (populated at create) makes this O(N_user_sessions),
// not O(all_sessions).
async function destroyAllForUser(userId: string, tenantId: string): Promise<number> {
  const redis = getRedis();
  const hashes = await redis.smembers(USER_INDEX_KEY(userId));

  if (hashes.length > 0) {
    const tx = redis.multi();
    for (const h of hashes) tx.del(SESSION_KEY(h));
    tx.del(USER_INDEX_KEY(userId));
    await tx.exec();
  } else {
    // Always del the index key — defends against stale empty-set entries.
    await redis.del(USER_INDEX_KEY(userId));
  }

  // Postgres mirror: blanket DELETE by user_id. RLS-scoped via withTenant.
  await withTenant(tenantId, async (client) => {
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  });

  return hashes.length;
}

// Public surface — exact signature pinned in modules/01-auth/SKILL.md § 10.
export const sessions = {
  create: createSession,
  get: getSession,
  refresh: refreshSession,
  markTotpVerified,
  destroy: destroyByToken,
  destroyAllForUser,
};

// Re-export type only — keeps the import surface tidy for downstream consumers.
export type { Session as SessionRecord };
// SessionRow is internal — not re-exported. Kept here for future repository tests.
export type { SessionRow as _SessionRow };
