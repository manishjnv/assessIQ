-- 0147_help_text_corrections_followup.sql
--
-- Follow-up to 0146 (review fix RS3). Two global help rows are not in
-- content/en/*.yml (older migrations seeded them), so 0146 did not reach them:
--   admin.integrations.embed-origins.add  (seeded by 12-embed-sdk 0072): customer name in an example
--   admin.grading.rerun                   (older seed; no UI id uses it today): internal words
-- Text only. No row is added or removed. Safe to re-run.

UPDATE help_content
   SET long_md = replace(long_md, 'https://portal.wipro.com', 'https://portal.example.com'),
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.integrations.embed-origins.add' AND locale = 'en';

UPDATE help_content
   SET short_text = 'Re-run asks the evaluation to grade the same answer again. Use it when the first proposal looks wrong.',
       long_md = $$## Re-run

Re-run sends the same answer and rubric through the evaluation again. Two
runs can give different results, so a second run sometimes gives a better
proposal for an unclear answer. Only AssessIQ evaluators can start a re-run.

Use re-run when:
- The justification is clearly misaligned with the rubric.
- The anchor hits don't match what you read in the answer.
- The band seems too high or too low but you want a second opinion before
  overriding manually.

Re-run does **not** replace the first proposal. Both are kept, and the later
one links to the first.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.grading.rerun' AND locale = 'en';
