// AssessIQ — modules/05-assessment-lifecycle invitation token primitives.
//
// PURE FUNCTIONS. No I/O, no clock, no DB. Token generation is local to this
// module rather than re-using 01-auth's session token because:
//   * 01-auth's session token has different shape concerns (cookie payload,
//     expiry encoding) and is not exported as a generic primitive.
//   * Invitation tokens are URL-safe single-use credentials embedded in email
//     bodies — they need to round-trip through a `?token=` query parameter
//     unchanged. base64url is mandatory; base64 is not URL-safe.
//
// Storage contract (per modules/05-assessment-lifecycle/SKILL.md § Decisions
// captured § "13-notifications Phase 1 scope"):
//   * Plaintext token: 32 bytes of CSPRNG, encoded as base64url (43 chars,
//     no padding). Lives ONLY in the email body. Never logged, never written
//     to a DB column.
//   * Hash: sha256 of plaintext, hex-encoded (64 chars). Stored in
//     `assessment_invitations.token_hash` with a UNIQUE constraint.
//   * Lookup at accept time: hash incoming `?token=<plaintext>`, SELECT by
//     token_hash. Constant-time comparison happens at the DB layer (the
//     UNIQUE index lookup is one row).
//
// TTL is owned by the service layer (defaults to 72 hours per SKILL.md);
// this module does not encode it.

import { createHash, randomBytes } from "node:crypto";

export interface InvitationToken {
  /**
   * URL-safe plaintext token. 32 bytes of CSPRNG, base64url-encoded.
   * Goes into the email body and the `?token=<plaintext>` accept URL only.
   * Never persist. Never log.
   */
  plaintext: string;

  /**
   * sha256(plaintext), hex-encoded. Stored in
   * assessment_invitations.token_hash. Safe to log.
   */
  hash: string;
}

/**
 * Generate a fresh invitation token. The plaintext is cryptographically
 * random and the hash is deterministic from the plaintext, so callers
 * holding both can verify the pair without re-hashing.
 */
export function generateInvitationToken(): InvitationToken {
  const plaintext = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(plaintext).digest("hex");
  return { plaintext, hash };
}

/**
 * Hash a plaintext token for lookup at accept time. Same algorithm as
 * generateInvitationToken so the hash matches the stored token_hash.
 */
export function hashInvitationToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Default invitation TTL — 72 hours from issuance. Service layer reads this
 * to compute `expires_at`. Pulled into a constant rather than scattered
 * literal so a future "configurable per tenant" change has one edit point.
 */
export const DEFAULT_INVITATION_TTL_HOURS = 72;
