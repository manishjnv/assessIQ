# Next brief (generated)

GENERATED FILE - do not edit. Run: node tools/next-brief.mjs

- Generated: 2026-10-19T17:43:22.920Z (2026-10-19 23:13:22 IST)
- HEAD: `8c0f0ec0`. If HEAD differs from `git rev-parse --short HEAD`, regenerate.
- Dirty files (`git status --short` lines): 3

## 1. Last session (SESSION_STATE, first block)

## Session — 2026-10-19 — S35: owner v2 sheet, pricing and the final build list (planning, no code)

**Headline:** the owner answered the v2 sheet (R1 to R39) and gave follow-up decisions; they are written into ROADMAP rows Z-70..Z-95, section Z.9 (final build list, five waves), the register and memory `owner-decisions.md`. No code changed.
**Commits:** `7f57e728` — ROADMAP and register: owner decisions, Z-79..Z-94, Z.9, exam-pack row updates merged from the S34 session, Z-77 ID clash fixed (admin list is now Z-95). Not pushed at the time of writing.
**Tests:** n/a (docs only). `node tools/roadmap-recount.mjs`: 93 pending, 187 closed, 280 total, 67 percent, SAME as Z.7.
**Next:** (1) push `7f57e728`; (2) write the Wave 1 prompt from ROADMAP Z.9 (credit ledger Z-93 and Z-79, test types Z-89, desktop-only Z-87 and readiness Z-91, sign-up Z-71 with Z-81 and Z-80, then Z-18 flip and the pilot tenant to paid, Z-90 mock dashboard); (3) owner tasks: live test of /admin, sign-in code and Delete buttons, console check of the CSP header, speed check, dry runs, the AI evaluation bless, lawyer review before the 2nd or 3rd paying customer.
**Open questions (owner):**
- **Public repo incident (found at the close of S35):** the rate card, founding offer, costs and break-even were pushed to the PUBLIC repo in ROADMAP Z-92, NEXT.md and this file (commits `7f57e728`, `92b22a42`, about 1.5 hours). Scrubbed in the next commit; the details moved to the untracked `docs/owner-review/PRIVATE_pricing_and_costs.md`. Git history still holds the old text: the owner decides whether to rewrite history (git filter-repo plus force push, destructive, see row Z.8) or accept the risk. Rule saved in memory `public-repo-hygiene.md`.
- Z-52 gap 7: the S34 session built the staff-only dispute action before the owner's answer A arrived; keep or remove.
- GIFT uploads: the format check allows csv and xlsx only; say if GIFT must work.
- Rescoring questions Q1 to Q4 in `docs/design/2026-10-19-answer-key-rescore-proposal.md`; warranty wording `ORG_UPLOAD_WARRANTY_TEXT`.
- Pricing: confirm the rate card; prices and costs are in the private file `docs/owner-review/PRIVATE_pricing_and_costs.md` (the repo is public).
- Haiku 5.5 trial: continue or stop (stop rule says STOP at 38 percent rework).
**Decisions to keep (full text in memory and the rows):** two test types (Mock any device and no camera; Real exam desktop only and camera, schools control the camera); real and mock burn different credits; credits valid 12 months; Free 20 credits a month; photos 90 days and video 7 days (schools 7); sign-up public at 5 a day with a DPA checkbox, lawyer review before the 2nd or 3rd paying customer; organisation keeps upload ownership, AssessIQ gets a licence; AI support only after 3 paying customers; no per-row gate, one GATE-8 review before the pilot.
**Old task or feature checked:** Z-18, Z-19, Z-20, Z-26, Z-35, Z-49, Z-51, Z-52, Z-70..Z-76, Z-77, Z-78, E11, D3, X2, X5, FR9, RW-1, C5, C7, C8, N10, SP2/SP11/P3, EXP-12, EXP-15, EXP-17 (Rule B).


## 2. ROADMAP status board


Merged 2026-10-15 from the former root file `PENDING_TASKS`. Tick here per session; the task rows are below.

**Legend:** ✅ = done, 🚧 = in progress, 💬 = waiting for owner, 🔲 = blocked, — = not started

## 3. Open Z and EXP rows (53 total)

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
- `Z-18` (Z-18 (PT1/PT-4 flip)) — Flip `PLAN_TIERS_ENFORCED=true` on the VPS (`/srv/assessiq/.env`, then recreate  — pending (owner decides the date; Claude flips and smokes) S32 (2026-10-19): owner decided there is NO flip date. The Fre
- `Z-19` (Z-19 (LC-2 flip)) — Flip `USER_PURGE_ENABLED=true` on the VPS (`.env`, then recreate `assessiq-worke — pending (owner decides after the first dry-run tick) S32 (2026-10-19 09:01 UTC): FLIPPED. The first tick (2026-10-19 03:
- `Z-20` (Z-20 (RV31 terms)) — Approve or edit the terms §8 sentence drafted in SESSION_STATE S14 § Owner gates — pending (owner wording) S32 (2026-10-19): owner said use Claude's draft. Draft ready: `docs/design/2026-10-20-terms-sect
- `Z-26` (Z-26 (SEO-A2; unblocks F2 and CWV-1)) — Connect Search Console and a privacy-light analytics tool. — pending (owner verifies and picks the tool; Claude adds tag and privacy line; XS). S17 fact: a Microsoft Clarity script 
- `Z-35` (Z-35 (SEO-F5, F7)) — Organization `sameAs` is empty (F5). Microsoft Clarity is live (F7): check `privacy.astro` and the consent wording. — pending (partly done S18, `59a5962`): (a) privacy page now names what Clarity records, cookie names and lifetimes (`_clc
- `Z-37` (Z-37 (Z-10 code fixes)) — Email code fixes from the Z-10 review. — PART 1 DONE earlier (67e5db5) and PART 2 DONE in S20 (`f253297` + `75a42ca`: plain result email, share links, `.txt` sig
- `Z-38` (Z-38 (Dependabot tail)) — Dependabot items left after the S17 patch pass. — partly done (S31, 2026-10-19; Claude; M): astro 7.4.0 DONE and DEPLOYED 2026-10-19 (marketing rebuilt from `da2a95cd`, 4
- `Z-42` (Z-42 (EXP-6 tail)) — Blueprint mocks: whole-test timer and marks per question. — pending, mostly done (S21, 2026-10-18, `43fc9b9` + gate hardening `7ef8826`): whole-test timer (`settings.whole_test_min
- `Z-48` (Z-48 (DOCSLINT-1)) — Make the Docs lint workflow pass before it becomes required on 2026-10-29. — pending, partly done (S22, 2026-10-18, `78165b0`, follow-ups `0a58c457`, `a3a41852`): Vale scoped to the docs set, 19 ma
- `Z-49` (Z-49 (BEACON-2)) — Decide whether the public demo page `/try` carries the Cloudflare Web Analytics beacon. — pending (owner decides A or B; Claude; XS) Owner v2 sheet 2026-10-19, R21: DECIDED option A: keep the Cloudflare beacon 
- `Z-51` (Z-51 (FORM-1)) — Admin form fields `whole_test_minutes` and marks per section for blueprint mocks. — pending (owner picks a or b; Claude; S) Owner v2 sheet 2026-10-19, R26: DECIDED option (b): keep sections and blueprint 
- `Z-54` (Z-54 (DOCSLINT-2)) — Docs lint: confirm green on main, then flip `fail_on_error` to true. — pending (Claude; XS; not before 2026-10-29). S24 check (2026-10-18): Docs lint on main is green in the last 4 runs, incl
- `Z-71` (Z-71 (SELFSERVE-BUILD)) — Self-serve organisation sign-up (build). — pending (design revision 2 written S31, 2026-10-19; owner approves; then build in two gated rows; Claude; L; design-gate
- `Z-72` (Z-72 (LIABILITY-1)) — Liability and data-processing proposal for the lawyer. — pending (owner and lawyer approve; Claude; S). Draft written S28. Owner follow-up 2026-10-19 (after the v2 sheet): not a
- `Z-74` (Z-74 (PROCTOR-RET)) — Webcam photos: 90-day automatic deletion job, and the appeal question. — pending (design revision 2 written S31, 2026-10-19; owner approves; no build until the owner says so; Claude; L split in
- `Z-75` (Z-75 (PUBLICDOCS-1)) — Plan to stop tracking public docs files in the public repo. — pending (plan written S31, 2026-10-19: `docs/plans/Z-75-stop-tracking-public-docs.md`; execution needs the owner's yes a
- `Z-76` (Z-76 (PAGES-1)) — Website page proposals (5 to 8), owner approves each. — pending (S30: proposals written, 7 pages, in `docs/design/2026-10-19-page-proposals.md`; owner approves each; Claude; S)
- `Z-77` (Z-77 (CSP-ENFORCE)) — Enforce the Content-Security-Policy on assessiq.in. — pending (owner go for the Caddy edit; Claude prepares and verifies; S) Owner v2 sheet 2026-10-19: the owner has not yet 
- `Z-78` (Z-78 (BACKUP-OFFSITE)) — Switch on the daily off-site backup. — pending (after the first paying customer; owner decides the key location; Claude switches on and watches the first run; 
- `Z-79` (Z-79 (PLAN-ADMIN)) — Super admin controls for plan and quota. — pending (Claude; M; gate)
- `Z-80` (Z-80 (LOCKED-CTA)) — Locked-feature 'Contact us' popup. — pending (Claude; S) Owner follow-up 2026-10-19 (after the v2 sheet): 'Contact us' is the route to every paid feature for
- `Z-81` (Z-81 (DPA-CLICK)) — DPA text, link and sign-up checkbox. — pending (Claude; S; part of Z-71 step e) Owner follow-up 2026-10-19 (after the v2 sheet): the DPA text is written by Cla
- `Z-82` (Z-82 (SCHOOL-CAM)) — School mode for webcam photos. — pending (Claude; M; lawyer first) Owner follow-up 2026-10-19 (after the v2 sheet): school flag is set by the super admin
- `Z-83` (Z-83 (UPTIME-1)) — UptimeRobot set-up guide and health URL list. — pending (Claude guide, owner account; XS)
- `Z-84` (Z-84 (SAMPLE-1)) — Parse and normalise the sample quiz files. — pending (Claude; M; uses the EXP-17 and EXP-15 tooling)
- `Z-85` (Z-85 (BREVO-DOC)) — Brevo mention fix. — pending (Claude; XS)
- `Z-86` (Z-86 (GATE-8)) — Full security review before the pilot. — pending (Claude; L; gate)
- `Z-87` (Z-87 (DESKTOP-ONLY)) — Tests can be taken only on a laptop or desktop. — pending (Claude; S; gate) Owner clarification 2026-10-19: SCOPE. The site stays mobile friendly. Mock tests, practice an
- `Z-88` (Z-88 (MOBILE-RETIRE)) — Bring the mobile work in line with the desktop-only rule. — pending (Claude; S) Owner clarification 2026-10-19: the mobile layouts stay in use. Keep a phone smoke for /try, the inv
- `Z-89` (Z-89 (DELIVERY-MODE)) — Invite as REAL EXAM or MOCK TEST. — pending (Claude; M; gate) RESEARCH 2026-10-19 (web search; owner asked for a better idea): vendors and test makers treat
- `Z-90` (Z-90 (MOCK-DASH)) — Separate dashboard for mock tests. — pending (Claude; M; waits for Z-89 data model) Owner follow-up 2026-10-19 (final list): schools use the mock dashboard t
- `Z-91` (Z-91 (READINESS)) — Readiness check before every real exam. — pending (Claude; M; gate; builds with Z-87 and Z-89)
- `Z-92` (Z-92 (RATECARD)) — Rate card for credits (details are private). — pending (Claude drafts rate-card options in the private file; owner decides; S)
- `Z-93` (Z-93 (CREDIT-LEDGER)) — Credit ledger with 12-month expiry, burn by test type, and free monthly refill. — pending (Claude; M-L; gate; after Z-89 and Z-92 numbers are confirmed) Also record the ACTUAL AI cost (model, tokens in 
- `Z-94` (Z-94 (SUPPORT-AI)) — Support automation with AI (no support hire). — pending (Claude; phases A and B S-M; phase C owner decision and gate) OWNER DECISION 2026-10-19: DEFERRED. Start only wh
- `Z-5` (Z-5 (SP9, SP10, Z-3)) — Owner live tests still open: — pending (owner)
- `Z-11` (Z-11 (Phase 5, FR13, Z-9, Z-15)) — Certificate visibility after a release. — pending (small). Item (c) done (S17, 2026-10-17, `f9c569f`): `CERTIFICATE_RULE_TEXT` in `modules/11-candidate-ui/src/cop
- `Z-14` (Z-14 (FU-B13, FR4, D8, D12)) — Embed: finish the iframe flow after the Caddy decision. — pending (owner first for a; Claude for b, c; owner decision for d) Owner sheets 2026-10-19 (applied S34), v1 Q39: embed 
- `Z-15` (Z-15 (Z-9, Z-10, M1-M4 mobile kit)) — Candidate result flow on a phone: findings. — pending (e is a bug) Item (e) closed (S16, 2026-10-17): `modules/15-analytics/src/activity-candidate/stats.ts`. Items (b

## 4. Newest RCA entries (5 newest of 240; file order: mixed (sorted by date; same-day ties keep file order))

### 2026-10-19 — CI unit shard 2 red once: Docker testcontainer unavailable (flake)
**Symptom:** CI run 39171014351 (commit `9bd08797`, a lockfile-only dependency change) failed in unit shard 2: `billing-events.test.ts:74` reported `Docker testcontainer required but unavailable in CI`. 110 of 111 files passed.
**Prevention:** if the error returns with 30 seconds, the cause is not the probe: read the runner Docker step and the testcontainer start logs the same day (logs expire). A shared probe helper for the 12 files is a later cleanup.

### 2026-10-19 — CI e2e red: two new SPA scripts returned 404 (files sat in a gitignored folder)
**Symptom:** CI run on `af47990b`: every signed-in smoke spec failed with two console errors, "Failed to load resource: 404". Local runs were green.
**Prevention:** after an agent adds files, run `git status --short` and `git ls-files <new paths>` before the commit. A new public file must not sit under an ignored folder (`git check-ignore -v <path>`). A local `vite preview` run cannot catch this.

### 2026-10-19 — CI unit red after S34: two guard tests outside the touched modules
**Symptom:** CI run 39275607685 on `abd2a939`: unit shard 2 failed `erasure-coverage.test.ts` (`question_review_notes.note` not in REGISTRY or EXEMPT) and shard 3 failed `help-id-page-prefix.test.ts` (six ids of `review-queue.tsx` outside `helpPage="admin.review_queue.page"`). Local runs of the touc
**Prevention:** after a new table or a new page, run the two guard tests (`erasure-coverage`, `help-id-page-prefix`) before the push; the agent brief should list them. Local `pnpm verify` runs lint and typecheck only, not these tests.

### 2026-10-18 — Admin page blank after login: two copies of react-router in the bundle
**Symptom:** after a successful sign-in at assessiq.in/admin the owner saw a blank white page. The browser error log (`stream":"frontend"`) held six `Uncaught Error` entries from `vendor-react-*.js` line 9 at one column, all with referer `/admin`. Public pages, the login page and the candidate pages
**Prevention:** the lockfile test above (runs in CI); a Dependabot bump must change every workspace that declares the package; the post-deploy sweep needs one signed-in check of `/admin` and an error boundary that shows a message instead of a blank page (ROADMAP Z-47).

### 2026-10-18 — CI typecheck red after Z-41
**Symptom:** the CI typecheck step failed after the Z-41 commit. Local vitest and eslint were green.
**Prevention:** run `pnpm typecheck` before push. The build agents ran only vitest and eslint.

## 5. Next free migration

- Next free: `0215` (highest `modules/*/migrations` prefix + 1)
- SESSION_STATE block names no next number; computed from files.

## 6. Reading list reminder

Still read PROJECT_BRAIN.md and docs/RCA_LOG.md (CLAUDE.md Phase 0).
