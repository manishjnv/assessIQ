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

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '@assessiq/core';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96-bit IV is recommended for GCM
const TAG_LENGTH = 16;  // 128-bit auth tag

function getMasterKey(): Buffer {
  return Buffer.from(config.ASSESSIQ_MASTER_KEY, 'base64');
}

/**
 * Encrypt plaintext string to a Buffer suitable for BYTEA storage.
 * Layout: [IV (12)] [auth-tag (16)] [ciphertext (variable)]
 */
export function encrypt(plaintext: string): Buffer {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a Buffer produced by encrypt() back to a plaintext string.
 * Throws if the auth tag doesn't match (tampered ciphertext).
 */
export function decrypt(cipherBuffer: Buffer): string {
  const key = getMasterKey();
  const iv = cipherBuffer.subarray(0, IV_LENGTH);
  const authTag = cipherBuffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = cipherBuffer.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
