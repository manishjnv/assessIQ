# Exam packs: question sources, normalised store, filters and platform changes (v2)

**Status:** PLAN ONLY, 2026-10-17, revision 3 (owner decisions D1 to D7 recorded in § 0). No code, no migration. Feeds ROADMAP rows EXP-0..EXP-15 (§ P0-Z.3 and Z.4). Supersedes the sourcing and platform-gap parts of `docs/private/design/2026-10-09-exam-packs-roadmap.md`; that file stays for the exam list, the waves and owner decisions OD-X0..OD-X9.
**Owner request (2026-10-17):** plan how questions for competitive exams enter the system (online scraping or super-admin upload), how they are normalised into the database by difficulty, topic, year and other categories, and what the architecture needs in order to carry them. Then re-review for a better approach and validate the findings.
**Method:** v1 used three read-only sweeps (architecture audit, exam-structure research, legal and tagging research). v2 re-checked the load-bearing claims in code and replaced three designs with simpler ones that reuse what exists (§ 2).

## 0. Owner decisions recorded 2026-10-17 (they override the recommendations in §§ 3 and 4 where they differ)

| # | Owner answer | How the plan handles it |
| --- | --- | --- |
| D1 | All sources are allowed: scraping, upload by the super admin **and by the organisation admin**, AI-written questions, and licensed content. Every source gets a licence or rights record. (Reading of "license all source": every item records its source and licence status; where a licence can be obtained it is attached.) | Lanes A, B, C, D stay; **scraping becomes lane E** (super admin only, run as a manual VPS script, polite crawling, raw items land in staging only); **organisation-admin upload becomes lane F** (tenant-private packs). This reverses OD-X1 (platform-authored only). See EXP-16 and EXP-17. |
| D2 | Exact questions with minor word changes (synonym replacement) are acceptable. | New generation mode **A2 "light edit"** (EXP-7): same question, synonyms swapped, source reference kept on the row. `rights_status = derived_from_source`. This reverses OD-X2 (no verbatim papers). **Legal exposure is the owner's decision**: a lightly edited copy of a copyrighted question is still treated as a copy in law, so every such item keeps its source reference and can be withdrawn by one click (takedown). A lawyer review stays on the list (EXP-0). |
| D3 | Follow the recommendation: keep clone-per-tenant for now; decide again when B2C starts (EXP-14). | unchanged |
| D4 | Follow the recommendation. If the source gives a difficulty, use it: translate it to the 1 to 5 scale and store both the original label and the mapped value. | `question_source.source_difficulty_raw` (text) plus `questions.difficulty_est` (mapped). A mapping table per source scale (for example easy/medium/hard to 2/3/4) lives with the import template. If the source has none, use the rubric. |
| D5 | Follow the recommendation: English plus Hindi in Wave 1. | unchanged (EXP-9) |
| D6 | Every exam question and its answer is reviewed by the super admin and the admin before students are invited. | **Review gate (EXP-18):** an assessment cannot publish or invite while any question in its pool is not `verified`. Platform items are verified by the super admin; organisation-uploaded items by that organisation's admin. The gate replaces the manual re-score decision for the common case; a later key change still creates a new version and the owner clicks to re-score (EXP-12). |
| D7 | No permission letters to the exam bodies; proceed as in D2 (decided 2026-10-17). | No letters are drafted. Items stay `derived_from_source` or `scraped_raw` (never `licensed`) unless the owner later supplies a signed licence. The lawyer review remains optional and unscheduled. |

New rights values: `original`, `derived_from_source` (light edit), `scraped_raw` (staging only until reviewed), `licensed`, `metadata_only`, `withdrawn`. The publish gate of § 4 changes from "block unclear rights" to "rights status must be set, the item must be `verified`, and a `withdrawn` item leaves every pack at the next sync".

Organisation-admin upload (lane F) rules: the pack is private to that tenant and is never shared or licensed to other tenants; the uploader accepts a content warranty at upload (they hold the rights); plan-tier quotas apply (PT1); the same dedupe and review gate apply.

## 1. Validation of the v1 observations

| Claim in v1 | Check | Result |
| --- | --- | --- |
| Question list filters are only pack, level, type, status, tag, topic prefix, domain, category | `ListQuestionsInput` (04/src/types.ts:~268) | confirmed |
| No exam, year, shift, language, image or source columns on questions | migrations 0010 to 0189 | confirmed |
| No full-text or trigram search anywhere | grep `pg_trgm` and `tsvector` in all migrations | confirmed: none |
| Taxonomy can hold exam structure | `taxonomy_nodes.kind IN ('board','stage','grade','subject','unit','outcome','criterion')`, `question_taxonomy` is many nodes per question (0169) | confirmed, and it is a better fit than v1's new `exam_catalog` table (§ 2) |
| Status is a CHECK of draft, active, archived, ai_draft | 0016 | confirmed; widening it would touch every reader, so v2 adds a separate `review_state` |
| Import caps 4 MB and 2,000 rows | `import/limits.ts` | confirmed; one file per exam stays under 2,000 rows, so v1's "raise the cap" item is dropped |
| Exact-match dedupe computed in JS per import, within one domain | `import/staging.ts:33,127` | confirmed |
| Clone-on-use copies every question into each licensed tenant | `clone/clone-on-grant.ts`, `(tenant_id, source_pack_id)` unique index (0084) | confirmed; fine for tens of B2B tenants, a problem only for per-user B2C tenants (EX-4, not built) |
| Option shuffle works in original-index space | `06/src/option-shuffle.ts` header | confirmed; this is why language must be an overlay, not a second row (§ 2) |
| EX-1 negative marking and EX-3 passages shipped | ROADMAP Z.2 row X9 (closed S14); `structured_case` steps | EX-1 confirmed; EX-3 is partial (steps inside one question only); the old rows at ROADMAP lines ~1052 still show them pending and are stale |
| AI generation runs only on an admin click | project rule 1, `generation-async.ts` | confirmed; prompts for generation live as VPS skills (rule 6), so a new exam-item skill is a deploy event with an eval re-baseline |
| Exam blueprints (marks, negative marking, times) | web research, secondary sources | **not verified**: official sites blocked the fetch tool; § 9 lists what to check |
| Copyright position | web research | product position only, not legal advice; confirm with a lawyer |

## 2. What changed from v1 and why (the better approach)

| Topic | v1 | v2 | Reason |
| --- | --- | --- | --- |
| Exam, stage | new `exam_catalog` table | **Taxonomy framework "Exam structure"**: `board` = exam body (SSC), `stage` = exam and tier (CGL Tier 1), linked through `question_taxonomy` | The tree, its kinds and the many-to-many link already exist; no table, no widening of `kind` |
| Subject, topic, subtopic | one shared tree with widened kinds | **Taxonomy framework "Subject map"** using existing kinds: `subject` = Quant, `unit` = Arithmetic (topic), `outcome` = Percentage (subtopic) | Same reason; one tree shared by SSC, bank and railway exams |
| Year, shift, paper, question number | `question_exam_use` many-to-many | Nullable columns on a slim `question_source` (one row per question), plus a separate **`pyq_catalog`** for metadata-only previous-year items | A question seldom serves two papers, and a metadata-only item has no text, so it must not live in `questions` |
| Language | paired rows with `translation_group_id` | **Overlay `content_i18n.hi` inside the same question row** | Correct answers are index-based and shuffle is index-based, so an overlay keeps one question, one version, one stats row and one score; paired rows would double attempts and statistics |
| Review states | widen `status` | **Separate `review_state`** column | `status` is read by import, clone, assessments and the picker |
| Measured difficulty | write-back column and job | A **view over `question_stats_mv`** compared with `difficulty_est`; no new column at first | Avoids a second source of truth |
| Near-duplicate and paraphrase | MinHash plus multilingual embeddings | Exact hash, then a **normalised-text hash**, then `pg_trgm` similarity in Postgres; embeddings only if trigram misses | No new service; fits "no new infrastructure" |
| Bulk caps | raise to 5,000+ rows | Keep 2,000; one file per exam | Largest planned exam is about 1,500 items |
| Delivery order | schema first, then everything | **One thin vertical slice first**: SSC CGL Tier 1 Quant, about 200 items, end to end | Proves the model on real data before Hindi, images and the other nine exams |
| Shared store (D3) | decide now | **Defer to a design gate** that starts when B2C (EX-4, EX-5) starts | Clone-on-use is fine for B2B |

## 3. Decisions the owner must make first (EXP-0)

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | **Sourcing lane.** | **No scraping of aggregator sites.** Lane A (seed-and-rewrite) for what students attempt, lane B (metadata only) for previous-year questions, lane C only with a signed licence, lane D (owner upload) as the intake path. | Scraping breaks site terms and risks copyright claims; a SaaS selling the content carries the liability. The 2026-10-09 decision OD-X2 already says original exam-pattern content, no verbatim papers. |
| D2 | Verbatim previous-year questions in the test engine. | Not until written permission or a licence exists per exam body. | Exam papers are copyrightable works. Confirm with a lawyer. |
| D3 | Shared store versus clone per tenant. | Defer; decide when B2C starts. | See § 2. |
| D4 | Difficulty scale. | 1 to 5 label per question (`difficulty_est`) plus measured value from attempts. Pack levels L1 to L3 stay as grouping. | Levels are per pack today, not per question. |
| D5 | Languages in Wave 1. | English plus Hindi (already OD-X6). | Not built for question content. |
| D6 | Re-score policy when an official answer key changes after release. | Owner click per exam, never automatic. | A candidate who saw a result would see it change. |
| D7 | Written permission letters to NTA, UPSC, SSC, IBPS, RRB. | Claude drafts, owner sends. | Only a written permission makes lane C possible. |

If the owner chooses scraping anyway, every scraped item enters with `rights_status = unlicensed_verbatim`, is held in a private seed store outside the tables a candidate can reach, is never sold, and may only seed lane A.

## 4. Source lanes and rights

| Lane | What enters | Rights status | Candidates see it | Notes |
| --- | --- | --- | --- | --- |
| **A. Seed-and-rewrite** | New questions: new stem, numbers and options, same concept and difficulty. AI drafts, human reviews. | `original` | yes | Core product. Super admin click, single-flight, on the VPS CLI (OD-X8, rule 1). Needs a similarity gate against private seeds. |
| **B. Catalog only** | Metadata in `pyq_catalog`: exam stage, year, date, shift, paper code, question number, section, topic, difficulty, answer key, official URL, links to original practice questions on the same concept. No question text. | `metadata_only` | catalog row yes, text no | Facts are weakly protected. Powers "SSC CGL 2023 Tier 1, Quant, Percentage" browsing. |
| **C. Licensed** | Verbatim text under a written licence. | `licensed` (licence id, expiry) | yes, within terms | Only after a signed document. |
| **D. Owner upload** | Intake files on the VPS for NEET and JEE (OD-X7). | set at upload | depends on lane | Not a rights lane; it feeds A and B. A verbatim file the owner uploads stays the platform's liability. |
| **Scraping** | Not recommended. | `unlicensed_verbatim` | never | See § 3. |

Hard rules: seed and verbatim files never enter git (`docs/exam-content/` is gitignored, files live on the VPS); a pack cannot become `published` while it holds an item whose rights status is not `original`, `metadata_only` or `licensed`; a takedown sets `rights_status = withdrawn` and the item leaves every pack at the next sync while attempts keep their frozen version for scoring; every item records uploader, file hash and seed.

## 5. Normalised model (additive, forward-only)

All new tables carry `tenant_id` and an RLS policy (platform content uses the platform tenant, as today).

1. **Taxonomy (no schema change).** Two platform frameworks seeded with the existing seed mechanism (`framework-seeds.ts`): *Exam structure* (board, stage) and *Subject map* (subject, unit, outcome). Each question links to one stage node per exam it targets and one `outcome` node (subtopic) through `question_taxonomy`. Draws by `outcome` nodes need the draw-by-node change in EXP-5 (today only `unit` and above are drawn).
2. **`question_source`** (one row per question): `origin` (`original_human`, `ai_original`, `ai_seeded`, `licensed`), `rights_status`, `seed_ref`, `import_id`, `uploaded_by`, `licence_id`, `content_hash`, `normalised_text_hash`, nullable `pyq_year`, `pyq_date`, `pyq_shift`, `pyq_paper_code`, `pyq_qno` (only for licensed verbatim items).
3. **`pyq_catalog`**: the lane B rows (§ 4). Links to many `questions` through an array of ids for "practice this concept".
4. **`questions` additions:** `difficulty_est` (1 to 5, rubric: steps, concepts combined, calculation length, distractor quality), `review_state` (`in_review`, `verified`, `disputed`, `needs_fix`; null for legacy rows), `language_primary` (`en`), `content_i18n` JSON (`{"hi": { stem, options, rationale }}` with the same option count and order as `content`). Time to solve is added later, only if calibration needs it.
5. **Exam blueprints**: `exam_blueprints` (per exam stage and edition: sections with name, subject node, count, marks per question, negative marks, minutes, sectional timing, qualifying and cutoff, calculator, allowed types). Feeds `settings.sections` and `settings.scoring`. This is EX-2.
6. **Passages**: `passages` (shared stem text or image) and `questions.passage_id`, with draw-together logic. Today only `structured_case` steps exist (EX-3 partial).
7. **Assets**: `question_assets` (sha256, mime, size, alt text, storage ref) and asset references in `content`; KaTeX safe subset, LaTeX stored as text. Needs a CSP and import and export support.
8. **Answer keys**: a new question version fixes a wrong key; attempts keep the frozen version. A super-admin "re-score released attempts of this question" action (manual, audit-logged) covers D6. No automatic job.

**Not proposed:** a separate question database, ambient AI (rule 1), a tenant-authoring path (OD-X1), a second taxonomy engine, an embedding service, a reviewer role (decommissioned; reviews are done by the super admin).

## 6. Filters and where each one lives

| Filter | Source of truth |
| --- | --- |
| Exam, stage, paper | taxonomy *Exam structure* node |
| Year, date, shift, paper code, question number | `question_source.pyq_*` (licensed items) and `pyq_catalog` (catalog) |
| Section, subject, topic, subtopic | taxonomy *Subject map* nodes |
| Concept tags, trap tags | `tags` (platform tenant) |
| Difficulty estimated | `questions.difficulty_est` |
| Difficulty measured, miscalibrated | view over `question_stats_mv` |
| Type, marks, negative marks, status | existing columns |
| Language available | `content_i18n` keys |
| Origin, rights, source, seed | `question_source` |
| Has solution, image, passage | derived |
| Review state | `questions.review_state` |
| Usage (exposure, correct rate, last used) | `question_stats_mv` |
| Full-text search | `pg_trgm` and `tsvector` (simple config, works for Hindi) on normalised text |

## 7. Ingestion pipeline

1. **Intake** (super admin, VPS): file sha256, lane and rights chosen at upload.
2. **Extract:** PDF or Word text, OCR for image-only items, images to assets, English and Hindi split.
3. **Normalise:** Unicode NFKC, lower-case, strip option labels, collapse whitespace, unify digits and symbols, maths to LaTeX.
4. **De-duplicate:** exact hash, normalised-text hash, then `pg_trgm` similarity with two thresholds (block above the high one, human review between).
5. **Seed-similarity gate (lane A):** compare each generated item with all private seeds before a reviewer sees it.
6. **Classify:** AI proposes subtopic node, difficulty and trap tags with a confidence; a human confirms in the staging screen. Super-admin click only.
7. **Match the answer key:** by exam, year, shift and number; confirm by option text because shuffled shifts reorder options; record the official key version (provisional or final).
8. **Review and publish:** `in_review` → `verified` → `active`; rights gate (§ 4).
9. **Calibrate** after about 100 attempts per item (rule of thumb, tune it): compare measured with estimated difficulty and flag a gap of two steps.

## 8. Work items and delivery order (as ROADMAP rows EXP-0..EXP-15)

| Slice | Rows | Notes |
| --- | --- | --- |
| Gate | EXP-0 | Owner decisions D1 to D7, lawyer review, blueprint verification |
| **Slice 1: SSC CGL Tier 1, Quant, about 200 items, end to end** | EXP-1 taxonomy seeds, EXP-2 schema, EXP-4 import v2, EXP-5 facets and search, EXP-6 blueprints, EXP-7 generator skill and similarity gate, EXP-15 the content and the full mock | Proves the model before anything else |
| Slice 2: Wave 1 completion | EXP-8 passages, EXP-9 Hindi overlay, EXP-12 review and key disputes, EXP-13 calibration | SSC rest, Bank, RRB |
| Slice 3: Waves 2 and 3 | EXP-10 images and KaTeX, EXP-11 drill mode, EXP-3 catalog | UPSC, NDA, JEE, NEET |
| Design gate | EXP-14 shared store | Starts with B2C |

## 9. Research limits and what to verify before coding

- **Exam blueprints are not locked.** Official sites (UPSC, SSC, IBPS, SBI, RRB) blocked the fetch tool; most figures come from coaching or news sites. Check each against the current official notice before storing a blueprint. Unverified: SSC CGL Tier 2 sections, SSC CHSL, all SBI figures, IBPS Mains section counts, JEE numeric-question negative marking, the NEET section structure, every copyright line on official sites, official syllabus URLs.
- **Working figures (secondary sources):** SSC CGL Tier 1: 100 questions, 200 marks, four sections of 25, 0.5 negative, 60 minutes. SSC MTS: Session 1 has 40 questions and 120 marks with no negative marking; Session 2 has 50 questions and 150 marks with 1 negative mark; 45 minutes each. IBPS PO and Clerk Prelims: 100 questions, 0.25 negative, 60 minutes in timed sections. RRB NTPC CBT 1 and Group D: 100 questions, one third negative, 90 minutes. UPSC Prelims: GS 100 x 2 marks and CSAT 80 x 2.5 marks, one third negative, 2 hours each. NDA: Maths 120 x 2.5 and GAT 150 x 4, one third negative, 2.5 hours each. JEE Main Paper 1: 75 questions, 300 marks, 20 MCQ and 5 numeric per subject, 3 hours. NEET UG: 180 questions, 720 marks, +4 and -1, 180 minutes.
- **Legal (to confirm with a lawyer):** who owns each body's papers; the exact clause of the exam-use exception; whether tolerated third-party publishing of previous-year papers is a safe practice for a paid SaaS. The research found court decisions that papers are copyrightable (for example Delhi High Court, Rupendra Kashyap v. Jiwan Publishing House, 1996), no reported case against the large ed-tech sites, no openly licensed source of exam questions, and one aggregator policy that bans crawlers (others unchecked).
- **Standards:** QTI 3 import and export already exist in the code; keep the internal schema and export through QTI on request. The field set in § 6 is a practical set, not an industry standard.

## 10. Open questions for the owner

1. D1 to D7 (§ 3).
2. Is a candidate-facing previous-year catalog (lane B) wanted for marketing and SEO, or only for internal tagging?
3. Which exam blueprint is verified first by hand against the official notice? Suggest SSC CGL Tier 1, because Wave 1 starts there.

## 11. Built in S18: EXP-1, EXP-2, EXP-4

Local commits 704b47d, 1363645, b0d6363, EXP-4 merge (not pushed or deployed at the time of writing).

**What changed**
- EXP-1: two bundled frameworks, `exam-structure.json` and `subject-map.json`, in `modules/04-question-bank/src/frameworks`, registered in `framework-seeds.ts`. The edition field (node `version`) is `draft-unverified`. Only Quant > Arithmetic has subtopics.
- EXP-2: migration 0194. New table `question_source` (RLS). New `questions` columns: `difficulty_est`, `review_state`, `language_primary`, `content_i18n`. Existing active questions are grandfathered as `review_state='verified'`. Super-admin route `POST /api/admin/super/questions/:id/withdraw`. A rights allowlist (`original`, `derived_from_source`, `licensed`) blocks pack publish and bulk activation. Clone and resync copy `question_source`.
- EXP-4: import v2. New template columns; difficulty scales (words, 1-3, 1-5) map to `difficulty_est` and keep the raw label; `rights_status` is required for CSV and XLSX; three duplicate classes (exact, normalised, trigram); commit writes `question_source` and the exam-stage and subject-map taxonomy links. Migration 0195 adds the help rows (module 16).

**Why**
- Provenance and rights must be recorded per item before any exam content enters the bank (see § 4, § 7). The allowlist makes "no rights record, no publish" a hard rule.
- Grandfathering keeps today's content usable without a review round.

**Considered and rejected**
- Trigram match with `CREATE EXTENSION pg_trgm` inside a migration: rejected; trigram runs only if the extension already exists, so no shared-database change.
- Silent default of `rights_status` for CSV and XLSX: rejected; old v1 CSV rows now error on purpose. GIFT, Aiken and QTI default to `original`.
- Hard-block on trigram duplicates: rejected; threshold 0.8 within the same domain gives a warning only.

**Not included**
- Takedown propagation to tenant clones (row EXP-19) and purge from frozen pools (row EXP-20), both found by the EXP-2 gate review.
- The review gate itself (EXP-18); the clone copies `review_state` as is, so EXP-18 may reset it.
- Organisation upload (EXP-17); it must set origin `tenant_upload`.
- Verification of the seeds against official notices (EXP-0).

**Downstream impact**
- Modules 04, 05 (publish path), 16 (help rows), 02 and 14 (EXP-19 later). `docs/02-data-model.md` and `docs/03-api-contract.md` need the schema and route entries.
- Gate: Sonnet takeover REVISE (3 fixes applied: allowlist, activation paths, idempotent withdraw). `codex exec` gave a text-only second opinion (REVISE, verify items only; its sandbox cannot run commands).
- EXP-4 doubts: report `checksRun` is computed at report time and not stored; the UI chips are untested.
