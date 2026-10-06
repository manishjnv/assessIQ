-- 0160_billing_events_ai_answer_meter.sql
--
-- FU-A4 / FU-A9 (2026-10-06): second meter "AI-evaluated answers".
-- One billing_events row per (tenant, attempt, question) when the super admin
-- accepts an AI grading for a written answer (07 admin-accept.ts, same tx as
-- the gradings insert). The existing 'assessment_graded' row (one credit per
-- graded attempt) is unchanged and stays in the grade-commit transaction.
--
-- Schema changes:
--   * question_id UUID NULL — set only on 'ai_answer_evaluated' rows. No FK:
--     the ledger must survive a question being deleted or archived.
--   * event_type CHECK gains 'ai_answer_evaluated'.
--   * The UNIQUE (tenant_id, attempt_id) constraint is replaced by two partial
--     unique indexes, one per event type, so an attempt can carry one graded
--     row AND one row per AI-evaluated answer. Both keep the idempotency rule
--     (re-accept / re-grade never double-charges).
--   * (tenant_id, event_type, occurred_at) index for the monthly cycle counts (FU-A2).
-- RLS: unchanged (SELECT / INSERT policies from 0079; UPDATE/DELETE stay revoked).
-- Idempotent: every statement is IF (NOT) EXISTS or guarded.

ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS question_id UUID;

ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_event_type_check;
ALTER TABLE billing_events ADD CONSTRAINT billing_events_event_type_check
  CHECK (event_type IN ('assessment_graded', 'ai_answer_evaluated'));

ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_question_id_check;
ALTER TABLE billing_events ADD CONSTRAINT billing_events_question_id_check
  CHECK (
    (event_type = 'ai_answer_evaluated' AND question_id IS NOT NULL)
    OR (event_type <> 'ai_answer_evaluated' AND question_id IS NULL)
  );

-- Replace the table-wide UNIQUE with per-event-type partial unique indexes.
ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_tenant_id_attempt_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS billing_events_graded_uniq
  ON billing_events (tenant_id, attempt_id)
  WHERE event_type = 'assessment_graded';

CREATE UNIQUE INDEX IF NOT EXISTS billing_events_ai_answer_uniq
  ON billing_events (tenant_id, attempt_id, question_id)
  WHERE event_type = 'ai_answer_evaluated';

-- Cycle-window counts: WHERE tenant_id = $1 AND event_type = $2 AND occurred_at >= $3.
CREATE INDEX IF NOT EXISTS billing_events_tenant_type_time_idx
  ON billing_events (tenant_id, event_type, occurred_at);
