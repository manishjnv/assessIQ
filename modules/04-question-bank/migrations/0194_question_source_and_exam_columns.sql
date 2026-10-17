-- owned by modules/04-question-bank
-- 0194 — EXP-2: provenance + rights table `question_source`, and four exam columns on `questions`.
--
-- WHAT
--   question_source  one row per question: origin, rights_status, source reference, licence,
--                    content hashes, optional previous-year-paper (pyq_*) fields.
--   questions        + difficulty_est (1..5), review_state, language_primary, content_i18n.
--
-- WHY a separate table: provenance and rights change without a question version bump, and a
--   takedown (rights_status = 'withdrawn') must not touch the frozen question versions.
-- WHY review_state next to status (not a wider status CHECK): status is read by import, clone, the
--   assessment picker and scoring; widening it would touch every reader.
-- WHY no FK on import_id / uploaded_by: import_id points at question_imports (same module, but
--   an import may be discarded) and uploaded_by at users (module 03). A cross-module FK in a
--   module-local table breaks per-module test harnesses (RCA 2026-10-17, migration 0183).
--   tenant_id keeps its FK to tenants(id) like question_imports (0174): tenants sorts before
--   every module-04 migration in every harness.
-- WHY tenant_id + direct RLS here (not JOIN-derived like questions): the new table has its own
--   tenant_id column, so the standard variant applies (lint-rls-policies rule 1).
-- GRANTs: not needed. 0002_rls_helpers.sql default privileges cover new tables.
--
-- BACKFILL (same file, idempotent)
--   origin from question_packs.source:  authored -> original_human, generated -> ai_original,
--     import -> tenant_upload when the pack tenant is NOT the platform tenant (slug 'platform'),
--     else original_human (a platform super-admin import is platform-authored content).
--   rights_status = 'original' for every existing row.
--   content_hash / normalised_text_hash stay NULL: the JS stable-JSON hash used by the import
--     (import/staging.ts) cannot be computed in SQL. They are filled lazily by the application.
--   review_state = 'verified' for every ACTIVE question present when this migration first runs.
--     This is GRANDFATHERED, not reviewed: nobody checked these keys under the EXP-18 gate. The
--     UPDATE runs only when the column is created by this run, so re-running never marks later
--     active questions verified.
--
-- Forward-only. Idempotent: IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE POLICY,
--   ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS question_source (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL REFERENCES tenants(id),
  question_id           UUID        NOT NULL UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
  origin                TEXT        NOT NULL CHECK (origin IN (
                          'original_human', 'ai_original', 'ai_seeded', 'derived_from_source',
                          'scraped_raw', 'tenant_upload', 'licensed')),
  rights_status         TEXT        NOT NULL CHECK (rights_status IN (
                          'original', 'derived_from_source', 'scraped_raw', 'licensed',
                          'metadata_only', 'withdrawn')),
  source_ref            TEXT,
  source_url            TEXT,
  seed_ref              TEXT,
  import_id             UUID,
  uploaded_by           UUID,
  licence_id            TEXT,
  source_difficulty_raw TEXT,
  content_hash          TEXT,
  normalised_text_hash  TEXT,
  pyq_year              INT,
  pyq_date              DATE,
  pyq_shift             TEXT,
  pyq_paper_code        TEXT,
  pyq_qno               INT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS question_source_content_hash_idx ON question_source (tenant_id, content_hash);
CREATE INDEX IF NOT EXISTS question_source_norm_hash_idx    ON question_source (tenant_id, normalised_text_hash);
CREATE INDEX IF NOT EXISTS question_source_rights_idx       ON question_source (tenant_id, rights_status);

ALTER TABLE question_source ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON question_source;
CREATE POLICY tenant_isolation ON question_source
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_insert ON question_source;
CREATE POLICY tenant_isolation_insert ON question_source
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS difficulty_est   SMALLINT CHECK (difficulty_est IS NULL OR difficulty_est BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS language_primary TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS content_i18n     JSONB;

-- review_state + grandfather: only when this run creates the column (see header).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'questions' AND column_name = 'review_state'
  ) THEN
    ALTER TABLE questions
      ADD COLUMN review_state TEXT
      CHECK (review_state IS NULL OR review_state IN ('in_review', 'verified', 'disputed', 'needs_fix'));
    UPDATE questions SET review_state = 'verified' WHERE status = 'active';
  END IF;
END $$;

INSERT INTO question_source (tenant_id, question_id, origin, rights_status)
SELECT p.tenant_id,
       q.id,
       CASE p.source
         WHEN 'generated' THEN 'ai_original'
         WHEN 'import' THEN
           CASE WHEN p.tenant_id = (SELECT t.id FROM tenants t WHERE t.slug = 'platform' LIMIT 1)
                THEN 'original_human' ELSE 'tenant_upload' END
         ELSE 'original_human'
       END,
       'original'
  FROM questions q
  JOIN question_packs p ON p.id = q.pack_id
ON CONFLICT (question_id) DO NOTHING;
