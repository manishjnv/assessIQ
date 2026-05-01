-- owned by modules/04-question-bank
-- Ships the `levels` table: ordered difficulty bands within a question pack.
-- Each level carries timing, question-count, and passing-score configuration.
-- UNIQUE (pack_id, position) ensures positions are non-overlapping per pack.
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
-- WHY JOIN-based RLS (no tenant_id column):
--   `levels` is a child of `question_packs` and carries no `tenant_id` column of
--   its own — tenancy is fully derived through the `pack_id` foreign key.
--   A direct `tenant_id = current_setting(...)` predicate is therefore impossible.
--   Instead, both RLS policies use an EXISTS sub-select that joins back to
--   `question_packs` and checks `p.tenant_id`, giving the same fail-closed
--   guarantee: if `app.current_tenant` is unset, `p.tenant_id = NULL` is FALSE
--   and zero rows are visible or insertable.

CREATE TABLE levels (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id                 UUID NOT NULL REFERENCES question_packs(id) ON DELETE CASCADE,
  position                INT NOT NULL,
  label                   TEXT NOT NULL,
  description             TEXT,
  duration_minutes        INT NOT NULL,
  default_question_count  INT NOT NULL,
  passing_score_pct       INT NOT NULL DEFAULT 60,
  UNIQUE (pack_id, position)
);

ALTER TABLE levels ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON levels
  USING (
    EXISTS (
      SELECT 1 FROM question_packs p
      WHERE p.id = levels.pack_id
        AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

CREATE POLICY tenant_isolation_insert ON levels
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM question_packs p
      WHERE p.id = levels.pack_id
        AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );
