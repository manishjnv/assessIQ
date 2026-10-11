-- 0169_curriculum_frameworks.sql — RW-55 (S9, 2026-10-11)
--
-- WHAT
--   Three tables for CASE-style curriculum frameworks:
--     frameworks       — one row per framework (CBSE, ICSE, IB, ... and framework 1,
--                        the migrated "domains and categories" tree).
--     taxonomy_nodes   — typed tree under a framework. kind is one of
--                        board / stage / grade / subject / unit / outcome / criterion.
--     question_taxonomy — many-to-many question <-> node.
--   Plus two nullable FK columns: domains.node_id and categories.node_id, so every
--   existing domain / category row knows its node. The blueprint draw resolves a
--   node criterion to (domain_id, category_id) INSIDE the tenant through these two
--   columns, so assessment_frozen_pool keeps its shape (RW-55 abort criterion).
--
-- WHY tenant_id NULL for platform rows (help_content RLS variant, 0010)
--   Platform content is authored once by the super admin and read by every tenant.
--   A NULL tenant_id row is visible to all tenants through the SELECT policy; no
--   per-tenant copies, so "propagation" is implicit. Tenant-local domains (0091
--   source = 'tenant') become tenant-owned nodes (tenant_id = that tenant) under
--   the same platform framework, visible only to that tenant.
--   assessiq_app can never INSERT / UPDATE / DELETE a NULL-tenant row: those writes
--   go through withSystemRole (RW-38) from super-admin routes and are audited.
--
-- MIGRATION OF 0018 DATA (framework 1, slug 'legacy-domains')
--   domains    -> kind = 'subject'   (code = slug, position = display_order)
--   categories -> kind = 'unit'      (code = slug, parent = the domain's node)
--   A platform domain (source = 'platform') becomes ONE NULL-tenant node per slug.
--   A category under a platform domain whose (domain slug, category slug) also
--   exists in the platform tenant becomes ONE NULL-tenant node; every other
--   category becomes a tenant-owned node. question_taxonomy is backfilled from
--   questions.domain_id / category_id.
--
-- NOT INCLUDED
--   Draws by outcome / criterion nodes (needs frozen-pool changes; RW-61+).
--   Framework seeds for CBSE / ICSE / IB (RW-57). Any UI (RW-61).
--   cognitive_level stays a column on questions (0086).
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS, ON CONFLICT DO NOTHING, WHERE node_id IS NULL.

-- ---------------------------------------------------------------------------
-- frameworks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS frameworks (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform-owned
  slug        text        NOT NULL,
  name        text        NOT NULL,
  source      text        NOT NULL DEFAULT 'platform' CHECK (source IN ('platform','tenant')),
  status      text        NOT NULL DEFAULT 'active'   CHECK (status IN ('active','archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, slug)
);

ALTER TABLE frameworks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON frameworks;
CREATE POLICY tenant_isolation ON frameworks
  FOR SELECT
  USING (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );
DROP POLICY IF EXISTS tenant_isolation_update ON frameworks;
CREATE POLICY tenant_isolation_update ON frameworks
  FOR UPDATE
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );
DROP POLICY IF EXISTS tenant_isolation_delete ON frameworks;
CREATE POLICY tenant_isolation_delete ON frameworks
  FOR DELETE
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );
DROP POLICY IF EXISTS tenant_isolation_insert ON frameworks;
CREATE POLICY tenant_isolation_insert ON frameworks
  FOR INSERT
  WITH CHECK (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );

-- ---------------------------------------------------------------------------
-- taxonomy_nodes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS taxonomy_nodes (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform-owned
  framework_id      uuid        NOT NULL REFERENCES frameworks(id) ON DELETE CASCADE,
  parent_id         uuid        REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
  kind              text        NOT NULL CHECK (kind IN
                      ('board','stage','grade','subject','unit','outcome','criterion')),
  code              text        NOT NULL,          -- stable short id inside the parent ('soc', 'ch-3')
  label             text        NOT NULL,
  position          int         NOT NULL DEFAULT 0,
  syllabus_edition  text,                          -- '2025-26'
  external_id       text,                          -- CASE identifier or board code
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, framework_id, parent_id, code)
);

CREATE INDEX IF NOT EXISTS taxonomy_nodes_parent_idx    ON taxonomy_nodes (framework_id, parent_id, position);
CREATE INDEX IF NOT EXISTS taxonomy_nodes_tenant_idx    ON taxonomy_nodes (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS taxonomy_nodes_external_idx  ON taxonomy_nodes (external_id) WHERE external_id IS NOT NULL;

ALTER TABLE taxonomy_nodes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON taxonomy_nodes;
CREATE POLICY tenant_isolation ON taxonomy_nodes
  FOR SELECT
  USING (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );
DROP POLICY IF EXISTS tenant_isolation_update ON taxonomy_nodes;
CREATE POLICY tenant_isolation_update ON taxonomy_nodes
  FOR UPDATE
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );
DROP POLICY IF EXISTS tenant_isolation_delete ON taxonomy_nodes;
CREATE POLICY tenant_isolation_delete ON taxonomy_nodes
  FOR DELETE
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );
DROP POLICY IF EXISTS tenant_isolation_insert ON taxonomy_nodes;
CREATE POLICY tenant_isolation_insert ON taxonomy_nodes
  FOR INSERT
  WITH CHECK (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );

-- ---------------------------------------------------------------------------
-- question_taxonomy — JOIN-based RLS through questions -> question_packs (as question_tags, 0014)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_taxonomy (
  question_id  uuid NOT NULL REFERENCES questions(id)       ON DELETE CASCADE,
  node_id      uuid NOT NULL REFERENCES taxonomy_nodes(id)  ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, node_id)
);

CREATE INDEX IF NOT EXISTS question_taxonomy_node_idx ON question_taxonomy (node_id);

ALTER TABLE question_taxonomy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON question_taxonomy;
CREATE POLICY tenant_isolation ON question_taxonomy
  USING (
    EXISTS (
      SELECT 1
        FROM questions q
        JOIN question_packs p ON p.id = q.pack_id
       WHERE q.id = question_taxonomy.question_id
         AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

DROP POLICY IF EXISTS tenant_isolation_insert ON question_taxonomy;
CREATE POLICY tenant_isolation_insert ON question_taxonomy
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM questions q
        JOIN question_packs p ON p.id = q.pack_id
       WHERE q.id = question_taxonomy.question_id
         AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

-- ---------------------------------------------------------------------------
-- node_id on the 0018 tables
-- ---------------------------------------------------------------------------
ALTER TABLE domains    ADD COLUMN IF NOT EXISTS node_id uuid REFERENCES taxonomy_nodes(id) ON DELETE SET NULL;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS node_id uuid REFERENCES taxonomy_nodes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS domains_node_idx    ON domains (node_id)    WHERE node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS categories_node_idx ON categories (node_id) WHERE node_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Framework 1 + data migration (runs as the migration superuser, bypasses RLS)
-- ---------------------------------------------------------------------------
INSERT INTO frameworks (tenant_id, slug, name, source, status)
VALUES (NULL, 'legacy-domains', 'Domains and categories', 'platform', 'active')
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- 1. Platform domains: one NULL-tenant subject node per slug.
--    Label / position come from the platform tenant's row when it exists, else from any row.
INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label, position, status)
SELECT DISTINCT ON (d.slug)
       NULL,
       (SELECT id FROM frameworks WHERE tenant_id IS NULL AND slug = 'legacy-domains'),
       NULL, 'subject', d.slug, d.name, d.display_order,
       CASE WHEN d.status = 'archived' THEN 'archived' ELSE 'active' END
  FROM domains d
  LEFT JOIN tenants pt ON pt.id = d.tenant_id AND pt.slug = 'platform'
 WHERE d.source = 'platform'
 ORDER BY d.slug, (pt.id IS NULL), d.created_at
ON CONFLICT (tenant_id, framework_id, parent_id, code) DO NOTHING;

UPDATE domains d
   SET node_id = n.id
  FROM taxonomy_nodes n
 WHERE d.node_id IS NULL
   AND d.source = 'platform'
   AND n.tenant_id IS NULL AND n.parent_id IS NULL AND n.kind = 'subject' AND n.code = d.slug
   AND n.framework_id = (SELECT id FROM frameworks WHERE tenant_id IS NULL AND slug = 'legacy-domains');

-- 2. Tenant-local domains: one tenant-owned subject node per row.
INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label, position, status)
SELECT d.tenant_id,
       (SELECT id FROM frameworks WHERE tenant_id IS NULL AND slug = 'legacy-domains'),
       NULL, 'subject', d.slug, d.name, d.display_order,
       CASE WHEN d.status = 'archived' THEN 'archived' ELSE 'active' END
  FROM domains d
 WHERE d.source = 'tenant' AND d.node_id IS NULL
ON CONFLICT (tenant_id, framework_id, parent_id, code) DO NOTHING;

UPDATE domains d
   SET node_id = n.id
  FROM taxonomy_nodes n
 WHERE d.node_id IS NULL
   AND d.source = 'tenant'
   AND n.tenant_id = d.tenant_id AND n.parent_id IS NULL AND n.kind = 'subject' AND n.code = d.slug
   AND n.framework_id = (SELECT id FROM frameworks WHERE tenant_id IS NULL AND slug = 'legacy-domains');

-- 3. Platform categories: (platform domain slug, category slug) present in the platform tenant
--    -> one NULL-tenant unit node under the platform subject node.
INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label, position, status)
SELECT NULL, dn.framework_id, dn.id, 'unit', c.slug, c.name, 0,
       CASE WHEN c.status = 'active' THEN 'active' ELSE 'archived' END
  FROM categories c
  JOIN domains d   ON d.id = c.domain_id
  JOIN tenants pt  ON pt.id = c.tenant_id AND pt.slug = 'platform'
  JOIN taxonomy_nodes dn ON dn.id = d.node_id AND dn.tenant_id IS NULL
ON CONFLICT (tenant_id, framework_id, parent_id, code) DO NOTHING;

UPDATE categories c
   SET node_id = n.id
  FROM domains d, taxonomy_nodes n
 WHERE c.node_id IS NULL
   AND d.id = c.domain_id AND d.node_id IS NOT NULL
   AND n.parent_id = d.node_id AND n.tenant_id IS NULL AND n.kind = 'unit' AND n.code = c.slug;

-- 4. Every remaining category: tenant-owned unit node under its domain's node.
INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label, position, status)
SELECT c.tenant_id, dn.framework_id, dn.id, 'unit', c.slug, c.name, 0,
       CASE WHEN c.status = 'active' THEN 'active' ELSE 'archived' END
  FROM categories c
  JOIN domains d ON d.id = c.domain_id
  JOIN taxonomy_nodes dn ON dn.id = d.node_id
 WHERE c.node_id IS NULL
ON CONFLICT (tenant_id, framework_id, parent_id, code) DO NOTHING;

UPDATE categories c
   SET node_id = n.id
  FROM domains d, taxonomy_nodes n
 WHERE c.node_id IS NULL
   AND d.id = c.domain_id AND d.node_id IS NOT NULL
   AND n.parent_id = d.node_id AND n.tenant_id = c.tenant_id AND n.kind = 'unit' AND n.code = c.slug;

-- 5. question_taxonomy backfill from questions.domain_id / category_id.
INSERT INTO question_taxonomy (question_id, node_id)
SELECT q.id, d.node_id FROM questions q JOIN domains d ON d.id = q.domain_id WHERE d.node_id IS NOT NULL
UNION
SELECT q.id, c.node_id FROM questions q JOIN categories c ON c.id = q.category_id WHERE c.node_id IS NOT NULL
ON CONFLICT DO NOTHING;
