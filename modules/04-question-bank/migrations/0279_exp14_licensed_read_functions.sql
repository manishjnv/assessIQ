-- EXP-14 phase 2, part 1 (design docs/design/2026-10-21-future-ready-question-store.md D3, D4, section 12).
-- WHAT  Three SECURITY DEFINER read helpers that say which platform packs the CALLING tenant may read, plus
--       the lookup indexes the policies (0280) need. This migration adds NO policy, so behaviour is unchanged.
--   licensed_pack_ids()          published platform packs the tenant holds an active entitlement for
--                                (pack scope by id, domain scope by lowercase slug); tier 'internal' reads all
--                                published platform packs (same rule as assertLicensedForSourcePack).
--   readable_platform_packs()    licensed packs PLUS platform packs used by the tenant's own assessments (pack
--                                names and levels stay readable for running tests; question content does not,
--                                see 0280 and 05/0281).
--   licensed_platform_tenant()   the platform tenant id when the caller can read any platform pack, else NULL.
-- WHY   a policy cannot join tenant_entitlements cheaply per row. A STABLE function called as (SELECT fn())
--       runs once per query. DEFINER because the tenant role cannot read tenants, entitlements or plans of others;
--       the functions read ONLY the caller's own rows (tenant id from app.current_tenant), take NO argument and
--       build NO dynamic SQL. Fixed search_path plus schema-qualified names block object shadowing. EXECUTE is
--       revoked from PUBLIC and given to the two application roles only.
-- WHY plpgsql: the tables of other modules (19 entitlements and plans, 05 assessments) may not exist in a
--       per-module test database. plpgsql checks table names at first call, not at CREATE, and each function
--       returns an empty result when a table it needs is absent. In production every table exists.
-- Platform identity: tenants.is_platform (0276), never a session setting.
-- Forward-only, idempotent.
-- Rollback: DROP FUNCTION licensed_platform_tenant(); DROP FUNCTION readable_platform_packs();
--           DROP FUNCTION licensed_pack_ids(); DROP INDEX questions_domain_idx;
--           DROP INDEX questions_category_idx; DROP INDEX question_tags_tag_idx;

CREATE OR REPLACE FUNCTION licensed_pack_ids() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  me     uuid := NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid;
  result uuid[];
BEGIN
  IF me IS NULL
     OR pg_catalog.to_regclass('public.tenant_entitlements') IS NULL
     OR pg_catalog.to_regclass('public.tenant_plans') IS NULL THEN
    RETURN ARRAY[]::uuid[];
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(p.id), ARRAY[]::uuid[]) INTO result
    FROM public.question_packs p
    JOIN public.tenants pt ON pt.id = p.tenant_id AND pt.is_platform
   WHERE p.status = 'published'
     AND (
       EXISTS (SELECT 1 FROM public.tenant_plans tp WHERE tp.tenant_id = me AND tp.tier = 'internal')
       OR EXISTS (SELECT 1 FROM public.tenant_entitlements e
                   WHERE e.tenant_id = me
                     AND e.status = 'active'
                     AND ((e.scope_type = 'pack' AND e.scope_id = p.id::text)
                       OR (e.scope_type = 'domain' AND e.scope_id = pg_catalog.lower(p.domain))))
     );
  RETURN result;
END
$$;

CREATE OR REPLACE FUNCTION readable_platform_packs() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  me     uuid := NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid;
  result uuid[] := public.licensed_pack_ids();
BEGIN
  IF me IS NULL OR pg_catalog.to_regclass('public.assessments') IS NULL THEN
    RETURN result;
  END IF;
  RETURN ARRAY(
    SELECT u FROM (
      SELECT pg_catalog.unnest(result) AS u
      UNION
      SELECT a.pack_id
        FROM public.assessments a
        JOIN public.question_packs p ON p.id = a.pack_id
        JOIN public.tenants pt ON pt.id = p.tenant_id AND pt.is_platform
       WHERE a.tenant_id = me
    ) s
  );
END
$$;

CREATE OR REPLACE FUNCTION licensed_platform_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  t uuid;
BEGIN
  SELECT pt.id INTO t FROM public.tenants pt
   WHERE pt.is_platform AND pg_catalog.cardinality(public.readable_platform_packs()) > 0;
  RETURN t;
END
$$;

-- Only the two application roles may call them (the policies run as the invoking role).
REVOKE ALL ON FUNCTION licensed_pack_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION readable_platform_packs() FROM PUBLIC;
REVOKE ALL ON FUNCTION licensed_platform_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION licensed_pack_ids() TO assessiq_app, assessiq_system;
GRANT EXECUTE ON FUNCTION readable_platform_packs() TO assessiq_app, assessiq_system;
GRANT EXECUTE ON FUNCTION licensed_platform_tenant() TO assessiq_app, assessiq_system;

-- Lookups used by the domains, categories and tags policies (0280): "is a visible question using this row?"
CREATE INDEX IF NOT EXISTS questions_domain_idx ON questions (domain_id) WHERE domain_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS questions_category_idx ON questions (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS question_tags_tag_idx ON question_tags (tag_id);
