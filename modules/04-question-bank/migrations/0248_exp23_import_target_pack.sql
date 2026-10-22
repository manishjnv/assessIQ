-- EXP-23: an import can append to an existing pack instead of creating one.
-- Plain columns, no FK: the app checks the pack under RLS (same tenant, not archived) at stage and at commit.
ALTER TABLE question_imports ADD COLUMN IF NOT EXISTS target_pack_id UUID NULL;
ALTER TABLE question_imports ADD COLUMN IF NOT EXISTS target_level_position INT NULL;
