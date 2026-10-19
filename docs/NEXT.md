# Next brief (generated)

GENERATED FILE - do not edit. Run: node tools/next-brief.mjs

- Generated: 2026-10-19T02:51:52.203Z (2026-10-19 08:21:52 IST)
- HEAD: `8c6bd806`. If HEAD differs from `git rev-parse --short HEAD`, regenerate.
- Dirty files (`git status --short` lines): 0

## 1. Last session (SESSION_STATE, first block)

## Session — 2026-10-19 — S31: close-out, Z-71 and Q9 designs rev 2, flake fix, three plans

**Headline:** Z-46 and Z-55 closed (recount 79 pending, 183 closed, 262 total, 70%). The Z-71 and Z-74 designs were rewritten for all S30 findings; a second review gate said REVISE again with detail findings, all answered in the design files; nothing built. FU-B2 (audit JSONL download) was already built in S13, so nothing was rebuilt. The CI Docker flake has a most-likely cause and a fix (probe timeout). Plans written: Z-52 gaps 5 to 7, Z-75, react-router 7. Z-37 (a) shipped and deployed.
**Commits:** `f9a3243c` — Z-46 Caddy reference copy and Astro 7 record; `2a264d43` — stale line-range note; `b67cd329` — ROADMAP close-out; `3435a60f` — gate trailer (Caddy); `88f4e3c8` — docker probe timeout 5 s to 30 s (11 suites); `9fa5be34` — gate trailer; `b6cdb8c0` — Z-37 a, HTML sign-off line; `02500fc8` — docs (designs rev 2, plans, ROADMAP); handoff commit (this file, NEXT, RCA).
**Deploy:** `tools/deploy.sh --yes`, VPS `da2a95cd` to `02500fc8`, no migration, api, worker and frontend recreated, sweep 0 failures. No Caddy, Cloudflare, DNS or flag change.
**Tests:** `pnpm verify` green before each push. Notifications 3 files, 99 tests. CI green on `88f4e3c8` (3m50) and `b6cdb8c0`. CI green streak 7 of 10 before these runs (Z-60 not closable yet).
**Gates:** (1) Sonnet takeover on the Caddy reference diff: accept (1 note fixed). (2) ONE design-review gate for Z-71 and Z-74: REVISE for both, 11 and 12 findings, all answered in the designs, no third review run. (3) Sonnet takeover on the timeout diff (3 files under 07-ai-grading): accept.
**Next:** (1) Owner reads the revised Z-71 and Z-74 designs and answers the new owner questions below. (2) Owner sets the Z-18 date (flip `PLAN_TIERS_ENFORCED` before any Free sign-up). (3) Build rows only after approval, each with its own gate.
**Open questions (owner):**
- Z-18 date; daily sign-up cap 50; certificate line for unverified organisations; should AI drafts count as AI attempts; appeal hold for photos (recommended yes); VPS backups of `/var/assessiq/uploads`; disk numbers (80 percent guard, 5 GB default); Caddy diff yes at webcam build time.
- Z-75: option A (stop tracking all 107 docs files) or B; yes for the VPS copy-then-pull step. react-router 7: yes or no (step 1 is safe).
- Z-52 gap options (5: set in_review in new paths; 6: note table; 7: wait for EXP-12).
- Lawyer: 90 days, self-declared age, school tests, acceptance-record retention after a purge, liability file.
- Owner checks: live /admin test, emailed sign-in code, Delete buttons; browser console check of the CSP report-only header on /admin, a take page and the marketing site; pagespeed.web.dev; DMARC move later.
**Not done on purpose:** Z-71 build, webcam build, SP2/SP11/P3 (the per-assessment release-mode override is a gated feature in 05/07, the company ETA needs your wording), Z-42 admin UI (row Z-51 needs your pick a or b), Z-37 b (needs wording), Z-15 a, c, d, e and Z-35, Z-54 (not before 2026-10-29), TIME-13, GATE-8.
**Old task or feature checked:** FU-B2 and FR1 (JSONL download, cap, audit row, rate limit already built S13; not rebuilt, Rule B), Z-37, Z-38, Z-42, Z-46, Z-52, Z-55, Z-60, Z-70 to Z-75, RCA 2026-10-19 (flake), RCA 2026-10-18 (router copies) (Rule B, PROJECT_BRAIN.md)


## 2. ROADMAP status board


Merged 2026-10-15 from the former root file `PENDING_TASKS`. Tick here per session; the task rows are below.

**Legend:** ✅ = done, 🚧 = in progress, 💬 = waiting for owner, 🔲 = blocked, — = not started

## 3. Open Z and EXP rows (38 total)

- `EXP-3` (EXP-3 (lane B catalog)) — Previous-year catalog without question text. — pending (after pilot; Claude; M)
- `EXP-5` (EXP-5 (search and facets)) — Facets and full-text search in the question bank. — PARTIAL (S20, 2026-10-17, `c34a597`; migrations 0196 module 04, 0197 module 16): facets, counts, tsvector plus `pg_trgm`
- `EXP-6` (EXP-6 (EX-2)) — Exam blueprints and section marks. — PARTIAL (S20, 2026-10-17, `8445eba`; migration 0201 module 04): blueprint tables (platform-only, read-only for tenants),
- `EXP-7` (EXP-7 (OD-X8, lane A)) — Generator skill for exam items, light-edit mode and the seed-similarity gate. — pending (after EXP-2; Claude + owner for the VPS skill deploy; M)
- `EXP-8` (EXP-8 (EX-3 completion)) — Passages across question rows. — pending (Wave 1 completion; Claude; M)
- `EXP-9` (EXP-9 (EX-10, OD-X6)) — Hindi through an overlay on the same question. — pending (Wave 1 completion; Claude + owner reviewer; L)
- `EXP-10` (EXP-10 (EX-11, EX-12)) — Images and KaTeX. — pending (Wave 2 and 3; Claude; L)
- `EXP-11` (EXP-11 (EX-6, FU-D23 drill part)) — Drill mode. — pending (Wave 2 and 3; Claude; M-L)
- `EXP-12` (EXP-12 (answer-key disputes)) — Review workflow and answer-key corrections. — pending (Wave 1 completion; Claude; M)
- `EXP-13` (EXP-13 (RW-60 reuse)) — Calibrate difficulty from attempts. — pending (after volume exists; Claude; S-M)
- `EXP-14` (EXP-14 (D3, EX-4, EX-5)) — Design gate: shared question store for B2C. — pending (blocked on owner B2C start; Claude; L design)
- `EXP-15` (EXP-15 (Wave 1 start, OD-X9)) — Vertical slice: SSC CGL Tier 1, Quant, about 200 original items, end to end. — pending (after EXP-1, EXP-2, EXP-4, EXP-5, EXP-6, EXP-7; Claude + owner spot-check; M)
- `EXP-16` (EXP-16 (lane E, scraping)) — Scraping intake for previous-year and practice questions. — pending (after EXP-2 and EXP-4; Claude; M per source)
- `EXP-17` (EXP-17 (lane F, organisation upload)) — Organisation admins upload their own question sets. — pending (after EXP-2 and EXP-4; Claude; M)
- `EXP-20` (EXP-20 (EXP-2 gate finding)) — Frozen assessment pools keep a withdrawn question. — pending (owner decides purge or sign-off; Claude; S-M) DECIDED (owner, 2026-10-18): leave frozen copies as they are; rem
- `Z-18` (Z-18 (PT1/PT-4 flip)) — Flip `PLAN_TIERS_ENFORCED=true` on the VPS (`/srv/assessiq/.env`, then recreate  — pending (owner decides the date; Claude flips and smokes)
- `Z-19` (Z-19 (LC-2 flip)) — Flip `USER_PURGE_ENABLED=true` on the VPS (`.env`, then recreate `assessiq-worke — pending (owner decides after the first dry-run tick)
- `Z-20` (Z-20 (RV31 terms)) — Approve or edit the terms §8 sentence drafted in SESSION_STATE S14 § Owner gates — pending (owner wording)
- `Z-26` (Z-26 (SEO-A2; unblocks F2 and CWV-1)) — Connect Search Console and a privacy-light analytics tool. — pending (owner verifies and picks the tool; Claude adds tag and privacy line; XS). S17 fact: a Microsoft Clarity script 
- `Z-35` (Z-35 (SEO-F5, F7)) — Organization `sameAs` is empty (F5). Microsoft Clarity is live (F7): check `privacy.astro` and the consent wording. — pending (partly done S18, `59a5962`): (a) privacy page now names what Clarity records, cookie names and lifetimes (`_clc
- `Z-37` (Z-37 (Z-10 code fixes)) — Email code fixes from the Z-10 review. — PART 1 DONE earlier (67e5db5) and PART 2 DONE in S20 (`f253297` + `75a42ca`: plain result email, share links, `.txt` sig
- `Z-38` (Z-38 (Dependabot tail)) — Dependabot items left after the S17 patch pass. — partly done (S31, 2026-10-19; Claude; M): astro 7.4.0 DONE and DEPLOYED 2026-10-19 (marketing rebuilt from `da2a95cd`, 4
- `Z-42` (Z-42 (EXP-6 tail)) — Blueprint mocks: whole-test timer and marks per question. — pending, mostly done (S21, 2026-10-18, `43fc9b9` + gate hardening `7ef8826`): whole-test timer (`settings.whole_test_min
- `Z-48` (Z-48 (DOCSLINT-1)) — Make the Docs lint workflow pass before it becomes required on 2026-10-29. — pending, partly done (S22, 2026-10-18, `78165b0`, follow-ups `0a58c457`, `a3a41852`): Vale scoped to the docs set, 19 ma
- `Z-49` (Z-49 (BEACON-2)) — Decide whether the public demo page `/try` carries the Cloudflare Web Analytics beacon. — pending (owner decides A or B; Claude; XS)
- `Z-51` (Z-51 (FORM-1)) — Admin form fields `whole_test_minutes` and marks per section for blueprint mocks. — pending (owner picks a or b; Claude; S)
- `Z-52` (Z-52 (EXP18-GAPS)) — EXP-18 review gate: known gaps. — pending (Claude; P2; M) S29 (2026-10-19): gaps 1 to 4 closed (needs_fix on a platform master reaches live clones in the 
- `Z-54` (Z-54 (DOCSLINT-2)) — Docs lint: confirm green on main, then flip `fail_on_error` to true. — pending (Claude; XS; not before 2026-10-29). S24 check (2026-10-18): Docs lint on main is green in the last 4 runs, incl
- `Z-70` (Z-70 (FREEPLAN)) — Free trial plan pack for self-serve organisations. — pending (owner approval of the proposal; Claude; S). Draft written S28. Owner answer 2026-10-18: the public name is "Tri
- `Z-71` (Z-71 (SELFSERVE-BUILD)) — Self-serve organisation sign-up (build). — pending (design revision 2 written S31, 2026-10-19; owner approves; then build in two gated rows; Claude; L; design-gate
- `Z-72` (Z-72 (LIABILITY-1)) — Liability and data-processing proposal for the lawyer. — pending (owner and lawyer approve; Claude; S). Draft written S28.
- `Z-74` (Z-74 (PROCTOR-RET)) — Webcam photos: 90-day automatic deletion job, and the appeal question. — pending (design revision 2 written S31, 2026-10-19; owner approves; no build until the owner says so; Claude; L split in
- `Z-75` (Z-75 (PUBLICDOCS-1)) — Plan to stop tracking public docs files in the public repo. — pending (plan written S31, 2026-10-19: `docs/plans/Z-75-stop-tracking-public-docs.md`; execution needs the owner's yes a
- `Z-76` (Z-76 (PAGES-1)) — Website page proposals (5 to 8), owner approves each. — pending (S30: proposals written, 7 pages, in `docs/design/2026-10-19-page-proposals.md`; owner approves each; Claude; S)
- `Z-5` (Z-5 (SP9, SP10, Z-3)) — Owner live tests still open: — pending (owner)
- `Z-11` (Z-11 (Phase 5, FR13, Z-9, Z-15)) — Certificate visibility after a release. — pending (small). Item (c) done (S17, 2026-10-17, `f9c569f`): `CERTIFICATE_RULE_TEXT` in `modules/11-candidate-ui/src/cop
- `Z-14` (Z-14 (FU-B13, FR4, D8, D12)) — Embed: finish the iframe flow after the Caddy decision. — pending (owner first for a; Claude for b, c; owner decision for d)
- `Z-15` (Z-15 (Z-9, Z-10, M1-M4 mobile kit)) — Candidate result flow on a phone: findings. — pending (e is a bug) Item (e) closed (S16, 2026-10-17): `modules/15-analytics/src/activity-candidate/stats.ts`. Items (b

## 4. Newest RCA entries (5 newest of 238; file order: mixed (sorted by date; same-day ties keep file order))

### 2026-10-19 — CI unit shard 2 red once: Docker testcontainer unavailable (flake)
**Symptom:** CI run 39171014351 (commit `9bd08797`, a lockfile-only dependency change) failed in unit shard 2: `billing-events.test.ts:74` reported `Docker testcontainer required but unavailable in CI`. 110 of 111 files passed.
**Prevention:** if the error returns with 30 seconds, the cause is not the probe: read the runner Docker step and the testcontainer start logs the same day (logs expire). A shared probe helper for the 12 files is a later cleanup.

### 2026-10-18 — Admin page blank after login: two copies of react-router in the bundle
**Symptom:** after a successful sign-in at assessiq.in/admin the owner saw a blank white page. The browser error log (`stream":"frontend"`) held six `Uncaught Error` entries from `vendor-react-*.js` line 9 at one column, all with referer `/admin`. Public pages, the login page and the candidate pages
**Prevention:** the lockfile test above (runs in CI); a Dependabot bump must change every workspace that declares the package; the post-deploy sweep needs one signed-in check of `/admin` and an error boundary that shows a message instead of a blank page (ROADMAP Z-47).

### 2026-10-18 — CI typecheck red after Z-41
**Symptom:** the CI typecheck step failed after the Z-41 commit. Local vitest and eslint were green.
**Prevention:** run `pnpm typecheck` before push. The build agents ran only vitest and eslint.

### 2026-10-18 — CI e2e red: "Question 1 of" locator matched two elements
**Symptom:** the CI e2e step failed with a Playwright strict-mode error on the text "Question 1 of".
**Prevention:** use anchored, role-based locators in e2e specs. Watch that CI steps after a red step are also run once green.

### 2026-10-18 — Worktree agent patch conflicts (Z-39)
**Symptom:** the Z-39 worktree patch conflicted with the Z-44 and Z-41 commits already on main.
**Prevention:** merge main into the worktree before the agent finishes, or start the agent from current main.

## 5. Next free migration

- Next free: `0209` (highest `modules/*/migrations` prefix + 1)
- SESSION_STATE block names no next number; computed from files.

## 6. Reading list reminder

Still read PROJECT_BRAIN.md and docs/RCA_LOG.md (CLAUDE.md Phase 0).
