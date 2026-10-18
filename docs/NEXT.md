# Next brief (generated)

GENERATED FILE - do not edit. Run: node tools/next-brief.mjs

- Generated: 2026-10-18T17:25:03.263Z (2026-10-18 22:55:03 IST)
- HEAD: `709c7b52`. If HEAD differs from `git rev-parse --short HEAD`, regenerate.
- Dirty files (`git status --short` lines): 3

## 1. Last session (SESSION_STATE, first block)

## Session — 2026-10-18 — S28: owner review sheet Q1 to Q6

**Headline:** Owner answers Q1 to Q6 are recorded in ROADMAP. The free trial plan pack (Z-70) and the liability and DPA proposal (Z-72) are written as proposals. The Astro upgrade plan is researched, not applied.
**Commits:** one docs commit (see git log). No deploy (docs only).
**Tests:** `pnpm verify` and `node tools/roadmap-recount.mjs` run. No code changed.
**Gate:** none. No security path touched. Z-71 (self-serve build) needs a design review and one adversarial gate after the owner approves Z-70.
**Next:** (1) Owner: read `docs/design/2026-10-18-free-plan-pack.md` and answer its 3 questions. (2) Owner: send `docs/design/2026-10-18-liability-and-dpa-proposal.md` to the lawyer. (3) Owner: say go or no go for the staged Astro upgrade. (4) Owner: decide the Haiku trial (TOK-6) and Q23 (`tools/assessiq-mcp/package-lock.json`).
**Open questions:**
- Q7 to Q49 are unanswered on the owner sheet. Nothing was guessed.
- Dependabot: 2 critical `astro` alerts in `apps/marketing` (installed 5.18.2, fix 7.2.8). The AVIF path is not used by code. Plan: stage A Astro 5 to 6, stage B 6 to 7 with `compressHTML` check. Not upgraded.
- Z-60 CI streak: 4 of 10.
**Not included:** any Astro bump, any change to /terms or /privacy, the `.gitignore` line for the stray lockfile, Z-71.
**Old task or feature checked:** X2, D1/RV28, D2/FU-A8, D3/FU-A7, OD4, OD8, PRICING_TIERS 2026-10-06, TOK-6 (Rule B, PROJECT_BRAIN.md)

#### Agent utilization
- Opus (main session ran on Sonnet 5.5): Phase 0, ROADMAP rows, both design docs, register row, review of the Astro report.
- Sonnet: n/a — no build code.
- Haiku: 1 run.
  - Haiku · Astro 5 to 7 upgrade research · reworked: N · tokens: 105353
- codex:rescue: n/a — no security path touched.
- Gemini (agy): n/a — not needed.
- Codex (exec): n/a — down since 2026-10-11.


## Session — 2026-10-18 — S27: token, gate and proof items (Z-67 to Z-69, Z-59 proof, GATE-6)

**Headline:** Agent brief, roadmap recount, next-migration, routing `--since`, Codex review script and CI streak script are built. A bad router copy turns CI red (proven). GATE-6 numbers are in the register.
**Commits:** `b423d8ce` — Z-67/Z-68, routing `--since` (CI green, run 39145795259, 3m28); `f8584a91` — Z-69, ci-green-streak, Z-59 proof, GATE-6, recount fix, .gitignore (CI green, run 39147241641, 3m28). No deploy (tools and docs only).
**Tests:** `pnpm verify` green twice; `tools/__tests__` 26 of 26. Live Codex call NOT tested (Codex down since 2026-10-11); only `--dry-run` and the secret scan ran.
**Gate:** none. No security path touched.
**Next:** (1) Owner: Haiku 5.5 trial reads STOP (29% non-gate rework, 7 runs); decide continue or stop. (2) Owner: TIME-13 yes/no. (3) Count green runs for Z-60: streak 4 of 10. (4) Owner: track or ignore `tools/assessiq-mcp/package-lock.json` on the VPS.
**Open questions:**
- Dependabot: 2 critical alerts, both `astro` < 7.2.8 in `apps/marketing` (installed 5.18.2). Advisory: RCE through AVIF image optimization. No `astro:assets`, `<Image>` or `sharp` use found in marketing code, so the path looks unused. Not upgraded.
- Z-54 not before 2026-10-29. GATE-8 and GATE-2 stay as decided.
**Not included:** TIME-13 enable, GATE-8, GATE-2, Z-54, any Astro upgrade, any VPS change.
**Old task or feature checked:** TOK-3..TOK-7, TIME-7/15/16, GATE-6, Z-47, Z-53, Z-59, Z-60, Z-64..Z-66 (Rule B, PROJECT_BRAIN.md)

### Agent utilization
- Opus (main session ran on Sonnet 5.5): Phase 0, ROADMAP rows, review of all agent output, recount rule fix, GATE-6 measuring, docs, commits.
- Sonnet: 2 runs (Z-59 proof, codex-review script).
  - Sonnet · Z-59 CI failure proof · reworked: N · tokens: 97820
  - Sonnet · codex-review.sh + test · reworked: N · tokens: 92570
- Haiku: 1 run.
  - Haiku · Z-67/Z-68/TOK-6 build · reworked: Y (closed-word rule and fixture changed by Opus) · tokens: 228598
- codex:rescue: n/a — no security path touched.
- Gemini (agy): n/a — not needed.
- Codex (exec): n/a — down since 2026-10-11; script built, dry run only.


## 2. ROADMAP status board


Merged 2026-10-15 from the former root file `PENDING_TASKS`. Tick here per session; the task rows are below.

**Legend:** ✅ = done, 🚧 = in progress, 💬 = waiting for owner, 🔲 = blocked, — = not started

## 3. Open Z and EXP rows (37 total)

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
- `Z-38` (Z-38 (Dependabot tail)) — Dependabot items left after the S17 patch pass. — pending (Claude; M per major)
- `Z-42` (Z-42 (EXP-6 tail)) — Blueprint mocks: whole-test timer and marks per question. — pending, mostly done (S21, 2026-10-18, `43fc9b9` + gate hardening `7ef8826`): whole-test timer (`settings.whole_test_min
- `Z-46` (Z-46 (CSP-1)) — The CSP header has only `frame-ancestors`; no `script-src` or `default-src`. — pending (Claude; P2; S)
- `Z-48` (Z-48 (DOCSLINT-1)) — Make the Docs lint workflow pass before it becomes required on 2026-10-29. — pending, partly done (S22, 2026-10-18, `78165b0`, follow-ups `0a58c457`, `a3a41852`): Vale scoped to the docs set, 19 ma
- `Z-49` (Z-49 (BEACON-2)) — Decide whether the public demo page `/try` carries the Cloudflare Web Analytics beacon. — pending (owner decides A or B; Claude; XS)
- `Z-51` (Z-51 (FORM-1)) — Admin form fields `whole_test_minutes` and marks per section for blueprint mocks. — pending (owner picks a or b; Claude; S)
- `Z-52` (Z-52 (EXP18-GAPS)) — EXP-18 review gate: known gaps. — pending (Claude; P2; M)
- `Z-54` (Z-54 (DOCSLINT-2)) — Docs lint: confirm green on main, then flip `fail_on_error` to true. — pending (Claude; XS; not before 2026-10-29). S24 check (2026-10-18): Docs lint on main is green in the last 4 runs, incl
- `Z-55` (Z-55 (CI-1)) — Cut CI wall time from about 11 minutes to about 5.5 minutes per push. — partly done (S24, 2026-10-18; Claude; M). Built: parallel typecheck job, 3-way unit shards, docs-only skip and `ci-ok` (
- `Z-70` (Z-70 (FREEPLAN)) — Free trial plan pack for self-serve organisations. — pending (owner approval of the proposal; Claude; S). Draft written S28.
- `Z-71` (Z-71 (SELFSERVE-BUILD)) — Self-serve organisation sign-up (build). — pending (blocked on Z-70 approval; Claude; L; design-gated)
- `Z-72` (Z-72 (LIABILITY-1)) — Liability and data-processing proposal for the lawyer. — pending (owner and lawyer approve; Claude; S). Draft written S28.
- `Z-5` (Z-5 (SP9, SP10, Z-3)) — Owner live tests still open: — pending (owner)
- `Z-11` (Z-11 (Phase 5, FR13, Z-9, Z-15)) — Certificate visibility after a release. — pending (small). Item (c) done (S17, 2026-10-17, `f9c569f`): `CERTIFICATE_RULE_TEXT` in `modules/11-candidate-ui/src/cop
- `Z-14` (Z-14 (FU-B13, FR4, D8, D12)) — Embed: finish the iframe flow after the Caddy decision. — pending (owner first for a; Claude for b, c; owner decision for d)
- `Z-15` (Z-15 (Z-9, Z-10, M1-M4 mobile kit)) — Candidate result flow on a phone: findings. — pending (e is a bug) Item (e) closed (S16, 2026-10-17): `modules/15-analytics/src/activity-candidate/stats.ts`. Items (b

## 4. Newest RCA entries (5 newest of 236; file order: mixed (sorted by date; same-day ties keep file order))

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

- Next free: `0206` (highest `modules/*/migrations` prefix + 1)
- SESSION_STATE block names no next number; computed from files.

## 6. Reading list reminder

Still read PROJECT_BRAIN.md and docs/RCA_LOG.md (CLAUDE.md Phase 0).
