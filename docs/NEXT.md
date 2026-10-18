# Next brief (generated)

GENERATED FILE - do not edit. Run: node tools/next-brief.mjs

- Generated: 2026-10-18T21:29:21.353Z (2026-10-19 02:59:21 IST)
- HEAD: `4daf94a4`. If HEAD differs from `git rev-parse --short HEAD`, regenerate.
- Dirty files (`git status --short` lines): 14

## 1. Last session (SESSION_STATE, first block)

## Session — 2026-10-19 — S29: owner answers wave 1 (Q17 to Q23, Q11, Z-52, designs)

**Headline:** Sign-in code UX (Q17), activity labels "Former reviewer" and "AssessIQ staff" (Q18, Q19), protected-file edits (Q20), lockfile ignore (Q23), invite batching (Q11) and EXP-18 gaps 1 to 4 (Z-52) are built. Free plan pack, self-serve sign-up design and tiered proctoring design are written.
**Commits:** `2517d072` — Q17, Q18, Q19, Q20, Q23 (CI green); `28bd5bf3` — Q11, Z-52, Z-46 reference line, Z-48; docs commit (this file, ROADMAP, designs).
**Deploy:** `tools/deploy.sh --yes` at `2eb00bb7` (VPS was `ce3be56`): assessiq-api, assessiq-worker, assessiq-frontend recreated, 0 migrations, sweep 0 failures, 6 assessiq-* containers up. The marketing site (Astro 7) was NOT deployed (owner approval pending). Owner check: open /admin signed in and a take page; try the email sign-in code once.
**Tests:** `pnpm verify` green before each push. New: email-otp page 2, activity feed 3 (30 in file), bulk cap 6 and queue route 1, question review 7 (25 in file), publish gate 13 of 13. 13-notifications full suite 300 of 300. Docs lint: markdownlint 0 errors; Vale not installed locally.
**Gate:** two Sonnet takeover gates, both ACCEPT. Gate 1 (Q17 web page, Q18/Q19 feed): low notes only (same-tick double submit costs an attempt on the server; a dangling actor id would show "AssessIQ staff"). Gate 2 (Z-52, bulk cap, Caddy line): low notes (the cap is global across tenants; `getDelayed` scans all tenants).
**Next:** (1) Owner: answer the free plan questions (what "5 chosen subjects" means, AI attempt count, locked vs hidden). (2) Owner: OK the Caddy report-only line on the VPS (Z-46). (3) Z-71 build needs your OK of the design, a design review and a gate. (4) Remaining: Z-38 majors (vite 6, basic-ftp 6, react-router 7), FU-D14, RW-100, SP2/SP11/P3 notices, Z-11, Z-15, RW-1 list, Y-10; FU-B2 in a later gate batch.
**Open questions:**
- Free plan: meaning of "5 chosen subjects"; AI attempt count (5 proposed); locked vs hidden features; public name "Free" is used.
- Q9 proctoring: "camera required" setting, retention (30 days proposed, lawyer decides), age self-declaration, Free plan gets tier 1.
- Q17: the owner review of `23c77e2` is still the owner's call (Y-2 stays open).
- Z-48: confirm the Vale count in the CI Docs lint job (Vale is not installed here). Z-54 not before 2026-10-29.
- Q6, Q13, Q14, Q21, Q36 to Q47 are blank on the sheet. Nothing was guessed.
**Not included:** Z-71 and Q9 build, any live /terms or /privacy change, Q22 retention rule, TIME-13, GATE-8, Z-54, any VPS or Cloudflare change (so the Z-46 line is not live), uuid 11 (no direct dependency), API-mode AI grading.
**Old task or feature checked:** Y-2/RV60, Y-3, SP-gap-2, Y-9, RV33/FU-D26, A5/RW-52 (Brevo 300 a day, delivery-policy), Z-46, Z-48, Z-52, Z-70 to Z-72, X5/OD5 (Rule B, PROJECT_BRAIN.md)


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

## 4. Newest RCA entries (5 newest of 237; file order: mixed (sorted by date; same-day ties keep file order))

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

### 2026-10-18 — axe: nested interactive control and low button contrast (Z-23 session 2)
**Symptom:** the axe a11y run reported two violations: Reports list rows (nested-interactive) and the Regenerate button (red text contrast 4.0, fails AA 4.5).
**Prevention:** the axe e2e now covers `/admin/reports` and `/admin/integrations/webhooks`.

## 5. Next free migration

- Next free: `0207` (highest `modules/*/migrations` prefix + 1)
- SESSION_STATE block names no next number; computed from files.

## 6. Reading list reminder

Still read PROJECT_BRAIN.md and docs/RCA_LOG.md (CLAUDE.md Phase 0).
