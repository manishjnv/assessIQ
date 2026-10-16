-- modules/13-notifications/migrations/0181_in_app_notifications_role_check_no_reviewer.sql
-- Row Y-1, 2026-10-16. The tenant role 'reviewer' was removed from the product on 2026-10-03 (RV60/RO7).
-- This migration removes the value from in_app_notifications_role_check (in_app_notifications.role, created in 0056). 0179 (03-users) does users.
-- It refuses to run when a legacy 'reviewer' row exists (production count was 0 on 2026-10-16).
-- One file per owning module so module-local test harnesses that load a subset of migration folders still apply cleanly.
-- help_content.audience is intentionally untouched: the audience enum keeps 'reviewer' (owner decision RW-2).

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM in_app_notifications WHERE role = 'reviewer';
  IF n > 0 THEN
    RAISE EXCEPTION '0181 refused: % legacy reviewer rows exist in in_app_notifications', n;
  END IF;
END
$$;

ALTER TABLE in_app_notifications DROP CONSTRAINT IF EXISTS in_app_notifications_role_check;
ALTER TABLE in_app_notifications ADD CONSTRAINT in_app_notifications_role_check CHECK (role IN ('admin'));
