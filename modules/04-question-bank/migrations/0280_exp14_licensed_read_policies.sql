-- EXP-14 phase 2, part 2 (design docs/design/2026-10-21-future-ready-question-store.md D3, D4, section 12).
-- WHAT  One permissive `licensed_read` policy FOR SELECT on each of the 11 question-store tables. Postgres ORs
--       permissive policies per command, so the existing `tenant_isolation` (own tenant, FOR ALL) is untouched and
--       NO write verb gains a path: INSERT, UPDATE and DELETE on a platform row stay impossible for a tenant.
--       Rollback is DROP POLICY licensed_read ON <table> (eleven statements, listed at the end).
-- DORMANT SWITCH  every policy also requires current_setting('app.licensed_read') = 'on'. withTenant sets it from
--       the env flag LICENSED_READ (default off), so deploying this migration changes nothing for any tenant until the
--       owner flips the flag. The functions (0279) still decide WHO may read; the flag only decides WHETHER licensed
--       read is active. A tenant that sets the setting itself gains nothing the functions do not already allow.
-- RULES (two, owner decision 2026-10-29: a revoked licence stops browsing at once, running tests keep working)
--   pack metadata   question_packs, levels: pack is licensed OR used by one of the tenant's own assessments.
--   content         questions: pack is licensed AND status = 'active' (drafts, archived and withdrawn are hidden;
--                   takedown archives), OR the exact question is in the tenant's own assessment_frozen_pool and is not a
--                   draft (second policy licensed_read_pinned, module 05 migration 0281).
--   children        question_versions, question_source, question_tags, question_taxonomy: pack is readable AND the PARENT
--                   QUESTION is visible to the caller (one primary-key lookup through the questions policy). So the versions,
--                   tags, source and taxonomy of a draft question never leak.
--   passages        platform rows only through a visible question that points at them.
--   domains, categories, tags   platform rows only while a visible question (or visible question_tags row) uses them,
--                   so the domain of a draft question stays hidden too.
-- No policy cycle: questions -> assessment_frozen_pool (plain tenant policy, 0281); children and passages -> questions.
-- Forward-only; no data is changed.
-- Rollback: DROP POLICY licensed_read ON question_packs, levels, questions, question_versions, question_source,
--           question_tags, question_taxonomy, passages, domains, categories, tags (one statement per table);
--           and DROP POLICY licensed_read_pinned ON questions (05/0281).

-- Switch used by every policy below.
-- (kept inline, not a function, so the lint can read it and there is nothing to mis-grant)

DROP POLICY IF EXISTS licensed_read ON question_packs;
CREATE POLICY licensed_read ON question_packs FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND id = ANY((SELECT readable_platform_packs())::uuid[])
  );

DROP POLICY IF EXISTS licensed_read ON levels;
CREATE POLICY licensed_read ON levels FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND pack_id = ANY((SELECT readable_platform_packs())::uuid[])
  );

-- Pinned questions of the tenant's own frozen pool are read through licensed_read_pinned (module 05, 0281),
-- because assessment_frozen_pool belongs to module 05. The two policies are ORed.
DROP POLICY IF EXISTS licensed_read ON questions;
CREATE POLICY licensed_read ON questions FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND pack_id = ANY((SELECT licensed_pack_ids())::uuid[])
    AND status = 'active'
  );

DROP POLICY IF EXISTS licensed_read ON question_versions;
CREATE POLICY licensed_read ON question_versions FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND pack_id = ANY((SELECT readable_platform_packs())::uuid[])
    AND EXISTS (SELECT 1 FROM questions q WHERE q.id = question_versions.question_id)
  );

DROP POLICY IF EXISTS licensed_read ON question_source;
CREATE POLICY licensed_read ON question_source FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND pack_id = ANY((SELECT readable_platform_packs())::uuid[])
    AND EXISTS (SELECT 1 FROM questions q WHERE q.id = question_source.question_id)
  );

DROP POLICY IF EXISTS licensed_read ON question_tags;
CREATE POLICY licensed_read ON question_tags FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND pack_id = ANY((SELECT readable_platform_packs())::uuid[])
    AND EXISTS (SELECT 1 FROM questions q WHERE q.id = question_tags.question_id)
  );

DROP POLICY IF EXISTS licensed_read ON question_taxonomy;
CREATE POLICY licensed_read ON question_taxonomy FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND pack_id = ANY((SELECT readable_platform_packs())::uuid[])
    AND EXISTS (SELECT 1 FROM questions q WHERE q.id = question_taxonomy.question_id)
  );

DROP POLICY IF EXISTS licensed_read ON passages;
CREATE POLICY licensed_read ON passages FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND tenant_id = (SELECT licensed_platform_tenant())
    AND EXISTS (SELECT 1 FROM questions q WHERE q.passage_id = passages.id)
  );

DROP POLICY IF EXISTS licensed_read ON domains;
CREATE POLICY licensed_read ON domains FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND tenant_id = (SELECT licensed_platform_tenant())
    AND EXISTS (SELECT 1 FROM questions q WHERE q.domain_id = domains.id)
  );

DROP POLICY IF EXISTS licensed_read ON categories;
CREATE POLICY licensed_read ON categories FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND tenant_id = (SELECT licensed_platform_tenant())
    AND EXISTS (SELECT 1 FROM questions q WHERE q.category_id = categories.id)
  );

DROP POLICY IF EXISTS licensed_read ON tags;
CREATE POLICY licensed_read ON tags FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND tenant_id = (SELECT licensed_platform_tenant())
    AND EXISTS (SELECT 1 FROM question_tags qt WHERE qt.tag_id = tags.id)
  );
