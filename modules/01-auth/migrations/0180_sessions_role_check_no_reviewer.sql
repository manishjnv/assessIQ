-- modules/01-auth/migrations/0180_sessions_role_check_no_reviewer.sql
-- Row Y-1, 2026-10-16. The tenant role 'reviewer' was removed from the product on 2026-10-03 (RV60/RO7).
-- This migration removes the value from sessions_role_check (sessions.role, created in 011 and re-created in 016). 0179 (03-users) does users.
-- It refuses to run when a legacy 'reviewer' row exists (production count was 0 on 2026-10-16).
-- One file per owning module so module-local test harnesses that load a subset of migration folders still apply cleanly.
-- help_content.audience is intentionally untouched: the audience enum keeps 'reviewer' (owner decision RW-2).

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM sessions WHERE role = 'reviewer';
  IF n > 0 THEN
    RAISE EXCEPTION '0180 refused: % legacy reviewer rows exist in sessions', n;
  END IF;
END
$$;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_role_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_role_check CHECK (role IN ('admin','super_admin','candidate'));
