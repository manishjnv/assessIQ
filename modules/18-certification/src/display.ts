// AssessIQ — modules/18-certification/src/display.ts
//
// Z-50: the organisation decides whether the word "Distinction" is shown.
// The tier STORED on the credential (and covered by the HMAC) never changes.
// Only a display copy is changed, at render time, AFTER any signature check.
// Use the returned copy for wording only (PDF, verify page, share preview,
// candidate list). Never sign, verify or persist it.

import { getCertificateShowDistinction } from '@assessiq/tenancy';
import type { Tier } from './types.js';

/** Pure: below the switch a distinction reads as completion. Other tiers pass through. */
export function applyDistinctionSetting<T extends { tier: Tier }>(cert: T, showDistinction: boolean): T {
  return cert.tier === 'distinction' && !showDistinction ? { ...cert, tier: 'completion' } : cert;
}

/** Reads the tenant switch (default off) and returns the display copy. */
export async function certForDisplay<T extends { tier: Tier; tenant_id: string }>(cert: T): Promise<T> {
  if (cert.tier !== 'distinction') return cert;
  return applyDistinctionSetting(cert, await getCertificateShowDistinction(cert.tenant_id));
}

/** X3a: expiry state from the optional valid_until. Display-only; the signature never covers it. */
export type ExpiryState =
  | { kind: 'none' }
  | { kind: 'expired'; date: string }
  | { kind: 'until'; date: string };

const IST_OFFSET_MS = 330 * 60_000; // Asia/Kolkata has no DST, so a fixed offset is exact.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The Indian calendar day of an instant, e.g. "9 Nov 2026". */
function istDay(t: number): string {
  const d = new Date(t + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Pure. NULL (or an unreadable date) shows nothing. Decision is by instant (UTC);
 * the shown date is the Indian calendar day, e.g. "9 Nov 2026".
 */
export function expiryState(validUntil: string | null | undefined, now: Date = new Date()): ExpiryState {
  if (validUntil === null || validUntil === undefined) return { kind: 'none' };
  const t = Date.parse(validUntil);
  if (Number.isNaN(t)) return { kind: 'none' };
  const date = istDay(t);
  return t <= now.getTime() ? { kind: 'expired', date } : { kind: 'until', date };
}
