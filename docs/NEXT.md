# Next brief (generated)

GENERATED FILE - do not edit. Run: node tools/next-brief.mjs

- Generated: 2026-10-21T09:14:53.590Z (2026-10-21 14:44:53 IST)
- HEAD: `7b0963a4`. If HEAD differs from `git rev-parse --short HEAD`, regenerate.
- Dirty files (`git status --short` lines): 10

## 1. Last session (SESSION_STATE, first block)

## Session — 2026-10-21 — S42: docs tidy (Z-105 to Z-109)

**Headline:** Docs are tracked again and 15 private items live in docs/private/. Guards run in CI. Old text is archived by script with a move trail. SESSION_STATE.md went from 1006604 to about 19000 bytes, ROADMAP.md from 732996 to about 418000 bytes. Z-106 and Z-107 are closed; Z-105, Z-108 and Z-109 wait for the owner's CLAUDE.md text. Recount: pending 92, closed 215, total 307, 70%.
**Commits:** `d9290ec1` move trail tools · `477aac15` private docs moved, leaks fixed · `0563d6f8` docs guards · `924cd996` ROADMAP citations pinned · `c2218fc2` archive run · `3f923876` archive link fix (CI was red on c2218fc2, green here) · `7b0963a4` plans/design tidy, folds, DECISIONS, close-session. CI green on 7b0963a4. Tag `docs-layout-before-tidy-2026-10-21`.
**Tests:** pass (the 8 docs tests, 36 tests; `pnpm verify`; doc-anchors; skill-mount; privacy 0 findings; links 0 new against the baseline of 167 old dead links).
**Start-up read (CLAUDE.md + PROJECT_BRAIN.md + 01-architecture + NEXT + MEMORY.md):** 84816 to about 66000 bytes. Tracked md files in docs/: 134 before, 142 after (nothing deleted, archive files added); md files on disk outside docs/private/: 191 (13 more in docs/private/).
**Next:** owner approves the CLAUDE.md text (host name and IP line 84, `git add -f` line 172, Phase 6 line 171), decides where the module SKILL.md files live (recommend: keep, 164 files and 342 references, 3 lints read them) and Z-110. Then move PROJECT_BRAIN.md into docs/ with `node tools/docs-move.mjs` and regenerate with `node tools/close-session.mjs`.
**Open questions:** the KNOWN list in tools/check-docs-privacy.mjs exempts old vendor and liability amounts in 8 public docs (owner decides on a clean-up); the Caddy snippet comments still show the origin IP; about 250 untracked files under docs/testing/ (track or ignore); lint-docs becomes strict on 2026-10-29 and ROADMAP.md is still over its 250000-byte cap.
**Old task or feature checked:** Z-73 (docs tests), Z-75 (stop tracking public docs: still open, owner decides in Z-110), RW-85 (docs lint date).
**New tools:** docs-move, docs-where, docs-rewrite-refs, docs-archive, docs-plans-index, close-session, check-docs-privacy, check-docs-links (all in tools/; moves in docs/moves.json).


## 2. ROADMAP status board


Merged 2026-10-15 from the former root file `PENDING_TASKS`. Tick here per session; the task rows are below.

**Legend:** ✅ = done, 🚧 = in progress, 💬 = waiting for owner, 🔲 = blocked, — = not started

## 3. Open Z and EXP rows (37 total)

- `EXP-3` (EXP-3 (lane B catalog)) — Previous-year catalog without question text. — pending (after pilot; Claude; M)
- `EXP-5` (EXP-5 (search and facets)) — Facets and full-text search in the question bank. — PARTIAL (S34 added the `has_passage` filter; Z-43 draws by outcome node still open) (S20, 2026-10-17, `c34a597`; migrati
- `EXP-6` (EXP-6 (EX-2)) — Exam blueprints and section marks. — PARTIAL (S34 added a read-only super-admin page `/admin/exam-blueprints` with Start full mock; Z-51 fields and other exa
- `EXP-7` (EXP-7 (OD-X8, lane A)) — Generator skill for exam items, light-edit mode and the seed-similarity gate. — pending (after EXP-2; Claude + owner for the VPS skill deploy; M)
- `EXP-9` (EXP-9 (EX-10, OD-X6)) — Hindi through an overlay on the same question. — pending (Wave 1 completion; Claude + owner reviewer; L)
- `EXP-10` (EXP-10 (EX-11, EX-12)) — Images and KaTeX. — pending (Wave 2 and 3; Claude; L)
- `EXP-11` (EXP-11 (EX-6, FU-D23 drill part)) — Drill mode. — pending (Wave 2 and 3; Claude; M-L)
- `EXP-12` (EXP-12 (answer-key disputes)) — Review workflow and answer-key corrections. — PARTIAL (S34, 2026-10-19; Claude; M): review queue across packs (`/admin/review-queue`), note history, dispute, affected
- `EXP-13` (EXP-13 (RW-60 reuse)) — Calibrate difficulty from attempts. — pending (after volume exists; Claude; S-M)
- `EXP-15` (EXP-15 (Wave 1 start, OD-X9)) — Vertical slice: SSC CGL Tier 1, Quant, about 200 original items, end to end. — pending (S34: tooling built, `tools/exam-slice/load.mjs` dry-run and apply plus runbook `docs/runbooks/exam-slice-spot-c
- `EXP-16` (EXP-16 (lane E, scraping)) — Scraping intake for previous-year and practice questions. — pending (after EXP-2 and EXP-4; Claude; M per source)
- `EXP-17` (EXP-17 (lane F, organisation upload)) — Organisation admins upload their own question sets. — PARTIAL (S34, 2026-10-19: screen `/admin/org-question-upload` built with preview, warranty, rights, uploads list and wit
- `EXP-20` (EXP-20 (EXP-2 gate finding)) — Frozen assessment pools keep a withdrawn question. — pending (owner decides purge or sign-off; Claude; S-M) DECIDED (owner, 2026-10-18): leave frozen copies as they are; rem
- `Z-19` (Z-19 (LC-2 flip)) — Flip `USER_PURGE_ENABLED=true` on the VPS (`.env`, then recreate `assessiq-worke — pending (owner decides after the first dry-run tick) S32 (2026-10-19 09:01 UTC): FLIPPED. The first tick (2026-10-19 03:
- `Z-26` (Z-26 (SEO-A2; unblocks F2 and CWV-1)) — Connect Search Console and a privacy-light analytics tool. — pending (owner verifies and picks the tool; Claude adds tag and privacy line; XS). S17 fact: a Microsoft Clarity script 
- `Z-35` (Z-35 (SEO-F5, F7)) — Organization `sameAs` is empty (F5). Microsoft Clarity is live (F7): check `privacy.astro` and the consent wording. — pending (partly done S18, `59a5962`): (a) privacy page now names what Clarity records, cookie names and lifetimes (`_clc
- `Z-37` (Z-37 (Z-10 code fixes)) — Email code fixes from the Z-10 review. — PART 1 DONE earlier (67e5db5) and PART 2 DONE in S20 (`f253297` + `75a42ca`: plain result email, share links, `.txt` sig
- `Z-38` (Z-38 (Dependabot tail)) — Dependabot items left after the S17 patch pass. — partly done (S41, 2026-10-21, `dd287b3c`): the 12 minor and patch updates applied (fastify 5.12.7, react 19.3.1, playwri
- `Z-54` (Z-54 (DOCSLINT-2)) — Docs lint: confirm green on main, then flip `fail_on_error` to true. — pending (Claude; XS; not before 2026-10-29). S41 (2026-10-21): still before the date, `fail_on_error` unchanged, waits u
- `Z-72` (Z-72 (LIABILITY-1)) — Liability and data-processing proposal for the lawyer. — pending (owner and lawyer approve; Claude; S). Draft written S28. Owner follow-up 2026-10-19 (after the v2 sheet): not a
- `Z-75` (Z-75 (PUBLICDOCS-1)) — Plan to stop tracking public docs files in the public repo. — pending (plan written S31, 2026-10-19: `docs/plans/Z-75-stop-tracking-public-docs.md`; execution needs the owner's yes a
- `Z-76` (Z-76 (PAGES-1)) — Website page proposals (5 to 8), owner approves each. — PARTIAL S37 (2026-10-20, commits `0bc3e5ad`, `6862328a`, `160e89e5`; code and marketing on the server `160e89e5`): pages
- `Z-77` (Z-77 (CSP-ENFORCE)) — Enforce the Content-Security-Policy on assessiq.in. — pending (S39 note: the report-only policy now has `media-src 'self' blob:` for the reviewer video, and the plan and `app
- `Z-78` (Z-78 (BACKUP-OFFSITE)) — Switch on the daily off-site backup. — pending (after the first paying customer; owner decides the key location; Claude switches on and watches the first run; 
- `Z-86` (Z-86 (GATE-8)) — Full security review before the pilot. — pending (Claude; L; gate)
- `Z-92` (Z-92 (RATECARD)) — Rate card for credits (details are private). — pending (Claude drafts rate-card options in the private file; owner decides; S)
- `Z-94` (Z-94 (SUPPORT-AI)) — Support automation with AI (no support hire). — pending (Claude; phases A and B S-M; phase C owner decision and gate) OWNER DECISION 2026-10-19: DEFERRED. Start only wh
- `Z-97` (Z-97 (SIGNUP-OPEN)) — Open public sign-up when the owner says. — pending (owner says when; Claude; S)
- `Z-101` (Z-101 (GMAIL-FOLD)) — Email address folding: apply the dot rule to Gmail only, and fix the tester case. — pending (owner confirms the exact change; Claude; S)
- `Z-103` (Z-103 (TIME-SUGGEST)) — Suggest the test time from the question count and difficulty. — pending (owner gives minutes per question; Claude; S)
- `Z-105` (Z-105 (DOCS-PRIVATE)) — Move the private docs into one ignored folder and fix the leaks in tracked files. — pending (partial, S42 2026-10-21: 15 items moved to docs/private/ and the tracked-file leaks fixed in 477aac15, CI green
- `Z-108` (Z-108 (DOCS-TIDY)) — Tidy the plan and design docs, and fold the change records into the feature docs. — pending (partial, S42 2026-10-21, 7b0963a4, CI green: 7 change records folded into module SKILL.md files and archived wi
- `Z-109` (Z-109 (CLOSE-CMD)) — One command for the session close-out. — pending (partial, S42 2026-10-21, 7b0963a4: tools/close-session.mjs and tools/docs-plans-index.mjs built and tested; lef
- `Z-110` (Z-110 (Z75-DECIDE)) — Decide what happens to Z-75 and run the history purge before the pilot. — pending (owner decides; Claude executes)
- `Z-111` (Z-111 (MOCK-FEEDBACK)) — Mock attempts always show the expected answer; real exams keep the tenant level. — pending (Claude; S; Sonnet; Opus reviews the helper)
- `Z-5` (Z-5 (SP9, SP10, Z-3)) — Owner live tests still open: — pending (owner)
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
- SESSION_STATE block names no next number; computed from files.

## 6. Reading list reminder

Still read PROJECT_BRAIN.md and docs/RCA_LOG.md (CLAUDE.md Phase 0).
