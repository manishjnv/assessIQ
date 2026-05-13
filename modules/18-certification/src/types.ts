// AssessIQ — modules/18-certification/src/types.ts
//
// Phase 5 Session 1 — type definitions for the certification module.
//
// Design decisions captured here (see also SKILL.md for full rationale):
//
//   1. PK is UUID (gen_random_uuid()) — consistent with every other AssessIQ
//      domain table. The plan's "int PK" is project-agnostic; AssessIQ uses
//      UUID v7-style PKs per docs/02-data-model.md conventions.
//
//   2. `attempt_id` replaces the plan's `enrollment_id`.
//      An `attempt` is the concrete "completed thing" in AssessIQ — it holds the
//      full lifecycle (draft → submitted → graded → released) and is already
//      tenant-scoped via its assessment_id FK. There is no separate
//      `enrollment` or `assessment_cycle` entity; `assessments` is the cycle
//      concept and `attempts` is the enrollment+completion entity.
//      UNIQUE(tenant_id, candidate_id, attempt_id) gives per-attempt idempotence.
//
//   3. `candidate_id` replaces the plan's `user_id` — matches 03-users naming
//      convention (users.role = 'candidate').
//
//   4. Tier enum matches AssessIQ's banded scoring philosophy: completion (≥90%),
//      distinction (100% + ≥80% repos), honors (distinction + AI eval ≥8.0).
//      TIER_ORDER enforces "only upgrade" invariant (plan §1.3).
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.
// Certification is deterministic credential issuance only. CLAUDE.md rule #1.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tier enum + ordering
// ---------------------------------------------------------------------------

/** The three certification tiers, in ascending order of merit. */
export type Tier = 'completion' | 'distinction' | 'honors';

/**
 * TIER_ORDER — monotonic ordering for tier upgrade enforcement.
 * Rule: an issued certificate may only be upgraded (higher ordinal), never
 * downgraded. See plan §1.3 and test_tier_no_downgrade in __tests__/types.test.ts.
 */
export const TIER_ORDER: Record<Tier, number> = {
  completion: 1,
  distinction: 2,
  honors: 3,
};

export const TierSchema = z.enum(['completion', 'distinction', 'honors']);

// ---------------------------------------------------------------------------
// Credential ID
// ---------------------------------------------------------------------------

/**
 * Public-facing credential slug format: PREFIX-YYYY-MM-XXXXXX
 *   PREFIX  = 2–4 uppercase letters (e.g. "AIQ")
 *   YYYY-MM = year and month of issuance
 *   XXXXXX  = 6 chars from [A-Z0-9], CSPRNG-generated
 *
 * Used in QR codes, verify URLs, and LinkedIn share links.
 * DB UNIQUE constraint is the collision guard; generation retries on conflict
 * (max 3 attempts). Stored uppercase; lookup normalises to upper.
 */
export type CredentialId = string;

export const CREDENTIAL_ID_REGEX = /^[A-Z]{2,4}-\d{4}-\d{2}-[A-Z0-9]{6}$/;

export const CredentialIdSchema = z
  .string()
  .regex(CREDENTIAL_ID_REGEX, 'credential_id must match PREFIX-YYYY-MM-XXXXXX format');

// ---------------------------------------------------------------------------
// Certificate row (mirrors migration 0046_certification_init.sql)
// ---------------------------------------------------------------------------

/**
 * Certificate — snapshotted point-in-time credential record.
 *
 * Fields are frozen at issuance. Profile changes after issuance do NOT
 * retro-update an issued certificate (plan §1.1 "snapshot" rule).
 *
 * Tier upgrades update `tier` + snapshot counters in place but MUST preserve
 * `credential_id` and `issued_at` so previously shared LinkedIn URLs remain valid.
 */
export interface Certificate {
  /** UUID primary key. */
  id: string;

  /** Tenant owning this certificate. Multi-tenancy hard rule — never nullable. */
  tenant_id: string;

  /**
   * The attempt this certificate is issued for.
   * Replaces plan's `enrollment_id`. See design decision #2 above.
   * UNIQUE(tenant_id, candidate_id, attempt_id) enforces one cert per attempt.
   */
  attempt_id: string;

  /**
   * The candidate who earned this certificate.
   * Replaces plan's `user_id`. Matches 03-users naming convention.
   */
  candidate_id: string;

  /** Template key (denormalised — survives template renames). */
  template_key: string;

  /**
   * Public-facing credential slug (PREFIX-YYYY-MM-XXXXXX).
   * Unique across the entire table (not tenant-scoped — globally unique slug).
   */
  credential_id: CredentialId;

  /** Tier at time of last upgrade. One of completion | distinction | honors. */
  tier: Tier;

  /** Candidate's display name snapshotted at issuance. */
  display_name: string;

  /** Assessment/course title snapshotted at issuance. */
  course_title: string;

  /** Level label snapshotted at issuance (e.g. "L1", "Foundation"). */
  level: string;

  /** HMAC-SHA256 hex digest for tamper-evidence. See plan §3 for payload spec. */
  signed_hash: string;

  /** UTC timestamp set once at first issuance. Preserved through tier upgrades. */
  issued_at: string; // ISO 8601

  /** Set when an admin revokes the certificate. Null if not revoked. */
  revoked_at: string | null; // ISO 8601 or null

  /** Reason for revocation. Null if not revoked. */
  revoke_reason: string | null;

  /** Counter: number of PDF downloads. Increment with UPDATE … = pdf_downloads + 1. */
  pdf_downloads: number;

  /** Counter: number of LinkedIn shares. */
  linkedin_shares: number;

  /** Counter: number of verify-page views (deduped per IP per 1h window). */
  verification_views: number;

  /** Row creation timestamp. */
  created_at: string; // ISO 8601

  /** Row last-update timestamp. */
  updated_at: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Zod schemas (for route validation and service input)
// ---------------------------------------------------------------------------

export const IssueCertificateInputSchema = z.object({
  tenant_id: z.string().uuid(),
  attempt_id: z.string().uuid(),
  candidate_id: z.string().uuid(),
  template_key: z.string().min(1),
  display_name: z.string().min(1),
  course_title: z.string().min(1),
  level: z.string().min(1),
  tier: TierSchema,
  /** UUID of the admin issuing the cert — recorded on the audit_log row. */
  actor_user_id: z.string().uuid(),
});

export type IssueCertificateInput = z.infer<typeof IssueCertificateInputSchema>;

export const RevokeCertificateInputSchema = z.object({
  revoke_reason: z.string().min(1).max(1000),
});

export type RevokeCertificateInput = z.infer<typeof RevokeCertificateInputSchema>;

export const ListCertificatesQuerySchema = z.object({
  candidate_id: z.string().uuid().optional(),
  tier: TierSchema.optional(),
  revoked: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListCertificatesQuery = z.infer<typeof ListCertificatesQuerySchema>;

// ---------------------------------------------------------------------------
// Reissue input schema
// ---------------------------------------------------------------------------

export const ReissueCertificateInputSchema = z.object({
  display_name: z.string().min(1).max(500).optional(),
});
export type ReissueCertificateInput = z.infer<typeof ReissueCertificateInputSchema>;

// ---------------------------------------------------------------------------
// View shapes (enriched responses)
// ---------------------------------------------------------------------------

/** Response shape for GET /api/certificates (candidate "My Certificates" view). */
export interface MyCertificateView extends Certificate {
  /** true if the stored signed_hash validates against the canonical payload. */
  signed_hash_valid: boolean;
  /** Public verify URL: /verify/<credential_id> */
  verify_url: string;
  /** PDF download URL: /api/certificates/<credential_id>/pdf */
  pdf_url: string;
}

/** Response shape for GET /api/admin/certificates (admin list with user email). */
export interface CertificateAdminView extends Certificate {
  user_email: string | null;
}

// ---------------------------------------------------------------------------
// Domain errors — thrown by service, caught by route handlers
// ---------------------------------------------------------------------------

export class CertificateNotFoundError extends Error {
  constructor(credentialId: string) {
    super(`Certificate not found: ${credentialId}`);
    this.name = 'CertificateNotFoundError';
  }
}

export class CertificateAlreadyRevokedError extends Error {
  constructor(credentialId: string, existingReason: string | null) {
    super(`Certificate ${credentialId} is already revoked: ${existingReason ?? '(no reason)'}`);
    this.name = 'CertificateAlreadyRevokedError';
  }
}

export class CertificateRevokedException extends Error {
  constructor(credentialId: string) {
    super(`Certificate ${credentialId} is revoked and cannot be reissued (issue a new cert)`);
    this.name = 'CertificateRevokedException';
  }
}

export class CertificateAccessDeniedError extends Error {
  constructor(credentialId: string) {
    super(`Access denied to certificate ${credentialId}`);
    this.name = 'CertificateAccessDeniedError';
  }
}
