/**
 * modules/13-notifications/src/webhooks/signature.ts
 *
 * HMAC-SHA256 signing + timing-safe verification for webhook payloads.
 *
 * Matches docs/03-api-contract.md:319-322 byte-for-byte:
 *   X-AssessIQ-Signature: sha256=<hex(HMAC-SHA256(body, secret))>
 *
 * V1 signs the body only, so a captured delivery can be replayed forever. V2
 * (sent alongside V1, V1 unchanged) binds a timestamp into the MAC:
 *   X-AssessIQ-Timestamp:    <unix seconds>
 *   X-AssessIQ-Signature-V2: sha256=<hex(HMAC-SHA256("<timestamp>.<body>", secret))>
 * Receivers verify V2 and reject timestamps outside +/-5 minutes.
 *
 * The `body` is the raw UTF-8 JSON string (never re-serialized).
 * The `secret` is the plaintext endpoint secret (decrypted from secret_enc).
 *
 * NEVER skip timing-safe comparison in tests — test mocks mirror the
 * production code path (per PHASE_3_KICKOFF.md anti-patterns list).
 */

import { hmacSha256Hex, timingSafeEqualStr } from '@assessiq/core';

/**
 * Sign a request body string with HMAC-SHA256.
 * Returns the value to use in the X-AssessIQ-Signature header:
 *   sha256=<lowercase hex>
 */
export function signPayload(body: string, secret: string): string {
  return `sha256=${hmacSha256Hex(secret, body)}`;
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

  return timingSafeEqualStr(expected, receivedSignature);
}

/** Receivers must reject timestamps older (or newer) than this. */
export const SIGNATURE_V2_TOLERANCE_SEC = 300;

/**
 * Sign "<timestamp>.<body>" — value of the X-AssessIQ-Signature-V2 header.
 * `timestamp` is the exact string sent in X-AssessIQ-Timestamp (unix seconds).
 */
export function signPayloadV2(body: string, secret: string, timestamp: string): string {
  return `sha256=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

/**
 * Verify X-AssessIQ-Signature-V2 (the reference implementation for receivers).
 * False when the timestamp is not unix seconds, is outside the tolerance
 * window (replay protection), or the MAC does not match (timing-safe compare).
 */
export function verifySignatureV2(
  body: string,
  secret: string,
  timestamp: string,
  receivedSignature: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > (opts.toleranceSec ?? SIGNATURE_V2_TOLERANCE_SEC)) {
    return false;
  }
  return timingSafeEqualStr(signPayloadV2(body, secret, timestamp), receivedSignature);
}
