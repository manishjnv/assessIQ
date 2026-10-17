-- owned by modules/04-question-bank
-- 0196 — EXP-5: full-text + typo-tolerant search over the normalised question text.
--
-- WHAT
--   pg_trgm extension (trusted: a database owner may create it).
--   aiq_json_leaves(jsonb) SQL mirror of import/v2.ts normalisedText(): every string leaf of the
--                         question content except the `rationale` key, NFKC + lower-case, option
--                         label ("A)", "(b)", "1.") stripped, whitespace collapsed, joined by newline.
--   questions.search_text maintained by trigger questions_search_text_trg on INSERT and on
--                         UPDATE OF content, so every write path (service, import, clone, generate)
--                         stays in sync without touching application code.
--   questions.search_tsv  to_tsvector('simple', search_text), filled by the same trigger. Stored, not
--                         an expression, because the app role runs under RLS: Postgres will not use
--                         an index for a non-leakproof operator (@@, <%) on an RLS table, so the
--                         query is a filtered scan and must evaluate cheaply per row.
--   GIN indexes: search_tsv and search_text gin_trgm_ops (used by the table owner / system jobs
--                         and by any future non-RLS reader; the app role scans).
--   questions (difficulty_est) index for the range filter. review_state and language_primary have
--                         few values, so an index would not help; they filter after the pack filter.
--
-- WHY a trigger-filled column and not a generated column: the trigger is re-runnable and
--   the function can change later without rewriting a generated-column definition.
-- WHY the 'simple' text-search configuration: no stemming and no stop words, so Hindi (Devanagari)
--   tokens work the same as English ones. Typos are covered by trigram word similarity.
-- WHY no new table: no tenant_id and no RLS policy are needed. Row access stays under the
--   existing questions RLS (JOIN through question_packs); the indexes hold no tenant-visible data
--   outside that policy.
-- DIFFERENCE from the JS function: the JS strips the option label from each leaf the same way;
--   JS sorts object keys by UTF-16 order and this function by the C collation. Order does not
--   matter for search.
--
-- Forward-only. Idempotent: IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION aiq_json_leaves(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE jsonb_typeof(v)
    WHEN 'string' THEN
      NULLIF(btrim(regexp_replace(
        regexp_replace(lower(normalize(v #>> '{}', NFKC)), '^\s*\(?([a-z]|[0-9]{1,2})[.)]\s+', ''),
        '\s+', ' ', 'g')), '')
    WHEN 'array' THEN
      (SELECT string_agg(aiq_json_leaves(e.value), E'\n') FROM jsonb_array_elements(v) AS e(value))
    WHEN 'object' THEN
      (SELECT string_agg(aiq_json_leaves(o.value), E'\n' ORDER BY o.key COLLATE "C")
         FROM jsonb_each(v) AS o(key, value) WHERE o.key <> 'rationale')
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION questions_search_text_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := aiq_json_leaves(NEW.content);
  NEW.search_tsv  := to_tsvector('simple', coalesce(NEW.search_text, ''));
  RETURN NEW;
END
$$;

ALTER TABLE questions ADD COLUMN IF NOT EXISTS search_text TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS search_tsv  tsvector;

DROP TRIGGER IF EXISTS questions_search_text_trg ON questions;
CREATE TRIGGER questions_search_text_trg
  BEFORE INSERT OR UPDATE OF content ON questions
  FOR EACH ROW EXECUTE FUNCTION questions_search_text_fn();

-- Backfill rows written before this migration (and rows whose content changed while no trigger existed).
UPDATE questions SET search_text = aiq_json_leaves(content),
                     search_tsv  = to_tsvector('simple', coalesce(aiq_json_leaves(content), ''))
 WHERE search_tsv IS NULL;

CREATE INDEX IF NOT EXISTS questions_search_fts_idx
  ON questions USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS questions_search_trgm_idx
  ON questions USING gin (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS questions_difficulty_est_idx ON questions (difficulty_est);
