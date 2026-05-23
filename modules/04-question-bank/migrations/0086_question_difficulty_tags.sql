-- 0086_question_difficulty_tags.sql
-- Phase A (question difficulty spec): add intrinsic-difficulty tagging columns to
-- `questions` and its `question_versions` snapshots.
--
-- Forward-only: legacy rows stay NULL (untagged); new AI-generated rows are stamped
-- by the generation handler in Phase A3. No backfill.
--
-- No RLS change: `questions` tenancy is JOIN-derived via pack_id -> question_packs.tenant_id
-- (the new columns ride the existing policies, same as 0016 / 0084).
--
-- TEXT + CHECK for the Bloom enum (repo convention — no Postgres ENUM types anywhere).
-- See docs/design/2026-05-23-question-difficulty-spec.md section 7.

-- ── questions ────────────────────────────────────────────────────────────────
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS cognitive_level   TEXT,
  ADD COLUMN IF NOT EXISTS nice_task_id      TEXT,
  ADD COLUMN IF NOT EXISTS difficulty_params JSONB,
  ADD COLUMN IF NOT EXISTS attack_technique  TEXT[];

ALTER TABLE questions ADD CONSTRAINT questions_cognitive_level_check
  CHECK (cognitive_level IS NULL OR cognitive_level IN
    ('remember','understand','apply','analyze','evaluate','create'));

-- ── question_versions (snapshots inherit difficulty tags — precedent: 0016) ────
ALTER TABLE question_versions
  ADD COLUMN IF NOT EXISTS cognitive_level   TEXT,
  ADD COLUMN IF NOT EXISTS nice_task_id      TEXT,
  ADD COLUMN IF NOT EXISTS difficulty_params JSONB,
  ADD COLUMN IF NOT EXISTS attack_technique  TEXT[];

ALTER TABLE question_versions ADD CONSTRAINT question_versions_cognitive_level_check
  CHECK (cognitive_level IS NULL OR cognitive_level IN
    ('remember','understand','apply','analyze','evaluate','create'));
