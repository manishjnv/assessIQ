-- owned by modules/06-attempt-engine
-- 0229 - real-exam camera data layer (Batch A part 1). Additive only.
-- No AI on images, no face matching. Files live on disk (relative storage_path); rows hold metadata.
-- camera_consents: immutable proof of the candidate decision (only change allowed: attempt_id NULL -> value; DELETE only for erasure).
-- camera_files: one row per photo or video chunk; flagged = camera stopped or blocked.
-- camera_attempt_reviews: staff review state and appeal state per attempt.
-- camera_reviewers: users a school admin named as camera reviewers.
-- ip_hash is a keyed HMAC of the IP, never the IP.

CREATE TABLE IF NOT EXISTS camera_consents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invitation_id  UUID NOT NULL,
  attempt_id     UUID NULL REFERENCES attempts(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('agreed','declined')),
  notice_version TEXT NOT NULL,
  ip_hash        TEXT NOT NULL,
  device_type    TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS camera_consents_invitation_idx ON camera_consents (tenant_id, invitation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS camera_consents_attempt_idx ON camera_consents (tenant_id, attempt_id);

ALTER TABLE camera_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON camera_consents
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON camera_consents
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- DELETE exists for the erasure job (modules/20-data-rights erasure.ts) and tenant purge.
CREATE POLICY tenant_isolation_delete ON camera_consents
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON camera_consents
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- A consent given before the attempt exists is linked later. The trigger allows only that
-- change (attempt_id NULL -> value) and blocks every other UPDATE for every role.
CREATE OR REPLACE FUNCTION camera_consents_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.attempt_id IS NULL AND NEW.attempt_id IS NOT NULL
     AND (NEW.id, NEW.tenant_id, NEW.invitation_id, NEW.user_id, NEW.decision, NEW.notice_version, NEW.ip_hash, NEW.device_type, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.tenant_id, OLD.invitation_id, OLD.user_id, OLD.decision, OLD.notice_version, OLD.ip_hash, OLD.device_type, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'camera_consents is immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS camera_consents_immutable ON camera_consents;
CREATE TRIGGER camera_consents_immutable BEFORE UPDATE ON camera_consents
  FOR EACH ROW EXECUTE FUNCTION camera_consents_immutable();

CREATE TABLE IF NOT EXISTS camera_files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt_id   UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('photo','video')),
  storage_path TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL CHECK (size_bytes > 0),
  taken_at     TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  flagged      BOOLEAN NOT NULL DEFAULT false,
  flag_reason  TEXT NULL CHECK (flag_reason IS NULL OR flag_reason IN ('camera_stopped','camera_blocked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS camera_files_attempt_idx ON camera_files (tenant_id, attempt_id);
CREATE INDEX IF NOT EXISTS camera_files_expires_idx ON camera_files (expires_at);
CREATE INDEX IF NOT EXISTS camera_files_flagged_idx ON camera_files (tenant_id) WHERE flagged;

ALTER TABLE camera_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON camera_files
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON camera_files
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- The retention sweep and erasure delete rows (after the disk file is gone).
CREATE POLICY tenant_isolation_delete ON camera_files
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE TABLE IF NOT EXISTS camera_attempt_reviews (
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt_id         UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  reviewed_at        TIMESTAMPTZ NULL,
  reviewed_by        UUID NULL,
  appeal_state       TEXT NOT NULL DEFAULT 'none' CHECK (appeal_state IN ('none','open','closed')),
  appeal_changed_at  TIMESTAMPTZ NULL,
  upload_refused     BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, attempt_id)
);

ALTER TABLE camera_attempt_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON camera_attempt_reviews
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON camera_attempt_reviews
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON camera_attempt_reviews
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON camera_attempt_reviews
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE TABLE IF NOT EXISTS camera_reviewers (
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL,
  added_by   UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

ALTER TABLE camera_reviewers ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON camera_reviewers
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON camera_reviewers
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON camera_reviewers
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
