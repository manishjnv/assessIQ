/**
 * computeMfaStatus — the whoami mfaStatus decision.
 *
 * Pins Defect #3 of the 2026-05-17 super-admin first-login MFA lockout RCA:
 * a pre-TOTP super_admin MUST report 'pending' even when MFA_REQUIRED=false,
 * so the SPA routes it to /admin/mfa instead of the dashboard (where every
 * cross-tenant action would then 401). admin/reviewer behaviour is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { computeMfaStatus } from '../../routes/auth/whoami.js';

describe('computeMfaStatus', () => {
  // --- super_admin is always-MFA regardless of MFA_REQUIRED ---------------
  it('pre-TOTP super_admin, MFA_REQUIRED=false → pending (routes to /admin/mfa)', () => {
    expect(computeMfaStatus('super_admin', false, false)).toBe('pending');
  });
  it('verified super_admin, MFA_REQUIRED=false → verified', () => {
    expect(computeMfaStatus('super_admin', true, false)).toBe('verified');
  });
  it('pre-TOTP super_admin, MFA_REQUIRED=true → pending', () => {
    expect(computeMfaStatus('super_admin', false, true)).toBe('pending');
  });

  // --- admin/reviewer: existing opt-in behaviour unchanged ---------------
  it('pre-TOTP admin, MFA_REQUIRED=false → verified (no MFA round-trip)', () => {
    expect(computeMfaStatus('admin', false, false)).toBe('verified');
  });
  it('pre-TOTP admin, MFA_REQUIRED=true → pending', () => {
    expect(computeMfaStatus('admin', false, true)).toBe('pending');
  });
  it('verified reviewer, MFA_REQUIRED=true → verified', () => {
    expect(computeMfaStatus('reviewer', true, true)).toBe('verified');
  });
});
