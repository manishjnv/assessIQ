-- EXP-14 phase 1 (design docs/design/2026-10-21-future-ready-question-store.md D3, FUT-5 part 1, section 10).
-- WHAT  Direct tenant_id on questions, question_versions, question_tags, question_taxonomy, and pack_id on
--       the four child tables, so phase 2 policies can read `tenant_id = current OR pack_id = ANY(...)`
--       without a per-row EXISTS. A BEFORE INSERT trigger copies both from the parent, so NO insert site
--       changes (module 07 stays untouched). Composite foreign keys make a row that claims a pack of
--       another tenant impossible (a foreign key ignores RLS).
-- WHY   shared (licensed) read of platform packs needs the owner and the pack on every row. Order inside:
--       add nullable, backfill from the parent, SET NOT NULL, add trigger. No policy changes here, so
--       behaviour is unchanged. RLS is never disabled.
-- NOT INCLUDED  policies, the readable_platform_packs() function (phase 2), passages (no pack_id; handled in
--       phase 2), attempt tables (FUT-5 part 2 waits for the k6 run).
-- The trigger fills a value only when it is NULL; an explicit wrong value is rejected by the composite FK.
-- Forward-only, idempotent. Rollback: drop the triggers, functions, composite FKs, indexes, then the columns.

-- Target of the composite foreign key on questions.
CREATE UNIQUE INDEX IF NOT EXISTS question_packs_id_tenant_uq ON question_packs (id, tenant_id);

-- 1. questions ---------------------------------------------------------------------------------
ALTER TABLE questions ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE questions q SET tenant_id = p.tenant_id FROM question_packs p WHERE p.id = q.pack_id AND q.tenant_id IS NULL;
ALTER TABLE questions ALTER COLUMN tenant_id SET NOT NULL;

CREATE OR REPLACE FUNCTION questions_fill_tenant() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    SELECT p.tenant_id INTO NEW.tenant_id FROM question_packs p WHERE p.id = NEW.pack_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS questions_fill_tenant ON questions;
CREATE TRIGGER questions_fill_tenant BEFORE INSERT ON questions
  FOR EACH ROW EXECUTE FUNCTION questions_fill_tenant();

DO $$ BEGIN
  ALTER TABLE questions ADD CONSTRAINT questions_pack_tenant_fk
    FOREIGN KEY (pack_id, tenant_id) REFERENCES question_packs (id, tenant_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS questions_tenant_idx ON questions (tenant_id);

-- Target of the composite foreign keys on the child tables: the question triple.
CREATE UNIQUE INDEX IF NOT EXISTS questions_id_pack_tenant_uq ON questions (id, pack_id, tenant_id);

-- 2. children of questions: one pattern, four tables ----------------------------------------------
ALTER TABLE question_versions ADD COLUMN IF NOT EXISTS tenant_id uuid, ADD COLUMN IF NOT EXISTS pack_id uuid;
ALTER TABLE question_tags     ADD COLUMN IF NOT EXISTS tenant_id uuid, ADD COLUMN IF NOT EXISTS pack_id uuid;
ALTER TABLE question_taxonomy ADD COLUMN IF NOT EXISTS tenant_id uuid, ADD COLUMN IF NOT EXISTS pack_id uuid;
ALTER TABLE question_source   ADD COLUMN IF NOT EXISTS pack_id uuid;

UPDATE question_versions t SET tenant_id = q.tenant_id, pack_id = q.pack_id
  FROM questions q WHERE q.id = t.question_id AND (t.tenant_id IS NULL OR t.pack_id IS NULL);
UPDATE question_tags t SET tenant_id = q.tenant_id, pack_id = q.pack_id
  FROM questions q WHERE q.id = t.question_id AND (t.tenant_id IS NULL OR t.pack_id IS NULL);
UPDATE question_taxonomy t SET tenant_id = q.tenant_id, pack_id = q.pack_id
  FROM questions q WHERE q.id = t.question_id AND (t.tenant_id IS NULL OR t.pack_id IS NULL);
UPDATE question_source t SET pack_id = q.pack_id
  FROM questions q WHERE q.id = t.question_id AND t.pack_id IS NULL;

ALTER TABLE question_versions ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN pack_id SET NOT NULL;
ALTER TABLE question_tags     ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN pack_id SET NOT NULL;
ALTER TABLE question_taxonomy ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN pack_id SET NOT NULL;
ALTER TABLE question_source   ALTER COLUMN pack_id SET NOT NULL;

-- One trigger function for all four. tenant_id is filled only where the table gets it here
-- (question_source already had it NOT NULL, so its insert always supplies it).
CREATE OR REPLACE FUNCTION question_child_fill_owner() RETURNS trigger AS $$
DECLARE
  q_tenant uuid;
  q_pack   uuid;
BEGIN
  SELECT q.tenant_id, q.pack_id INTO q_tenant, q_pack FROM questions q WHERE q.id = NEW.question_id;
  IF NEW.pack_id IS NULL THEN NEW.pack_id := q_pack; END IF;
  IF TG_TABLE_NAME <> 'question_source' AND NEW.tenant_id IS NULL THEN NEW.tenant_id := q_tenant; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS question_versions_fill_owner ON question_versions;
CREATE TRIGGER question_versions_fill_owner BEFORE INSERT ON question_versions
  FOR EACH ROW EXECUTE FUNCTION question_child_fill_owner();
DROP TRIGGER IF EXISTS question_tags_fill_owner ON question_tags;
CREATE TRIGGER question_tags_fill_owner BEFORE INSERT ON question_tags
  FOR EACH ROW EXECUTE FUNCTION question_child_fill_owner();
DROP TRIGGER IF EXISTS question_taxonomy_fill_owner ON question_taxonomy;
CREATE TRIGGER question_taxonomy_fill_owner BEFORE INSERT ON question_taxonomy
  FOR EACH ROW EXECUTE FUNCTION question_child_fill_owner();
DROP TRIGGER IF EXISTS question_source_fill_owner ON question_source;
CREATE TRIGGER question_source_fill_owner BEFORE INSERT ON question_source
  FOR EACH ROW EXECUTE FUNCTION question_child_fill_owner();

-- Composite FKs: the row (question, pack, tenant) must be the question real triple.
DO $$ BEGIN
  ALTER TABLE question_versions ADD CONSTRAINT question_versions_owner_fk
    FOREIGN KEY (question_id, pack_id, tenant_id) REFERENCES questions (id, pack_id, tenant_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE question_tags ADD CONSTRAINT question_tags_owner_fk
    FOREIGN KEY (question_id, pack_id, tenant_id) REFERENCES questions (id, pack_id, tenant_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE question_taxonomy ADD CONSTRAINT question_taxonomy_owner_fk
    FOREIGN KEY (question_id, pack_id, tenant_id) REFERENCES questions (id, pack_id, tenant_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE question_source ADD CONSTRAINT question_source_owner_fk
    FOREIGN KEY (question_id, pack_id, tenant_id) REFERENCES questions (id, pack_id, tenant_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS question_versions_tenant_idx ON question_versions (tenant_id);
CREATE INDEX IF NOT EXISTS question_versions_pack_idx   ON question_versions (pack_id);
CREATE INDEX IF NOT EXISTS question_tags_pack_idx       ON question_tags (pack_id);
CREATE INDEX IF NOT EXISTS question_taxonomy_pack_idx   ON question_taxonomy (pack_id);
CREATE INDEX IF NOT EXISTS question_source_pack_idx     ON question_source (pack_id);
