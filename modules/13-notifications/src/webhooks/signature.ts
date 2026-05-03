/**
 * modules/13-notifications/src/webhooks/signature.ts
 *
 * HMAC-SHA256 signing + timing-safe verification for webhook payloads.
 *
 * Matches docs/03-api-contract.md:319-322 byte-for-byte:
 *   X-AssessIQ-Signature: sha256=<hex(HMAC-SHA256(body, secret))>
 *
 * The `body` is the raw UTF-8 JSON string (never re-serialized).
 * The `secret` is the plaintext endpoint secret (decrypted from secret_enc).
 *
 * NEVER skip timing-safe comparison in tests — test mocks mirror the
 * production code path (per PHASE_3_KICKOFF.md anti-patterns list).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sign a request body string with HMAC-SHA256.
 * Returns the value to use in the X-AssessIQ-Signature header:
 *   sha256=<lowercase hex>
 */
export function signPayload(body: string, secret: string): string {
  const mac = createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('hex');
  return `sha256=${mac}`;
}

/**
 * Verify an X-AssessIQ-Signature header value against a body + secret.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * Returns true only if the signature is exactly correct.
 */
export function verifySignature(
  body: string,
  secret: string,
  receivedSignature: string,
): boolean {
  const expected = signPayload(body, secret);

  // Convert to Buffers for timing-safe comparison.
  // Both must be the same length — `sha256=` prefix + 64 hex chars = 71 chars.
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(receivedSignature, 'utf8');

  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, receivedBuf);
}
