-- Z-89 (data only): Mock/Real delivery mode on assessments and invitations.
-- Existing rows were real exams, so the default 'real' is correct.
ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'real'
  CHECK (delivery_mode IN ('real','mock'));
ALTER TABLE assessment_invitations
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'real'
  CHECK (delivery_mode IN ('real','mock'));
