// modules/01-auth/src/embed-jwt.ts
//
// Embed JWT mint + verify. HS256-only — algorithm confusion is the canonical
// embed-JWT vuln (alg:none, HS256-vs-RS256 key confusion, HS384 against an
// HS256 secret).  jose.jwtVerify with algorithms: ["HS256"] is the ONLY
// supported posture; do not add fallback paths.
//
// Spec sources:
//   - modules/01-auth/SKILL.md § Decisions captured § 5.
//   - docs/04-auth-flows.md Flow 3 (Embed) — esp. line 201 ("alg confusion").
//   - docs/03-api-contract.md § Embed worked example.

import * as jose from "jose";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { encryptEnvelope, decryptEnvelope, randomTokenBase64Url } from "./crypto-util.js";
import { getRedis } from "./redis.js";
import { withTenant } from "@assessiq/tenancy";
import { uuidv7, AuthnError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbedTokenPayload {
  iss: string;             // host app name, free-text
  aud: "assessiq";         // hard-coded — verify rejects other values
  sub: string;             // host's user id
  tenant_id: string;       // UUID v7
  email: string;
  name: string;
  assessment_id: string;   // UUID v7
  iat: number;             // unix seconds
  exp: number;             // unix seconds; exp - iat <= 600
  jti: string;             // UUID; jti replay cache key
}

export interface VerifiedEmbedToken {
  payload: EmbedTokenPayload;
  tenantId: string;        // payload.tenant_id, surfaced for tenantContextMiddleware
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Derive a jose KeyObject from a base64url-encoded raw secret. */
function secretToKey(base64url: string): Uint8Array {
  return Buffer.from(base64url, "base64url");
}

/**
 * Attempt jwtVerify with a given raw secret (base64url string).
 * Returns the verified payload on success, throws on any failure.
 * Throws are NOT swallowed here — the caller decides what to do with them.
 */
async function tryVerify(
  token: string,
  secretBase64url: string,
): Promise<jose.JWTVerifyResult> {
  const key = secretToKey(secretBase64url);
  return jose.jwtVerify(token, key, {
    algorithms: ["HS256"],
    audience: "assessiq",
  });
}

/**
 * Distinguish a signature-mismatch error from other verification failures.
 * jose surfaces signature failures as JWSSignatureVerificationFailed.
 * Any other failure (alg confusion, exp, malformed) must NOT trigger key fallback.
 */
function isSignatureMismatch(err: unknown): boolean {
  if (err instanceof jose.errors.JWSSignatureVerificationFailed) return true;
  // jose may also surface this as a generic JOSEError with code set.
  if (
    err instanceof jose.errors.JOSEError &&
    (err as jose.errors.JOSEError & { code?: string }).code ===
      "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// DB row type for embed_secrets
// ---------------------------------------------------------------------------

interface EmbedSecretRow {
  id: string;
  secret_enc: Buffer;
}

// ---------------------------------------------------------------------------
// Public API — mint
// ---------------------------------------------------------------------------

/**
 * Mints an embed token. Loads the active embed_secrets row for the tenant,
 * decrypts via ASSESSIQ_MASTER_KEY, signs with HS256. Caller (admin UI)
 * receives the token; AssessIQ never stores it.
 */
export async function mintEmbedToken(
  payload: Omit<EmbedTokenPayload, "iat" | "exp" | "jti" | "aud">,
  opts?: { ttlSeconds?: number },
): Promise<string> {
  const ttl = Math.min(opts?.ttlSeconds ?? 600, 600);
  const now = Math.floor(Date.now() / 1000);
  const iat = now;
  const exp = now + ttl;
  const jti = randomUUID();

  // Load active secret for this tenant.
  const secretBase64url = await withTenant(payload.tenant_id, async (client: PoolClient) => {
    const result = await client.query<EmbedSecretRow>(
      `SELECT id, secret_enc FROM embed_secrets
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [payload.tenant_id],
    );
    if (result.rows.length === 0) {
      throw new AuthnError("invalid embed token");
    }
    const row = result.rows[0]!;
    const plaintext = decryptEnvelope(row.secret_enc);
    return plaintext.toString("utf8");
  });

  const fullPayload: EmbedTokenPayload = {
    ...payload,
    aud: "assessiq",
    iat,
    exp,
    jti,
  };

  const key = secretToKey(secretBase64url);
  const token = await new jose.SignJWT(fullPayload as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);

  return token;
}

// ---------------------------------------------------------------------------
// Public API — verify
// ---------------------------------------------------------------------------

/**
 * Verifies an embed token. ALL of:
 *   1. jose.jwtVerify with algorithms: ["HS256"] — reject every other alg.
 *   2. payload.aud === "assessiq" (hard, enforced by jose options).
 *   3. payload.iat <= now <= payload.exp (jose handles exp; iat-future-skew separate).
 *   4. payload.exp - payload.iat <= 600 (10-minute max lifetime).
 *   5. Two-key rotation: try active first; if signature fails try most-recent
 *      rotated row ONCE. Never try more than two keys.
 *   6. Replay cache: SET aiq:embed:jti:<jti> 1 EX (exp - now) NX.
 *
 * On any failure throws AuthnError("invalid embed token").
 * On success returns { payload, tenantId }.
 */
export async function verifyEmbedToken(token: string): Promise<VerifiedEmbedToken> {
  // ---------- Step 0: decode header to catch alg confusion before any DB call ----------
  // jose.decodeProtectedHeader does not verify — just parses. We use it only
  // to fast-reject non-HS256 alg headers. The authoritative alg enforcement is
  // still the algorithms: ["HS256"] option inside jwtVerify.
  let decodedHeader: jose.ProtectedHeaderParameters;
  try {
    decodedHeader = jose.decodeProtectedHeader(token);
  } catch {
    throw new AuthnError("invalid embed token");
  }
  if (decodedHeader.alg !== "HS256") {
    throw new AuthnError("invalid embed token");
  }

  // ---------- Step 1: decode payload claims for pre-checks ----------
  let rawPayload: EmbedTokenPayload;
  try {
    const decoded = jose.decodeJwt(token);
    rawPayload = decoded as unknown as EmbedTokenPayload;
  } catch {
    throw new AuthnError("invalid embed token");
  }

  // Validate required claims are present.
  if (
    typeof rawPayload.tenant_id !== "string" ||
    typeof rawPayload.iat !== "number" ||
    typeof rawPayload.exp !== "number" ||
    typeof rawPayload.jti !== "string" ||
    typeof rawPayload.sub !== "string" ||
    typeof rawPayload.email !== "string" ||
    typeof rawPayload.name !== "string" ||
    typeof rawPayload.assessment_id !== "string"
  ) {
    throw new AuthnError("invalid embed token");
  }

  // Lifetime cap check: exp - iat must not exceed 600 seconds.
  if (rawPayload.exp - rawPayload.iat > 600) {
    throw new AuthnError("embed token lifetime exceeds 10 minutes");
  }

  // iat future-skew check (jose handles exp-expired; we handle iat-in-future).
  const now = Math.floor(Date.now() / 1000);
  if (rawPayload.iat > now + 5) {
    // Allow 5s clock skew; reject tokens with iat meaningfully in the future.
    throw new AuthnError("invalid embed token");
  }

  // Fast reject already-expired tokens before touching Redis.
  if (rawPayload.exp <= now) {
    throw new AuthnError("invalid embed token");
  }

  // ---------- Step 2: load tenant secrets and verify signature ----------
  let verifiedPayload: EmbedTokenPayload;

  try {
    verifiedPayload = await withTenant(rawPayload.tenant_id, async (client: PoolClient) => {
      // Load active secret.
      const activeResult = await client.query<EmbedSecretRow>(
        `SELECT id, secret_enc FROM embed_secrets
         WHERE tenant_id = $1 AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
        [rawPayload.tenant_id],
      );

      if (activeResult.rows.length === 0) {
        throw new AuthnError("invalid embed token");
      }

      const activeRow = activeResult.rows[0]!;
      const activeSecret = decryptEnvelope(activeRow.secret_enc).toString("utf8");

      let verifyResult: jose.JWTVerifyResult;
      try {
        verifyResult = await tryVerify(token, activeSecret);
      } catch (activeErr) {
        // Only fall back to rotated key on signature mismatch.
        // Any other failure (alg, exp, malformed, aud) propagates immediately.
        if (!isSignatureMismatch(activeErr)) {
          throw activeErr;
        }

        // Try the most-recent rotated key — ONCE.
        const rotatedResult = await client.query<EmbedSecretRow>(
          `SELECT id, secret_enc FROM embed_secrets
           WHERE tenant_id = $1 AND status = 'rotated'
           ORDER BY rotated_at DESC LIMIT 1`,
          [rawPayload.tenant_id],
        );

        if (rotatedResult.rows.length === 0) {
          throw new AuthnError("invalid embed token");
        }

        const rotatedRow = rotatedResult.rows[0]!;
        const rotatedSecret = decryptEnvelope(rotatedRow.secret_enc).toString("utf8");

        // This throw propagates unmodified if the rotated key also fails.
        verifyResult = await tryVerify(token, rotatedSecret);
      }

      return verifyResult.payload as unknown as EmbedTokenPayload;
    });
  } catch (err) {
    if (err instanceof AuthnError) throw err;
    // Wrap any jose / DB failure as a non-leaky AuthnError.
    throw new AuthnError("invalid embed token");
  }

  // ---------- Step 3: replay cache ----------
  const jti = verifiedPayload.jti;
  const ttlSeconds = Math.floor(verifiedPayload.exp - now);
  // Double-check: should not reach here with ttl <= 0 (already handled above),
  // but be defensive.
  if (ttlSeconds <= 0) {
    throw new AuthnError("invalid embed token");
  }

  const redis = getRedis();
  const cacheKey = `aiq:embed:jti:${jti}`;
  // SET key 1 EX ttl NX — returns "OK" on success, null if key already exists.
  const setResult = await redis.set(cacheKey, "1", "EX", ttlSeconds, "NX");
  if (setResult === null) {
    throw new AuthnError("invalid embed token");
  }

  return {
    payload: verifiedPayload,
    tenantId: verifiedPayload.tenant_id,
  };
}

// ---------------------------------------------------------------------------
// Public API — admin helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new embed_secrets row for the tenant. Returns the plaintext
 * secret ONCE — it is never stored in plaintext and never returned again.
 */
export async function createEmbedSecret(
  tenantId: string,
  name: string,
): Promise<{ id: string; plaintextSecret: string }> {
  const plaintextSecret = randomTokenBase64Url(32);
  const secretEnc = encryptEnvelope(Buffer.from(plaintextSecret, "utf8"));
  const id = uuidv7();

  await withTenant(tenantId, async (client: PoolClient) => {
    await client.query(
      `INSERT INTO embed_secrets (id, tenant_id, name, secret_enc, algorithm, status)
       VALUES ($1, $2, $3, $4, 'HS256', 'active')`,
      [id, tenantId, name, secretEnc],
    );
  });

  return { id, plaintextSecret };
}

/**
 * Lists embed-secret metadata rows for the tenant. Admin rotation panel uses
 * this to surface which secrets are active vs rotated. The encrypted envelope
 * (`secret_enc`) is NEVER returned — admins do not need plaintext, and the
 * column is excluded from the SELECT to make leak-by-typo impossible.
 *
 * Tenant scoping: withTenant sets app.current_tenant; the embed_secrets RLS
 * policy filters cross-tenant rows out at the DB layer (fail-closed via
 * current_setting('app.current_tenant', true)).
 */
export interface EmbedSecretRecord {
  id: string;
  tenantId: string;
  name: string;
  algorithm: string;
  status: "active" | "rotated" | "revoked";
  rotatedAt: string | null;
  createdAt: string;
}

interface EmbedSecretListRow {
  id: string;
  tenant_id: string;
  name: string;
  algorithm: string;
  status: "active" | "rotated" | "revoked";
  rotated_at: string | null;
  created_at: string;
}

export async function listEmbedSecrets(tenantId: string): Promise<EmbedSecretRecord[]> {
  const result = await withTenant(tenantId, async (client: PoolClient) => {
    return client.query<EmbedSecretListRow>(
      `SELECT id, tenant_id, name, algorithm, status, rotated_at, created_at
       FROM embed_secrets
       ORDER BY created_at DESC`,
    );
  });
  return result.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    algorithm: row.algorithm,
    status: row.status,
    rotatedAt: row.rotated_at,
    createdAt: row.created_at,
  }));
}

/**
 * Rotates the active embed secret for a tenant. Marks the current 'active'
 * row as 'rotated' and creates a new 'active' row. Returns the new plaintext
 * secret ONCE.
 */
export async function rotateEmbedSecret(
  tenantId: string,
): Promise<{ id: string; plaintextSecret: string }> {
  const plaintextSecret = randomTokenBase64Url(32);
  const secretEnc = encryptEnvelope(Buffer.from(plaintextSecret, "utf8"));
  const newId = uuidv7();

  await withTenant(tenantId, async (client: PoolClient) => {
    // Mark current active row as rotated.
    await client.query(
      `UPDATE embed_secrets
       SET status = 'rotated', rotated_at = now()
       WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId],
    );

    // Insert new active row.
    await client.query(
      `INSERT INTO embed_secrets (id, tenant_id, name, secret_enc, algorithm, status)
       VALUES ($1, $2, 'rotated-secret', $3, 'HS256', 'active')`,
      [newId, tenantId, secretEnc],
    );
  });

  return { id: newId, plaintextSecret };
}
