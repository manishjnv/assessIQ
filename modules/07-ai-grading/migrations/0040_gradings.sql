-- owned by modules/07-ai-grading
-- Phase 2 G2.A Session 1.a — gradings table.
--
-- WHY one combined CREATE (vs the kickoff plan's ALTER-from-existing):
--   The kickoff plan (PHASE_2_KICKOFF.md G2.A Session 1) assumed `gradings`
--   already existed from Phase 0/1. Investigation 2026-05-03 (memory obs 834)
--   confirmed it does not — no migration creates the table. So this single
--   migration creates the table with all Phase 2 columns from the start
--   (D4: prompt_version_sha, prompt_version_label, model; D-related:
--   escalation_chosen_stage). The kickoff's separate 0041 ALTER for
--   escalation_chosen_stage is folded in.
--
--   The kickoff's "migration-internal sanity assertion" gating non-backfill
--   is therefore unnecessary — the CREATE TABLE has zero pre-existing rows
--   by construction.
--
-- D4 — prompt_version_sha is `anchors:<8hex>;band:<8hex>;escalate:<8hex|->`.
--   See docs/05-ai-pipeline.md D4 for the format. NOT NULL because every
--   AI grading row MUST be reproducible from a known prompt sha.
--   prompt_version_label is the human-readable from the skill frontmatter.
--   model is the concatenated model identifiers used.
--
-- Override / re-grade audit (D8): override_of points at the original
-- gradings row; an admin override never UPDATEs an existing row.
-- Re-grade always INSERTs a new row.
--
-- escalation_chosen_stage records which stage of the cascade actually
-- produced the row: '2' (Sonnet band), '3' (Opus escalate), 'manual'
-- (admin authored), or NULL (deterministic / pattern grader). Drives the
-- module 10 admin dashboard "stage badge" rendering.
--
-- Standard tenant_id-bearing RLS variant.

CREATE TABLE gradings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  attempt_id               UUID NOT NULL REFERENCES attempts(id),
  question_id              UUID NOT NULL REFERENCES questions(id),
  grader                   TEXT NOT NULL CHECK (grader IN (
    'deterministic','pattern','ai','admin_override'
  )),
  score_earned             NUMERIC(6,2) NOT NULL,
  score_max                NUMERIC(6,2) NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN (
    'correct','incorrect','partial','review_needed','overridden'
  )),
  anchor_hits              JSONB,
  reasoning_band           INT,
  ai_justification         TEXT,
  error_class              TEXT,
  -- D4: per-row prompt SHA pinning. NOT NULL — every AI row reproducible.
  prompt_version_sha       TEXT NOT NULL,
  prompt_version_label     TEXT NOT NULL,
  model                    TEXT NOT NULL,
  -- D6/D-related: which stage of the cascade actually graded this row.
  escalation_chosen_stage  TEXT CHECK (escalation_chosen_stage IS NULL OR escalation_chosen_stage IN ('2','3','manual')),
  graded_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  graded_by                UUID REFERENCES users(id),
  override_of              UUID REFERENCES gradings(id),
  override_reason          TEXT
);

CREATE INDEX gradings_attempt_idx ON gradings (attempt_id, question_id);

-- D7 single-flight idempotency: re-grade same attempt+question with same
-- prompt SHA returns the existing row rather than writing a new one. Phase 1
-- single-flight is the in-process mutex; this UNIQUE is the structural
-- backstop so a buggy mutex doesn't allow duplicate rows.
CREATE UNIQUE INDEX gradings_attempt_question_sha_idx
  ON gradings (attempt_id, question_id, prompt_version_sha)
  WHERE override_of IS NULL;

ALTER TABLE gradings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON gradings
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON gradings
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
