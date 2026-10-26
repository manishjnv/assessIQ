-- owned by modules/04-question-bank
-- 0266 - CT-0: exam pattern hardening (exam_blueprints).
--
-- WHAT
--   max_questions     per-pattern question cap, default 100 (replaces the fixed zod max 500 on a section).
--   archived_at       archive instead of hard delete. An archived pattern stays readable by id (old
--                     assessments point at it) but is hidden from lists and cannot start a new mock.
--   supersedes_id     the edition this row replaced (a verified edition is never edited; a change adds a row).
--   last_checked_at, next_check_due, owner_contact   monthly upkeep fields (source_note already exists).
--   upkeep_reminded_at   when the monthly reminder mail last named this pattern (dedupe).
--
-- WHY
--   Plan create-a-test-plan.md section 13 and ROADMAP Z.10 CT-0. Today update replaces rows in place and
--   delete is a hard CASCADE delete, so an old edition could change under live tests.
--
-- NOT INCLUDED  kind (fixed/flexible/role/private), tenant_id for private patterns (CT-4), exam grants.
--   No RLS change: the table stays platform data (SELECT policy only, writes run as assessiq_system).
--
-- IDEMPOTENT, forward-only, additive. Existing rows get max_questions 100 and next_check_due = now + 1 month.

ALTER TABLE exam_blueprints ADD COLUMN IF NOT EXISTS max_questions int NOT NULL DEFAULT 100;
ALTER TABLE exam_blueprints ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL;
ALTER TABLE exam_blueprints ADD COLUMN IF NOT EXISTS supersedes_id uuid NULL REFERENCES exam_blueprints(id) ON DELETE SET NULL;
ALTER TABLE exam_blueprints ADD COLUMN IF NOT EXISTS last_checked_at timestamptz NULL;
ALTER TABLE exam_blueprints ADD COLUMN IF NOT EXISTS next_check_due date NOT NULL DEFAULT (CURRENT_DATE + 30);
ALTER TABLE exam_blueprints ADD COLUMN IF NOT EXISTS owner_contact text NULL;
ALTER TABLE exam_blueprints ADD COLUMN IF NOT EXISTS upkeep_reminded_at timestamptz NULL;

DO $$ BEGIN
  ALTER TABLE exam_blueprints ADD CONSTRAINT exam_blueprints_max_questions_chk CHECK (max_questions BETWEEN 1 AND 500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS exam_blueprints_next_check_idx ON exam_blueprints (next_check_due) WHERE archived_at IS NULL;
