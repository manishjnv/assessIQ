-- owned by modules/07-ai-grading
-- Stage 1.5f — mechanical citation enforcement.
--
-- Adds citation_dropped to generation_attempts so admins can see how many
-- questions were silently dropped because the model emitted source IDs that
-- were not present verbatim in the caller-supplied input.sources[].id list.
--
-- Kept separate from dedupe_dropped for observability: a future admin can
-- distinguish "3 dropped for topic duplication" from "5 dropped for invalid
-- citation IDs" without parsing JSON logs.  Both columns are independent
-- post-generation quality signals.
--
-- WHY NOT folded into dedupe_dropped:
--   dedupe_dropped is a semantic deduplication metric (topic collision).
--   citation_dropped is a model-compliance metric (hallucinated source IDs).
--   Folding them collapses two distinct failure modes into one number, making
--   regression analysis harder.  The column cost is trivial.
--
-- NULL semantics: NULL means the attempt pre-dates this column or used a
-- code path where citation filtering was not applied (e.g., a failed run
-- that never reached the filter).  0 means the filter ran and passed all
-- questions.

ALTER TABLE generation_attempts
  ADD COLUMN citation_dropped INTEGER;
