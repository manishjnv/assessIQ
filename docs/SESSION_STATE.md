# Session — 2026-05-01 (Phase 1 kickoff plan authorship)

**Headline:** `docs/plans/PHASE_1_KICKOFF.md` shipped — full Phase 1 (Author & Take, Week 3-5) plan covering modules `04-question-bank`, `05-assessment-lifecycle`, `06-attempt-engine`, `11-candidate-ui`, `16-help-system`. Mirrors the Phase 0 plan structure: discovery summary (consolidated from 3 parallel Haiku Explore agents, one per module cluster), 23-row decisions-captured table (4 user-blocking, 19 orchestrator defaults), 5 sessions across 4 serial groups (G1.A parallel × 2 → G1.B → G1.C → G1.D), per-session blocks with file paths + restated SKILL contract + verification checklist + anti-pattern guards + 4-step DoD, final orchestrator-only verification pass, routing summary, 22-help_id seed catalog appendix.

**Commits:**

- HEAD on push — `docs(plans): phase 1 kickoff plan` (run `git log` for the SHA)

**Tests:** skipped — pure docs authorship; no code/migration changes. Pre-commit hook (`.claude/hooks/precommit-gate.sh`) runs the secrets-scan over the diff; the Phase-1 plan contains no real secrets, only example token-format strings already documented in the Phase 0 plan and `01-auth/SKILL.md` addendum (`aiq_live_<32-char-random>`, `randomBytes(32).toString('base64url')`). The 103/103 vitest suite from G0.B-2 remains green and was not re-run since no source code changed. Pre-existing markdownlint warnings in adjacent docs predate this PR — not in newly-added content; deferred.

**Next:** Phase 1 G1.A (sessions 1 + 2 in parallel) is BLOCKED on two predecessors landing first: (1) G0.C-4 `01-auth` implementation — pre-flight decisions are pinned (commit `1cf5066`, per the previous session's SKILL.md addendum), but the migrations + middleware + JWT verify code has NOT shipped yet; (2) G0.C-5 `03-users` + admin login screen has not started. G0.B-2 `02-tenancy` is already shipped (commit `7923492 feat(tenancy): tenants table + RLS isolation + middleware`) — the working-tree-modified state from this session's start was already-committed work surfaced via Window 2's earlier commit. The orchestrator's IMMEDIATE next action is to ping the user with the four user-blocking decisions surfaced in this plan: **#3** (`log_analysis` content schema — orchestrator-default proposes mirroring `kql` shape with `log_excerpt` + `expected_findings`), **#4** (bulk import file format — default JSON-only in Phase 1, schema mirroring DB shape), **#12** (`13-notifications` — real SMTP via Hostinger relay vs stay stubbed), **#13** (bulk-import UX scope — CLI helper in Phase 1 vs browser UI). On answers, a one-commit "decisions captured" PR updates the relevant SKILLs + `docs/02-data-model.md` § log_analysis content shape; then G1.A opens once the three Phase 0 predecessors merge.

**Open questions:**

- Four user-blocking decisions (#3, #4, #12, #13) above. Orchestrator-default recommendations included in the plan; user can defer to defaults to unblock G1.A immediately.
- `08-rubric-engine` module abstraction deferred to Phase 2. Phase 1 inlines rubric Zod into 04-question-bank because per `02-data-model.md:25` rubrics are denormalized into `questions.rubric` JSONB; no separate module needed for Phase 1 surface.
- `14-audit-log` real writes deferred to Phase 3. Phase 1 continues the `// TODO(audit)` pattern from G0.B-2 02-tenancy + G0.C-4 pre-flight (the relaxed CI marker regex accepts tagged forms).
- `Tooltip` primitive co-ships with `16-help-system` in G1.A Session 2 since 16 is the only Phase 1 consumer; captured as decision #1 in the plan.
- Phase 1 vs Phase 2 grading-state ambiguity (`submitAttempt` returns `grading` per `03-api-contract.md:217` vs `pending_admin_grading` per `05-ai-pipeline.md:43`) is resolved as decision #6: Phase 1 stops at `submitted`, `/me/attempts/:id/result` returns `202 { status: "pending_admin_review" }`. `docs/03-api-contract.md` ~line 217 update is part of Session 4's DoD.
- The `getTenantBySlug` carry-forward question from G0.C-4 pre-flight remains open — it affects `01-auth` Window 4 (Google SSO callback), not Phase 1 sessions, but Phase 1 G1.A admin endpoints assume tenant context already exists from session, so it doesn't block Phase 1 directly.
- `apps/web` G0.B-3 smoke page still on `/`. G1.D Session 5 lands the first real `/take/*` routes — recommendation from G0.B-3 handoff stands (keep smoke behind `import.meta.env.DEV` once routing lands).

---

## Agent utilization

- **Opus:** orchestrator throughout — Phase 0 warm-start parallel reads (6 files: PROJECT_BRAIN, 01-architecture-overview, SESSION_STATE, RCA_LOG, PHASE_0_KICKOFF, 03-api-contract), Phase 1-specific module reads (7 files in one parallel burst: SKILLs for 04/05/06/11/16, plus 02-data-model + 07-help-system), 3-Haiku-agent dispatch design with module-cluster scoping + sources-cited reporting contract, dependency-DAG synthesis, decisions-captured table authorship (23 rows mixing user-blocking with orchestrator defaults), per-session block authorship (5 sessions × ~80-100 lines each: file paths, restated contracts, verification checklists, anti-pattern guards, four-step DoD), final-phase verification design, routing-summary table, help_id seed-catalog dedup. Wrote `docs/plans/PHASE_1_KICKOFF.md` directly (no Sonnet handoff) because the work was judgment-heavy: dependency-DAG decisions, deferral calls (`generateDraft` → Phase 2; `08-rubric-engine` inlined; `14-audit-log` TODO continued; admin-authoring UI → Phase 2 admin-dashboard), Phase 1 vs Phase 2 ambiguity resolution (decision #6 grading state), multi-tab autosave trade-off (decision #7 last-write-wins + visibility event over blocking optimistic-lock), and the JOIN-based RLS lint-policy variant decision for child tables (`levels`, `attempt_questions`, `attempt_answers`, `attempt_events`).
- **Sonnet:** n/a — pure plan authorship; no mechanical implementation work to delegate. The plan itself prescribes Sonnet usage for each Phase 1 implementation session per the global orchestration playbook.
- **Haiku:** 3 parallel Explore agents (single-message dispatch) for documentation discovery — Cluster A (authoring chain: 04 + 05), Cluster B (attempt chain: 06 + 11), Cluster C (help system + cross-cuts: 16 + data-model + api-contract). Each agent received: scope, source files to read, structured report contract (contracts exposed/consumed, copy-from-doc snippets, gaps/ambiguities, sources cited with line numbers, confidence per section, no paraphrasing of normative text), and the specific gap categories to surface (pack file format, versioning, autosave concurrency, integrity hook design, help_id stability across renames). All three returned ≤1500 words with rich citations; gaps surfaced fed directly into the 23-row decisions table — the highest-leverage uses were Cluster A surfacing the missing `log_analysis` content schema and the unspecified bulk import format, Cluster B surfacing the multi-tab autosave concurrency gap and the Phase 1 vs Phase 2 grading-state ambiguity, Cluster C surfacing the nullable-tenant RLS bug for `help_content` (standard template fails closed on globals).
- **codex:rescue:** n/a — pure docs authorship; nothing in this diff touches auth/RLS/classifier/audit-log paths. The plan itself prescribes codex:rescue invocation for Phase 1 Session 4 (`06-attempt-engine` — embed JWT + magic-link surfaces, mandatory) and recommends rescue for Sessions 1 (version-snapshot transaction logic) and 3 (state-machine + boundary-cron) as judgment calls.

---

## Files shipped (1)

- `docs/plans/PHASE_1_KICKOFF.md` — new file, ~430 lines. Discovery summary + 23-row decisions table + 5 session blocks + final verification pass + routing summary + 22-help_id seed-catalog appendix.

No source-code changes, no migrations, no deploy. VPS untouched (still G0.B-2's state per the previous session's pointer). The previous-session HEAD `1cf5066` (G0.C-4 pre-flight) is the parent commit. Markdownlint emits MD024 (duplicate-heading) warnings on the new plan because per-session blocks repeat the `#### What to implement / Documentation references / Verification checklist / Anti-pattern guards / DoD` heading set — this matches the structural pattern of `docs/plans/PHASE_0_KICKOFF.md` (the explicit mirror requirement) and the previous session's deferred-lint convention; not addressed in this PR.

---

## Previous-session pointers

The G0.C-4 pre-flight handoff (Window 4 `01-auth` decisions) is preserved in git history — `git show <previous HEAD>:docs/SESSION_STATE.md` retrieves it. Key carry-forward state for any Phase 1 session:

- 10-bucket `01-auth` decisions are pinned in `modules/01-auth/SKILL.md` § "Decisions captured (2026-05-01)". Phase 1 admin endpoints depend on `01-auth` shipping (Window 4) — `requireAuth` + `requireRole('admin')` middleware comes from there.
- `tenant_id` denormalized onto `oauth_identities` / `user_credentials` / `totp_recovery_codes` per the schema-note block above `## Users & auth` in `docs/02-data-model.md`. Phase 1 doesn't touch these tables but inherits the convention: every Phase 1 child table (`levels`, `attempt_questions`, `attempt_answers`, `attempt_events`) faces the same denormalize-vs-JOIN-RLS trade-off, and the Phase 1 plan picks JOIN-RLS via the new `lint-rls-policies.ts` exemption-with-alternative-policy list (decision #1's parent migration in the Session 1 block).
- `tools/lint-rls-policies.ts` exemption convention extended in Phase 1: `help_content` joins the exemption list with the nullable-tenant variant policy; `levels` / `attempt_questions` / `attempt_answers` / `attempt_events` join with JOIN-based-via-parent-FK policy.
- `assessiq-postgres` healthy on VPS at `/srv/assessiq/`, three roles + rotated passwords in `/srv/assessiq/secrets/`, network `assessiq-net`, volume `assessiq_assessiq_pgdata`. No new VPS state added by this session.
- `tools/migrate.ts` not yet shipped (G0.C-4 acceptance criterion). Phase 1 G1.A Session 1 will be the first session writing 5 migrations at once; either Window 4 ships `tools/migrate.ts` first, or G1.A Session 1 inherits the `docker compose exec` ad-hoc apply pattern.

The G0.B-3 (`17-ui-system`) handoff at commit `f21ac4d` and the G0.B-2 (`02-tenancy`) handoff at commit `7923492` are preserved in git history per their respective `docs/SESSION_STATE.md` snapshots — `git show <sha>:docs/SESSION_STATE.md` retrieves them.


---

## Phase 1 Planning Session — 2026-05-01

**Goal:** Draft Phase 1 kickoff plan (`docs/plans/PHASE_1_KICKOFF.md`) from discovery through commit + push.

**Commits this session:**
- `7573f68` — `docs(plans): phase 1 kickoff plan`

**What happened:**
- Dispatched 3 parallel Haiku Explore agents (Clusters A/B/C) against 37 sources.
- Surfaced 25 structured gaps; resolved 14 decisions (D1–D14).
- Synthesized into `docs/plans/PHASE_1_KICKOFF.md` (37,975 bytes) covering 5 modules, 4 session groups, 9 per-session blocks, 22-entry help-ID seed catalog.
- Committed + pushed via git plumbing (observer session had no direct FS write access to project).

**Open items blocking Phase 1 start:**
- Pre-P1: Author `log_analysis` content JSONB schema + bulk-import schema into docs/02-data-model.md + docs/03-api-contract.md (BLOCKS G1.A-04)
- Pre-P2: Author `assessments.settings` JSONB shape + update api-contract.md:217 to `pending_admin_grading` (BLOCKS G1.B-05)
- Pre-P3: Author magic-link JIT-vs-pre-existing user policy in docs/04-auth-flows.md (BLOCKS G1.C-06)
- G0.B Session 2 (02-tenancy): still uncommitted with 3 lint + 4 typecheck errors — needs resolution before Phase 1 G1.B.
- G0.C (01-auth + 03-users): not yet started.
- `tools/migrate.ts` not yet shipped — G1.A Session 1 will need ad-hoc apply pattern.

**Agent utilization:**
- Opus: Discovery synthesis, decision adjudication, git-plumbing session coordination — main session
- Sonnet: n/a this session (planning-only; no implementation subagents dispatched)
- Haiku: 3 parallel Explore agents — Clusters A (04+05), B (06+11), C (16+cross-cuts) — 37 sources, ~20 min wall time
- codex:rescue: n/a — no security/auth/classifier diffs this session
