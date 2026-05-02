-- owned by modules/05-assessment-lifecycle
-- Phase 1 G1.B Session 3 — assessments table.
--
-- An assessment is a runnable instance composed from one (pack, level) tuple,
-- scheduled with opens_at/closes_at, and presented to invited candidates. The
-- state machine lives in src/state-machine.ts; this table just stores the
-- current state and the scheduling/composition fields that drive it.
--
-- pgcrypto (gen_random_uuid) is enabled by modules/02-tenancy/migrations/0001_tenants.sql;
-- not re-enabled here.
--
-- WHY current_setting(..., true) — the `, true` second argument:
--   With `true`, current_setting returns NULL instead of raising
--   "unrecognized configuration parameter" when the GUC has never been SET.
--   RLS then evaluates `tenant_id = NULL` which is FALSE (SQL three-value logic),
--   so every row is filtered out. Fail-closed behaviour: an unauthenticated or
--   misconfigured session sees zero rows rather than all rows.
--
-- WHY pack_version (additive vs docs/02-data-model.md § "Assessment lifecycle"):
--   The data-model schema does not list a `pack_version` column. We add it here
--   per the Phase 1 G1.B Session 3 plan (warm-start summary) so each assessment
--   pins to the exact pack.version at create time. Without this pointer, an
--   admin republishing a pack (which bumps `question_packs.version`) would
--   silently change the question pool of every draft assessment that references
--   it. Storing pack_version makes the assessment's content contract a
--   `(pack_id, pack_version)` tuple and decouples assessment lifecycle from
--   pack republishing. Set at INSERT time from `question_packs.version`;
--   never updated afterwards. docs/02-data-model.md is updated in the same PR.
--
-- WHY the CHECK on opens_at/closes_at:
--   The state machine rejects publish/active when closes_at <= opens_at, but
--   the DB-layer CHECK is the structural backstop — defence-in-depth against
--   future code paths that might bypass the service-layer check. NULLs are
--   allowed because draft assessments may not yet have either bound set.

CREATE TABLE assessments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  pack_id         UUID NOT NULL REFERENCES question_packs(id),
  level_id        UUID NOT NULL REFERENCES levels(id),
  pack_version    INT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  status          assessment_status NOT NULL DEFAULT 'draft',
  question_count  INT NOT NULL CHECK (question_count >= 1),
  randomize       BOOLEAN NOT NULL DEFAULT true,
  opens_at        TIMESTAMPTZ,
  closes_at       TIMESTAMPTZ,
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assessments_window_chk
    CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at)
);

-- Index supporting:
--   - listAssessments(tenant, status?) — RLS filters tenant_id; status drives the
--     remaining predicate. The index lets the planner skip a seq-scan for tenants
--     with many assessments.
CREATE INDEX assessments_tenant_status_idx
  ON assessments (tenant_id, status);

-- Indexes supporting the BullMQ boundary job (boundaries.ts).
-- The cron query is roughly:
--   UPDATE assessments SET status='active'
--    WHERE status='published' AND opens_at <= now()
-- A partial index on (status, opens_at) keeps the index small (most assessments
-- are not in `published` state at any moment) and gives a direct range scan.
CREATE INDEX assessments_open_boundary_idx
  ON assessments (opens_at)
  WHERE status = 'published';

CREATE INDEX assessments_close_boundary_idx
  ON assessments (closes_at)
  WHERE status = 'active';

ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON assessments
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON assessments
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
