-- owned by modules/02-tenancy
-- 0114 — per-tenant result release mode.
--
--   manual (default): a finished result stays hidden until a tenant admin publishes it
--                     (single Release, or the bulk "release all ready" action).
--   auto:             a finished result is published to the student as soon as it is
--                     complete (worker sweep `result.auto_release`, every ~15 s).
--
-- result_release_auto_since — when the tenant switched manual -> auto (NULL while the
--   mode is 'manual'). The auto-release sweep only publishes attempts whose evaluation
--   was released AT OR AFTER this moment, so switching a tenant to 'auto' never
--   releases the results that were already waiting in the manual queue ("nothing is
--   released retroactively without an explicit click" — the admin uses the bulk
--   release for those). Set to now() by updateResultReleaseMode on manual -> auto and
--   cleared on auto -> manual.
--
-- Default 'manual' is the safer choice for hiring tenants.

ALTER TABLE tenant_settings
  ADD COLUMN result_release_mode text NOT NULL DEFAULT 'manual'
    CHECK (result_release_mode IN ('manual', 'auto')),
  ADD COLUMN result_release_auto_since timestamptz NULL;
