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
  tombstone: z.object({
    name: z.string(),
    email: z.string(),
  }),
  attemptResponsesErased: z.number().int().nonnegative(),
  attemptEventsRedacted: z.number().int().nonnegative(),
  certificatesPreserved: z.number().int().nonnegative(),
});

export type ErasureReceipt = z.infer<typeof ErasureReceiptSchema>;
