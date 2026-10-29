-- owned by modules/04-question-bank
-- 0284 — EXP-10 part 1: images in questions.
--
-- WHAT
--   question_assets            one row per image: sha256, mime (PNG or JPEG only), byte_size, width, height, required
--                              alt text, the cleaned bytes (`data`, bytea). Rows never change (trigger) and have no
--                              delete route; a fix is a new upload and a new question version.
--   question_versions.asset_ids  uuid[] filled by a BEFORE INSERT trigger from content.stem_assets and
--                              content.option_assets. The candidate asset route reads this column (GIN index), never the
--                              content JSON. The same trigger checks that every id is a question_assets row of the SAME
--                              pack_id AND tenant_id as the version, so clone, re-sync, restore, import and the service are
--                              all covered by one rule.
--
-- WHY bytes in Postgres: same as tenant_logos. RLS and the nightly dump cover them, no new volume on the shared VPS.
-- WHY the tenant cap is NOT here: it is checked under an advisory lock in the service (assets.ts) with the insert.
-- RLS: question_assets is the 12th question-store table. tenant_isolation (own tenant, all verbs) plus licensed_read
--   (SELECT only, behind app.licensed_read, through readable_platform_packs()) and only for an asset that a VISIBLE
--   question version references, so an image of a draft question never leaks.
-- No cross-module FK on created_by (RCA 2026-10-17, 0183). Forward-only, idempotent.
-- Rollback: DROP TRIGGER question_versions_zz_assets ON question_versions; DROP FUNCTION question_versions_fill_assets();
--           DROP INDEX question_versions_asset_ids_gin; ALTER TABLE question_versions DROP COLUMN asset_ids;
--           DROP TABLE question_assets;  (no row exists before part 1 ships)

CREATE TABLE IF NOT EXISTS question_assets (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL,
  pack_id     UUID        NOT NULL,
  sha256      TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime        TEXT        NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  byte_size   INTEGER     NOT NULL CHECK (byte_size BETWEEN 1 AND 409600),
  width       INTEGER     NOT NULL CHECK (width  BETWEEN 16 AND 4000),
  height      INTEGER     NOT NULL CHECK (height BETWEEN 16 AND 4000),
  alt_text    TEXT        NOT NULL CHECK (char_length(btrim(alt_text)) BETWEEN 5 AND 300),
  data        BYTEA       NOT NULL CHECK (octet_length(data) = byte_size),
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT question_assets_pack_fk FOREIGN KEY (pack_id, tenant_id)
    REFERENCES question_packs (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT question_assets_hash_uq UNIQUE (tenant_id, pack_id, sha256)
);

CREATE INDEX IF NOT EXISTS question_assets_tenant_idx ON question_assets (tenant_id) INCLUDE (byte_size);
CREATE INDEX IF NOT EXISTS question_assets_pack_idx   ON question_assets (pack_id);

ALTER TABLE question_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON question_assets;
CREATE POLICY tenant_isolation ON question_assets
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Added after the column exists (below), so the policy can name asset_ids.
ALTER TABLE question_versions ADD COLUMN IF NOT EXISTS asset_ids UUID[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS question_versions_asset_ids_gin ON question_versions USING gin (asset_ids);

DROP POLICY IF EXISTS licensed_read ON question_assets;
CREATE POLICY licensed_read ON question_assets FOR SELECT
  USING (
    current_setting('app.licensed_read', true) = 'on'
    AND pack_id = ANY((SELECT readable_platform_packs())::uuid[])
    AND EXISTS (SELECT 1 FROM question_versions qv WHERE qv.asset_ids @> ARRAY[question_assets.id])
  );

-- Rows never change.
CREATE OR REPLACE FUNCTION question_assets_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'question_assets are immutable: upload a new image and save a new question version';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS question_assets_immutable ON question_assets;
CREATE TRIGGER question_assets_immutable BEFORE UPDATE ON question_assets
  FOR EACH ROW EXECUTE FUNCTION question_assets_immutable();

-- Fill question_versions.asset_ids and check the references. Runs after question_versions_fill_owner
-- (BEFORE INSERT triggers fire in name order), so NEW.pack_id and NEW.tenant_id are set.
CREATE OR REPLACE FUNCTION question_versions_fill_assets() RETURNS trigger AS $$
DECLARE
  ids   uuid[] := '{}';
  e     text;
  found int;
BEGIN
  IF jsonb_typeof(NEW.content) = 'object' THEN
    IF NEW.content ? 'stem_assets' AND jsonb_typeof(NEW.content->'stem_assets') <> 'array' THEN
      RAISE EXCEPTION 'content.stem_assets must be an array' USING ERRCODE = '22023';
    END IF;
    IF NEW.content ? 'option_assets' AND jsonb_typeof(NEW.content->'option_assets') <> 'array' THEN
      RAISE EXCEPTION 'content.option_assets must be an array' USING ERRCODE = '22023';
    END IF;
    FOR e IN
      SELECT x FROM jsonb_array_elements_text(COALESCE(NEW.content->'stem_assets', '[]'::jsonb)) AS t(x)
      UNION ALL
      SELECT x FROM jsonb_array_elements_text(COALESCE(NEW.content->'option_assets', '[]'::jsonb)) AS t(x)
    LOOP
      CONTINUE WHEN e IS NULL;
      IF e !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'content holds an asset reference that is not an id' USING ERRCODE = '22023';
      END IF;
      IF NOT (e::uuid = ANY(ids)) THEN ids := ids || e::uuid; END IF;
    END LOOP;
  END IF;
  IF cardinality(ids) > 6 THEN
    RAISE EXCEPTION 'a question may hold at most 6 images' USING ERRCODE = '22023';
  END IF;
  IF cardinality(ids) > 0 THEN
    SELECT count(*) INTO found FROM question_assets a
     WHERE a.id = ANY(ids) AND a.pack_id = NEW.pack_id AND a.tenant_id = NEW.tenant_id;
    IF found <> cardinality(ids) THEN
      RAISE EXCEPTION 'every image of a question must belong to the same pack' USING ERRCODE = '23503';
    END IF;
  END IF;
  NEW.asset_ids := ids;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS question_versions_zz_assets ON question_versions;
CREATE TRIGGER question_versions_zz_assets BEFORE INSERT ON question_versions
  FOR EACH ROW EXECUTE FUNCTION question_versions_fill_assets();
