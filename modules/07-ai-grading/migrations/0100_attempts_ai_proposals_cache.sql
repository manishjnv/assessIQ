-- 0100_attempts_ai_proposals_cache.sql
-- Bug A Phase 2 (2026-05-29): persist AI grading proposals server-side so
-- they survive HTTP timeouts (Cloudflare's ~100s edge timeout was killing
-- the 4-minute synchronous POST /grade response mid-flight) AND admin tab
-- navigation. Server-side compute continues to completion regardless of
-- client disconnect (Fastify default) — this cache captures the result so
-- the admin can pick it up on the next page load.
--
-- D8 compliance frame UNCHANGED: ai_proposals is review-state only. NO
-- gradings row is written without an explicit admin Accept click. The
-- cache is just an intermediate buffer between handleAdminGrade's batch
-- output and the admin's Accept decision.
--
-- ai_proposals: the most-recent GradingProposal[] from handleAdminGrade.
--   Written at batch end. Cleared by acceptProposals on a successful
--   gate-flip (true completion). Replaced by handleAdminGrade /
--   handleAdminRerun on re-grade. Schema is the runtime's GradingProposal
--   array, JSONB so we can store the heterogeneous proposal shape without
--   a sub-table per field.
--
-- grading_started_at: in-flight marker. Set by handleAdminGrade on entry
--   (after status / heartbeat / single-flight checks pass), nulled at
--   batch completion (regardless of success / per-question failure).
--   Drives the FE "Grading in progress" banner and 15s poll cadence.
--
-- Both columns are NULLable — every legacy attempt row keeps working.

ALTER TABLE attempts
  ADD COLUMN ai_proposals       JSONB,
  ADD COLUMN grading_started_at TIMESTAMPTZ;

-- Partial index: lets the (rarely-needed) "find attempts currently grading"
-- query short-circuit cheaply. Most attempts have NULL here so the index
-- stays small.
CREATE INDEX attempts_grading_started_at_idx
  ON attempts (grading_started_at)
  WHERE grading_started_at IS NOT NULL;

COMMENT ON COLUMN attempts.ai_proposals IS
  'D8 review cache: latest GradingProposal[] from handleAdminGrade. NOT committed grades — admin Accept click still required. Cleared on true completion (acceptProposals gate flip). Replaced on re-grade / rerun.';
COMMENT ON COLUMN attempts.grading_started_at IS
  'D7 in-flight marker. Set on grade-batch start (post heartbeat + single-flight checks), nulled at batch completion. Drives FE "grading in progress" banner + auto-poll.';
