# Session — 2026-10-21 — S42: docs tidy (Z-105 to Z-109)

**Headline:** Docs are tracked again and 15 private items live in docs/private/. Guards run in CI. Old text is archived by script with a move trail. SESSION_STATE.md went from 1006604 to about 19000 bytes, ROADMAP.md from 732996 to about 418000 bytes. Z-106 and Z-107 are closed; Z-105, Z-108 and Z-109 wait for the owner's CLAUDE.md text. Recount: pending 92, closed 215, total 307, 70%.
**Commits:** `d9290ec1` move trail tools · `477aac15` private docs moved, leaks fixed · `0563d6f8` docs guards · `924cd996` ROADMAP citations pinned · `c2218fc2` archive run · `3f923876` archive link fix (CI was red on c2218fc2, green here) · `7b0963a4` plans/design tidy, folds, DECISIONS, close-session. CI green on 7b0963a4. Tag `docs-layout-before-tidy-2026-10-21`.
**Tests:** pass (the 8 docs tests, 36 tests; `pnpm verify`; doc-anchors; skill-mount; privacy 0 findings; links 0 new against the baseline of 167 old dead links).
**Start-up read (CLAUDE.md + PROJECT_BRAIN.md + 01-architecture + NEXT + MEMORY.md):** 84816 to about 66000 bytes. Tracked md files in docs/: 134 before, 142 after (nothing deleted, archive files added); md files on disk outside docs/private/: 191 (13 more in docs/private/).
**Next:** owner approves the CLAUDE.md text (host name and IP line 84, `git add -f` line 172, Phase 6 line 171), decides where the module SKILL.md files live (recommend: keep, 164 files and 342 references, 3 lints read them) and Z-110. Then move PROJECT_BRAIN.md into docs/ with `node tools/docs-move.mjs` and regenerate with `node tools/close-session.mjs`.
**Open questions:** the KNOWN list in tools/check-docs-privacy.mjs exempts old vendor and liability amounts in 8 public docs (owner decides on a clean-up); the Caddy snippet comments still show the origin IP; about 250 untracked files under docs/testing/ (track or ignore); lint-docs becomes strict on 2026-10-29 and ROADMAP.md is still over its 250000-byte cap.
**Old task or feature checked:** Z-73 (docs tests), Z-75 (stop tracking public docs: still open, owner decides in Z-110), RW-85 (docs lint date).
**New tools:** docs-move, docs-where, docs-rewrite-refs, docs-archive, docs-plans-index, close-session, check-docs-privacy, check-docs-links (all in tools/; moves in docs/moves.json).

---

## Agent utilization
- Opus: n/a — the main session ran on Sonnet 5.5 (~180k tokens): plan, review of every script and the hook, fixes after rework, commits, ROADMAP rows.
- Sonnet · move trail tools · reworked: Y (moved files' own links not re-pointed; fixed in main) · tokens: 91032
- Sonnet · docs guards (privacy, links, lint rules, hook warn) · reworked: N (KNOWN list flagged to owner) · tokens: 134323
- Sonnet · docs-archive script · reworked: Y (archive links and 3 third-party values failed CI; fixed in 3f923876) · tokens: 102466
- Sonnet · fold camera, time limit, cert records · reworked: N · tokens: 111766
- Sonnet · fold wave1, session4, wave4 records · reworked: N · tokens: 111821
- Sonnet · deploy history to archive · reworked: N · tokens: 89436
- Sonnet · plans index and close-session · reworked: Y (index listed an untracked file; fixed in main) · tokens: 94398
- Haiku · Status and Rows on 40 plan and design files · reworked: N (7 guesses listed for review) · tokens: 147357
- Haiku trial: 1 run, 0 rework. Gemini (agy): n/a — file lists were small. Codex (exec): n/a. codex:rescue: n/a — no security path touched (hook is warn-only; guard scripts only).
- Total subagent tokens: 882599.

---

# Session — 2026-10-21 — S41: small rows (session 6)

**Headline:** Z-48, Z-11, Z-51 (b) and Z-88 closed; Z-38 minor and patch updates applied; Z-54 waits until 2026-10-29; Z-15 has only an owner decision left. Recount: pending 94, closed 212, total 306, 69%.
**Commits:** `dd287b3c` — feat: blueprint fields, deps, phone smoke, docs lint fixes (on main, CI green at `3ccdf443`). Marketing container rebuilt by hand.
**Tests:** pass (`pnpm verify`, module 05 232, guard tests 53, docs lint strict 0). Phone smoke not run locally.
**S42 follow-up:** Z-88 phone smoke fixed and required (`590e4cd1`, `33afde5b`, `be5210dc`; CI run 39554101909: 5 passed). Cause: real link on a phone shows the laptop message; CI step lacked base URLs. `phone-first-question` still fails (advisory, same cause). Recount 94/212/306.
**S43 follow-up:** RW-79 phone first-question timing now uses a mock link and is required in CI (`005794e0`, `762a4117`; median 3798 ms against a 20000 ms budget, run 39559548191). No deploy needed (test and CI only). Counts unchanged.
**Next:** one green CI run of the phone smoke, then remove `continue-on-error`; module 06 must read the blueprint fields (gated; Z-42); Z-54 on or after 2026-10-29.
**Open questions:** label "marks per section" vs per question; Z-15 (g) default feedback level; Z-38 majors after the pilot.
**Old task or feature checked:** Z-42, Z-89, Z-87, Z-104 (Rule B).
**Process note:** the trailer amend landed on another session's HEAD commit `3ccdf443` (docs only); see change record.
**Change record:** `docs/archive/2026-10-21-session6-change-record.md`

---

## Agent utilization
- Opus: n/a — the main session ran Sonnet 5.5.
- Sonnet: main session (coordination, review, docs) · dependency agent · adversarial takeover review · 166,104 tokens in the two agents.
- Haiku: Z-51/Z-11 build agent 157,666 · Z-88/Z-48 agent 167,914 tokens.
- codex:rescue: n/a — Codex down; Sonnet takeover on the dependency bump: accept.
- Routing lines:
  - Sonnet · dependency bump · reworked: N · tokens: 90074
  - Haiku · Z-51 form and Z-11 drawer · reworked: N · tokens: 157666
  - Haiku · Z-88 smoke and Z-48 lint · reworked: Y (CI step made advisory by the orchestrator) · tokens: 167914
  - Sonnet · adversarial review · reworked: N · tokens: 76028

---

# Session — 2026-10-21 — S40: future-ready question store (design only, no code)

**Headline:** The owner decided ONE master question database, written by the platform super admin and read by licensed organisations. A design (v2.1) now covers it, validated by Fable 5.1 and Opus 5.5 reviews plus a market scan. Roadmap rows FUT-1 to FUT-11 are added and EXP-14 is revised. No code was written.
**Commits (docs only, not pushed):** `eff07ff0` design v2.1 and rows FUT-1..11 · `686c1df5` hide answer keys from licensed admins · `d82908c9` break-glass key view · `53ff71f5` break-glass per assessment, 30 minutes, no copy · `d2ffb6df` option B (keys hidden in every licensed pack, one question set) · this handoff commit.
**Tests:** n/a (docs only).
**Design:** `docs/design/2026-10-21-future-ready-question-store.md` (decisions D1 to D12).
**Owner decisions recorded:** one master database, no database per exam; licensed read first, one mode, no clone flag; keys hidden from licensed admins in every licensed pack (option B); break-glass view = one assessment, 30-minute window, fresh-MFA or email OTP, reason, two emails (open and close), no copy, watermark, audit row per reveal, super-admin kill switch. Compliance and review gates were left out on purpose (pre-launch).
**Build order:** FUT-1 (immutable versions, `source_question_id` index, pin FKs) → FUT-8 (taxonomy by node) → EXP-14 (11-table licensed-read policy family, XL) → FUT-2 (key hiding and break-glass, L) → FUT-10 (close `assessiq_system` membership) and FUT-11 (attempt retention) before real customer data → FUT-3/4/5p2/6/7/9 when a real need appears.
**Next:** build FUT-1 (one migration, Sonnet agent, Opus diff review, `pnpm verify`). Then FUT-8.
**Open questions:** approval to retire the clone-on-grant code after EXP-14 (Rule A); cap values for break-glass (25 reveals was replaced by the assessment's question count; daily cap number not set); the `sample`/`secure` per-question flag stays a later option.
**Not done:** the Z.7 pending count (86 becomes about 88 with FUT-8..11); no push; `docs/ai-playbook/01-speed-rules.md` was edited by another session and is not part of these commits.
**Old task or feature checked:** EXP-14, EXP-19, EXP-20, Z-43, Z-89, Q12, R2 (Rule B).
**Optimization register rows touched:** none.

---

## Agent utilization
- Opus: n/a — the main session ran Sonnet 5.5; two Opus 5.5 agents did independent reviews (below).
- Sonnet: main session (draft design, merge, roadmap edits, commits) · market research agent · 86,873 tokens.
- Haiku: n/a — no bulk sweep needed.
- codex:rescue: n/a — owner set no gates for this design-only session.
- Fable 5.1: 4 read-only runs · architecture review 230,491 · re-review of 14 ideas 140,996 · design validation 225,866 · final best-in-class review 140,112 · total 737,465.
- Opus 5.5 agent: 2 read-only runs · architecture review 122,869 · design validation 144,987 · total 267,856.
- Routing lines:
  - Fable · architecture review · reworked: N · tokens: 230491
  - Opus · architecture review · reworked: N · tokens: 122869
  - Sonnet · market research · reworked: N (sources were mixed quality; findings used as support only) · tokens: 86873
  - Fable · re-review of 14 ideas · reworked: N · tokens: 140996
  - Fable · design validation · reworked: N (design v1 revised into v2) · tokens: 225866
  - Opus · design validation · reworked: N (design v1 revised into v2) · tokens: 144987
  - Fable · final best-in-class review · reworked: N (design v2 amended to v2.1) · tokens: 140112
- Total subagent tokens: about 1.09M. Main session figure is an estimate (about 90k).

---

# Session — 2026-10-20/21 — S39: Wave 2 camera for real exams (Z-74, Z-82), camera follow-up, optional time limit per assessment

**Headline:** The camera feature is built and live, and the `CAMERA_ENFORCED` switch is ON in production (owner decision 2026-10-21; server `.env` backup kept; api and worker both recreated, sweep 0 failures). Z-104 CERT-POLISH is done and deployed: no empty signature line, larger social preview text, "No answers yet" at the start (error and offline keep "Not saved yet"), Congratulations box checked (one small fix), tier rule confirmed (75% Completion, 90% Distinction). Caddy `camera=(self)` is applied on take pages only. Follow-up shipped: camera line in the invitation and reminder emails, own limit and idempotence on the consent route, retake consent test. New: the organisation admin can set an optional time limit per assessment (empty = the difficulty's time). Z-74 and Z-82 closed in place.
**Commits (all pushed, CI green, deployed):** `737ccb13` camera server side · `6dbabbd4` candidate and staff screens, help 0231 · `b1426b66` nav probe fix · `572a8dff` close-out docs, smoke spec, edge reference copies · `dd287b3c` (the other session's blueprint fields and dependency bumps, pushed with ours after a gate check of its two package changes) · `e1d4ed50` camera follow-up · `5f72240c` time limit plus the gate fixes (bulk invite resolves the camera rule once per batch) · `e2d2aed6` Z-104 polish, capacity notes, pre-pilot checklist line (pushed, CI green, deployed) · docs commits (handoff, ROADMAP Z-104 row).
**Tests:** pass. Module 05 213 (3 skipped), 06 full, 10 279, 13 314, 16 116, take pages 81, time-limit test file 6, smoke spec 3 of 3 (local). `pnpm verify` green before every push. Deployed three times, sweep 0 failures. Migrations 0229 to 0234 applied (0232 is the other session's blueprint help). Next free migration: 0235. Last deployed sha `e2d2aed6` (Z-104; no migration). Capacity read: disk 46 GB free of 96 GB, camera folder 0 bytes and 0 files (no photo yet), see the Capacity section of the camera change record.
**Recount:** pending 81, closed 208, total 289, 72% (was 81/204/285 at the start of S39). Rows Z-101 to Z-104 are in ROADMAP (Z-102 time limit and Z-104 closed; Z-101 and Z-103 wait for the owner). Another session has 9 uncommitted FUT rows in ROADMAP.md (Z.4, 90 / 208 / 298 with them): whoever commits them updates the Z.7 line. NEXT.md was not regenerated for that reason; run `node tools/next-brief.mjs` first next session.
**Edge:** the shared Caddyfile was edited once with the owner's go (old copy saved on the server). The camera header must be a site-level deferred header (RCA 2026-10-21). Repo reference copies match the live file.
**Next:** (1) owner: run the live camera test yourself; confirm the camera notice in each organisation (Settings, Data privacy, Camera card; needed before any real exam can start), run the 20-minute live camera test (readiness picture, consent, photos, cover the camera, reviewer page, console check for Z-77, free disk and photo size), create the school test organisation and walk `docs/runbooks/camera-school-test.md`. Undo = `CAMERA_ENFORCED=false` and recreate `assessiq-api`. (2) owner or ROADMAP session: add a row for the time limit (change record `docs/archive/2026-10-21-assessment-time-limit-change-record.md`). (3) Wave 3 (exam content) or Wave 5 (GATE-8, load test).
**Open questions:** none blocking. The worker was recreated, so reminder emails show the camera line. Accepted gaps: per-tenant camera storage quota, orphan-file sweep, super admin cross-tenant file view (support access deferred), no per-IP cap on the consent route. Time limit: preview and invited list show the override or the level time and ignore section or whole-test time (old behaviour). Owner tasks: school test walk-through, signed-in check of /admin and one take page, CSP console check, speed check, AI evaluation bless and dry runs, rate card, host and IP in the public CLAUDE.md.
**Old task or feature checked:** Z-87, Z-91 (camera reuses the desktop rule and readiness page), Z-39 (retake limit and retake consent), Z-77 (CSP `media-src`), the level time rule in `levels.duration_minutes` (Rule B).
**Change records:** `docs/archive/2026-10-20-camera-change-record.md`, `docs/archive/2026-10-21-assessment-time-limit-change-record.md`
**Optimization register rows touched:** TOK-6, GATE-4.

---

## Agent utilization
- Opus: n/a — this session's orchestrator ran on Sonnet 5.5 · plan, contracts for every agent, line review of all server and timer code, 9 review fixes, commits, pushes, deploys, Caddy edit, docs
- Sonnet · A1 camera data layer · reworked: N · tokens: 202k
- Sonnet · A2 routes and start gate · reworked: Y (retake consent bug found in review) · tokens: 258k
- Sonnet · B1 capture hook · reworked: N · tokens: 110k
- Sonnet · C2 "Did not consent" label · reworked: N · tokens: 143k
- Sonnet · gap 1 camera line in emails · reworked: Y (pool deadlock in bulk invite found by the gate, fixed by orchestrator) · tokens: 129k
- Sonnet · gaps 2 and 3 retake test, consent limit · reworked: N · tokens: 99k
- Sonnet · optional time limit per assessment · reworked: Y (card shown on sectioned tests, found by the gate, fixed by orchestrator) · tokens: 213k
- Sonnet · gate batch A (takeover, owner approved) · REVISE, 3 fixed 3 accepted · tokens: 129k
- Sonnet · gate camera follow-up · REVISE, medium fixed · tokens: 94k
- Sonnet · gate time limit and dependency bumps · A REVISE (fixed), B ACCEPT · tokens: 115k
- Haiku · B2 readiness camera and consent screen, help 0231 · reworked: Y (general consent checkbox restored) · tokens: 213k
- Haiku · C1 staff screens · reworked: Y (3 help ids renamed, is_school added, nav probe replaced after CI) · tokens: 206k
- Haiku · D1 local smoke spec · reworked: N · tokens: 146k
- Haiku · D2 runbook · reworked: N · tokens: 111k
- Haiku · docs as-built update · reworked: N · tokens: 128k
- Haiku · Z-104 polish a to d and f · reworked: N (my review only checked the badge fit and escaping; wording decision for (c) was set in the brief) · tokens: 122k
- codex:rescue: n/a — Codex down; three Sonnet takeover gates (owner approved), all REVISE with fixes applied or findings accepted in the change records
- Gemini (agy): n/a — no bulk digest needed; reads were targeted

# Session — 2026-10-20 — S38: Session 4 pre-pilot readiness (exact meter, expiry warning, result sign-in link, ETA notice, sample quiz, load-test script)

**Headline:** Z-93 and Z-96 closed (exact meter + expiry-warning email), Z-15 (a) shipped (7-day one-time sign-in link in the result email), SP11 live, Z-84 report done, load-test script and checklist written (not run).
**Commits:** `5afedc62` — feat: exact credit meter, expiry-warning email, result sign-in link, ETA notice, sample-quiz tool, load-test script · `57801b92` — docs close-out · `23267f7a` — SP11 wording for both release modes, help v2 rows, `retireResultLoginLinks` · `d6c998b5` — docs: withdraw rule on Z-15, GATE-8 check on Z-86
**Tests:** pass (billing 12+7, auth 334+, notifications 308, help 116 + guards, admin-dashboard 262, `pnpm verify`); CI green on every commit; deployed twice, sweep 0 failures; migration 0228 applied (next 0229). Last deployed sha `23267f7a` (`d6c998b5` is docs only).
**Recount:** pending 81, closed 204, total 285, 72% (was 84/201/285, 71%).
**Owner answers applied (S38 part 2):** SP11 text changed (true for both modes) and help v2 live; withdraw rule = helper only, no withdraw action built, GATE-8 checks it; sample quiz: none of the 4 sources loaded; load test waits until after Wave 2.
**Next:** Wave 2 (camera: Z-74, Z-82; needs your Caddy `camera=(self)` go and the lawyer question), or more Wave 1/4 rows. Before the load test: test-only token export, no real invite emails, source-IP plan, image-tag rollback step in deploy.
**Open questions:** none blocking. Owner tasks: signed-in check of /admin and a take page, CSP console check (unlocks Z-77), speed check, AI evaluation bless and dry runs, legal defaults and lawyer question, rate card, host/IP in public CLAUDE.md, rescoring Q1-Q4, warranty wording, GIFT format.
**Old task or feature checked:** Z-93, Z-96, Z-15, SP11, Z-84 (Rule B); the 2026-05-13 candidate magic-link decision is honoured (POST verify via SPA).
**Change record:** `docs/archive/2026-10-20-session4-change-record.md`

---

## Agent utilization
- Opus · plan, billing code (meter, expiry job, tests), review of every agent diff, gate fixes (redact, retire, erased check), deploy, docs
- Sonnet · Z-15 a build · reworked: N · tokens: 123k
- Sonnet · gate review of Z-15 a (takeover) · reworked: N (verdict REVISE, fixed by Opus) · tokens: 87k
- Haiku · SP11 notice · reworked: N · tokens: 136k
- Haiku · Z-84 sample quiz tool · reworked: N · tokens: 142k
- Haiku · load-test script + checklist · reworked: N · tokens: 161k
- Haiku · fixed-date test sweep (no findings) · reworked: N · tokens: 106k
- Haiku · IndexNow readiness check · reworked: N · tokens: 78k
- codex:rescue: n/a — Codex down; Sonnet takeover gate on Z-15 a (owner approved), verdict REVISE, all fixed
- Gemini (agy): n/a — bulk reads were small

