-- Z-142: the test type card decides the camera. Mock = (mock,false), Real = (real,false), Real + camera = (real,true).
-- Column on an existing table (assessments has tenant_id + RLS already); no new policy. Forward-only, idempotent.
-- Existing assessments stay false (owner test data, no backfill).
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS camera_required boolean NOT NULL DEFAULT false;
