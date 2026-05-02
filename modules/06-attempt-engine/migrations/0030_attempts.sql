-- owned by modules/06-attempt-engine
-- Phase 1 G1.C Session 4 — attempts table.
--
-- An attempt is a candidate's session against one assessment. Created at
-- startAttempt time, transitions through 'in_progress' to a terminal status
-- via submitAttempt or the auto-submit sweep. The state machine is enforced in
-- src/service.ts (no separate state-machine.ts — the transition table is small
-- enough to live with the service writes).
--
-- Phase 1 status enum (per docs/05-ai-pipeline.md + PROJECT_BRAIN.md decision):
--   draft → in_progress → submitted | auto_submitted | cancelled
-- 'pending_admin_grading', 'graded', 'released' are reserved for Phase 2; the
-- value 'grading' is reserved for the Phase 2 async worker. The CHECK
-- constraint accepts all of them so Phase 2 needs no schema change — only the
-- service-layer transition table grows.
--
-- WHY tenant_id directly (standard RLS variant, not JOIN-based):
--   attempts is the chokepoint for every cross-table query: attempt_questions,
--   attempt_answers, attempt_events all derive tenancy through THIS row. A
--   direct tenant_id column makes the EXISTS sub-select on the children's RLS
--   policies a single-hop lookup against an indexed column. Storing tenant_id
--   redundantly with (assessment_id → assessments.tenant_id) is acceptable —
--   the FK chain and the column are both checked at INSERT via WITH CHECK,
--   and a service-layer regression that reaches the wrong tenant would fail
--   either gate.
--
-- WHY ends_at is a stored column, not computed:
--   Server is the single source of truth for the timer (per SKILL.md § Time
--   enforcement). Pinning ends_at at startAttempt time means: (a) the timer
--   does not change if an admin edits level.duration_minutes mid-attempt
--   (defensive against inadvertent mutation), and (b) the boundary sweep can
--   filter `ends_at < now()` against an index without a JOIN to levels.
--
-- WHY UNIQUE (assessment_id, user_id) (decision #22):
--   v1 caps to one attempt per candidate per assessment. Re-attempts are an
--   explicit Phase 2+ feature that introduces an attempt_number column.
--   Until then the unique constraint is the structural enforcement.

CREATE TABLE attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  assessment_id   UUID NOT NULL REFERENCES assessments(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft',
      'in_progress',
      'submitted',
      'auto_submitted',
      'cancelled',
      'pending_admin_grading',
      'graded',
      'released'
    )),
  started_at      TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  submitted_at    TIMESTAMPTZ,
  duration_seconds INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, user_id)
);

-- Lookup index for "what attempts has this candidate started?" — drives the
-- /me/assessments endpoint and the candidate-side resume flow.
CREATE INDEX attempts_user_idx
  ON attempts (tenant_id, user_id);

-- Lookup index for the boundary sweep — finds in_progress attempts whose
-- timer has expired. Partial index keeps it small (most attempts are not
-- in_progress at any given moment).
CREATE INDEX attempts_timer_sweep_idx
  ON attempts (ends_at)
  WHERE status = 'in_progress';

-- Lookup for admin "list attempts for this assessment" — the GET
-- /admin/assessments/:id/attempts endpoint mentioned in api-contract.md
-- (extension column; will land with module 06 admin routes in Session 4b).
CREATE INDEX attempts_assessment_status_idx
  ON attempts (assessment_id, status);

ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON attempts
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON attempts
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
