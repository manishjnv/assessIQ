-- owned by modules/04-question-bank
-- RW-58 (2026-10-15): super-admin CSV/XLSX question import, staged then committed.
--
-- WHY two tables: an upload is parsed and validated into question_import_rows
--   (decision ok/skip/duplicate/error) so the admin can fix rows before commit.
--   Commit creates ONE draft pack (source = 'import') holding the ok rows only.
-- WHY question_packs.source / import_file_sha256: provenance of imported packs.
--   Default 'authored' covers all existing rows; no backfill is needed.
-- WHY unique (tenant_id, file_sha256) WHERE status = 'staged': re-uploading the same
--   file returns the existing staged import instead of a second one.
-- Not included: any UI (later task); multipart upload (JSON base64 body for now).
-- Standard tenant_id-bearing RLS variant (mirrors 0142 generation_batches).

ALTER TABLE question_packs
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'authored'
    CHECK (source IN ('authored', 'generated', 'import')),
  ADD COLUMN IF NOT EXISTS import_file_sha256 TEXT;

CREATE TABLE question_imports (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES tenants(id),
  created_by        UUID        REFERENCES users(id),
  file_name         TEXT        NOT NULL,
  file_sha256       TEXT        NOT NULL,
  format            TEXT        NOT NULL CHECK (format IN ('csv', 'xlsx')),
  domain            TEXT        NOT NULL,
  pack_name         TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'staged'
                      CHECK (status IN ('staged', 'committed', 'discarded')),
  row_count         INT         NOT NULL DEFAULT 0,
  error_count       INT         NOT NULL DEFAULT 0,
  committed_pack_id UUID        REFERENCES question_packs(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX question_imports_staged_file_idx
  ON question_imports (tenant_id, file_sha256) WHERE status = 'staged';

ALTER TABLE question_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON question_imports
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON question_imports
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE TABLE question_import_rows (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id    UUID        NOT NULL REFERENCES question_imports(id) ON DELETE CASCADE,
  tenant_id    UUID        NOT NULL REFERENCES tenants(id),
  row_number   INT         NOT NULL,
  raw          JSONB       NOT NULL,
  normalized   JSONB,
  content_hash TEXT,
  errors       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  decision     TEXT        NOT NULL CHECK (decision IN ('ok', 'skip', 'duplicate', 'error')),
  UNIQUE (import_id, row_number)
);

ALTER TABLE question_import_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON question_import_rows
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON question_import_rows
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
