// modules/01-auth/src/totp.ts
//
// TOTP enrollment, verify, recovery codes, and account lockout.
//
// Spec: modules/01-auth/SKILL.md § Decisions captured §§ 2, 3, 4.
// 20-byte SHA-1 secret per RFC 4226 §4 (the older PLAN doc said 32 bytes;
// the addendum overrides — 20 bytes is what every consumer authenticator
// app speaks fluently).
//
// Anti-patterns refused (CLAUDE.md):
//   - String === or library default comparison on TOTP codes — always
//     crypto.timingSafeEqual via constantTimeEqual.
//   - Logging plaintext secret, otpauth URI, or recovery codes.
//   - Skipping the lockout check on the verify path.

import { randomBytes } from "node:crypto";
import { uuidv7 } from "@assessiq/core";
import { ValidationError, AuthnError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import * as argon2 from "argon2";
import { authenticator as _authenticatorBase } from "@otplib/preset-default";
import { totpEpochAvailable, totpToken, HashAlgorithms, KeyEncodings } from "@otplib/core";
import type { AuthenticatorOptions } from "@otplib/core";
import { encryptEnvelope, decryptEnvelope, constantTimeEqual } from "./crypto-util.js";
import { getRedis } from "./redis.js";
import { audit } from "@assessiq/audit-log";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const ENROLL_KEY = (userId: string): string => `aiq:totp:enroll:${userId}`;
const ENROLL_TTL = 600; // 10 minutes

const FAIL_KEY = (userId: string): string => `aiq:auth:totpfail:${userId}`;
const LOCKED_KEY = (userId: string): string => `aiq:auth:lockedout:${userId}`;
const FAIL_TTL = 900; // 15 minutes
const MAX_FAILS = 5;

// Recovery code alphabet: Crockford base32 minus I/L/O/U.
// 256 % 32 === 0 — no modular bias.
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Argon2id parameters per OWASP 2024 recommendation for password-equivalent secrets.
const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

// Configured authenticator instance — SHA-1 + latin1 encoding + 30s + 6-digit + ±1 window.
// algorithm: HashAlgorithms.SHA1 → "sha1" (enum, required by type)
// encoding: KeyEncodings.LATIN1 → raw bytes (binary) encoding; base32 encode/decode
//           is handled transparently by the authenticator's keyEncoder/keyDecoder plugins
//           (plugin-thirty-two), not by the `encoding` option itself.
// We fix the options once so all calls share the same configuration.
const AUTH_OPTS: Partial<AuthenticatorOptions<string>> = {
  algorithm: HashAlgorithms.SHA1,
  encoding: KeyEncodings.LATIN1,
  step: 30,
  digits: 6,
  window: 1,
};
const authenticator = _authenticatorBase.clone(AUTH_OPTS);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnrollStartOutput {
  otpauthUri: string;
  secretBase32: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateRecoveryCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += RECOVERY_ALPHABET[bytes[i]! & 0x1f]!;
  return out;
}

async function hashRecoveryCode(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTS);
}

/** Generate 10 recovery codes, hash them all, return plaintext + hashes. */
async function generateRecoveryCodes(): Promise<{ plaintexts: string[]; hashes: string[] }> {
  const plaintexts = Array.from({ length: 10 }, () => generateRecoveryCode());
  const hashes = await Promise.all(plaintexts.map(hashRecoveryCode));
  return { plaintexts, hashes };
}

/**
 * Insert 10 recovery code rows in a single multi-value INSERT.
 * Must be called within a withTenant callback (client already has RLS context).
 * Does NOT delete old codes — caller must DELETE first if regenerating.
 */
async function insertRecoveryCodes(
  client: import("pg").PoolClient,
  userId: string,
  tenantId: string,
  hashes: string[],
): Promise<void> {
  // Build parameterised multi-row INSERT.
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let idx = 1;
  for (const hash of hashes) {
    const id = uuidv7();
    placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++})`);
    values.push(id, tenantId, userId, hash);
  }
  await client.query(
    `INSERT INTO totp_recovery_codes (id, tenant_id, user_id, code_hash)
     VALUES ${placeholders.join(", ")}`,
    values,
  );
}

/** Increment fail counter and set lockout if threshold reached.
 * Returns { wasLocked: true } on the exact call that triggers lockout.
 */
async function recordFailure(userId: string): Promise<{ wasLocked: boolean }> {
  const redis = getRedis();
  const count = await redis.incr(FAIL_KEY(userId));
  // Set the 15-min window TTL only on the first failure (NX flag).
  if (count === 1) {
    await redis.expire(FAIL_KEY(userId), FAIL_TTL, "NX");
  }
  if (count >= MAX_FAILS) {
    await redis.set(LOCKED_KEY(userId), "1", "EX", FAIL_TTL);
    // Only the exact triggering call (count === MAX_FAILS) returns wasLocked.
    return { wasLocked: count === MAX_FAILS };
  }
  return { wasLocked: false };
}

/** Throw AuthnError if the user account is locked out. */
async function assertNotLocked(userId: string): Promise<void> {
  const redis = getRedis();
  const locked = await redis.exists(LOCKED_KEY(userId));
  if (locked === 1) {
    throw new AuthnError("account locked");
  }
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

async function enrollStart(
  userId: string,
  tenantId: string,
  email: string,
): Promise<EnrollStartOutput> {
  // 20-byte secret per RFC 4226 §4.
  const secretBytes = randomBytes(20);

  // Base32-encode using the authenticator's encoder.
  const secretBase32 = authenticator.encode(secretBytes.toString("binary"));

  // Encrypt the raw bytes for Redis staging.
  const envelope = encryptEnvelope(secretBytes);

  // Stage in Redis with 10-min TTL.
  const redis = getRedis();
  await redis.set(ENROLL_KEY(userId), envelope.toString("base64"), "EX", ENROLL_TTL);

  // Build otpauth URI per SKILL.md § 3.
  const otpauthUri =
    `otpauth://totp/AssessIQ:${encodeURIComponent(email)}` +
    `?secret=${secretBase32}&issuer=AssessIQ&period=30&digits=6&algorithm=SHA1`;

  return { otpauthUri, secretBase32 };
}

// ---------------------------------------------------------------------------
// Enroll confirm
// ---------------------------------------------------------------------------

async function enrollConfirm(
  userId: string,
  tenantId: string,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const redis = getRedis();

  // Read the staged envelope.
  const raw = await redis.get(ENROLL_KEY(userId));
  if (raw === null) {
    throw new ValidationError("totp enrollment not started or expired");
  }

  const envelope = Buffer.from(raw, "base64");
  const secretBytes = decryptEnvelope(envelope);
  // The base32 form is what the authenticator app sees (otpauth URI). Round-tripping
  // through @otplib's keyDecoder normalizes the bytes into the post-decode form the
  // app actually HMACs against — important because @otplib's encoder is lossy on
  // bytes with the high bit set, so raw-bytes HMAC and app HMAC disagree otherwise.
  const secretBase32 = authenticator.encode(secretBytes.toString("binary"));
  const opts = authenticator.allOptions();
  const decodedSecret = opts.keyDecoder(secretBase32, opts.encoding);

  // Verify the supplied code using constant-time comparison (see verify path below).
  // For enrollConfirm we still gate on code correctness before persisting.
  const epochData = totpEpochAvailable(Date.now(), opts.step, opts.window);
  const epochs = [
    epochData.current,
    ...epochData.past,
    ...epochData.future,
  ];

  let matched = false;
  for (const epoch of epochs) {
    const expected = totpToken(decodedSecret, { ...opts, epoch });
    if (
      code.length === expected.length &&
      constantTimeEqual(Buffer.from(code), Buffer.from(expected))
    ) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    // Do NOT consume the staging key — allow retry.
    throw new ValidationError("invalid totp code");
  }

  // Persist to user_credentials (UPSERT for idempotent re-enrollment).
  // Generate recovery codes before the DB write so a hash failure aborts cleanly.
  const { plaintexts, hashes } = await generateRecoveryCodes();

  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO user_credentials (user_id, tenant_id, totp_secret_enc, totp_enrolled_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE
         SET totp_secret_enc  = EXCLUDED.totp_secret_enc,
             totp_enrolled_at = now()`,
      [userId, tenantId, envelope],
    );

    // Delete any existing recovery codes, then insert fresh ones.
    await client.query(
      `DELETE FROM totp_recovery_codes WHERE user_id = $1`,
      [userId],
    );
    await insertRecoveryCodes(client, userId, tenantId, hashes);
  });

  // Delete the staging key — enrollment is complete.
  await redis.del(ENROLL_KEY(userId));

  return { recoveryCodes: plaintexts };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

async function verify(
  userId: string,
  tenantId: string,
  code: string,
): Promise<boolean> {
  // Lockout check first — cheap EXISTS before any crypto.
  await assertNotLocked(userId);

  // Fetch the encrypted secret.
  const row = await withTenant(tenantId, async (client) => {
    const result = await client.query<{ totp_secret_enc: Buffer | null }>(
      `SELECT totp_secret_enc FROM user_credentials WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  });

  if (row === null || row.totp_secret_enc === null) {
    throw new ValidationError("totp not enrolled");
  }

  const secretBytes = decryptEnvelope(
    Buffer.isBuffer(row.totp_secret_enc)
      ? row.totp_secret_enc
      : Buffer.from(row.totp_secret_enc as unknown as string, "hex"),
  );
  // See note in enrollConfirm — round-trip through encode + keyDecoder so we
  // HMAC the same bytes the user's authenticator app does.
  const secretBase32 = authenticator.encode(secretBytes.toString("binary"));
  const opts = authenticator.allOptions();
  const decodedSecret = opts.keyDecoder(secretBase32, opts.encoding);

  // Generate expected codes for current ±1 steps and compare via constantTimeEqual.
  // NEVER use === on TOTP tokens (timing leak).
  const epochData = totpEpochAvailable(Date.now(), opts.step, opts.window);
  const epochs = [
    epochData.current,
    ...epochData.past,
    ...epochData.future,
  ];

  let matched = false;
  for (const epoch of epochs) {
    const expected = totpToken(decodedSecret, { ...opts, epoch });
    if (
      code.length === expected.length &&
      constantTimeEqual(Buffer.from(code), Buffer.from(expected))
    ) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    const { wasLocked } = await recordFailure(userId);
    // G3.A audit hook: failed TOTP attempt.
    await audit({
      tenantId,
      actorKind: "user",
      actorUserId: userId,
      action: "auth.login.totp_failed",
      entityType: "user",
      entityId: userId,
    });
    // G3.A audit hook: lockout triggered (only on the exact triggering call).
    if (wasLocked) {
      await audit({
        tenantId,
        actorKind: "system",
        action: "auth.login.locked",
        entityType: "user",
        entityId: userId,
      });
    }
    return false;
  }

  // Success: clear fail counter, update last-used timestamp (fire-and-forget).
  const redis = getRedis();
  await redis.del(FAIL_KEY(userId));

  withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE user_credentials SET totp_last_used_at = now() WHERE user_id = $1`,
      [userId],
    );
  }).catch(() => {
    // Best-effort — last_used_at is an audit field, not a security invariant.
  });

  // G3.A audit hook: successful TOTP login.
  await audit({
    tenantId,
    actorKind: "user",
    actorUserId: userId,
    action: "auth.login.totp_success",
    entityType: "user",
    entityId: userId,
  });

  return true;
}

// ---------------------------------------------------------------------------
// Consume recovery code
// ---------------------------------------------------------------------------

async function consumeRecovery(
  userId: string,
  tenantId: string,
  code: string,
): Promise<boolean> {
  // Lockout check — same gate as verify.
  await assertNotLocked(userId);

  // Fetch all unused recovery code rows.
  interface RecoveryRow {
    id: string;
    code_hash: string;
  }

  const rows = await withTenant(tenantId, async (client) => {
    const result = await client.query<RecoveryRow>(
      `SELECT id, code_hash FROM totp_recovery_codes
       WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    return result.rows;
  });

  for (const row of rows) {
    const matches = await argon2.verify(row.code_hash, code);
    if (!matches) continue;

    // Atomic consume via UPDATE … RETURNING — race-safe single-use enforcement.
    const consumed = await withTenant(tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE totp_recovery_codes
         SET used_at = now()
         WHERE id = $1 AND used_at IS NULL
         RETURNING id`,
        [row.id],
      );
      return result.rows.length > 0;
    });

    if (!consumed) {
      // Race lost — another concurrent consume beat us. Try next row.
      continue;
    }

    // Success: clear fail counter.
    const redis = getRedis();
    await redis.del(FAIL_KEY(userId));
    return true;
  }

  // No matching unused code found.
  await recordFailure(userId);
  return false;
}

// ---------------------------------------------------------------------------
// Regenerate recovery codes
// ---------------------------------------------------------------------------

async function regenerateRecoveryCodes(
  userId: string,
  tenantId: string,
): Promise<{ recoveryCodes: string[] }> {
  const { plaintexts, hashes } = await generateRecoveryCodes();

  await withTenant(tenantId, async (client) => {
    await client.query(
      `DELETE FROM totp_recovery_codes WHERE user_id = $1`,
      [userId],
    );
    await insertRecoveryCodes(client, userId, tenantId, hashes);
  });

  return { recoveryCodes: plaintexts };
}

// ---------------------------------------------------------------------------
// Admin TOTP reset (G3.A hook site 4)
// ---------------------------------------------------------------------------

/**
 * Force-revoke a user's TOTP enrollment — admin action.
 * Clears totp_secret_enc + all recovery codes, requiring the user to re-enroll.
 * Emits `auth.totp.reset` audit event.
 *
 * Called by: POST /api/admin/users/:id/totp/reset (fresh-MFA gated at route layer).
 */
async function adminResetTotp(
  adminUserId: string,
  tenantId: string,
  targetUserId: string,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    // Clear the TOTP secret.
    await client.query(
      `UPDATE user_credentials
       SET totp_secret_enc = NULL, totp_enrolled_at = NULL, totp_last_used_at = NULL
       WHERE user_id = $1`,
      [targetUserId],
    );
    // Purge all recovery codes.
    await client.query(
      `DELETE FROM totp_recovery_codes WHERE user_id = $1`,
      [targetUserId],
    );
  });

  // G3.A audit hook: admin forced a TOTP reset.
  await audit({
    tenantId,
    actorKind: "user",
    actorUserId: adminUserId,
    action: "auth.totp.reset",
    entityType: "user",
    entityId: targetUserId,
  });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const totp = {
  enrollStart,
  enrollConfirm,
  verify,
  consumeRecovery,
  regenerateRecoveryCodes,
  adminResetTotp,
};
