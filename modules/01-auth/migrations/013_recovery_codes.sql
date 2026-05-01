-- owned by modules/01-auth
--
-- What this table represents:
--   totp_recovery_codes stores one-time backup codes that let an admin user
--   bypass TOTP when their authenticator is unavailable. Each row holds the
--   argon2id digest of a single 8-character Crockford base32 code (alphabet
--   0123456789ABCDEFGHJKMNPQRSTVWXYZ — deliberately excludes I, L, O, U to
--   eliminate the print-and-photograph readability traps of O/0 and I/1/L).
--   10 codes are generated per user; the plaintext set is shown exactly once
--   at generation time and never stored or returned again.
--
-- Why the partial index (used_at IS NULL):
--   Single-use enforcement is implemented as an atomic UPDATE … RETURNING:
--
--     UPDATE totp_recovery_codes
--        SET used_at = now()
--      WHERE id = $1
--        AND used_at IS NULL
--     RETURNING id;
--
--   This returns the row's id only when the row was previously unused; if
--   used_at is already set (replay attempt) the UPDATE matches zero rows and
--   RETURNING returns nothing — atomically, with no race window and no
--   separate SELECT-then-UPDATE round-trip. The partial index on
--   (user_id) WHERE used_at IS NULL makes the "live codes for user X" lookup
--   fast: it covers only unused rows, keeping the index small and stable even
--   after large numbers of codes are consumed. Once a code is consumed its row
--   is excluded from the index entirely; it is retained for audit purposes.
--   (See modules/01-auth/SKILL.md § Decisions captured § 2 for the full
--   rationale and the rejected JSON-column alternative.)
--
-- Why tenant_id is denormalized here:
--   The canonical data model (docs/02-data-model.md § Schema note (2026-05-01))
--   records that tenant ownership is reachable transitively via
--   totp_recovery_codes.user_id → users.tenant_id. However, CLAUDE.md hard
--   rule #4 and the tools/lint-rls-policies.ts linter both require that every
--   domain table with a `tenant_id` column carry the standard two-policy RLS
--   template (tenant_isolation + tenant_isolation_insert) directly on the
--   table. A denormalized tenant_id column is therefore added here so that:
--     (a) RLS can be expressed as a simple column equality without a subquery
--         JOIN on users (which would be invisible to the linter and expensive
--         at read time), and
--     (b) the linter passes in CI without special-casing this table.
--   The column is kept in sync with users.tenant_id at insert time by the
--   application layer (modules/01-auth). See docs/02-data-model.md §
--   Schema note (2026-05-01) and modules/01-auth/SKILL.md §
--   "Schema deviations from 02-DATA" for the full rationale and rejected
--   alternatives.
--
-- Note: the users FK (user_id → users(id)) is intentional. The users table
-- lands in modules/03-users/migrations/020_users.sql (Window 5). This
-- migration must be applied after that one in dependency order.

CREATE TABLE totp_recovery_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),       -- denormalized from users.tenant_id; see docs/02-data-model.md § Schema note (2026-05-01)
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash       TEXT NOT NULL,               -- argon2id digest (m=65536, t=3, p=4) of the 8-char Crockford base32 plaintext
  used_at         TIMESTAMPTZ,                 -- null = unused; set atomically via UPDATE … RETURNING (see partial index note above)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial index covering only unused codes.
-- Supports the atomic consume query and the "list live codes for user X" admin
-- display path without scanning consumed rows.
CREATE INDEX totp_recovery_codes_user_live_idx
  ON totp_recovery_codes (user_id)
  WHERE used_at IS NULL;

-- RLS for totp_recovery_codes: standard tenant_id-keyed two-policy template.
-- Policies must live in the same file as the CREATE TABLE for the linter
-- (tools/lint-rls-policies.ts) to accept them.
--
-- WHY current_setting(..., true):
--   The second argument `true` makes current_setting return NULL instead of
--   raising an error when the GUC is unset. RLS then evaluates
--   `tenant_id = NULL` which is FALSE, so all rows are filtered out.
--   This is fail-closed: an unauthenticated session sees zero rows.
ALTER TABLE totp_recovery_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON totp_recovery_codes
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON totp_recovery_codes
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
