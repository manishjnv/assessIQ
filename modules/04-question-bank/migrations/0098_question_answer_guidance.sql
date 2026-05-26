-- owned by modules/04-question-bank
-- 0098_question_answer_guidance.sql
--
-- Adds a per-question, candidate-facing ANSWER-FORMAT HINT.
--
-- WHAT / WHY
--   Candidates currently get no instruction on HOW to shape an answer — how long,
--   what form (one word? a query? findings + explanation?). `answer_guidance`
--   carries a short, instructional, candidate-SAFE string per question
--   (e.g. "Select the one best option.", "Write a focused answer — about 3–6
--   sentences."). Feature #4 (per-question answer-format hint). Phase A
--   (this migration) is the foundation; Phase B fills the column with an
--   admin-triggered AI generator. When the column is NULL the application
--   serves a per-type DEFAULT, so every question shows a hint with or without
--   an authored value.
--
-- INSTRUCTIONAL, NOT AN ANSWER KEY
--   This is HOW to answer, never WHAT the answer is. It is a sibling column to
--   `content`/`rubric` — it is NOT part of the rubric and is NOT graded. It is
--   safe to send to candidates (unlike `rubric`, which is internal-only).
--
-- LIVE-READ, NOT SNAPSHOTTED
--   Unlike `content`/`rubric` (frozen per attempt via `question_versions`),
--   `answer_guidance` is read LIVE from the `questions` row at serve time —
--   exactly like `topic` and `points`. It is therefore NOT written to
--   `question_versions`, and editing it is a metadata change with NO version
--   bump (mirrors `updateQuestion`'s handling of `topic`/`points`).
--
-- FORWARD-ONLY / ADDITIVE / IDEMPOTENT
--   Nullable, no default. `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.
--   No backfill: existing rows stay NULL and fall back to the per-type default
--   at serve time (pre-launch — no real candidate data to migrate).

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS answer_guidance text;

COMMENT ON COLUMN questions.answer_guidance IS 'Candidate-facing answer-format hint (HOW to answer, not WHAT). Instructional/candidate-safe — never a rubric or answer key. NULL falls back to a per-type default at serve time. Live-read (not snapshotted to question_versions).';
