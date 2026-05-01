-- owned by modules/04-question-bank
-- Ships the `question_versions` table: append-only snapshot history for
-- questions. Every content edit by an author produces a new version row;
-- the live question row's `version` column tracks the current version number.
-- UNIQUE (question_id, version) prevents duplicate version numbers per question.
-- The DESC index on version makes "latest version" lookups efficient.
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
-- WHY JOIN-based RLS — two-hop (no tenant_id column):
--   `question_versions` is a grandchild of `question_packs`: the chain is
--   question_versions.question_id → questions.pack_id → question_packs.tenant_id.
--   There is no `tenant_id` column here nor on `questions`. Both RLS policies
--   resolve tenancy with a single EXISTS that JOINs questions → question_packs,
--   keeping the predicate one round-trip. The fail-closed guarantee holds:
--   if `app.current_tenant` is unset, `p.tenant_id = NULL` is FALSE and zero
--   rows are visible or insertable.

CREATE TABLE question_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id     UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  version         INT NOT NULL,
  content         JSONB NOT NULL,
  rubric          JSONB,
  saved_by        UUID NOT NULL REFERENCES users(id),
  saved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (question_id, version)
);

CREATE INDEX question_versions_question_idx ON question_versions (question_id, version DESC);

ALTER TABLE question_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON question_versions
  USING (
    EXISTS (
      SELECT 1
        FROM questions q
        JOIN question_packs p ON p.id = q.pack_id
       WHERE q.id = question_versions.question_id
         AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

CREATE POLICY tenant_isolation_insert ON question_versions
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM questions q
        JOIN question_packs p ON p.id = q.pack_id
       WHERE q.id = question_versions.question_id
         AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );
