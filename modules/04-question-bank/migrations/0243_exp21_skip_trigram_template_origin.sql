-- EXP-21: (1) per-import flag to skip the trigram duplicate class; (2) origin 'template_generated'
-- for items made by a template generator (not AI content). Forward-only, idempotent.
-- Pre-0194 rows need no hash backfill: existingHashes() hashes the domain's questions from their content.
ALTER TABLE question_imports ADD COLUMN IF NOT EXISTS skip_trigram BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE question_source DROP CONSTRAINT IF EXISTS question_source_origin_check;
ALTER TABLE question_source ADD CONSTRAINT question_source_origin_check CHECK (origin IN (
  'original_human', 'ai_original', 'ai_seeded', 'derived_from_source',
  'scraped_raw', 'tenant_upload', 'licensed', 'template_generated'));
