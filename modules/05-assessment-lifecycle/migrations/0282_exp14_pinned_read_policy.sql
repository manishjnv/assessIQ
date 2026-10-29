-- EXP-14 phase 2, part 4 (design docs/design/2026-10-21-future-ready-question-store.md D4, section 12).
-- WHAT  Policy licensed_read_pinned ON questions FOR SELECT: a question that is in the caller's OWN frozen pool (and is
--       not a draft) stays readable even after the licence is revoked, so running tests keep working. Nothing else is
--       browsable after a revoke. ORed with licensed_read (04/0280). Dormant behind the same app.licensed_read switch.
--       SELECT only; no write verb gains a path. Module 05 owns assessment_frozen_pool, hence this file.
-- Forward-only, idempotent.
-- Rollback: DROP POLICY licensed_read_pinned ON questions;

DROP POLICY IF EXISTS licensed_read_pinned ON questions;
CREATE POLICY licensed_read_pinned ON questions FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND status <> 'draft'
    AND EXISTS (SELECT 1 FROM assessment_frozen_pool f WHERE f.question_id = questions.id)
  );
