-- modules/01-auth/migrations/016_super_admin.sql
--
-- Super-admin platform onboarding — C1 of the super-admin-onboarding contract.
-- Applied SURGICALLY by Opus (per-file + sha256 in schema_migrations tracking gap).
-- DO NOT run via tools/migrate.ts — that path is still broken (see RCA log).
--
-- What this migration does:
--   1. Extends the sessions.role and users.role CHECK constraints to include
--      'super_admin'. Both tables use a named CHECK constraint; we drop+readd
--      the constraint to add the new value. Sessions is small; users rows
--      are tenant-scoped and the operation is a metadata-only DDL change (no
--      rewrite). Both are safe at AssessIQ's current scale.
--   2. Inserts the platform tenant (fixed well-known UUID), its settings row,
--      and the bootstrap super_admin user (manishjnvk@gmail.com).
--      All three INSERTs use ON CONFLICT DO NOTHING for idempotency — running
--      this migration more than once is safe.
--
-- PLATFORM_TENANT_UUID:
--   00000000-0000-7000-0000-000000000001
--   Chosen rationale: UUID v7 style with all-zeros timestamp + sequence except
--   the final nibble = 1. Unmistakable in logs, easy to grep, zero collision
--   risk with real UUIDv7 values (v7 timestamps start in 2020+; this encodes
--   epoch ~Jan 1 1970 UTC). The '7' in position 13 marks it as UUIDv7-family
--   (version nibble) so tooling doesn't reject it as malformed.
--   Same constant must be set as env var PLATFORM_TENANT_ID (fail-fast on
--   startup if missing or mismatched — checked in apps/api/src/server.ts).
--
-- Runs as the migration runner role (assessiq_system or direct superuser access).
-- RLS is NOT engaged for this file — the runner bypasses RLS.

-- ---------------------------------------------------------------------------
-- Step 1a — sessions.role CHECK: add 'super_admin'
-- ---------------------------------------------------------------------------
-- Drop the existing constraint by its known name (created in 011_sessions.sql).
-- If the constraint name differs in a given env, this will fail loudly.
-- Opus must verify the exact constraint name before applying.
ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_role_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_role_check
    CHECK (role IN ('admin', 'super_admin', 'reviewer', 'candidate'));

-- ---------------------------------------------------------------------------
-- Step 1b — users.role CHECK: add 'super_admin'
-- ---------------------------------------------------------------------------
-- The users table is owned by 03-users but 01-auth references its schema via
-- FK (sessions.user_id → users.id). The CHECK constraint name is from the
-- 03-users initial migration. Opus must verify the name before applying.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'super_admin', 'reviewer', 'candidate'));

-- ---------------------------------------------------------------------------
-- Step 2 — Platform tenant
-- ---------------------------------------------------------------------------
INSERT INTO tenants (id, slug, name, status)
VALUES (
  '00000000-0000-7000-0000-000000000001',
  'platform',
  'AssessIQ Platform',
  'active'
)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Step 3 — Platform tenant_settings (FK NOT NULL, required immediately)
-- ---------------------------------------------------------------------------
INSERT INTO tenant_settings (tenant_id)
VALUES ('00000000-0000-7000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Step 4 — Bootstrap super_admin user
--
-- No oauth_identities row is inserted here. The platform login path (option c)
-- resolves by verified email only; it never touches oauth_identities.
-- The UUID for the user row is also fixed for grep-ability:
--   00000000-0000-7000-0000-000000000002
-- ---------------------------------------------------------------------------
INSERT INTO users (id, tenant_id, email, name, role, status)
VALUES (
  '00000000-0000-7000-0000-000000000002',
  '00000000-0000-7000-0000-000000000001',
  'manishjnvk@gmail.com',
  'Manish Kumar',
  'super_admin',
  'active'
)
ON CONFLICT DO NOTHING;
