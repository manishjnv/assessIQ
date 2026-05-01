-- owned by modules/04-question-bank
-- Ships two tables: `tags` (tenant-scoped vocabulary) and `question_tags`
-- (many-to-many join). Tags are optional metadata on questions used for
-- filtering, reporting, and content-library search. UNIQUE (tenant_id, name)
-- on tags prevents duplicate tag names within a tenant.
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
-- `tags` uses the standard RLS variant: it has its own `tenant_id` column, so
-- the isolation predicate is a direct equality check.
--
-- WHY JOIN-based RLS on question_tags — two-hop (no tenant_id column):
--   `question_tags` is a pure join table with no `tenant_id` column of its own.
--   Tenancy is derived via question_tags.question_id → questions.pack_id →
--   question_packs.tenant_id. Both RLS policies use the same two-hop EXISTS
--   pattern as question_versions. The fail-closed guarantee holds: if
--   `app.current_tenant` is unset, `p.tenant_id = NULL` is FALSE and zero rows
--   are visible or insertable.

-- ---------------------------------------------------------------------------
-- tags
-- ---------------------------------------------------------------------------

CREATE TABLE tags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  category    TEXT,
  UNIQUE (tenant_id, name)
);

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tags
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON tags
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- question_tags
-- ---------------------------------------------------------------------------

CREATE TABLE question_tags (
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, tag_id)
);

ALTER TABLE question_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON question_tags
  USING (
    EXISTS (
      SELECT 1
        FROM questions q
        JOIN question_packs p ON p.id = q.pack_id
       WHERE q.id = question_tags.question_id
         AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

CREATE POLICY tenant_isolation_insert ON question_tags
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM questions q
        JOIN question_packs p ON p.id = q.pack_id
       WHERE q.id = question_tags.question_id
         AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );
