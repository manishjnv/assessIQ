-- owned by modules/05-assessment-lifecycle
-- "Lock at assignment" — frozen eligible-question pool per assessment.
--
-- WHY this table exists (the feature):
--   Until now an assessment's content was resolved LIVE at attempt-start:
--   module 06 startAttempt drew from listActiveQuestionPoolForPick /
--   listActiveQuestionPoolForCriterion, which select status='active' questions
--   pinned to MAX(question_versions.version). That means editing/re-syncing a
--   pack changed what FUTURE attempts of an already-published assessment drew,
--   and two candidates of the same assessment could even get different content
--   if the pack changed between their start times.
--
--   The "lock at assignment" model freezes an assessment's exact eligible pool
--   (question_id + the version that was current) at PUBLISH time. From then on
--   the assessment's content is immutable: master pack revisions / clone
--   auto-sync only reach NEWLY-published assessments. This table is that frozen
--   snapshot — one row per active question in the assessment's (pack, level) at
--   publish, capturing the exact version + the taxonomy fields the blueprint
--   draw needs (domain_id, category_id, type).
--
-- STRICTLY ADDITIVE:
--   - New table only. No existing table/column is altered or dropped.
--   - Assessments published BEFORE this migration have NO rows here; module 06
--     falls back to the existing live-pool query for them (legacy/un-frozen).
--     No backfill — prod has only dev/seed data (see memory
--     project-under-development-no-real-data).
--
-- WHY a dedicated table (not extending attempt_questions):
--   attempt_questions is PER-ATTEMPT (the chosen subset pinned per candidate,
--   written at attempt-start). This is PER-ASSESSMENT (the eligible SET to draw
--   FROM, written at publish). Different cardinality and lifecycle; keeping them
--   separate leaves attempt_questions semantics untouched.
--
-- WHY MAX(question_versions.version) at freeze:
--   Mirrors listActiveQuestionPoolForPick exactly so the frozen snapshot equals
--   what a live draw would have selected at publish time. The version pin lets
--   module 06 fetch frozen content via the same (question_id, version) contract
--   it already uses for attempt_questions.
--
-- WHY current_setting(..., true): see modules/05-assessment-lifecycle/migrations/
--   0021_assessments.sql — fail-closed RLS (NULL GUC → zero rows).
--
-- GRANTs: not needed here. modules/02-tenancy/migrations/0002_rls_helpers.sql
--   sets ALTER DEFAULT PRIVILEGES so future tables inherit SELECT/INSERT/UPDATE/
--   DELETE for assessiq_app + assessiq_system automatically.

CREATE TABLE assessment_frozen_pool (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  assessment_id     UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_id       UUID NOT NULL REFERENCES questions(id),
  question_version  INT  NOT NULL,
  level_id          UUID NOT NULL REFERENCES levels(id),
  -- Taxonomy fields captured so the blueprint draw can re-filter the frozen set
  -- by (domain_id, category_id, type) without re-reading the live questions
  -- table. Nullable to match the questions table's own nullability.
  domain_id         UUID,
  category_id       UUID,
  type              TEXT NOT NULL,
  points            INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One frozen row per question per assessment. Makes the freeze idempotent
  -- (ON CONFLICT DO NOTHING) and is the structural backstop for write-once.
  CONSTRAINT assessment_frozen_pool_uniq UNIQUE (assessment_id, question_id)
);

-- The unique constraint's index (assessment_id, question_id) already serves the
-- attempt-start read (WHERE assessment_id = $1) via its leftmost column, so no
-- separate single-column index is added.

ALTER TABLE assessment_frozen_pool ENABLE ROW LEVEL SECURITY;

-- Read/update/delete policy. Written by module 05 (publish, admin tenant) and
-- read by module 06 (attempt-start, candidate tenant) — both scoped to the
-- assessment's tenant via withTenant, so a single tenant-isolation policy
-- covers both call paths.
CREATE POLICY tenant_isolation ON assessment_frozen_pool
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON assessment_frozen_pool
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
