-- modules/03-users/migrations/0179_drop_reviewer_from_checks.sql
-- Row Y-1, 2026-10-16. The tenant role 'reviewer' was removed from the product on 2026-10-03 (RV60/RO7).
-- This migration removes the value from users_role_check (users.role). 0180 (01-auth) does sessions, 0181 (13-notifications) does in_app_notifications.
-- It refuses to run when a legacy 'reviewer' row exists (production count was 0 on 2026-10-16).
-- One file per owning module so module-local test harnesses that load a subset of migration folders still apply cleanly.
-- help_content.audience is intentionally untouched: the audience enum keeps 'reviewer' (owner decision RW-2).

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM users WHERE role = 'reviewer';
  IF n > 0 THEN
    RAISE EXCEPTION '0179 refused: % legacy reviewer rows exist in users', n;
  END IF;
END
$$;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','super_admin','candidate'));
