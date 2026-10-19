-- owned by modules/04-question-bank
-- EXP-17 (2026-10-19): organisation admins upload question sets through import v2.
-- WHY: a tenant upload must (a) keep the uploader's rights choice and origin 'tenant_upload' when a
--   row is edited before commit, and (b) record who accepted the content warranty and when.
-- upload_rights_status NULL = platform (super-admin) import, as before. No backfill needed.
-- Not included: quotas (billing has no question/pack count limit). question_imports already has RLS.
ALTER TABLE question_imports
  ADD COLUMN IF NOT EXISTS upload_rights_status TEXT
    CHECK (upload_rights_status IN ('original', 'derived_from_source', 'licensed')),
  ADD COLUMN IF NOT EXISTS warranty_accepted_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS warranty_accepted_at TIMESTAMPTZ;
