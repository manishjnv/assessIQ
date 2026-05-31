-- owned by modules/07-ai-grading
-- Add batch_id to generation_attempts so the "AI generation history" UI can
-- collapse the per-category rows of ONE "Generate question set" action into a
-- single expandable batch row.
--
-- WHY: the generate-wizard fires one POST /admin/generate per category (each
--   writes its own generation_attempts row — required for per-category progress,
--   resume, and category tagging). A 7-category set therefore produced 7 rows
--   that read as 7 separate runs. batch_id is a client-minted UUID shared by
--   every call of one wizard batch, letting the read-only history projection
--   group them (and a resumed batch keeps the same id, so it stays one group).
--
-- NULLABLE + no backfill: pre-existing rows (and any single-call generation that
--   does not send a batch_id) keep batch_id = NULL and render as standalone rows,
--   exactly as today. Forward-only; additive; no behavioural change to the
--   generation engine itself.
--
-- No new RLS policy needed — batch_id is just another column on an already
--   tenant-isolated table (see 0042_generation_attempts.sql). Grouping is done
--   in the application layer over already-tenant-scoped rows; batch_id is NOT a
--   tenant boundary and is never trusted for isolation.

ALTER TABLE generation_attempts
  ADD COLUMN batch_id UUID;  -- client-minted UUIDv4; NULL for legacy / single-call runs

-- Group lookups for the history projection: most-recent batches first.
-- Partial index (WHERE batch_id IS NOT NULL) keeps it small — only batched runs.
CREATE INDEX generation_attempts_batch_idx
  ON generation_attempts (batch_id, started_at DESC)
  WHERE batch_id IS NOT NULL;
