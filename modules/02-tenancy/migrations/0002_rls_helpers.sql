-- Two-role design for AssessIQ database access.
--
-- assessiq_app  — runtime application role. NO BYPASSRLS. All API server and
--                 worker connections use this role. RLS policies are active and
--                 tenant isolation is enforced automatically. The production
--                 DATABASE_URL MUST point at this role; the postgres superuser
--                 is reserved for running migrations only.
--
-- assessiq_system — explicit-elevation role. BYPASSRLS granted for cross-tenant
--                   operations: backups, cross-tenant analytics, support tooling.
--                   Every use of this role MUST be audited by the calling module
--                   (14-audit-log lands in Phase 3). Never use this role from
--                   candidate-facing or assessment-runtime code paths.
--
-- See modules/02-tenancy/SKILL.md § System-level escapes for usage guidelines.
--
-- DEPLOY NOTE — passwords are NOT set in this migration.
--   CREATE ROLE ... WITH LOGIN (no PASSWORD clause) creates the role with
--   a NULL password. The role exists and can authenticate via auth methods
--   that do not require a password (peer/trust on a private Docker network),
--   but cannot log in via md5/scram-sha-256.
--
--   Production deploy must run AFTER this migration (sourced from a Docker
--   secret, NOT committed to git):
--     ALTER ROLE assessiq_app    PASSWORD '<random-32-byte>';
--     ALTER ROLE assessiq_system PASSWORD '<random-32-byte-different>';
--
--   See docs/06-deployment.md § Post-migration role passwords.
--
--   Tests do not need passwords: testcontainers connects as the postgres
--   superuser and uses SET ROLE / RESET ROLE to switch identities.

-- Create roles idempotently. The DO block swallows duplicate_object so
-- re-running this migration (e.g. in dev) does not fail.
DO $$
BEGIN
  CREATE ROLE assessiq_app WITH LOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE assessiq_system WITH LOGIN NOINHERIT BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;

-- Grant baseline privileges. Default privileges ensure future tables inherit.
GRANT USAGE ON SCHEMA public TO assessiq_app, assessiq_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO assessiq_app, assessiq_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO assessiq_app, assessiq_system;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO assessiq_app, assessiq_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO assessiq_app, assessiq_system;
