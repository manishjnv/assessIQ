-- owned by modules/07-ai-grading
-- Phase 2 observability — generation_attempts table.
--
-- Records every call to handleAdminGenerate so admins can diagnose why a
-- "Generate" click produced 0 rows without SSH'ing the VPS.
--
-- WHY owned by ai-grading (not question-bank):
--   The INSERT/UPDATE path lives in modules/07-ai-grading/src/handlers/
--   admin-generate.ts. The table references ai-grading concepts (skill_sha,
--   model, stderr_tail). The GET endpoint that reads it lives in
--   modules/04-question-bank/src/routes.ts — a read-only projection for the
--   pack-detail UI.
--
-- status state machine:
--   running → success | partial | failed
--   'partial' means chunks_failed > 0 but at least one chunk succeeded.
--   (Option B parallelisation; chunks_* columns are NULL until Option B ships.)
--
-- stderr_tail privacy gate:
--   Persisted ONLY for non-grading skills (generate-questions, generate-rubric).
--   For grading skills, stderr is captured in memory but never logged or
--   persisted — candidate text must not appear in any durable store.
--   See modules/07-ai-grading/src/runtimes/claude-code-vps.ts for the gate.
--
-- APPEND-MOSTLY: the only update path is the status finalization in
--   admin-generate.ts. No deletes, no edits.
--
-- Standard tenant_id-bearing RLS variant (mirrors 0040_gradings.sql).

CREATE TABLE generation_attempts (
  id               UUID        NOT NULL PRIMARY KEY,  -- UUIDv7, generated app-side
  tenant_id        UUID        NOT NULL REFERENCES tenants(id),
  pack_id          UUID        NOT NULL,
  level_id         UUID        NOT NULL,
  user_id          UUID        NOT NULL REFERENCES users(id),
  count_requested  INT         NOT NULL,
  count_inserted   INT         NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL CHECK (status IN (
                     'success', 'partial', 'failed', 'running'
                   )),
  error_code       TEXT,
  error_message    TEXT,
  stderr_tail      TEXT,         -- last 1024 bytes of claude stderr; generation skills only
  skill_sha        TEXT,
  model            TEXT,
  chunks_planned   INT,          -- NULL until Option B parallel fanout ships
  chunks_failed    INT,          -- NULL until Option B parallel fanout ships
  dedupe_dropped   INT,          -- NULL until Option B parallel fanout ships
  duration_ms      INT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);

-- Most-recent attempts for a pack+level — drives the pack-detail UI query.
CREATE INDEX generation_attempts_pack_level_idx
  ON generation_attempts (pack_id, level_id, started_at DESC);

ALTER TABLE generation_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON generation_attempts
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON generation_attempts
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
