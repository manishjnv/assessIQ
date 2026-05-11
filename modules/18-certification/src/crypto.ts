// AssessIQ — modules/18-certification/src/crypto.ts
//
// Phase 5 Session 2 — HMAC-SHA256 signing helpers for tamper-evident
// certificates. Stateless, deterministic, env-keyed.
//
// INVARIANT: secret is read from process.env.CERT_SIGNING_SECRET ONLY.
// No defaults, no dev fallback, no derivation from another secret.
// Rotating the secret invalidates all signatures — operationally documented
// in docs/14-credentialing.md.
//
// INVARIANT: signature compare uses crypto.timingSafeEqual on equal-length
// Buffers. Never `===`. Plan §15 trap #1 — `==` makes the verify badge a
// timing oracle.
//
// CLAUDE.md rule #1: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Tier } from './types.js';

/**
 * Env var holding the HMAC secret. Required in production AND in tests
 * (vitest.setup.ts sets it). No fallback by design.
 */
export const CERT_SIGNING_SECRET_ENV = 'CERT_SIGNING_SECRET';

/**
 * Canonical payload signed by HMAC. The set is fixed: changing it requires
 * a coordinated re-sign migration of every existing row.
 *
 * Fields are the immutable identity + display-snapshot fields stored on the
 * certificate row. Mutable counters (pdf_downloads etc.) and revocation
 * fields are deliberately excluded — they change post-issue, and including
 * them would force a re-sign on every counter bump.
 *
 * `tier` IS included even though it can change on upgrade: a tier upgrade
 * re-signs the row in the same transaction (see service.issueCertificate),
 * and the verify endpoint always recomputes against the row's current state,
 * so previously shared LinkedIn URLs continue to verify against the latest
 * signature. The credential_id and issued_at — the things a recruiter's URL
 * actually depends on — are preserved across upgrades.
 */
export interface CertificateSignaturePayload {
  id: string;
  tenant_id: string;
  candidate_id: string;
  attempt_id: string;
  template_key: string;
  credential_id: string;
  tier: Tier;
  display_name: string;
  course_title: string;
  level: string;
  issued_at: string;
}

/**
 * Read the HMAC secret from process.env. Throws if unset or empty.
 * Read at call time (not module load) so tests can set/unset the env
 * between cases. Production safety: there is no default — an unset
 * secret crashes issuance loudly rather than silently signing with a
 * predictable derived key.
 */
export function getCertSigningSecret(): string {
  const value = process.env[CERT_SIGNING_SECRET_ENV];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `${CERT_SIGNING_SECRET_ENV} env var is required for certificate signing — ` +
        'no default, no fallback (see modules/18-certification/SKILL.md)',
    );
  }
  return value;
}

/**
 * Canonical-serialize the payload: sort keys alphabetically, JSON.stringify
 * with no whitespace. Deterministic across Node processes and versions
 * because JSON.stringify in V8 preserves key insertion order when given
 * an object whose keys we explicitly inserted in sorted order.
 */
function canonicalize(payload: CertificateSignaturePayload): string {
  const source = payload as unknown as Record<string, unknown>;
  const sortedKeys = Object.keys(source).sort();
  const ordered: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    ordered[key] = source[key];
  }
  return JSON.stringify(ordered);
}

/**
 * Compute the HMAC-SHA256 hex digest of the canonical-serialized payload.
 * Always 64 lowercase hex characters.
 */
export function signCertificate(
  payload: CertificateSignaturePayload,
  secret: string,
): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('signCertificate: secret must be a non-empty string');
  }
  return createHmac('sha256', secret).update(canonicalize(payload)).digest('hex');
}

/**
 * Constant-time signature verification.
 *
 * Returns false (does not throw) on length mismatch, malformed hex,
 * or any other shape error — the caller should map false → red badge,
 * not a 5xx. Returns false (not throws) when the secret cannot be read
 * from env, so callers in non-fatal paths can degrade gracefully (the
 * verify-page route in Phase 5 Session 3 will still surface a server
 * error separately when the cert exists but cannot be verified).
 */
export function verifyCertificateSignature(
  payload: CertificateSignaturePayload,
  signature: string,
  secret: string,
): boolean {
  if (typeof signature !== 'string' || signature.length === 0) {
    return false;
  }
  let expectedHex: string;
  try {
    expectedHex = signCertificate(payload, secret);
  } catch {
    return false;
  }
  if (signature.length !== expectedHex.length) {
    return false;
  }
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expectedHex, 'hex');
  if (sigBuf.length === 0 || sigBuf.length !== expBuf.length) {
    return false;
  }
  return timingSafeEqual(sigBuf, expBuf);
}
