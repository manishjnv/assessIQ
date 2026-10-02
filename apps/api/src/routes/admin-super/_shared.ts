// AssessIQ — apps/api/src/routes/admin-super/_shared.ts
// Moved verbatim from routes/admin-super.ts (E9 split).

import { streamLogger, ValidationError } from '@assessiq/core';
import { authChain } from '../../middleware/auth-chain.js';

export const log = streamLogger('app');

// ---------------------------------------------------------------------------
// Auth chains
// ---------------------------------------------------------------------------

// Gate: session must exist AND role must be 'super_admin'.
// requireAuth in require-auth.ts enforces totpVerified=true for super_admin
// unconditionally (MFA_REQUIRED override — see require-auth.ts).
export const superAdminOnly = authChain({ roles: ['super_admin'] });

// Fresh-MFA gate for mutating operations: TOTP must have occurred within 15min.
// This is in addition to the always-on totpVerified=true check above.
export const superAdminFreshMfa = authChain({
  roles: ['super_admin'],
  freshMfaWithinMinutes: 15,
});

export function parseLifecycleBody(body: unknown): { reason: string | undefined } {
  const b = (body ?? {}) as Record<string, unknown>;
  const reason = b['reason'];
  if (reason === undefined || reason === null) {
    return { reason: undefined };
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ValidationError('reason must be a non-empty string if provided', {
      details: { code: 'INVALID_REASON', received: reason },
    });
  }
  if (reason.length > 500) {
    throw new ValidationError('reason must be 500 characters or fewer', {
      details: { code: 'INVALID_REASON', maxLength: 500, received: reason.length },
    });
  }
  // Strip ASCII control characters (including NUL \x00) — these are valid in
  // jsonb columns but can crash downstream SIEM tooling and corrupt log
  // displays. Reasons are free-form human text; control chars never belong.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(reason)) {
    throw new ValidationError('reason contains disallowed control characters', {
      details: { code: 'INVALID_REASON', cause: 'control_chars' },
    });
  }
  return { reason: reason.trim() };
}
