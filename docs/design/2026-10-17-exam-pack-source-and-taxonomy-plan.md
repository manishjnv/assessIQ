# Exam packs: question sources, normalised store, filters and platform changes

**Status:** PLAN ONLY, 2026-10-17. No code, no migration. Supersedes the content-sourcing and platform-gap parts of `docs/design/2026-10-09-exam-packs-roadmap.md` (that file stays for the exam list, waves and owner decisions OD-X0..OD-X9).
**Owner request (2026-10-17):** plan how questions for competitive exams enter the system (online scraping or super-admin upload), how they are normalised into the database by difficulty, topic, year and other categories, and what the current architecture needs in order to carry them.
**Method:** three read-only sweeps. (1) Architecture audit of modules 04, 05, 06, 09, 15 and the data model. (2) Online research on 10 exam structures. (3) Online research on Indian copyright, scraping terms, tagging standards and de-duplication. Research limits are listed in § 9: official sites blocked the fetch tool, so many exam figures are secondary-source and every legal point is "to confirm with a lawyer".

## 1. Decisions the owner must make first

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | **Sourcing lane.** Scraping versus owner upload versus AI-original. | **Do not scrape aggregator sites.** Use lane A (seed-and-rewrite) for what students attempt, lane B (metadata and link only) for previous-year questions (PYQ) as a catalog, lane C only with a signed licence. Owner upload (lane D) is the intake path for A and B. | Scraping breaks site terms, risks copyright claims, and a SaaS that sells the content carries the liability. Owner decision OD-X2 (2026-10-09) already said "original exam-pattern content, no verbatim papers". This plan keeps that rule and gives it a mechanism. |
| D2 | **Verbatim PYQ in the test engine.** Allowed or not. | Not allowed until written permission or a licence exists per exam body. | Papers are copyrightable works. The paper setter or the body owns them. A commercial product selling verbatim papers is the riskiest line. Confirm with a lawyer. |
| D3 | **Shared store versus clone-per-tenant.** | Decide before building. Recommended: for exam packs, tenants and B2C users read the platform questions through a shared read model, not a copy. | Today every licensed tenant gets a full copy of each question. 5,550 items times many tenants, and per-user B2C tenants (EX-4), multiplies rows and breaks answer-key fixes (every clone must resync). |
| D4 | **Difficulty scale.** | A 5-step label per question (1 very easy .. 5 very hard) plus a measured value. Keep L1/L2/L3 as the pack-level grouping. | Exam banks tag difficulty per question. Levels are per pack today. |
| D5 | **Languages in Wave 1.** | English plus Hindi as paired items (already OD-X6). | Not built anywhere for question content. Large change. |

If the owner picks scraping anyway (D1), the plan below still holds, but every scraped item must enter with `rights_status = unlicensed_verbatim`, must never reach a candidate or a customer, and may only feed lane A as a private seed. That is the only use this plan can support.

## 2. What exists today (verified in code, 2026-10-17)

- **Tables:** `question_packs` (domain slug, version, `source` authored/generated/import, `import_file_sha256`), `levels` (L1-L3 by position), `questions` (type, free-text `topic`, points, `negative_marks`, status draft/active/archived/ai_draft, `content` JSON, `domain_id`, `category_id`, `cognitive_level`, `difficulty_params`), `question_versions` (frozen snapshot used for scoring), `tags` and `question_tags`, `domains` and `categories`, `frameworks` / `taxonomy_nodes` / `question_taxonomy` (CASE-style tree, many nodes per question), `question_imports` and `question_import_rows` (staging), `attempt_questions` (frozen points and negative marks), `question_stats_mv` (exposure, correct rate, mean band, point-biserial).
- **Types (9):** mcq, multi_select, numeric, ordering, structured_case (deterministic); subjective, scenario, kql, log_analysis (AI-graded, SOC-flavoured). Competitive exams need only mcq, multi_select, numeric and later an essay type.
- **Import:** super admin only; CSV, XLSX, GIFT, Aiken, QTI 3; 4 MB and 2,000 rows per file; dry run, fix rows, commit as a draft pack; exact-match de-duplication (SHA-256 of type plus content) against the same domain; template columns `type, topic, points, level, negative_marks` plus per-type columns. No columns for exam, year, shift, language, image, source or tags.
- **Delivery:** sections with timers (up to 10, server-enforced, one open at a time, calculator flag), negative marking per question and per assessment default, option shuffle, per-question flag and time spent. Passage steps only inside one `structured_case` question.
- **Sharing:** platform tenant authors; tenants hold entitlements by domain or pack; use clones the pack into the tenant (`materializeSetForTenant`); a new platform version re-syncs every clone; assessments freeze their pool at publish.
- **Stale items in the 2026-10-09 roadmap:** EX-1 (negative marking) and EX-3 (passage steps) shipped in S14. EX-3 is only partial: no shared stem across separate question rows. Sections with timers shipped; section marks and cutoffs did not (EX-2).

## 3. Filter dimensions wanted, and where each one lives

| Filter | Source of truth (proposed) | Today |
| --- | --- | --- |
| Exam, stage or tier, paper | `exam_catalog` + `question_exam_use` | missing |
| Year, date, shift, paper set code, question number | `question_exam_use` | missing |
| Section (Quant, Reasoning, English, GA, Physics, ...) | taxonomy node of kind `section` | partial (category) |
| Subject, topic, subtopic | one shared taxonomy tree (`subject` > `topic` > `subtopic`) via `question_taxonomy` | topic is free text |
| Concept tags, common-error or trap tags | `tags` with category | tags exist, not filterable in the list |
| Difficulty estimated (1-5) | `questions.difficulty_est` | only pack level |
| Difficulty measured | `question_stats_mv` written back to `difficulty_measured` | MV only |
| Expected time to solve (seconds) | `questions.time_to_solve_sec` | missing |
| Type, marks, negative marks | existing columns | exist |
| Language and paired item | `questions.language`, `translation_group_id` | missing |
| Origin (original_human, ai_original, ai_seeded, pyq_verbatim, pyq_metadata_only, licensed) | `question_source.origin` | partial (`source` on pack) |
| Rights status (see § 4) | `question_source.rights_status` | missing |
| Source reference and URL, seed reference | `question_source` | missing |
| Has solution, has image, has passage | derived from columns | missing |
| Review status (draft, in_review, verified, disputed, needs_fix, active, archived) | widen `questions.status` | 4 states |
| Usage (exposure, correct rate, last used) | `question_stats_mv` | exists |
| Full-text search | tsvector or trigram index on normalised text | prefix match on topic |

## 4. Source strategy: lanes, rights and the intake path

| Lane | What enters the DB | Rights status | May candidates see it | Notes |
| --- | --- | --- | --- | --- |
| **A. Seed-and-rewrite** | New questions: new stem, new numbers, new options, same concept and difficulty. AI generates from an extracted pattern, human reviews. | `original` | Yes | Core product. Needs a similarity gate against all private seeds (§ 6). Fits OD-X2 and OD-X8 (super admin generates through the VPS Claude CLI, no ambient AI). |
| **B. Catalog only** | Metadata: exam, year, shift, section, topic, difficulty, answer key, official source URL. No question text. | `metadata_only` | The catalog row yes; text no | Facts are weakly protected. Lets students filter "SSC CGL 2023 Tier 1, Quant, Percentage" and see practice on the same concept through lane A. |
| **C. Licensed** | Verbatim text under a written licence from the body or a publisher. | `licensed` (record licence id and expiry) | Yes, within licence terms | Only after a signed document. Ask NTA, UPSC, SSC, IBPS, RRB in writing. |
| **D. Owner upload** | Intake file (PDF, Word, CSV, XLSX) put on the VPS by the owner for NEET and JEE (OD-X7). | Set by the uploader at upload time | Depends on lane | Not a rights lane. D feeds A and B. A verbatim file the owner uploads stays the platform's liability. |
| **Scraping** | Not recommended. | `unlicensed_verbatim` | Never | If done, items stay in a private seed store, outside the question tables a candidate can reach, and are never sold. |

**Hard rules for every lane**
1. Seed files and verbatim text never go into git (OD-X2: `docs/exam-content/` is gitignored; files live on the VPS). Public repo hygiene memory applies.
2. The `rights_status` field gates publishing. A pack cannot move to `published` while it holds an item that is not `original`, `metadata_only` or `licensed`.
3. A takedown path: set `rights_status = withdrawn`, the item leaves every pack at the next sync, attempts keep their frozen version for scoring.
4. Every item records who uploaded it, when, from which file hash and which seed (if any).

## 5. Proposed normalised model (additive, forward-only, tenant rules kept)

All new tables carry `tenant_id` and an RLS policy (platform content uses the platform tenant, as today). Names are proposals.

1. **`exam_catalog`** (exam, stage, paper): `slug`, `name`, `body` (SSC, IBPS, RRB, UPSC, NTA), `stage` (tier 1, prelims, CBT 1), `paper` (GS paper 1, CSAT, Maths, GAT), `languages[]`, `syllabus_url`, `syllabus_edition`.
2. **`exam_blueprints`**: one row per exam paper edition. `sections[]` each with name, taxonomy section node, question count, marks per question, negative marks, minutes, sectional timing yes or no, qualifying yes or no and cutoff, calculator, allowed types. Feeds `settings.sections` and `settings.scoring` when an admin or a student starts a full mock. This is EX-2 (section marks and cutoff) plus templates.
3. **`question_exam_use`** (M:N): `question_id`, `exam_id`, `year`, `exam_date`, `shift`, `paper_code`, `question_no`, `stage`. One question can be used in more than one exam, so exam is not a column on `questions`.
4. **`question_source`** (1:1 with a question): `origin`, `rights_status`, `source_ref` (free text), `source_url`, `seed_question_id` or `seed_ref`, `import_id`, `uploaded_by`, `licence_id`, `content_hash`, `normalised_text_hash`.
5. **Taxonomy.** Use the existing `frameworks` / `taxonomy_nodes`. Create **one shared subject tree** (Quant > Arithmetic > Percentage > Successive percentage change, and so on), because SSC, bank and RRB share the same four-subject base, and add exam-specific trees only where the syllabus is different (UPSC GS, NEET Biology). Widen `kind` to include `section`, `topic`, `subtopic`. Allow draws by any node level (today `outcome` and `criterion` nodes cannot be drawn).
6. **Difficulty and time:** `questions.difficulty_est` (1-5 from a rubric: number of steps, concepts combined, calculation length, distractor quality), `difficulty_measured` (written by the nightly job from `correct_rate` and point-biserial once 100 or more attempts exist; the 100 is a rule of thumb, tune it), `time_to_solve_sec`.
7. **Language:** `questions.language` (`en`, `hi`) and `translation_group_id` linking the pair. The candidate chooses a language per attempt or per question; the attempt freezes both versions.
8. **Assets:** `question_assets` (sha256, mime, width, height, alt text, storage ref) and an asset reference in `content` for the stem and each option. KaTeX safe subset for math, stored as LaTeX.
9. **Passages:** `passages` (shared stem text or image, language) and `questions.passage_id` with a draw-together rule. Today a passage exists only as steps inside one `structured_case`.
10. **Review states and keys:** widen status to `draft, in_review, verified, active, disputed, needs_fix, archived`. Add `answer_key_events` (question, version, change, reason, official key version provisional or final, date) and a re-score job for past attempts when a key changes. Re-scoring is an owner decision per exam because a candidate who already saw a result sees a change.

**Not proposed:** a separate question database, an ambient AI call anywhere (rule 1), a tenant-authoring path (OD-X1), a second taxonomy engine.

## 6. Ingestion pipeline (staging, normalising, de-duplicating)

Same staging pattern as today's `question_imports`, extended.

1. **Intake** (super admin, on the VPS): file in, sha256 recorded, lane and declared rights chosen. Bulk caps raised from 2,000 rows and 4 MB to a chunked job (target 5,000+ rows).
2. **Extract:** PDF and Word via text extraction; OCR for scanned or image-only items; images saved as assets; Hindi and English split into separate fields.
3. **Normalise:** Unicode NFKC, lower-case, strip option labels, collapse whitespace, unify digits and symbols, math to LaTeX. Keep Hindi and English normalised separately.
4. **De-duplicate in three layers:** exact hash (SHA-256 of normalised stem plus sorted options, stored on `question_source.content_hash`, indexed; today it is computed in JS per import); near-duplicate with MinHash on word shingles; paraphrase with a multilingual embedding. Two thresholds: block above the high one, human review in the middle.
5. **Seed-similarity gate (lane A):** every generated question is compared with all private seeds; a close match is rejected before a reviewer sees it.
6. **Classify:** AI proposes subject, topic, subtopic, difficulty_est, time_to_solve and trap tags with a confidence; a human confirms in the staging screen. Low confidence goes to the review queue. The AI call is a super-admin click, single-flight, never a worker or a cron (hard rule 1).
7. **Match the answer key:** by exam, year, shift and question number, then confirm by option text (shuffled shifts reorder options). Mark disputed or changed keys with the official key version.
8. **Pair languages:** by position, option count, numbers in the stem and embedding similarity; the reviewer confirms.
9. **Review and publish:** in_review, verified, active. A pack publishes only when every item is `original`, `metadata_only` or `licensed` (§ 4 rule 2).
10. **Calibrate:** after enough attempts, write the measured difficulty back and flag items whose measured value differs from the label by two steps (the existing `miscalibrated` idea in RW-60, reused).

## 7. Platform changes by size (ordered)

| # | Change | Module | Size | Blocks |
| --- | --- | --- | --- | --- |
| P1 | `question_source`, `question_exam_use`, `exam_catalog`, new columns, status widening, stored hash and index | 04 + migration | M | everything |
| P2 | Taxonomy widening and draw by any node; shared subject tree seed | 04, 05 | M | filters, drill |
| P3 | List API and admin UI facets for all filters in § 3; full-text search | 04, 10 | M | review at scale |
| P4 | Import v2: new template columns (exam, year, shift, section, topic path, difficulty, language, source, rights), chunked 5,000+ rows, stored hash | 04 | M | content load |
| P5 | Exam blueprints and section marks and cutoff (EX-2); "start a full mock" from a blueprint | 05, 06, 09 | M-L | full mocks |
| P6 | Passages across rows | 04, 05, 06, 11 | M | UPSC, banking, SSC English |
| P7 | Bilingual questions and language toggle; Devanagari font | 04, 06, 11 | L | Wave 1 Hindi (OD-X6) |
| P8 | Images and KaTeX | 04, 11, 18 | L | Wave 2 and 3 (NDA, JEE, NEET) |
| P9 | Drill mode: pick subject and topics and count, fixed-rule score, no AI | 05, 06, 11 | M-L | EX-6 |
| P10 | Near-duplicate and seed-similarity service | 04 | M-L | lane A at scale |
| P11 | Review workflow states, key disputes, re-score job | 04, 09 | M-L | trust |
| P12 | Shared read model for platform content instead of clone-per-tenant (D3) | 02, 04, 05 | L, design first | B2C scale |
| P13 | Candidate-facing PYQ catalog (lane B) | 11 | S-M | marketing |

Roadmap mapping: P5 is EX-2, P6 completes EX-3, P7 is EX-10, P8 is EX-11 and EX-12, P9 is EX-6, P4 is EX-7 (content pipeline). The Wave 1 order from OD-X9 does not change: SSC first, then Bank and RRB.

## 8. Delivery order

1. **Owner decisions D1 to D5** (one short session of answers; nothing else starts before D1 and D3).
2. **Session A:** P1 and P2 (schema and taxonomy). Review gate: Sonnet takeover. Docs 02 and the module SKILL.
3. **Session B:** P4 and P3 (import v2 and facets). Load the SSC shared base as the first content, lane A only.
4. **Session C:** P5 (blueprints and section marks) and the SSC CGL Tier 1 blueprint. First full mock end to end.
5. **Session D:** P7 (Hindi) and P6 (passages), then Bank and RRB blueprints.
6. **Sessions E and F:** P10 and P11, then P9.
7. **Wave 2 and 3:** P8 first, then UPSC, NDA, JEE, NEET content with owner-verified sources (OD-X7).
P12 is designed in session A and built when B2C starts.

## 9. Research limits and what must be verified before coding

- **Exam blueprints are not locked.** Official sites (UPSC, SSC, IBPS, SBI, RRB) blocked the fetch tool; most figures come from coaching or news sites. Before any blueprint is stored, check each against the current official notice. Items marked UNVERIFIED by the research: SSC CGL Tier 2 section marks and counts; SSC CHSL; all SBI figures; IBPS Mains section counts; JEE numeric-question negative marking; the NEET 2025 and 2026 section structure; every copyright or terms line on official sites; official syllabus URLs.
- **Working figures (secondary sources, check first):**

| Exam | Questions and marks | Negative marking | Time | Notes |
| --- | --- | --- | --- | --- |
| SSC CGL Tier 1 | 100 q, 200 marks, 4 sections of 25 | 0.5 | 60 min | qualifying, no sectional timing |
| SSC MTS | Session 1: 40 q, 120 marks; Session 2: 50 q, 150 marks | none, then 1 | 45 min each | both mandatory |
| IBPS PO Prelims | 100 q, 3 timed sections | 0.25 | 60 min | section counts differ by source |
| IBPS Clerk Prelims | 100 q (30, 35, 35) | 0.25 | 60 min | |
| RRB NTPC CBT 1 | 100 q (GA 40, Maths 30, Reasoning 30) | 1/3 | 90 min | no sectional timing |
| RRB Group D | 100 q | 1/3 | 90 min | |
| UPSC Prelims | GS 100 q x 2 marks; CSAT 80 q x 2.5 marks | 1/3 | 2 h each | CSAT qualifying at 33% |
| NDA | Maths 120 q x 2.5; GAT 150 q x 4 | 1/3 | 2.5 h each | |
| JEE Main Paper 1 | 75 q, 300 marks; per subject 20 MCQ + 5 numeric | -1 MCQ; numeric unverified | 3 h | two sessions a year, shifts, percentile normalisation |
| NEET UG | 180 q, 720 marks, +4 / -1 | -1 | 180 min | structure of Section A and B unverified |

- **Legal.** Everything in § 4 is a product position, not legal advice. Items to confirm with a lawyer: who owns each exam body's papers (government work or setter), the exact clause of the exam-use exception in the Copyright Act, whether tolerated third-party PYQ publishing is a safe practice for a paid SaaS, and the wording of a written permission request to NTA, UPSC, SSC, IBPS and RRB. The research found court decisions that papers are copyrightable (Delhi HC, Rupendra Kashyap v. Jiwan Publishing House, 1996, in favour of the board; Allahabad HC and Patna HC on board ownership claims), no reported case against the large ed-tech sites, and no openly licensed source of exam questions.
- **Scraping.** One aggregator's policy copy bans scripts, crawlers and data mining; other aggregators were not checked. Treat all aggregator question pages as owned by the site.
- **Standards.** QTI 3 import and export already exist; keep the internal schema and export through QTI on request. No published tag standard from Indian ed-tech banks was found; the field set in § 3 is a practical set, not an industry standard.

## 10. Open questions for the owner

1. D1 to D5 above.
2. Written permission: should Claude draft the permission letters to NTA, UPSC, SSC, IBPS and RRB for the owner to send?
3. Re-score policy when an official key changes after release (automatic, owner click, or never).
4. Is a candidate-facing PYQ catalog (lane B) wanted for marketing and SEO, or only for internal tagging?
5. Which exam's blueprint is verified first by hand against the official notice (suggest SSC CGL Tier 1 because Wave 1 starts there)?
