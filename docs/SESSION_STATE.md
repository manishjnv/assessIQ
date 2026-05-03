# Session — 2026-05-03 (Phase 4 pre-flight — `12-embed-sdk` decision pinning — PURE DOCS)

**Headline:** Phase 4 12-embed-sdk pre-flight complete. 13 frozen decisions appended to `modules/12-embed-sdk/SKILL.md`; Phase 4 migration plan pre-seeded; two spec drifts fixed in `docs/04-auth-flows.md` and `docs/03-api-contract.md`. No code, no deploy, no VPS touches. Implementation session can start immediately against the locked contract.

**Commits:**
- `b7dfaa9 — docs(embed): pin 12-embed-sdk decisions before phase 4`
- `<handoff-sha> — docs(session): Phase 4 12-embed-sdk pre-flight handoff`

**Tests:** skipped — pure docs session. `pnpm -r typecheck` exit 0 (all 17 packages clean) confirmed before commit.

**Next:** Phase 2 G2.C (`10-admin-dashboard`) once `09-scoring` lands from the parallel window; Phase 3 G3.A (`14-audit-log` — Opus 4.7, `codex:rescue` mandatory) when cycled in; Phase 4 (`12-embed-sdk`) can open immediately once Phase 3 completes — the contract is frozen.

**Open questions:**
- D1 (surface scope): confirm whether admin-view embedding is ever needed in v2 (UX implications).
- D4 (rotation grace): 24h default pinned; if 01-AUTH §5 "90-day rotation grace" was meant as a grace WINDOW (not cadence), override `tenant_settings.features.embed.rotation_grace_hours` to 2160 before Phase 4.
- D10 (SDK npm): `@assessiq/embed` pinned as public npm — confirm if first partners are all internal Wipro (private/unlisted is viable; visibility flag only, no code change).

---

## What shipped (commit `b7dfaa9`)

| File | Change |
|---|---|
| `modules/12-embed-sdk/SKILL.md` | Appended `## Decisions captured (2026-05-03)` with D1–D13 at full CLAUDE.md §9 detail level (chosen/rationale/alternatives/downstream impact for each). Also appended `## Phase 4 migration plan`, `## Spec drifts resolved`, `## Security review note`. ~430 lines added. Existing SKILL.md content untouched. |
| `modules/12-embed-sdk/migrations/.gitkeep` | New file; creates the migrations directory for Phase 4. |
| `modules/12-embed-sdk/migrations/README.md` | New file; documents all 4 Phase 4 migrations (0070–0073) with schema sketches, RLS notes, and docs/02-data-model.md cross-references. Phase 4 writes the actual SQL. |
| `docs/04-auth-flows.md` | Flow 3 postMessage section: expanded type list (aiq.ready, aiq.error, aiq.close-blocked, aiq.close-request); added spec-drift note callout box for two production-visible gaps: (1) `tenants.embed_origins` column absent; (2) `frame-ancestors 'none'` in live Caddy blocks iframe embedding. |
| `docs/03-api-contract.md` | Embed section: added pre-flight note with cookie name, scope, session type, and CSP override contract; added two new Phase 4 endpoint rows (`/embed/sdk.js`, `/embed/test-mint`). |

## Decisions resolved this session

- D1–D13: all 13 embed-SDK-specific ambiguities pinned. See `modules/12-embed-sdk/SKILL.md` § Decisions captured (2026-05-03).
- Spec drift 1 (embed_origins column absent): identified and documented; Phase 4 migration 0070 adds it.
- Spec drift 2 (frame-ancestors 'none' blocks iframe): identified as production-visible; D8 pins the Fastify-header override mechanism.
- Spec drift 3 (external_id claim undocumented): resolved in D9 (optional claim, stored in `users.metadata.external_id`).

## Considered and rejected

- D4: 90-day grace window — 01-AUTH §5 used "90-day rotation grace" phrasing; pinned 24h as the security-forward default; flagged as open question.
- D6: JWT-exp as session lifetime — would expire mid-assessment; pinned standard 8h/30min idle instead.
- D3: aiq.resize inbound type — rejected as redundant with proactive aiq.height from ResizeObserver.

## Explicitly NOT included

No code changes. No migrations written. No deploy. No VPS touches. `modules/01-auth/` read-only — Phase 4 sessionLoader + SameSite=None changes gated behind Opus + codex:rescue.

## Agent utilization
- Opus: n/a — Sonnet-only session per user instruction
- Sonnet: full session — Phase 0 warm-start reads (12 docs), plan authoring, SKILL.md addendum (13 decisions, ~430 lines), migrations README, spec-drift fixes, gate verification, both commits
- Haiku: n/a — pure docs, no bulk sweeps needed
- codex:rescue: n/a — pure docs session, no diff touching load-bearing paths

---

# Session — 2026-05-03 (G2.B Session 3 — 09-scoring shipped)

**Headline:** `@assessiq/scoring` module shipped — attempt_scores table, cohort stats, archetype derivation, leaderboard, 4 admin endpoints. 29/29 tests pass. Live on production VPS.

**Commits:**
- `64a4d28 — feat(scoring): attempt_scores + cohort + archetype + leaderboard (09-scoring)` — 20 files, 2532 insertions
- `<handoff-sha> — docs(session): G2.B Session 3 — 09-scoring shipped` — SESSION_STATE + RCA update

**Tests:** 29/29 pass (`pnpm --filter @assessiq/scoring exec vitest run`). Pure-unit: 16 (deriveArchetype×10, computeSignals×6). Integration: 13 (computeAttemptScore×5, cohortStats×2, leaderboard×3, getAttemptScoreRow×2, individualReport×1). Workspace typecheck: 17/17 packages clean.

**Next:** Fix Phase 1 closure regression — `modules/05-assessment-lifecycle/src/service.ts:749` `tenantName:""` → fetch `tenant.name` from DB. Then re-run closure drills 1/3(step5)/4.

**Open questions:**
- Test entities in production (phase1-closure-test pack + entities from closure audit) — leave or clean up?
- Phase 1 is still formally NOT CLOSED pending the tenantName fix.

---

## Agent utilization
- Opus: n/a — Sonnet-only session by user instruction
- Sonnet: full implementation — 11 new files (migration, types, archetype, repository, service, routes, index, tests) + 4 modified files (server.ts, admin-accept.ts, package.json ×2) + 3 doc updates (SKILL.md, 02-data-model.md, 03-api-contract.md) + typecheck/test gate iteration + deploy
- Haiku: n/a — Sonnet handled all bulk reads inline
- codex:rescue: n/a — judgment-skipped (09-scoring not on load-bearing paths per CLAUDE.md)

---

## Prior session (Phase 1 Closure Verification — PARTIAL) — archived below

### Summary
Phase 1 closure audit (5 drills) against `assessiq.automateedge.cloud`. Drills 2 (RLS) and 5 (VPS additive-deploy) PASS. Drill 1 fails Step 9 (invite → 500: `tenantName:""` × notifications Zod `.min(1)`). Phase 1 NOT CLOSED — re-audit after fixing `05-assessment-lifecycle/src/service.ts:749`.

| Drill | Steps | Result |
|---|---|---|
| D1 — Candidate happy path | 1-8 PASS; step 9 FAIL | PARTIAL |
| D2 — Tenant RLS isolation | All PASS | PASS |
| D3 — Token security | Steps 1-4 PASS; step 5 SKIPPED | PARTIAL |
| D4 — Autosave + timer | All BLOCKED | BLOCKED |
| D5 — VPS additive-deploy | All PASS | PASS |

- Step 3: `POST /api/admin/levels` (L1 - SOC Analyst) → 201, id=`019dedd6-2a3d-746d-8e05-36c3ef5d6ee5` ✓
- Step 4: `POST /api/admin/questions` Q1 MCQ (Incident Response, 20pts) → 201, id=`019dedd8-0aa2-7fac-b8a6-1ba8e1f8040a` ✓
- Step 5: Q2 Subjective (Threat Analysis, 25pts) → 201, id=`019dedd9-a7bd-7f6c-ba78-cc2f9a077751` ✓
- Step 6: Q3 Subjective (Log Analysis, 25pts) → 201, id=`019dedd9-a7e6-7cd8-af7d-93796bc8ffd7` ✓
- Step 7: `POST /api/admin/packs/:id/publish` → 200 (status=published, version=2) ✓
- Step 8a: `POST /api/admin/questions/:id/activate` × 3 → 200 each, activated=3 ✓
- Step 8b: `POST /api/admin/assessments` → 201, id=`019dedd9-a832-7086-afcb-374030b7875b` ✓
- Step 8c: `POST /api/admin/assessments/:id/publish` → 200 (status=published) ✓
- Step 9: `POST /api/admin/assessments/:id/invite` → **500** `ZodError: tenantName must contain at least 1 character(s)` ✗

### Drill 2 detail (PASS)
- Inserted `closure-test-tenant` + `closure-test@example.com` via assessiq_system BYPASSRLS
- `GET /api/admin/users` under wipro-soc session: no closure-test user returned → API isolation PASS ✓
- SQL `SET ROLE assessiq_app; SET app.current_tenant = '<wipro-soc-uuid>'; SELECT ... FROM users`: zero cross-tenant rows → SQL isolation PASS ✓
- Cleanup: 0 test users, 0 test tenants remaining ✓

### Drill 3 detail (steps 1-4 PASS, step 5 SKIPPED)
- Fake 43-char token → `404 INVITATION_NOT_FOUND` ✓
- Empty body `{}` → `404 INVITATION_NOT_FOUND` ✓
- Too-short token `abc123` → `404 INVITATION_NOT_FOUND` ✓
- All three return identical error code + message → **no enumeration oracle** ✓
- Step 5 (single-use enforcement): SKIPPED — no valid invitation token exists

### Drill 5 detail (PASS)
- All 5 assessiq containers: healthy (`api up 27min`, `worker 4h`, `frontend 7h`, `redis 2d`, `postgres 2d`) ✓
- No new non-assessiq systemd units ✓
- Caddyfile: `@api path /api/* /embed* /help/* /take/start` correct; no non-assessiq blocks modified ✓
- Logs: `app.log`, `request.log`, `auth.log`, `worker.log`, `webhook.log` all present and populating ✓
- `logrotate.timer` active (triggers daily, next trigger 2026-05-04T00:00Z) ✓
- Crontab: only roadmap-maintenance entries (pre-existing); no new assessiq crontab entries ✓
- Sibling apps: `intelwatch.in 307`, `ti.intelwatch.in 200`, `accessbridge.space 200`, `automateedge.cloud 200` ✓

## Production test entities (not yet cleaned up)
| Entity | ID | Notes |
|---|---|---|
| Pack `phase1-closure-test` | `019dedd6-0a04-7b2e-9877-c5c77d1e80a7` | status=published; safe to leave (wipro-soc tenant only) |
| Level `L1 - SOC Analyst` | `019dedd6-2a3d-746d-8e05-36c3ef5d6ee5` | — |
| Q1 MCQ (Incident Response) | `019dedd8-0aa2-7fac-b8a6-1ba8e1f8040a` | status=active |
| Q2 Subj (Threat Analysis) | `019dedd9-a7bd-7f6c-ba78-cc2f9a077751` | status=active |
| Q3 Subj (Log Analysis) | `019dedd9-a7e6-7cd8-af7d-93796bc8ffd7` | status=active |
| Assessment `Phase1 Closure Drill` | `019dedd9-a832-7086-afcb-374030b7875b` | status=published |
| Candidate user `drill1-candidate@closure-audit.test` | `019dedda-3cc6-7c3b-a03f-06e5666b191a` | role=candidate, status=active |

---

## Agent utilization
- Opus: n/a — Sonnet-only session per explicit user instruction
- Sonnet: Primary for all reads, drills, documentation. Ran all 5 drills via SSH + scp script pattern (PowerShell quoting workaround).
- Haiku: n/a
- codex:rescue: n/a — read-only operational session; no code changes to review

---

## Prior session — 2026-05-03 (Phase 2 G2.B Session 2 — `08-rubric-engine` live)

> See `git log --oneline 8600ce9` for the full diff. Key facts preserved below for Phase 0 warm-start.

**Commits:** `8600ce9 — feat(rubric-engine): lift RubricSchema + ship validate/score helpers` (20 files, +658/−345). On `origin/main`.

**What shipped:** New `@assessiq/rubric-engine` module — canonical `RubricSchema`/`AnchorSchema`/`AnchorFinding` types lifted from 04+07, plus four pure helpers: `validateRubric`, `sumAnchorScore`, `computeReasoningScore`, `finalScore`. 04 re-exports schemas verbatim (zero consumer churn). 07 swapped local `score.ts` to import `finalScore` from 08 (behavior-identical). `docs/02-data-model.md:25` dead table reference corrected.

**Tests at that point:** `@assessiq/rubric-engine` 28/28; `@assessiq/question-bank` 55/55; `@assessiq/ai-grading` 85/85; `pnpm -r typecheck` clean; all lints clean.

**Next for Phase 2:** Phase 2 G2.B Session 3 — `09-scoring`. Greenfield. Ships `0050_attempt_scores.sql`, `ArchetypeLabel` enum (8 built-ins), `deriveArchetype`, `computeAttemptScore` (UPSERT idempotent), `cohortStats`, `leaderboard`. Imports `finalScore` + `sumAnchorScore` + `computeReasoningScore` from 08. codex:rescue judgment-call recommended once on archetype rule logic.





