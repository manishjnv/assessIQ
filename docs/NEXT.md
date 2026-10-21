# Next brief (generated)

GENERATED FILE - do not edit. Run: node tools/next-brief.mjs

- Generated: 2026-10-21T04:14:45.802Z (2026-10-21 09:44:45 IST)
- HEAD: `e1353390`. If HEAD differs from `git rev-parse --short HEAD`, regenerate.
- Dirty files (`git status --short` lines): 0

## 1. Last session (SESSION_STATE, first block)

## Session — 2026-10-20/21 — S39: Wave 2 camera for real exams (Z-74, Z-82), camera follow-up, optional time limit per assessment

**Headline:** The camera feature is built and live, and the `CAMERA_ENFORCED` switch was turned ON in production on 2026-10-21 (owner decision, after the commits below; server `.env` backup kept, only `assessiq-api` recreated, sweep 0 failures). Caddy `camera=(self)` is applied on take pages only. Follow-up shipped: camera line in the invitation and reminder emails, own limit and idempotence on the consent route, retake consent test. New: the organisation admin can set an optional time limit per assessment (empty = the difficulty's time). Z-74 and Z-82 closed in place.
**Commits (all pushed, CI green, deployed):** `737ccb13` camera server side · `6dbabbd4` candidate and staff screens, help 0231 · `b1426b66` nav probe fix · `572a8dff` close-out docs, smoke spec, edge reference copies · `dd287b3c` (the other session's blueprint fields and dependency bumps, pushed with ours after a gate check of its two package changes) · `e1d4ed50` camera follow-up · `5f72240c` time limit plus the gate fixes (bulk invite resolves the camera rule once per batch) · handoff docs commits.
**Tests:** pass. Module 05 213 (3 skipped), 06 full, 10 279, 13 314, 16 116, take pages 81, time-limit test file 6, smoke spec 3 of 3 (local). `pnpm verify` green before every push. Deployed three times, sweep 0 failures. Migrations 0229 to 0234 applied (0232 is the other session's blueprint help). Next free migration: 0235. Last deployed sha `5f72240c`.
**Recount:** pending 79, closed 206, total 285, 72% (was 81/204/285). Z-101 (GMAIL-FOLD) was added to ROADMAP.md by the other session; ROADMAP.md was NOT committed by this session and has no row for the time limit yet.
**Edge:** the shared Caddyfile was edited once with the owner's go (old copy saved on the server). The camera header must be a site-level deferred header (RCA 2026-10-21). Repo reference copies match the live file.
**Next:** (1) owner: confirm the camera notice in each organisation (Settings, Data privacy, Camera card; needed before any real exam can start), run the 20-minute live camera test (readiness picture, consent, photos, cover the camera, reviewer page, console check for Z-77, free disk and photo size), create the school test organisation and walk `docs/runbooks/camera-school-test.md`. Undo = `CAMERA_ENFORCED=false` and recreate `assessiq-api`. The worker still has the old value (recreate it so reminder emails show the camera line). (2) owner or ROADMAP session: add a row for the time limit (change record `docs/plans/2026-10-21-assessment-time-limit-change-record.md`). (3) Wave 3 (exam content) or Wave 5 (GATE-8, load test).
**Open questions:** recreate the worker so reminder emails match? Accepted gaps: per-tenant camera storage quota, orphan-file sweep, super admin cross-tenant file view (support access deferred), no per-IP cap on the consent route. Time limit: preview and invited list show the override or the level time and ignore section or whole-test time (old behaviour). Owner tasks: school test walk-through, signed-in check of /admin and one take page, CSP console check, speed check, AI evaluation bless and dry runs, rate card, host and IP in the public CLAUDE.md.
**Old task or feature checked:** Z-87, Z-91 (camera reuses the desktop rule and readiness page), Z-39 (retake limit and retake consent), Z-77 (CSP `media-src`), the level time rule in `levels.duration_minutes` (Rule B).
**Change records:** `docs/plans/2026-10-20-camera-change-record.md`, `docs/plans/2026-10-21-assessment-time-limit-change-record.md`
**Optimization register rows touched:** TOK-6, GATE-4.


## 2. ROADMAP status board


Merged 2026-10-15 from the former root file `PENDING_TASKS`. Tick here per session; the task rows are below.

**Legend:** ✅ = done, 🚧 = in progress, 💬 = waiting for owner, 🔲 = blocked, — = not started

## 3. Open Z and EXP rows (39 total)

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
- `Z-75` (Z-75 (PUBLICDOCS-1)) — Plan to stop tracking public docs files in the public repo. — pending (plan written S31, 2026-10-19: `docs/plans/Z-75-stop-tracking-public-docs.md`; execution needs the owner's yes a
- `Z-76` (Z-76 (PAGES-1)) — Website page proposals (5 to 8), owner approves each. — PARTIAL S37 (2026-10-20, commits `0bc3e5ad`, `6862328a`, `160e89e5`; code and marketing on the server `160e89e5`): pages
- `Z-77` (Z-77 (CSP-ENFORCE)) — Enforce the Content-Security-Policy on assessiq.in. — pending (S39 note: the report-only policy now has `media-src 'self' blob:` for the reviewer video, and the plan and `app
- `Z-78` (Z-78 (BACKUP-OFFSITE)) — Switch on the daily off-site backup. — pending (after the first paying customer; owner decides the key location; Claude switches on and watches the first run; 
- `Z-86` (Z-86 (GATE-8)) — Full security review before the pilot. — pending (Claude; L; gate)
- `Z-88` (Z-88 (MOBILE-RETIRE)) — Bring the mobile work in line with the desktop-only rule. — pending (Claude; S) Owner clarification 2026-10-19: the mobile layouts stay in use. Keep a phone smoke for /try, the inv
- `Z-92` (Z-92 (RATECARD)) — Rate card for credits (details are private). — pending (Claude drafts rate-card options in the private file; owner decides; S)
- `Z-94` (Z-94 (SUPPORT-AI)) — Support automation with AI (no support hire). — pending (Claude; phases A and B S-M; phase C owner decision and gate) OWNER DECISION 2026-10-19: DEFERRED. Start only wh
- `Z-97` (Z-97 (SIGNUP-OPEN)) — Open public sign-up when the owner says. — pending (owner says when; Claude; S)
- `Z-101` (Z-101 (GMAIL-FOLD)) — Email address folding: apply the dot rule to Gmail only, and fix the tester case. — pending (owner confirms the exact change; Claude; S)
- `Z-103` (Z-103 (TIME-SUGGEST)) — Suggest the test time from the question count and difficulty. — pending (owner gives minutes per question; Claude; S)
- `Z-104` (Z-104 (CERT-POLISH)) — Small polish found in the owner test. — pending (Claude; S; mostly Haiku)
- `Z-5` (Z-5 (SP9, SP10, Z-3)) — Owner live tests still open: — pending (owner)
- `Z-11` (Z-11 (Phase 5, FR13, Z-9, Z-15)) — Certificate visibility after a release. — pending (small). Item (c) done (S17, 2026-10-17, `f9c569f`): `CERTIFICATE_RULE_TEXT` in `modules/11-candidate-ui/src/cop
- `Z-14` (Z-14 (FU-B13, FR4, D8, D12)) — Embed: finish the iframe flow after the Caddy decision. — pending (owner first for a; Claude for b, c; owner decision for d) Owner sheets 2026-10-19 (applied S34), v1 Q39: embed 

## 4. Newest RCA entries (5 newest of 256; file order: mixed (sorted by date; same-day ties keep file order))

### 2026-10-21 — A Caddy header added in the site block lost to the shared snippet (Z-74, Z-77)
**Symptom:** after the first edge reload, `/take/...` still sent `Permissions-Policy: camera=()`. A second try inside the app handler failed the same way.
**Prevention:** `docs/06-deployment.md` records the trap. After each edge edit read the whole `caddy validate` output, then check the live headers with curl.

### 2026-10-21 — Bulk invite resolved the camera rule inside an open transaction (Z-74 follow-up)
**Symptom:** found in the review gate, not in production. A bulk invite would hold one pooled connection per request and wait for a second for each invitee; with as many concurrent bulk invites as the pool size, every request would wait forever.
**Prevention:** the review gate. Rule: never call a function that opens its own pooled connection from inside an open transaction. Single resend and the reminder job send outside a transaction.

### 2026-10-21 — Time limit shown on tests that ignore it (assessment time limit)
**Symptom:** found in the review gate. The new card accepted a time limit on a sectioned or whole-test assessment, where the clock uses the section minutes, so the screen and the clock would disagree.
**Prevention:** a test in `time-limit.test.ts`. When a field is ignored in one mode, refuse it in that mode instead of only documenting it.

### 2026-10-21 — Mock factories missed a new export (test trap, again)
**Symptom:** 20 module 05 tests failed with `No "resolveCameraRequired" export is defined on the "../email.js" mock`.
**Prevention:** after adding an export to a module that tests mock, grep `vi.mock("../<module>.js"` in the module and in apps/api and add the stub in the same change.

### 2026-10-20 — Passage draw could fail an attempt start with "Question pool too small" (random)
**Symptom:** CI unit test `passage-draw.test.ts` failed once with `Question pool too small at start: 4 < 5`. In production a candidate could be refused at start on a random shuffle.
**Prevention:** the unit test pins the stranded-gap case. The DB test `passage-draw.test.ts` already runs 12 random draws.

## 5. Next free migration

- Next free: `0235` (highest `modules/*/migrations` prefix + 1)
- Matches the newest SESSION_STATE block.

## 6. Reading list reminder

Still read PROJECT_BRAIN.md and docs/RCA_LOG.md (CLAUDE.md Phase 0).
