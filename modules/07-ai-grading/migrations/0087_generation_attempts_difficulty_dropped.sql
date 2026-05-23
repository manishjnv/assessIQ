-- owned by modules/07-ai-grading
-- Phase A3 — structural difficulty gate observability.
--
-- Adds difficulty_dropped to generation_attempts: the count of questions
-- dropped because they failed the structural difficulty gate
-- (validateStructuralDifficulty in modules/04-question-bank/src/difficulty-spec.ts)
-- — e.g. an L1 MCQ without exactly 4 options, an L3 scenario with too many steps.
--
-- Kept separate from citation_dropped (model-compliance: hallucinated source IDs)
-- and dedupe_dropped (semantic: topic collision). difficulty_dropped is a third,
-- independent post-generation quality signal — a structural-conformance metric.
-- Folding them would collapse distinct failure modes into one number; the column
-- cost is trivial (mirrors 0043_generation_attempts_citation_dropped.sql).
--
-- NULL semantics: NULL means the attempt pre-dates this column, did not inject
-- difficulty (back-compat caller), or never reached the difficulty filter (e.g. a
-- failed run). 0 means the filter ran and passed every question.

ALTER TABLE generation_attempts
  ADD COLUMN difficulty_dropped INTEGER;
