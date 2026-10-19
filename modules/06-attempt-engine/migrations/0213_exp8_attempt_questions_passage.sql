-- owned by modules/06-attempt-engine
-- 0213 — EXP-8: attempt_questions keeps the passage id that was valid at attempt start.
-- The passage row is immutable (04 migration 0211), so the id freezes the text too.
-- No FK on purpose: module-local test harnesses (RCA 2026-10-17, 0183). NULL = no passage.
-- Forward-only, no backfill.
ALTER TABLE attempt_questions ADD COLUMN IF NOT EXISTS passage_id UUID;
