-- owned by modules/04-question-bank
-- Ships the `questions` table: individual assessment items belonging to a pack
-- and level. Types: mcq | subjective | kql | scenario | log_analysis.
-- Statuses: draft | active | archived. The assessment-lifecycle module pulls
-- questions where status = 'active'; the CHECK constraint enforces valid values.
-- `content` and `rubric` are JSONB — schema is owned by each question type's
-- handler in modules/04-question-bank/content-schemas/.
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
--   `questions` is a child of `question_packs` and carries no `tenant_id` column
--   of its own — tenancy is fully derived through the `pack_id` foreign key.
--   A direct `tenant_id = current_setting(...)` predicate is therefore impossible.
--   Instead, both RLS policies use an EXISTS sub-select that joins back to
--   `question_packs` and checks `p.tenant_id`, giving the same fail-closed
--   guarantee: if `app.current_tenant` is unset, `p.tenant_id = NULL` is FALSE
--   and zero rows are visible or insertable.

CREATE TABLE questions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id         UUID NOT NULL REFERENCES question_packs(id),
  level_id        UUID NOT NULL REFERENCES levels(id),
  type            TEXT NOT NULL CHECK (type IN ('mcq','subjective','kql','scenario','log_analysis')),
  topic           TEXT NOT NULL,
  points          INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  version         INT NOT NULL DEFAULT 1,
  content         JSONB NOT NULL,
  rubric          JSONB,
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX questions_pack_level_idx ON questions (pack_id, level_id, status);

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON questions
  USING (
    EXISTS (
      SELECT 1 FROM question_packs p
      WHERE p.id = questions.pack_id
        AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

CREATE POLICY tenant_isolation_insert ON questions
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM question_packs p
      WHERE p.id = questions.pack_id
        AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );
