-- owned by modules/04-question-bank
-- Ships the `domains` and `categories` tables: the two-level taxonomy that
-- classifies questions by field (domain) and sub-topic (category).
-- Both tables are tenant-scoped with the standard direct tenant_id RLS pattern
-- (same as question_packs and tags — not the JOIN-based pattern used by
-- questions/question_versions which have no own tenant_id column).
-- pgcrypto is already enabled by modules/02-tenancy/migrations/0001_tenants.sql;
-- we do NOT re-enable it here.
--
-- WHY current_setting(..., true) — the `, true` second argument:
--   With `true`, current_setting returns NULL instead of raising
--   "unrecognized configuration parameter" when the GUC has never been SET.
--   RLS then evaluates `tenant_id = NULL` which is FALSE (SQL three-value logic),
--   so every row is filtered out. This is fail-closed behaviour: an
--   unauthenticated or misconfigured session sees zero rows rather than all rows.
--
-- WHY nullable domain_id / category_id on questions:
--   Legacy question rows (created before this migration) have no domain/category
--   association. Adding NOT NULL here would require a backfill — deferred. New
--   questions generated via the wizard will carry these FKs. Existing RLS on
--   `questions` is NOT changed by this migration.

-- ---------------------------------------------------------------------------
-- domains
-- ---------------------------------------------------------------------------

CREATE TABLE domains (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id),
  slug          text        NOT NULL,
  name          text        NOT NULL,
  description   text,
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  display_order int         NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

ALTER TABLE domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON domains
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON domains
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL REFERENCES tenants(id),
  domain_id              uuid        NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  slug                   text        NOT NULL,
  name                   text        NOT NULL,
  description            text,
  relevance_score        int         NOT NULL DEFAULT 0,
  default_selected       bool        NOT NULL DEFAULT true,
  supported_types        jsonb       NOT NULL DEFAULT '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb,
  default_question_count int         NOT NULL DEFAULT 1,
  status                 text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, domain_id, slug)
);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON categories
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON categories
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- questions — add nullable FK columns (no backfill, no NOT NULL)
-- ---------------------------------------------------------------------------

ALTER TABLE questions
  ADD COLUMN domain_id   uuid REFERENCES domains(id),
  ADD COLUMN category_id uuid REFERENCES categories(id);
