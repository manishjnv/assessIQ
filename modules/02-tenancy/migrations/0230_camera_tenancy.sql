-- owned by modules/02-tenancy
-- 0230 - camera settings per organisation (Batch A part 1). Additive and idempotent.
-- tenants.is_school: set by the super admin only (setTenantIsSchool, audited).
-- camera_enabled / camera_photos_enabled: school switches (updateCameraSettings, audited).
-- camera_notice_confirmed_*: which notice version the school admin confirmed (confirmCameraNotice, audited).

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS is_school BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS camera_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS camera_photos_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS camera_notice_confirmed_version TEXT NULL,
  ADD COLUMN IF NOT EXISTS camera_notice_confirmed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS camera_notice_confirmed_by UUID NULL;
