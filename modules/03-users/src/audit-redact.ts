/**
 * Defensive redaction helper for audit-log payloads built from user records.
 *
 * The current `users` table (migration 020) does NOT carry credential columns —
 * password hashes, TOTP secrets, recovery codes, and email/password reset
 * tokens all live in 01-auth's separate tables (oauth_identities,
 * user_credentials, totp_recovery_codes per modules/03-users/SKILL.md
 * § 5 Decisions captured). So today, `redactUserForAudit(row)` is a no-op for
 * every column in `users`.
 *
 * The helper exists for two reasons:
 *
 *   1. **Schema drift insurance.** If a future migration ever adds a
 *      credential column directly onto `users` (e.g. inlining a TOTP secret
 *      for a denormalised lookup), the helper drops it from the audit payload
 *      automatically — no audit-log call-site changes needed. The
 *      audit_log table is queryable by tenant admins; credential material
 *      MUST NEVER appear there even transiently.
 *
 *   2. **Drift detection.** The audit-writes test suite includes a single
 *      sweep test that asserts no audit row written by 03-users contains
 *      any of the names in `USER_AUDIT_REDACTED_FIELDS` as a key in
 *      `before` or `after`. Adding a credential column to `users` without
 *      updating this set will fail the sweep.
 *
 * If you add a new column to `users` that is in any sense credential-bearing,
 * add it to `USER_AUDIT_REDACTED_FIELDS` here AND surface the addition in the
 * G3.D § 17 entry of docs/11-observability.md.
 */

export const USER_AUDIT_REDACTED_FIELDS: ReadonlySet<string> = new Set([
  // Names that COULD plausibly land on `users` if 01-auth's tables are ever
  // partially denormalised. Listed here rather than waiting for the schema
  // change so the redaction sweep stays meaningful from day one.
  'password_hash',
  'mfa_secret',
  'mfa_recovery_codes_hash',
  'mfa_recovery_codes',
  'email_verification_token',
  'password_reset_token',
  'oidc_id_token',
  'oauth_refresh_token',
]);

/**
 * Strip any redacted-field keys from a user-derived row before stuffing it
 * into an audit_log before/after payload.
 *
 * The input is intentionally typed loosely so callers can pass either a
 * fully-typed `User` object or a partial snapshot built ad-hoc from changed
 * fields. Returns a fresh object — the caller's input is not mutated.
 */
export function redactUserForAudit(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (USER_AUDIT_REDACTED_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}
