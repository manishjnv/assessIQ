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
