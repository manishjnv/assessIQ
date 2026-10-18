# Next brief (generated)

GENERATED FILE - do not edit. Run: node tools/next-brief.mjs

- Generated: 2026-10-18T22:19:53.090Z (2026-10-19 03:49:53 IST)
- HEAD: `9bd08797`. If HEAD differs from `git rev-parse --short HEAD`, regenerate.
- Dirty files (`git status --short` lines): 4

## 1. Last session (SESSION_STATE, first block)

## Session — 2026-10-19 — S30: owner answers into ROADMAP, design review of Z-71 and Q9, Q44, dependency majors

**Headline:** 18 ROADMAP rows closed from the owner sheet (recount 81 pending, 181 closed, 262 total, 69%). The Z-71 and Q9 designs went through a review gate: both REVISE, findings written into the design files, nothing built. Q44 (row delete or cancel, bulk clear of empty drafts, simpler status tabs) is built and deployed. Z-73 (docs-only CI runs the docs-reading tests) is proven. Storybook vite 6 and basic-ftp 6 are in. Seven page proposals are written.
**Commits:** `4daf94a4` — ci Z-73; `cea5012e` — docs (ROADMAP, designs, page proposals); `6a44cfa4` — Q44 (migration 0206); `61192fa3` — Z-38 vite 6; `b63f2b23` — Z-11 row PDF, Z-15 band labels (migration 0208); `9bd08797` — Z-38 basic-ftp 6; docs commit (this file, ROADMAP, NEXT).
**Deploy:** `tools/deploy.sh --yes` at `6a44cfa4` (VPS was `2eb00bb7`): assessiq-api, assessiq-worker, assessiq-frontend recreated, migration 0206 applied, sweep 0 failures, 6 assessiq-* containers up. Second deploy at `9bd08797` (VPS `6a44cfa4` to `9bd08797`): migration 0208 applied (help_content rows 580), the same three services recreated, sweep 0 failures. CI on `9bd08797` was red once: unit shard 2, `modules/19-billing/src/__tests__/billing-events.test.ts:74` said the Docker testcontainer was unavailable; a rerun of the failed job was green (runner flake, no code cause found). Marketing (Astro 7) NOT deployed (owner approval pending).
**Tests:** `pnpm verify` green before each push. Module 05 199, admin dashboard 239, candidate UI 159, help system 116, tools 4 docs-reading files 13. Storybook build passes on vite 6. No browser smoke of the new list buttons: owner check.
**Gate:** one Sonnet takeover design-review gate (Z-71 and Q9): REVISE for both (12 and 9 findings). One Sonnet review of the Q44 bulk endpoint: REVISE (check-then-delete race), fixed before push (row lock, guarded DELETE, all-or-nothing).
**Next:** (1) Owner: approve the revised Z-71 and Q9 designs after the design edits (findings in each design file); lawyer answers (liability proposal addenda). (2) Owner yes before: Z-46 on the VPS, Astro 7 deploy, react-router 7 plan. (3) FU-B2 (audit-log JSONL download) was NOT started (Batch 4 skipped, time). (4) Remaining tails need owner wording: Z-15 (a)(c)(d)(e), SP11 company ETA.
**Open questions:**
- Z-71 and Q9: findings 1 to 7 and 1 to 5 must be written into the designs, then the owner approves. Check on the VPS (read-only) whether other apps import the Caddy `(security-headers)` snippet before changing Permissions-Policy.
- Daily sign-up cap of 50 is still a proposal.
- Appeal hold for flagged-attempt photos: recommended yes with a lawyer-set upper limit; not decided.
- Results card: should the default feedback level change from "none"? (Z-15 g)
- The details drawer shows "Download PDF" for a revoked certificate (server answers 410); small fix, not done.
- CI flake: the testcontainer start failure above. If it returns, note the date and look at the runner Docker step (Z-55 area).
- Dependabot opened a branch to take storybook vite to 8.3.4: not taken.
**Not included:** Z-71 and Q9 build, live /terms or /privacy, Z-46 on the VPS, marketing deploy, Z-75 execution, react-router 7, Q22 retention job, FU-B2, any Cloudflare or DNS change.
**Old task or feature checked:** Q44 (existing `deleteAssessment` and `cancelAssessment` reused), Z-11, Z-15, Z-38, Z-52 gaps, RW-1, FU-D14 and RW-100 (already closed), X2, X5/OD5, Z-70 to Z-72, Z-73 (RCA 2026-10-18) (Rule B, PROJECT_BRAIN.md)


## 2. ROADMAP status board


Merged 2026-10-15 from the former root file `PENDING_TASKS`. Tick here per session; the task rows are below.

**Legend:** ✅ = done, 🚧 = in progress, 💬 = waiting for owner, 🔲 = blocked, — = not started

## 3. Open Z and EXP rows (40 total)

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
- `Z-38` (Z-38 (Dependabot tail)) — Dependabot items left after the S17 patch pass. — pending (Claude; M per major) S29 (2026-10-19): uuid 11 checked and skipped: no workspace declares uuid (lighthouse, sto
- `Z-42` (Z-42 (EXP-6 tail)) — Blueprint mocks: whole-test timer and marks per question. — pending, mostly done (S21, 2026-10-18, `43fc9b9` + gate hardening `7ef8826`): whole-test timer (`settings.whole_test_min
- `Z-46` (Z-46 (CSP-1)) — The CSP header has only `frame-ancestors`; no `script-src` or `default-src`. — pending (Claude; P2; S) S29 (2026-10-19): a `Content-Security-Policy-Report-Only` line (default-src, script-src for Turn
- `Z-48` (Z-48 (DOCSLINT-1)) — Make the Docs lint workflow pass before it becomes required on 2026-10-29. — pending, partly done (S22, 2026-10-18, `78165b0`, follow-ups `0a58c457`, `a3a41852`): Vale scoped to the docs set, 19 ma
- `Z-49` (Z-49 (BEACON-2)) — Decide whether the public demo page `/try` carries the Cloudflare Web Analytics beacon. — pending (owner decides A or B; Claude; XS)
- `Z-51` (Z-51 (FORM-1)) — Admin form fields `whole_test_minutes` and marks per section for blueprint mocks. — pending (owner picks a or b; Claude; S)
- `Z-52` (Z-52 (EXP18-GAPS)) — EXP-18 review gate: known gaps. — pending (Claude; P2; M) S29 (2026-10-19): gaps 1 to 4 closed (needs_fix on a platform master reaches live clones in the 
- `Z-54` (Z-54 (DOCSLINT-2)) — Docs lint: confirm green on main, then flip `fail_on_error` to true. — pending (Claude; XS; not before 2026-10-29). S24 check (2026-10-18): Docs lint on main is green in the last 4 runs, incl
- `Z-55` (Z-55 (CI-1)) — Cut CI wall time from about 11 minutes to about 5.5 minutes per push. — partly done (S24, 2026-10-18; Claude; M). Built: parallel typecheck job, 3-way unit shards, docs-only skip and `ci-ok` (
- `Z-70` (Z-70 (FREEPLAN)) — Free trial plan pack for self-serve organisations. — pending (owner approval of the proposal; Claude; S). Draft written S28. Owner answer 2026-10-18: the public name is "Tri
- `Z-71` (Z-71 (SELFSERVE-BUILD)) — Self-serve organisation sign-up (build). — pending (blocked on Z-70 approval; Claude; L; design-gated) Design written 2026-10-19 (S29): `docs/design/2026-10-18-sel
- `Z-72` (Z-72 (LIABILITY-1)) — Liability and data-processing proposal for the lawyer. — pending (owner and lawyer approve; Claude; S). Draft written S28.
- `Z-74` (Z-74 (PROCTOR-RET)) — Webcam photos: 90-day automatic deletion job, and the appeal question. — pending (design reviewed in S30 batch 2; design review S30: REVISE, 9 findings recorded in the design file; no build unt
- `Z-75` (Z-75 (PUBLICDOCS-1)) — Plan to stop tracking public docs files in the public repo. — pending (plan only; Claude; S)
- `Z-76` (Z-76 (PAGES-1)) — Website page proposals (5 to 8), owner approves each. — pending (S30: proposals written, 7 pages, in `docs/design/2026-10-19-page-proposals.md`; owner approves each; Claude; S)
- `Z-5` (Z-5 (SP9, SP10, Z-3)) — Owner live tests still open: — pending (owner)
- `Z-11` (Z-11 (Phase 5, FR13, Z-9, Z-15)) — Certificate visibility after a release. — pending (small). Item (c) done (S17, 2026-10-17, `f9c569f`): `CERTIFICATE_RULE_TEXT` in `modules/11-candidate-ui/src/cop
- `Z-14` (Z-14 (FU-B13, FR4, D8, D12)) — Embed: finish the iframe flow after the Caddy decision. — pending (owner first for a; Claude for b, c; owner decision for d)
- `Z-15` (Z-15 (Z-9, Z-10, M1-M4 mobile kit)) — Candidate result flow on a phone: findings. — pending (e is a bug) Item (e) closed (S16, 2026-10-17): `modules/15-analytics/src/activity-candidate/stats.ts`. Items (b

## 4. Newest RCA entries (5 newest of 238; file order: mixed (sorted by date; same-day ties keep file order))

### 2026-10-19 — CI unit shard 2 red once: Docker testcontainer unavailable (flake)
**Symptom:** CI run 39171014351 (commit `9bd08797`, a lockfile-only dependency change) failed in unit shard 2: `billing-events.test.ts:74` reported `Docker testcontainer required but unavailable in CI`. 110 of 111 files passed.
**Prevention:** manual discipline: rerun once, log the run id; if it returns twice, look at the Docker setup step in the unit job.

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
