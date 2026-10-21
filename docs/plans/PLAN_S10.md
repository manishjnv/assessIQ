# AssessIQ — S10 plan (extract for Autopilot, 2026-10-15)

Status: plan (done)
Rows: none (S10 rows moved to docs/archive/ROADMAP-closed-rows-2026-10.md)

Source: `docs/ROADMAP.md` § P0-W "Hardening roadmap from the 2026-10-09 full review". Only the rows tagged S10 and S10+ are here. The rest of that file is context, not scope.

AssessIQ is a half-built, deployed product: 18 modules under `modules/`, apps under `apps/`, ~127k lines of app source, 72k lines of tests, production on a shared VPS. Nothing here is a new project. Every task edits an existing codebase. Mark anything already shipped as done.

Binding rules: `CLAUDE.md` and `PROJECT_BRAIN.md` at the repo root. Load-bearing paths (high risk, Opus review): `modules/00-core/**`, `modules/01-auth/**`, `modules/02-tenancy/**`, `modules/07-ai-grading/**`, `modules/14-audit-log/**`, `infra/**`. No ambient AI calls. No `if (domain === ...)` in code. Never delete or rename an existing file. Never remove a dormant feature.

## Tasks

| ID | Slot | Task | Effort | Who |
| --- | --- | --- | --- | --- |
| RW-45 | S10 | Recovery-code regeneration UI and admin-reset-TOTP UI (backends in `01-auth/src/totp.ts`; orphans from MFA_ENROLLMENT_UX). | M | Claude |
| RW-46 | S10 | Generate wizard topic-focus field (api has `topic_focus`); prompt change = skill scp + eval re-baseline. | S | Claude; owner scp |
| RW-47 | S10 | Clone archival on entitlement revoke (`design/question-set-sharing-clone-on-grant.md` deferred). | M | Claude |
| RW-48 | S10 | State-aware login copy for scope=user vs tenant (`docs/04-auth-flows.md` ~783); `tenant.purged` retention job (~760). | M | Claude |
| RW-49 | S10 | DMARC `p=quarantine` after a 14-day report check (extends C6). | S | Claude; owner DNS |
| RW-50 | S10 | Difficulty Phase B warn heuristics (`plans/QUESTION_DIFFICULTY_PHASE_A.md`). | M | Claude |
| RW-51 | S10 | RCA "manual discipline" guards: help-seed same-version edit lint, `erasure.ts` field-coverage test, migrations-path assert. | S | Claude |
| RW-69 | S10 | **Erasure gap for AI grading data.** modules/20-data-rights erasure blanks attempt_answers only; gradings.anchor_hits, ai_justification and the new stage_inputs (RW-41) plus attempts.ai_proposals keep verbatim answer text after erasure. Add UPDATE gradings SET stage_inputs = NULL, anchor_hits = '[]', ai_justification = NULL and clear attempts.ai_proposals in the erasure path; test. Found by the RW-41 review. | S | Claude |
| RW-70 | S10 | **pool.connect lint aliases.** tools/lint-rls-policies.ts regex misses aliased pools (`const p = getPool(); p.connect()`), `new Pool(`/`new Client(`, and checks the allowlist per file not per line. Extend the scan and add `new Pool(`/`new Client(` outside 02-tenancy as a violation. | S | Claude |
| RW-71 | S10 | **Registry parity test compares itself.** After RW-68 the 06/09/04 functions delegate to the registry, so `packages/question-types/src/__tests__/parity.test.ts` compares the registry with itself for candidateView, deterministicScore and guidanceText (coerceContent still has an independent twin). Replace with frozen golden fixtures (hardcoded expected outputs per type). Found by the RW-68 review. | S | Claude |
| RW-57 | S10+ | **Framework seeds** as JSON files (platform content, super admin loads them): CBSE (NCERT chapters, grades 6-12), ICSE (grade / subject / unit + textbook edition), IB (PYP / MYP / DP, subject groups, criteria). Owner verifies one board against the official syllabus. | M | Claude seeds; owner checks |
| RW-58 | S10+ | **Import pipeline, super admin only.** Build on the existing JSON import (`POST /api/admin/questions/import`, `schemas/import.schema.json`, `tools/aiq-import-pack.ts`): add XLSX/CSV (one row per question, template per type generated from RW-54), `question_imports` staging with per-row errors, content-hash dedupe, dry-run report, "skip errors or fix", commit as draft pack with `source='import'` and file hash. Pattern: Kahoot/Canvas/Moodle templates; candidate CSV parser in 03 `import.ts:99`. No tenant upload. | M | Claude |

## Order

1. RW-51, RW-70, RW-71 (small, test and lint only, no schema).
2. RW-69 (data-rights erasure, touches 07 data: high risk).
3. RW-45, RW-48 (auth UI and copy: high risk, module 01).
4. RW-46, RW-47, RW-50.
5. RW-49 needs the owner (DNS). RW-57 and RW-58 are S10+, last.

## Not in scope

Rows tagged "later", "after 100%", "any" or already in a "Done" section of the source file. Prompt skills on the VPS. Infra changes. Deploys (the owner deploys by hand per `docs/06-deployment.md`).
