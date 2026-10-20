# Next brief (generated)

GENERATED FILE - do not edit. Run: node tools/next-brief.mjs

- Generated: 2026-10-20T14:51:19.054Z (2026-10-20 20:21:19 IST)
- HEAD: `d6c998b5`. If HEAD differs from `git rev-parse --short HEAD`, regenerate.
- Dirty files (`git status --short` lines): 1

## 1. Last session (SESSION_STATE, first block)

## Session — 2026-10-20 — S38: Session 4 pre-pilot readiness (exact meter, expiry warning, result sign-in link, ETA notice, sample quiz, load-test script)

**Headline:** Z-93 and Z-96 closed (exact meter + expiry-warning email), Z-15 (a) shipped (7-day one-time sign-in link in the result email), SP11 live, Z-84 report done, load-test script and checklist written (not run).
**Commits:** `5afedc62` — feat: exact credit meter, expiry-warning email, result sign-in link, ETA notice, sample-quiz tool, load-test script · `57801b92` — docs close-out · `23267f7a` — SP11 wording for both release modes, help v2 rows, `retireResultLoginLinks` · `d6c998b5` — docs: withdraw rule on Z-15, GATE-8 check on Z-86
**Tests:** pass (billing 12+7, auth 334+, notifications 308, help 116 + guards, admin-dashboard 262, `pnpm verify`); CI green on every commit; deployed twice, sweep 0 failures; migration 0228 applied (next 0229). Last deployed sha `23267f7a` (`d6c998b5` is docs only).
**Recount:** pending 81, closed 204, total 285, 72% (was 84/201/285, 71%).
**Owner answers applied (S38 part 2):** SP11 text changed (true for both modes) and help v2 live; withdraw rule = helper only, no withdraw action built, GATE-8 checks it; sample quiz: none of the 4 sources loaded; load test waits until after Wave 2.
**Next:** Wave 2 (camera: Z-74, Z-82; needs your Caddy `camera=(self)` go and the lawyer question), or more Wave 1/4 rows. Before the load test: test-only token export, no real invite emails, source-IP plan, image-tag rollback step in deploy.
**Open questions:** none blocking. Owner tasks: signed-in check of /admin and a take page, CSP console check (unlocks Z-77), speed check, AI evaluation bless and dry runs, legal defaults and lawyer question, rate card, host/IP in public CLAUDE.md, rescoring Q1-Q4, warranty wording, GIFT format.
**Old task or feature checked:** Z-93, Z-96, Z-15, SP11, Z-84 (Rule B); the 2026-05-13 candidate magic-link decision is honoured (POST verify via SPA).
**Change record:** `docs/plans/2026-10-20-session4-change-record.md`


## 2. ROADMAP status board


Merged 2026-10-15 from the former root file `PENDING_TASKS`. Tick here per session; the task rows are below.

**Legend:** ✅ = done, 🚧 = in progress, 💬 = waiting for owner, 🔲 = blocked, — = not started

## 3. Open Z and EXP rows (38 total)

- `EXP-3` (EXP-3 (lane B catalog)) — Previous-year catalog without question text. — pending (after pilot; Claude; M)
- `EXP-5` (EXP-5 (search and facets)) — Facets and full-text search in the question bank. — PARTIAL (S34 added the `has_passage` filter; Z-43 draws by outcome node still open) (S20, 2026-10-17, `c34a597`; migrati
- `EXP-6` (EXP-6 (EX-2)) — Exam blueprints and section marks. — PARTIAL (S34 added a read-only super-admin page `/admin/exam-blueprints` with Start full mock; Z-51 fields and other exa
- `EXP-7` (EXP-7 (OD-X8, lane A)) — Generator skill for exam items, light-edit mode and the seed-similarity gate. — pending (after EXP-2; Claude + owner for the VPS skill deploy; M)
- `EXP-9` (EXP-9 (EX-10, OD-X6)) — Hindi through an overlay on the same question. — pending (Wave 1 completion; Claude + owner reviewer; L)
- `EXP-10` (EXP-10 (EX-11, EX-12)) — Images and KaTeX. — pending (Wave 2 and 3; Claude; L)
- `EXP-11` (EXP-11 (EX-6, FU-D23 drill part)) — Drill mode. — pending (Wave 2 and 3; Claude; M-L)
- `EXP-12` (EXP-12 (answer-key disputes)) — Review workflow and answer-key corrections. — PARTIAL (S34, 2026-10-19; Claude; M): review queue across packs (`/admin/review-queue`), note history, dispute, affected
- `EXP-13` (EXP-13 (RW-60 reuse)) — Calibrate difficulty from attempts. — pending (after volume exists; Claude; S-M)
- `EXP-14` (EXP-14 (D3, EX-4, EX-5)) — Design gate: shared question store for B2C. — pending (blocked on owner B2C start; Claude; L design)
- `EXP-15` (EXP-15 (Wave 1 start, OD-X9)) — Vertical slice: SSC CGL Tier 1, Quant, about 200 original items, end to end. — pending (S34: tooling built, `tools/exam-slice/load.mjs` dry-run and apply plus runbook `docs/runbooks/exam-slice-spot-c
- `EXP-16` (EXP-16 (lane E, scraping)) — Scraping intake for previous-year and practice questions. — pending (after EXP-2 and EXP-4; Claude; M per source)
- `EXP-17` (EXP-17 (lane F, organisation upload)) — Organisation admins upload their own question sets. — PARTIAL (S34, 2026-10-19: screen `/admin/org-question-upload` built with preview, warranty, rights, uploads list and wit
- `EXP-20` (EXP-20 (EXP-2 gate finding)) — Frozen assessment pools keep a withdrawn question. — pending (owner decides purge or sign-off; Claude; S-M) DECIDED (owner, 2026-10-18): leave frozen copies as they are; rem
- `Z-19` (Z-19 (LC-2 flip)) — Flip `USER_PURGE_ENABLED=true` on the VPS (`.env`, then recreate `assessiq-worke — pending (owner decides after the first dry-run tick) S32 (2026-10-19 09:01 UTC): FLIPPED. The first tick (2026-10-19 03:
- `Z-26` (Z-26 (SEO-A2; unblocks F2 and CWV-1)) — Connect Search Console and a privacy-light analytics tool. — pending (owner verifies and picks the tool; Claude adds tag and privacy line; XS). S17 fact: a Microsoft Clarity script 
- `Z-35` (Z-35 (SEO-F5, F7)) — Organization `sameAs` is empty (F5). Microsoft Clarity is live (F7): check `privacy.astro` and the consent wording. — pending (partly done S18, `59a5962`): (a) privacy page now names what Clarity records, cookie names and lifetimes (`_clc
- `Z-37` (Z-37 (Z-10 code fixes)) — Email code fixes from the Z-10 review. — PART 1 DONE earlier (67e5db5) and PART 2 DONE in S20 (`f253297` + `75a42ca`: plain result email, share links, `.txt` sig
- `Z-38` (Z-38 (Dependabot tail)) — Dependabot items left after the S17 patch pass. — partly done (S31, 2026-10-19; Claude; M): astro 7.4.0 DONE and DEPLOYED 2026-10-19 (marketing rebuilt from `da2a95cd`, 4
- `Z-42` (Z-42 (EXP-6 tail)) — Blueprint mocks: whole-test timer and marks per question. — pending, mostly done (S21, 2026-10-18, `43fc9b9` + gate hardening `7ef8826`): whole-test timer (`settings.whole_test_min
- `Z-48` (Z-48 (DOCSLINT-1)) — Make the Docs lint workflow pass before it becomes required on 2026-10-29. — pending, partly done (S22, 2026-10-18, `78165b0`, follow-ups `0a58c457`, `a3a41852`): Vale scoped to the docs set, 19 ma
- `Z-51` (Z-51 (FORM-1)) — Admin form fields `whole_test_minutes` and marks per section for blueprint mocks. — pending (owner picks a or b; Claude; S) Owner v2 sheet 2026-10-19, R26: DECIDED option (b): keep sections and blueprint 
- `Z-54` (Z-54 (DOCSLINT-2)) — Docs lint: confirm green on main, then flip `fail_on_error` to true. — pending (Claude; XS; not before 2026-10-29). S24 check (2026-10-18): Docs lint on main is green in the last 4 runs, incl
- `Z-72` (Z-72 (LIABILITY-1)) — Liability and data-processing proposal for the lawyer. — pending (owner and lawyer approve; Claude; S). Draft written S28. Owner follow-up 2026-10-19 (after the v2 sheet): not a
- `Z-74` (Z-74 (PROCTOR-RET)) — Webcam photos: 90-day automatic deletion job, and the appeal question. — pending (design revision 2 written S31, 2026-10-19; owner approves; no build until the owner says so; Claude; L split in
- `Z-75` (Z-75 (PUBLICDOCS-1)) — Plan to stop tracking public docs files in the public repo. — pending (plan written S31, 2026-10-19: `docs/plans/Z-75-stop-tracking-public-docs.md`; execution needs the owner's yes a
- `Z-76` (Z-76 (PAGES-1)) — Website page proposals (5 to 8), owner approves each. — PARTIAL S37 (2026-10-20, commits `0bc3e5ad`, `6862328a`, `160e89e5`; code and marketing on the server `160e89e5`): pages
- `Z-77` (Z-77 (CSP-ENFORCE)) — Enforce the Content-Security-Policy on assessiq.in. — pending (owner go for the Caddy edit; Claude prepares and verifies; S) Owner v2 sheet 2026-10-19: the owner has not yet 
- `Z-78` (Z-78 (BACKUP-OFFSITE)) — Switch on the daily off-site backup. — pending (after the first paying customer; owner decides the key location; Claude switches on and watches the first run; 
- `Z-82` (Z-82 (SCHOOL-CAM)) — School mode for webcam photos. — pending (Claude; M; lawyer first) Owner follow-up 2026-10-19 (after the v2 sheet): school flag is set by the super admin
- `Z-86` (Z-86 (GATE-8)) — Full security review before the pilot. — pending (Claude; L; gate)
- `Z-88` (Z-88 (MOBILE-RETIRE)) — Bring the mobile work in line with the desktop-only rule. — pending (Claude; S) Owner clarification 2026-10-19: the mobile layouts stay in use. Keep a phone smoke for /try, the inv
- `Z-92` (Z-92 (RATECARD)) — Rate card for credits (details are private). — pending (Claude drafts rate-card options in the private file; owner decides; S)
- `Z-94` (Z-94 (SUPPORT-AI)) — Support automation with AI (no support hire). — pending (Claude; phases A and B S-M; phase C owner decision and gate) OWNER DECISION 2026-10-19: DEFERRED. Start only wh
- `Z-97` (Z-97 (SIGNUP-OPEN)) — Open public sign-up when the owner says. — pending (owner says when; Claude; S)
- `Z-5` (Z-5 (SP9, SP10, Z-3)) — Owner live tests still open: — pending (owner)
- `Z-11` (Z-11 (Phase 5, FR13, Z-9, Z-15)) — Certificate visibility after a release. — pending (small). Item (c) done (S17, 2026-10-17, `f9c569f`): `CERTIFICATE_RULE_TEXT` in `modules/11-candidate-ui/src/cop
- `Z-14` (Z-14 (FU-B13, FR4, D8, D12)) — Embed: finish the iframe flow after the Caddy decision. — pending (owner first for a; Claude for b, c; owner decision for d) Owner sheets 2026-10-19 (applied S34), v1 Q39: embed 

## 4. Newest RCA entries (5 newest of 248; file order: mixed (sorted by date; same-day ties keep file order))

### 2026-10-20 — Passage draw could fail an attempt start with "Question pool too small" (random)
**Symptom:** CI unit test `passage-draw.test.ts` failed once with `Question pool too small at start: 4 < 5`. In production a candidate could be refused at start on a random shuffle.
**Prevention:** the unit test pins the stranded-gap case. The DB test `passage-draw.test.ts` already runs 12 random draws.

### 2026-10-20 — CI e2e red: the test factory started real attempts without readiness signals (Z-91)
**Symptom:** CI run on `a3a0b337` failed in the e2e shards: `take-happy-path`, `take-timer-expiry`, `ordering-admin` and `admin-workflow` step 11 got `422 READINESS_FAILED` from `startAttempt`.
**Prevention:** the gate is covered by a route test for `/api/me/assessments/:id/start` in `attempt-engine.test.ts`. A new gate on a start route must update the e2e factory in the same commit.

### 2026-10-20 — CI unit red: route tests that mock tenancy and auth could not load the sign-up body schema
**Symptom:** CI run on `6c770069` failed about 20 `apps/api` test files at import: `No "isValidOrgName" export is defined on the "@assessiq/tenancy" mock` and `No "DPA_VERSION" export is defined on the "@assessiq/auth" mock`.
**Prevention:** new exports from a shared module must not be read at import time in `_schemas.ts`. Run the full `apps/api` test directory before a push that changes `_schemas.ts`.

### 2026-10-20 — Second start route skipped the device and readiness gate (found in review)
**Symptom:** none in production (found in the adversarial review of `2301abb7`). A candidate with a session could start a real exam from a phone through `POST /api/me/assessments/:id/start`, with no device or readiness check.
**Prevention:** route tests for both start routes. Embed starts stay exempt and are recorded as an accepted gap.

### 2026-10-20 — CI unit red: ledger test read migration 0225 from a path that depends on the working folder
**Symptom:** CI run on `33b7b52c` failed `modules/19-billing/src/__tests__/credit-ledger.test.ts` at load (`ENOENT` when run from the module folder; `TypeError: The URL must be of scheme file` when the first fix used `import.meta.url` under the root run).
**Prevention:** a test that reads a repo file must work from the module folder and from the repo root; run it both ways before the push.

## 5. Next free migration

- Next free: `0229` (highest `modules/*/migrations` prefix + 1)
- SESSION_STATE block names no next number; computed from files.

## 6. Reading list reminder

Still read PROJECT_BRAIN.md and docs/RCA_LOG.md (CLAUDE.md Phase 0).
