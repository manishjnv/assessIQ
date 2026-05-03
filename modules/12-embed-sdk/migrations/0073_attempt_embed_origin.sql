-- Phase 4: add embed_origin flag to attempts so host apps can identify
-- iframe-sourced attempts in webhook payloads (D9).
-- Spec: modules/12-embed-sdk/SKILL.md § Decisions captured (2026-05-03) D9.
-- docs/02-data-model.md § Attempt engine (attempts table) needs a same-PR update.
--
-- Owned by 06-attempt-engine; migration co-located in 12-embed-sdk per SKILL.md D9.
--
-- RLS note: attempts uses standard two-policy RLS on tenant_id.
-- No new policy needed — existing policies cover the new column.
--
-- Partial index: only indexes rows where embed_origin = TRUE (small fraction of total).

ALTER TABLE attempts
  ADD COLUMN embed_origin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX attempts_embed_origin_idx
  ON attempts (tenant_id, embed_origin)
  WHERE embed_origin = TRUE;
