# Answer-key correction and rescoring: proposal (not built)

**Type:** design proposal and owner question. **Date:** 2026-10-19 (S34). **Row:** EXP-12.
**Old task or feature checked:** EXP-12, EXP-18, EXP-20, Z-52 gaps 6 and 7, `updateQuestion` (new version on content change), `attempt_questions.question_version` (frozen version per attempt).

## What exists now (built in S34)

- A correction is an edit of the question. The edit creates a NEW question version. A verified question goes back to `in_review`.
- Attempts keep the version they used. Frozen pools keep their copy (EXP-20 owner decision).
- Staff can mark a question `disputed` or `needs_fix` with a note. The note is in `question_review_notes`. The audit row holds ids only.
- An admin can list the attempts that used an older version: `GET /api/admin/questions/:id/affected-attempts`. It changes no marks.

## What is NOT built: rescoring

Rescoring changes marks that a candidate may already have seen. It also changes certificates, pass or fail results and cohort reports. The owner must decide the rules first.

## Proposal (for the owner to accept, change or reject)

1. Rescoring is a manual super-admin action per question. It is never automatic and never runs in a background job.
2. The admin first sees a preview: the attempts that change, the old mark, the new mark, and the pass or fail change. Nothing is written in the preview.
3. The action needs a written reason (stored in `question_review_notes`) and writes one audit row per attempt (ids only).
4. A released result is not changed silently. The candidate gets a new result version and a notice. A certificate that was issued stays valid unless the pass or fail status changes; in that case an admin decides.
5. Only attempts of the admin's own tenant are touched. For a platform master, each organisation decides for its own attempts after the clone resync.
6. Bands stay 0/25/50/75/100. Multiple-choice and similar types rescore by a deterministic rule. Questions that were graded by AI are never rescored by AI.

## Owner questions

- Q1. Do you want rescoring at all in Wave 1, or only the list of affected attempts?
- Q2. If yes: may a rescore lower a mark, or only raise it?
- Q3. If a pass becomes a fail (or the reverse), who decides: the admin, or you?
- Q4. Should candidates get an email when a mark changes?

## Not included

- Any code. Any change to marks, certificates or reports.
- Shift normalisation and rank prediction.

## Downstream

Modules 06, 09 (scoring), 11 (result page), 12 (certificates), 14 (audit). A Sonnet takeover gate is required before push.
