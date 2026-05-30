// modules/20-data-rights/src/types.ts
// Module 20 S1 — type surface for downstream sessions.
//
// S1 is migrations + scaffold only. Service / route implementations land
// in S2 (export), S3 (erasure + DSR token), S4 (admin DSR queue),
// S5 (retention cron + UI), S6 (consent ledger surfaces).
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any
// AI SDK. data-rights is not part of the AI pipeline.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Consent ledger (migration 0101)
// ---------------------------------------------------------------------------

export const CONSENT_PURPOSES = ['data_processing', 'marketing', 'benchmarking'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const LAWFUL_BASES = [
  'consent',
  'legitimate_interest',
  'contract',
  'legal_obligation',
] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

export const ConsentEventSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  purpose: z.enum(CONSENT_PURPOSES),
  policyVersion: z.string().min(1),
  grantedAt: z.string().datetime().nullable(),
  withdrawnAt: z.string().datetime().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  lawfulBasis: z.enum(LAWFUL_BASES),
  createdAt: z.string().datetime(),
});

export type ConsentEvent = z.infer<typeof ConsentEventSchema>;

// ---------------------------------------------------------------------------
// DSR (data subject request) shapes — wired in S2+
// ---------------------------------------------------------------------------

export const DSR_PURPOSES = ['manage'] as const;
export type DsrPurpose = (typeof DSR_PURPOSES)[number];

/** Signed magic-link token claims (verified server-side; never trusted from client). */
export const DsrTokenClaimsSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  purpose: z.enum(DSR_PURPOSES),
  expiresAt: z.string().datetime(),
});
export type DsrTokenClaims = z.infer<typeof DsrTokenClaimsSchema>;

// ---------------------------------------------------------------------------
// Erasure receipt — returned to the admin DSR queue after S3 erasure runs.
// ---------------------------------------------------------------------------

export const ErasureReceiptSchema = z.object({
  userId: z.string().uuid(),
  erasedAt: z.string().datetime(),
  alreadyErased: z.boolean(),              // true if no-op (idempotent re-run)
  tombstone: z.object({ name: z.string(), email: z.string() }),
  attemptAnswersErased: z.number().int().nonnegative(),
  sessionsRedacted: z.number().int().nonnegative(),
  certificatesPreserved: z.number().int().nonnegative(),
});

export type ErasureReceipt = z.infer<typeof ErasureReceiptSchema>;

// ---------------------------------------------------------------------------
// Data export bundle — full DSAR package returned to the admin route.
// ---------------------------------------------------------------------------

export const DataExportBundleSchema = z.object({
  manifest: z.object({
    schemaVersion: z.literal(1),
    generatedAt: z.string(),
    userId: z.string().uuid(),
  }),
  profile: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
    createdAt: z.string(),
    erasedAt: z.string().nullable(),
  }),
  attempts: z.array(z.record(z.unknown())),
  answers: z.array(z.record(z.unknown())),
  certificates: z.array(z.record(z.unknown())),
  consents: z.array(z.record(z.unknown())),
  auditEvents: z.array(z.record(z.unknown())),
});

export type DataExportBundle = z.infer<typeof DataExportBundleSchema>;

// ---------------------------------------------------------------------------
// Erased-candidates list (admin compliance view) — wired in S3-display followup.
// ---------------------------------------------------------------------------

export interface ListErasedCandidatesOpts {
  /** ISO-8601 timestamp; only return candidates erased at or after this time. Default: 365d ago. */
  since?: string;
  /** UUID; only return candidates erased by this admin (audit_log.actor_user_id). */
  adminId?: string | null;
  /** 1–500; default 100. */
  limit?: number;
}

export interface ErasedCandidateRow {
  userId: string;
  erasedAt: string;
  erasedById: string | null;
  erasedByName: string | null;
  erasedByEmail: string | null;
  reason: string | null;
  attemptsKept: number;
  certsKept: number;
}
