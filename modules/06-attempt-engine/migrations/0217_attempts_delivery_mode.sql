-- Z-89 (data only): attempt carries its delivery mode, camera flag and readiness-check result.
ALTER TABLE attempts
  ADD COLUMN IF NOT EXISTS delivery_mode  TEXT NOT NULL DEFAULT 'real' CHECK (delivery_mode IN ('real','mock')),
  ADD COLUMN IF NOT EXISTS camera_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS readiness      JSONB;
