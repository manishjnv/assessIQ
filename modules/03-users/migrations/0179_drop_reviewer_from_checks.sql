-- modules/03-users/migrations/0179_drop_reviewer_from_checks.sql
-- Row Y-1, 2026-10-16. The tenant role 'reviewer' was removed from the product on 2026-10-03 (RV60/RO7).
-- This migration removes the value from the role CHECKs on users, sessions and in_app_notifications.
-- It refuses to run when a legacy 'reviewer' row exists (production count was 0 on 2026-10-16).
-- help_content.audience is intentionally untouched: the audience enum keeps 'reviewer' (owner decision RW-2).

DO $$
DECLARE
  n_users    bigint;
  n_sessions bigint;
  n_notifs   bigint;
BEGIN
  SELECT count(*) INTO n_users    FROM users                WHERE role = 'reviewer';
  SELECT count(*) INTO n_sessions FROM sessions             WHERE role = 'reviewer';
  SELECT count(*) INTO n_notifs   FROM in_app_notifications WHERE role = 'reviewer';
  IF n_users + n_sessions + n_notifs > 0 THEN
    RAISE EXCEPTION '0179 refused: legacy reviewer rows exist (users=%, sessions=%, in_app_notifications=%)',
      n_users, n_sessions, n_notifs;
  END IF;
END
$$;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','super_admin','candidate'));

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_role_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_role_check CHECK (role IN ('admin','super_admin','candidate'));

ALTER TABLE in_app_notifications DROP CONSTRAINT IF EXISTS in_app_notifications_role_check;
ALTER TABLE in_app_notifications ADD CONSTRAINT in_app_notifications_role_check CHECK (role IN ('admin'));
