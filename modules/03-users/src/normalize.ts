/**
 * Per addendum § 10. Single source of truth for user email canonicalization.
 * 01-auth Google SSO callback also calls this — see § 10 carry-forward.
 *
 * All write paths (createUser, updateUser, inviteUser, bulkImport, acceptInvitation)
 * MUST call normalizeEmail before any DB write or lookup. The DB UNIQUE(tenant_id, email)
 * constraint enforces the lowercase-at-write convention at the Postgres level.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
