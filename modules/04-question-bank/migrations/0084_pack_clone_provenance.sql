-- owned by modules/04-question-bank
-- Step 2 (question-set sharing via clone-on-grant) — provenance columns.
-- See docs/design/question-set-sharing-clone-on-grant.md § Phase 1.
--
-- WHAT:
--   When a super-admin grant copies a published platform-library pack into a
--   company tenant, the copy records WHERE it came from:
--     question_packs.source_pack_id  — the platform pack it was cloned from
--     question_packs.source_version  — that pack's version at clone time
--     questions.source_question_id   — lineage of each cloned question
--
-- WHY nullable (no NOT NULL, no backfill):
--   Originals (platform packs, hand-authored packs) carry NULL — they have no
--   source. Only clones populate these columns. A NOT NULL would break every
--   existing row. Same fail-safe shape as the 0018 nullable domain_id/category_id.
--
-- WHY no FK to the source row:
--   The source lives in a DIFFERENT tenant (the platform tenant). A real FK
--   would be a cross-tenant reference — exactly the coupling clone-on-grant
--   avoids. Provenance is a SOFT pointer (used for idempotent re-grant and the
--   opt-in "newer version available / re-sync" check), not a referential
--   constraint. If a source pack is later archived/removed, clones stand alone.
--
-- WHY no new RLS policies:
--   The columns ride the existing table RLS — question_packs uses direct
--   tenant_id RLS; questions uses JOIN-based RLS via pack_id. Adding columns
--   changes neither policy. No cross-tenant read is introduced (the clone is a
--   privileged system-role WRITE, performed in the grant transaction).
--
-- Idempotency: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS — re-running
-- this migration is safe.
--
-- WHY the index:
--   The grant path looks up "does this tenant already have a clone of source
--   pack X?" (idempotent re-grant) and the re-sync check scans a tenant's clones
--   by source. (tenant_id, source_pack_id) serves both; partial WHERE keeps it
--   small (only clone rows are indexed).

ALTER TABLE question_packs
  ADD COLUMN IF NOT EXISTS source_pack_id UUID,
  ADD COLUMN IF NOT EXISTS source_version INT;

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS source_question_id UUID;

CREATE INDEX IF NOT EXISTS question_packs_source_idx
  ON question_packs (tenant_id, source_pack_id)
  WHERE source_pack_id IS NOT NULL;
