/**
 * modules/13-notifications/src/webhooks/crypto.ts
 *
 * AES-256-GCM encrypt/decrypt for webhook endpoint secrets.
 * Uses ASSESSIQ_MASTER_KEY (32-byte base64) from @assessiq/core config.
 *
 * Format: [12-byte IV][16-byte auth tag][ciphertext] — all concatenated
 * into a single Buffer stored as BYTEA in Postgres.
 *
 * Per CLAUDE.md rule #4: secrets stored encrypted at rest, plaintext
 * returned ONCE at create-time, never logged.
 */

import { sealTagMid, openTagMid } from '@assessiq/core/aes-gcm';

/**
 * Encrypt plaintext string to a Buffer suitable for BYTEA storage.
 * Layout: [IV (12)] [auth-tag (16)] [ciphertext (variable)]
 */
export function encrypt(plaintext: string): Buffer {
  return sealTagMid(plaintext);
}

/**
 * Decrypt a Buffer produced by encrypt() back to a plaintext string.
 * Throws if the auth tag doesn't match (tampered ciphertext).
 * Master-key rotation (E8): tries the current key, then ASSESSIQ_MASTER_KEY_PREVIOUS.
 */
export function decrypt(cipherBuffer: Buffer): string {
  return openTagMid(cipherBuffer).toString('utf8');
}
