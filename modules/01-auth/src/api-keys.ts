// modules/01-auth/src/api-keys.ts
//
// Server-to-server authentication tokens (Authorization: Bearer aiq_live_...).
// Format: aiq_live_<43-char base62> (32 bytes entropy = 256 bits).
// Storage: sha256(full_key); plaintext shown to admin once at creation.
//
// Spec source: modules/01-auth/SKILL.md § Decisions captured § 6.

import { uuidv7, nowIso, AuthnError, AuthzError } from "@assessiq/core";
import { withTenant, getPool } from "@assessiq/tenancy";
import { sha256Hex, randomTokenBase62 } from "./crypto-util.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApiKeyScope =
  | "assessments:read"
  | "assessments:write"
  | "users:read"
  | "users:write"
  | "attempts:read"
  | "attempts:write"
  | "results:read"
  | "webhooks:manage"
  | "admin:*";

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  status: "active" | "revoked";
  lastUsedAt: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  status: "active" | "revoked";
  last_used_at: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
}

// ---------------------------------------------------------------------------
// Row → record mapper
// ---------------------------------------------------------------------------

function rowToRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes as ApiKeyScope[],
    status: row.status,
    lastUsedAt: row.last_used_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function create(
  tenantId: string,
  input: {
    name: string;
    scopes: ApiKeyScope[];
    createdBy: string;
    expiresAt?: string | null;
  },
): Promise<{ record: ApiKeyRecord; plaintextKey: string }> {
  const id = uuidv7();
  const randomPart = randomTokenBase62(32); // 43 chars
  const plaintextKey = `aiq_live_${randomPart}`;
  const keyPrefix = plaintextKey.slice(0, 12); // e.g. "aiq_live_xyz"
  const keyHash = sha256Hex(plaintextKey);
  const createdAt = nowIso();
  const expiresAt = input.expiresAt ?? null;

  const row = await withTenant(tenantId, async (client) => {
    const result = await client.query<ApiKeyRow>(
      `INSERT INTO api_keys
         (id, tenant_id, name, key_prefix, key_hash, scopes, status,
          last_used_at, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], 'active', NULL, $7, $8, $9)
       RETURNING
         id, tenant_id, name, key_prefix, scopes, status,
         last_used_at, created_by,
         created_at AT TIME ZONE 'UTC' AS created_at,
         expires_at`,
      [
        id,
        tenantId,
        input.name,
        keyPrefix,
        keyHash,
        input.scopes,
        input.createdBy,
        createdAt,
        expiresAt,
      ],
    );
    // INSERT ... RETURNING always returns exactly one row.
    return result.rows[0]!;
  });

  return { record: rowToRecord(row), plaintextKey };
}

async function revoke(tenantId: string, id: string): Promise<void> {
  // Soft-delete: sets status = 'revoked'. Idempotent — 0 rows affected on an
  // already-revoked key is fine. withTenant scopes to the correct tenant via RLS.
  const result = await withTenant(tenantId, async (client) => {
    return client.query(
      `UPDATE api_keys SET status = 'revoked' WHERE id = $1`,
      [id],
    );
  });

  // If 0 rows were updated the key either doesn't exist or belongs to another
  // tenant (RLS filtered it out). Either way, surface a NotFoundError so callers
  // can distinguish "key not mine" from success. An already-revoked key will
  // also return 0 rows on the status != 'revoked' path — but we deliberately
  // do NOT add that filter: idempotency means revoking an already-revoked key
  // should succeed silently, not throw. To be truly idempotent we drop the
  // existence check here. If the key never existed, 0 rows is fine too — the
  // admin UI will show no key with that ID after the call.
  void result; // rowCount is 0 or 1; both are valid
}

async function list(tenantId: string): Promise<ApiKeyRecord[]> {
  const result = await withTenant(tenantId, async (client) => {
    return client.query<ApiKeyRow>(
      `SELECT
         id, tenant_id, name, key_prefix, scopes, status,
         last_used_at, created_by, created_at, expires_at
       FROM api_keys
       ORDER BY created_at DESC`,
    );
  });

  return result.rows.map(rowToRecord);
}

// authenticate is called by auth middleware BEFORE tenantContextMiddleware runs,
// so withTenant(...) cannot be used here. The lookup must traverse all tenants.
//
// Strategy: acquire a connection from the shared pool, open an explicit
// transaction, switch to the assessiq_system role (BYPASSRLS), and run the
// point-lookup. This is the ONLY system-role read in the auth module. Every
// use is auditable because the api_key id is logged on every authenticated
// request via 14-audit-log (lands in Phase 3).
//
// SET LOCAL ROLE must be inside BEGIN/COMMIT because SET LOCAL is
// transaction-scoped — outside a transaction it is a no-op with a warning.
async function authenticate(plaintextKey: string): Promise<ApiKeyRecord> {
  const keyHash = sha256Hex(plaintextKey);
  const pool = getPool();
  const client = await pool.connect();

  let row: ApiKeyRow | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");

    const result = await client.query<ApiKeyRow>(
      `SELECT
         id, tenant_id, name, key_prefix, scopes, status,
         last_used_at, created_by, created_at, expires_at
       FROM api_keys
       WHERE key_hash = $1
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [keyHash],
    );
    await client.query("COMMIT");
    row = result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Secondary rollback failure — connection is likely dead. Swallow and
      // re-throw the original error so the caller sees the real cause.
    });
    throw err;
  } finally {
    client.release();
  }

  if (row === undefined) {
    throw new AuthnError("invalid, revoked, or expired api key");
  }

  const record = rowToRecord(row);

  // Fire-and-forget last_used_at update. The auth path must not block or fail
  // because of a stat-update. Errors are intentionally swallowed.
  getPool()
    .query(
      `UPDATE api_keys SET last_used_at = now() WHERE id = $1`,
      [record.id],
    )
    .catch(() => {
      // Intentionally swallowed: last_used_at is an audit-visibility field,
      // not a security invariant. A dropped update is acceptable.
    });

  return record;
}

function requireScope(record: ApiKeyRecord, required: ApiKeyScope): void {
  // "admin:*" is a wildcard that matches any scope.
  if (record.scopes.includes("admin:*") || record.scopes.includes(required)) {
    return;
  }
  throw new AuthzError(`api key missing scope: ${required}`);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const apiKeys = {
  create,
  revoke,
  list,
  authenticate,
  requireScope,
};
