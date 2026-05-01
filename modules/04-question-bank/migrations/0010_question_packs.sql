-- owned by modules/04-question-bank
-- Ships the `question_packs` table: top-level content container scoped to a
-- tenant. A pack groups levels and questions for a single role-readiness domain.
-- Statuses: draft | published | archived. UNIQUE (tenant_id, slug, version)
-- allows a pack to be re-versioned without destroying the original slug.
-- pgcrypto is already enabled by modules/02-tenancy/migrations/0001_tenants.sql;
-- we do NOT re-enable it here.
--
-- WHY current_setting(..., true) — the `, true` second argument:
--   With `true`, current_setting returns NULL instead of raising
--   "unrecognized configuration parameter" when the GUC has never been SET.
--   RLS then evaluates `tenant_id = NULL` which is FALSE (SQL three-value logic),
--   so every row is filtered out. This is fail-closed behaviour: an
--   unauthenticated or misconfigured session sees zero rows rather than all rows.

CREATE TABLE question_packs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  domain          TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version         INT NOT NULL DEFAULT 1,
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug, version)
);

CREATE INDEX question_packs_tenant_status_idx
  ON question_packs (tenant_id, status, domain);

ALTER TABLE question_packs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON question_packs
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON question_packs
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
