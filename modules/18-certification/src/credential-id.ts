// AssessIQ — modules/18-certification/src/credential-id.ts
//
// Phase 5 Session 2 — credential_id slug generation.
//
// Format: PREFIX-YYYY-MM-XXXXXX
//   PREFIX  = 2–4 uppercase letters (default "AIQ")
//   YYYY-MM = UTC year + month at issuance
//   XXXXXX  = 6 chars from [A-Z0-9], drawn via CSPRNG (crypto.randomInt)
//
// 36^6 ≈ 2.18B suffixes per (prefix, year-month). DB UNIQUE(credential_id)
// is the actual collision guard; the service layer retries on conflict.
//
// INVARIANT: NEVER Math.random. Always crypto.randomInt(0, 36). The slug
// is part of the credential's identity — a non-CSPRNG draw makes collisions
// predictable.
//
// CLAUDE.md rule #1: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { randomInt } from 'node:crypto';

import { CREDENTIAL_ID_REGEX } from './types.js';

/**
 * Default issuer prefix. AssessIQ-wide platform issuer.
 * Tenant-scoped prefixes are deferred to Phase 5 Session 6 (admin reissue).
 */
export const DEFAULT_CREDENTIAL_PREFIX = 'AIQ';

/**
 * Crockford-style 32-character alphabet used for the random suffix.
 *
 * Excludes visually ambiguous characters I, L, O, U so credential IDs
 * transcribed by hand from a printed certificate or a LinkedIn URL are
 * unambiguous. Based on the Crockford Base32 reference shape
 * (https://www.crockford.com/base32.html) with U additionally excluded
 * because it creates no ambiguity concern and avoids accidentally spelling
 * profanities.
 *
 * 32^6 ≈ 1.07 billion suffixes per (prefix, year-month). Still far exceeds
 * the expected issuance volume; the DB UNIQUE(credential_id) constraint is
 * the actual collision guard.
 *
 * MIGRATION NOTE: Existing certificates use the 36-char [A-Z0-9] alphabet.
 * There are no production certs at the time of this change (Phase 5
 * Session 2, pre-deploy). The CREDENTIAL_ID_REGEX still accepts all
 * uppercase letters + digits, so old-alphabet IDs remain valid (no data
 * migration needed). New issuances will never include I, L, O, U in the
 * suffix.
 */
const CHARSET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 chars — Crockford-style, no I/L/O/U

/** Prefix shape: 2–4 uppercase ASCII letters. */
const PREFIX_REGEX = /^[A-Z]{2,4}$/;

/** Length of the random suffix (chars). */
const SUFFIX_LENGTH = 6;

/**
 * Generate a credential_id of the form PREFIX-YYYY-MM-XXXXXX.
 *
 * Each call draws a fresh 6-character suffix from the CSPRNG. Two calls in
 * the same millisecond produce different suffixes with overwhelming
 * probability — the DB UNIQUE constraint is the final tie-breaker and the
 * caller (service.issueCertificate) retries on UNIQUE violation.
 *
 * @param prefix Issuer prefix; 2–4 uppercase letters. Throws otherwise.
 * @param now    Time used for the YYYY-MM stamp. Defaults to current time.
 */
export function generateCredentialId(
  prefix: string = DEFAULT_CREDENTIAL_PREFIX,
  now: Date = new Date(),
): string {
  if (!PREFIX_REGEX.test(prefix)) {
    throw new Error(
      `generateCredentialId: prefix must match /^[A-Z]{2,4}$/, got "${prefix}"`,
    );
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('generateCredentialId: now must be a valid Date');
  }
  const year = String(now.getUTCFullYear()).padStart(4, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');

  let suffix = '';
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    suffix += CHARSET[randomInt(0, CHARSET.length)];
  }
  return `${prefix}-${year}-${month}-${suffix}`;
}

/**
 * Validate a credential_id string against the canonical regex.
 * Defers to the regex constant in types.ts (single source of truth).
 */
export function isValidCredentialId(s: string): boolean {
  return typeof s === 'string' && CREDENTIAL_ID_REGEX.test(s);
}
