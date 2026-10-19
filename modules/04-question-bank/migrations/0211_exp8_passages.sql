-- owned by modules/04-question-bank
-- 0211 — EXP-8: passages shared by several question rows.
--
-- WHAT
--   passages          one row per shared stem (reading text, data set, logic set): tenant_id, optional
--                     title, body (plain text / markdown-safe, rendered like a question stem), language,
--                     source_passage_id (clone provenance).
--   questions         + passage_id (nullable FK), + passage_position (order inside the passage).
--
-- WHY passages are immutable (trigger below)
--   attempt_questions (06, migration 0213) freezes only the passage id. If the body could change,
--   a running or finished attempt would show new text. To change a passage, insert a new row and
--   repoint the questions; old attempts keep the old row.
-- WHY no delete: questions.passage_id is ON DELETE RESTRICT; a passage with children cannot go.
-- WHY no backfill: no existing question has a passage.
-- WHY tenant_id + direct RLS: passages carries its own tenant_id (lint-rls-policies rule 1).
-- NOT INCLUDED  Images in passages (EXP-10), a passage edit screen.
-- No cross-module FK (RCA 2026-10-17, 0183). Forward-only, idempotent.

CREATE TABLE IF NOT EXISTS passages (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES tenants(id),
  title             TEXT,
  body              TEXT        NOT NULL CHECK (btrim(body) <> ''),
  language          TEXT        NOT NULL DEFAULT 'en',
  source_passage_id UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS passages_tenant_source_uq
  ON passages (tenant_id, source_passage_id) WHERE source_passage_id IS NOT NULL;

ALTER TABLE passages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON passages;
CREATE POLICY tenant_isolation ON passages
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_insert ON passages;
CREATE POLICY tenant_isolation_insert ON passages
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE OR REPLACE FUNCTION passages_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'passages are immutable: insert a new passage and repoint the questions';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS passages_immutable ON passages;
CREATE TRIGGER passages_immutable BEFORE UPDATE ON passages
  FOR EACH ROW EXECUTE FUNCTION passages_immutable();

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS passage_id       UUID REFERENCES passages(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS passage_position INT;

CREATE INDEX IF NOT EXISTS questions_passage_idx ON questions (passage_id) WHERE passage_id IS NOT NULL;
