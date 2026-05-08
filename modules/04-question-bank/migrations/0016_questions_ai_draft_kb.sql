-- owned by modules/04-question-bank
-- Adds AI question generation support to the questions table.
--
-- Two changes, gated together so the question_versions snapshot trigger sees
-- a coherent schema for newly-generated rows:
--
--   1. Extend the `status` CHECK constraint to allow 'ai_draft' — generated
--      questions land in this status until an admin reviews and promotes them
--      to 'draft' (or 'active' on first activation). This is distinct from
--      'draft' so the admin queue can filter "needs review" vs "human-authored
--      draft" without an extra column.
--
--   2. Add `knowledge_base_sources` JSONB column to BOTH `questions` and
--      `question_versions`. Records which curated KB entries (e.g. MITRE T1059,
--      NIST IR Phase 2) were embedded in the prompt context that produced this
--      question. Per-row provenance enables (a) admin-visible source-citation
--      chips on draft cards, (b) duplicate-detection across packs, and
--      (c) audit reproducibility against the soc.json version stored in the
--      first array element's `kb_version` field.
--
-- Shape of `knowledge_base_sources`:
--   [
--     {
--       "id":         "mitre.t1059",                -- soc.json source id
--       "name":       "Command and Scripting Interpreter",
--       "citation":   "MITRE ATT&CK T1059",
--       "url":        "https://attack.mitre.org/techniques/T1059/",
--       "kb_version": "2026-05-08"                  -- soc.json `version` field
--     },
--     ...
--   ]
--
-- Defaults to '[]'::jsonb so every existing question (and every new
-- human-authored question that doesn't go through the generator) carries an
-- empty array — never NULL — keeping downstream UI render code simple.
--
-- No RLS change needed: `knowledge_base_sources` is per-row data scoped by the
-- existing tenant_isolation policies on questions / question_versions.

-- 1. Extend status CHECK constraint to add 'ai_draft'
ALTER TABLE questions DROP CONSTRAINT questions_status_check;
ALTER TABLE questions ADD CONSTRAINT questions_status_check
  CHECK (status IN ('draft','active','archived','ai_draft'));

-- 2a. Add column to questions
ALTER TABLE questions
  ADD COLUMN knowledge_base_sources JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2b. Add column to question_versions (snapshots inherit provenance)
ALTER TABLE question_versions
  ADD COLUMN knowledge_base_sources JSONB NOT NULL DEFAULT '[]'::jsonb;
