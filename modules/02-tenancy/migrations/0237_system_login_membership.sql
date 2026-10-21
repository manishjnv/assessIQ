-- owned by modules/02-tenancy
-- 0237 - FUT-10 step 1: let the assessiq_system LOGIN also switch to assessiq_app.
-- Safe while old code runs, idempotent, removes nothing.
--
-- withSystemRole now runs on its own pool whose login is assessiq_system. Mixed callers
-- (system read, then SET LOCAL ROLE assessiq_app + set_config for an audit row) need the
-- system login to be a member of assessiq_app. PostgreSQL refuses circular membership, so
-- while 0002's `GRANT assessiq_system TO assessiq_app` still exists the grant is skipped
-- (NOTICE). The manual step 2 (FUT-10 handoff) does REVOKE + this GRANT in one transaction.
-- Fresh databases (no 0002 membership left) get it here. No password in SQL (see 0002).

DO $$
BEGIN
  IF pg_has_role('assessiq_app', 'assessiq_system', 'member') THEN
    RAISE NOTICE 'FUT-10: assessiq_app is still a member of assessiq_system; run step 2 (REVOKE then GRANT assessiq_app TO assessiq_system)';
  ELSIF NOT pg_has_role('assessiq_system', 'assessiq_app', 'member') THEN
    GRANT assessiq_app TO assessiq_system;
  END IF;
END
$$;

-- Re-assert baseline (0002 already grants these; default privileges cover new tables).
GRANT USAGE ON SCHEMA public TO assessiq_system;
