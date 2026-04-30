# Phase 1 Kickoff — Author & Take (Week 3–5)

> **Status:** DRAFT — pending author sign-off on pre-session prerequisites (D4, D5).
> **Scope:** modules 04-question-bank, 05-assessment-lifecycle, 06-attempt-engine,
> 11-candidate-ui, 16-help-system.
> **Out of scope:** 02-tenancy (in-flight G0.B), 07-ai-grading (Phase 2), 00/01/03/17
> except as cited dependency contracts.

---

## 1  Discovery Summary

Three parallel Haiku Explore agents ran against all Phase 1 module SKILLs, the full
data-model, the API contract, the AI-pipeline spec, the auth-flows spec, and the
architecture overview. Combined: 37 sources read, 25 structured gaps surfaced, 12
decisions captured.

### Cluster A — Authoring chain (04 + 05)

| # | Gap | Severity |
|---|---|---|
| A1 | `log_analysis` question type declared in SKILL.md; **no content schema in docs/02-data-model.md** | CRITICAL |
| A2 | Bulk-import file format (JSON/CSV) has **no field-level schema** beyond help-text reference | CRITICAL |
| A3 | `assessments.settings` JSONB shape **completely undocumented** | HIGH |
| A4 | kql/scenario/log_analysis UI component content shapes must agree with 04's `content` JSONB | HIGH |
| A5 | `generateDraft()` conflicts with Phase 1 no-ambient-AI rule — defer to Phase 2 | MEDIUM |
| A6 | Pack publish semantics — does `publishPack` snapshot questions to immutable `question_versions`? — undocumented | MEDIUM |
| A7 | Pool-size pre-flight at `publishAssessment()` — assumed yes but not explicit in API contract | MEDIUM |
| A8 | 08-rubric-engine and 14-audit-log not yet implemented — stub interfaces needed | MEDIUM |
| A9 | 13-notifications is console+file logger only; email templates needed for Phase 1 invitations | MEDIUM |
| A10 | Question selection randomization seed reproducibility — no rule stated | LOW |
| A11 | `question_versions` UNIQUE on `(question_id, version)` — version counter is app-managed, not DB-generated; risk of gap on concurrent PATCH | LOW |

### Cluster B — Attempt chain (06 + 11)

| # | Gap | Severity |
|---|---|---|
| B1 | `submitAttempt` returns `{ status:'grading' }` per API contract; **Phase 1 has no async grader** — actual status should be `pending_admin_grading` | CRITICAL |
| B2 | Multi-tab autosave: **no OCC column** on `attempt_answers`; last-write-win behavior unspecified | CRITICAL |
| B3 | Result page (`GET /me/attempts/:id/result`) Phase 1 state: **no grader exists**, so result is `pending_admin_grading` indefinitely | CRITICAL |
| B4 | `attempt.status` enum: data-model lists `grading/graded/released`; ai-pipeline.md defines `pending_admin_grading` — **two enums, pick one** | CRITICAL |
| B5 | localStorage backup schema — mentioned in SKILL, **not documented** | HIGH |
| B6 | postMessage protocol: event-type names confirmed; **no formal TypeScript interface or JSON schema** | MEDIUM |
| B7 | `attempt_events` JSONB payload shape — signal names enumerated; **`payload` structure undefined** | MEDIUM |
| B8 | Browser APIs for integrity signals partially specified (tab visibility + clipboard confirmed; keystroke-pause, resize, fullscreen unspecified) | MEDIUM |
| B9 | `attempt_events` volume ceiling — no rate-limit or batch-size cap documented | MEDIUM |
| B10 | Magic-link `/take/:token` — unclear whether candidate user record must pre-exist or JIT-create is allowed | MEDIUM |
| B11 | Monaco `@monaco-editor/react` dep (~3 MB) required for `KqlEditor`; no lighter alternative documented | MEDIUM |
| B12 | 09-scoring archetype in Phase 1 — `attempt_scores.archetype` would be NULL; Phase 2 coupling acceptable | LOW |

### Cluster C — Help system + cross-cuts (16 + all)

| # | Gap | Severity |
|---|---|---|
| C1 | `<Tooltip>` primitive **not shipped in Phase 0 G0.B-3**; `<HelpTip>` blocks on it | CRITICAL |
| C2 | `help_content` RLS standard template **fails-closed on globals** (`tenant_id=NULL` rows invisible) | CRITICAL |
| C3 | Help-ID stability across page renames — **no migration strategy documented** | HIGH |
| C4 | Telemetry: `help_usage` table or `audit_log` — **Phase 1 decision needed** | MEDIUM |
| C5 | Locale fallback: per-key or per-page? — **spec ambiguous** | MEDIUM |
| C6 | SSE endpoint for live help-content updates — mentioned in docs, **not in API contract** | MEDIUM |
| C7 | YAML seed timing: deploy-time SQL migration or runtime startup check? — **implementation detail unresolved** | LOW |

---

## 2  Decisions Captured

| # | Decision | Rationale | Supersedes |
|---|---|---|---|
| D1 | **Phase 1 grading = sync-on-click Claude Code CLI.** `AI_PIPELINE_MODE=claude-code-vps`. No BullMQ grading workers. | Admin Max subscription VPS; async grading is Phase 2. | Any stale reference to grading queue in 06 SKILL |
| D2 | **`submitAttempt` in Phase 1 → `attempt.status = 'pending_admin_grading'`**, not `'grading'`. api-contract.md:217 to be updated in G1.B PR. | No grader process exists. `'grading'` means async grader has it; that is Phase 2. | api-contract.md:217 |
| D3 | **`attempt.status` enum** in Phase 1: `draft → in_progress → submitted → pending_admin_grading → graded → released` plus `auto_submitted` and `cancelled` terminals. The `grading` value is reserved for Phase 2. | ai-pipeline.md supersedes data-model.md for status machine; keep both in sync. | data-model.md:368 |
| D4 | **`log_analysis` content schema MUST be written into `docs/02-data-model.md` before G1.A-04 session starts** (pre-session prerequisite). Block on this. | No implementation can proceed without a content JSONB shape. | — |
| D5 | **`assessments.settings` JSONB shape MUST be documented in `docs/03-api-contract.md` and `docs/02-data-model.md` before G1.B session starts**. | Phase 2 features might use settings; Phase 1 shape must not be a free-form blob. | — |
| D6 | **`generateDraft()` is deferred to Phase 2.** The 04 SKILL.md function stub is excluded from Phase 1 implementation. | Conflicts with hard rule: no ambient AI calls outside 07-ai-grading. | 04 SKILL.md:generateDraft |
| D7 | **Pack publish atomically snapshots all current question versions** to `question_versions`. After publish, a PATCH to a question creates a new version; in-flight assessments retain the frozen snapshot. | Assessment integrity across question edits. | A6 |
| D8 | **Pool-size pre-flight enforced at `publishAssessment()`**, not at attempt start. If `pool < question_count`, return 422 with human-readable error. | Fail at admin time. | A7 |
| D9 | **Multi-tab autosave = last-write-win**. No OCC column on `attempt_answers`. v2 may add `client_seq` for conflict detection. | v1 simplicity; double-tab scenario is edge case. | B2 |
| D10 | **`<Tooltip>` primitive ships as part of G1.A-16 session** (added to `modules/17-ui-system`). 16-help-system MUST NOT start until G1.A-16 Tooltip is merged. | `<HelpTip>` depends on a floating popover primitive not yet in Phase 0 UI system. | C1 |
| D11 | **`help_content` RLS policy uses `tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')::uuid`**. The linter must be updated to accept this variant for nullable `tenant_id` columns. | Standard RLS fails-closed on global-default rows, making all help invisible. | C2 |
| D12 | **Help telemetry → `audit_log` for Phase 1 MVP.** Events: `help.tooltip.shown` (10% sampled), `help.drawer.opened`, `help.feedback`. Dedicated `help_usage` table deferred to Phase 2. | No additional schema migration; audit_log already ships from Phase 0. | C4 |
| D13 | **Monaco `@monaco-editor/react`** added as a workspace dep for `KqlEditor`. Lazy-loaded only on KQL question pages. | Non-trivial (~3 MB) but no lighter alternative. Lazy-load mitigates bundle impact. | B11 |
| D14 | **Help-ID key stability policy:** help-content keys are treated as stable identifiers. A page or element rename requires a DB migration that either (a) adds an alias column or (b) migrates rows. No orphan keys allowed. Decision logged here; migration template TBD in Phase 3. | C3 — prevents silent orphan accumulation. | C3 |

---

## 3  Session Groupings

```
shipped ──► 17-ui-system ────────────────────────────────────────────────────────────────┐
                                                                                           │
           ┌──────────────────────────┐   ┌───────────────────────────────────────────────┤
  G1.A     │ G1.A-04  question-bank   │   │ G1.A-16  help-system (+ Tooltip in 17)        │
  (parallel)│ ~4 sessions              │   │ ~2 sessions                                   │
           └──────────────┬───────────┘   └──────────────────────┬────────────────────────┘
                          │ merge                                 │ merge (Tooltip)
                          ▼                                       │
           ┌──────────────────────────┐                          │
  G1.B     │ G1.B-05  assessment-     │◄─────────────────────────┘ (help IDs needed)
  (serial)  │ lifecycle  ~3 sessions   │
           └──────────────┬───────────┘
                          │ merge
                          ▼
           ┌──────────────────────────┐   ┌───────────────────────────────────────────────┐
  G1.C     │ G1.C-06  attempt-engine  │   │ G1.C-11  candidate-ui                         │
  (parallel)│ ~3 sessions              │   │ ~4 sessions                                   │
           └──────────────────────────┘   └───────────────────────────────────────────────┘
```

**Gate rules:**
- G1.A-04 and G1.A-16 run in parallel from day 1. They do not depend on each other.
- G1.A-16 Tooltip PR must merge before G1.B-05 or G1.C-11 begin consuming help IDs.
- G1.B-05 MUST NOT start until G1.A-04 **merges to main** (assessment depends on pack API).
- G1.C-06 and G1.C-11 run in parallel once G1.B-05 merges. G1.C-11 imports G1.A-16 + G1.C-06 API.

---

## 4  Pre-Session Prerequisites

The following must be resolved by the **doc author (Opus in main session)** before any
implementation subagent runs. These are not implementation tasks — they are design
decisions that implementation cannot assume.

| PR | Prerequisite | Blocks |
|---|---|---|
| Pre-P1 | Write `log_analysis` content JSONB schema into `docs/02-data-model.md` (questions.content shape for `log_analysis` type) | G1.A-04 Session 1 |
| Pre-P1 | Write bulk-import JSON/CSV field-level schema into `docs/03-api-contract.md` (POST `/admin/questions/import` body shape) | G1.A-04 Session 2 |
| Pre-P2 | Write `assessments.settings` JSONB shape into `docs/02-data-model.md` and `docs/03-api-contract.md` | G1.B-05 Session 1 |
| Pre-P2 | Update `docs/03-api-contract.md:217` — change `status:'grading'` to `status:'pending_admin_grading'` and add Phase 1/Phase 2 callout | G1.B-05 Session 1 |
| Pre-P3 | Add `magic_link` / candidate session section to `docs/04-auth-flows.md` — clarify JIT user creation vs pre-existing user for `/take/:token` | G1.C-06 Session 1 |

---

## 5  Per-Session Blocks

---

### G1.A-04 — 04-question-bank

#### What to implement

**Session G1.A-04.1 — DB layer + pack CRUD + question types**
- `modules/04-question-bank/migrations/`
  - `0001_question_packs.sql` — `question_packs`, `levels` tables with `tenant_id` + RLS
  - `0002_questions.sql` — `questions`, `question_versions`, `tags`, `question_tags` tables
- `modules/04-question-bank/src/`
  - `schemas.ts` — Zod schemas for all 5 question `content` JSONB shapes:
    `mcq` (choices[], correct_index), `subjective` (rubric JSONB ref), `kql` (expected_query,
    expected_keywords[]), `scenario` (steps[{type,prompt,content}]), `log_analysis` (per Pre-P1)
  - `repository.ts` — `createPack`, `getPack`, `updatePack`, `publishPack` (version-snapshot),
    `createQuestion`, `getQuestion`, `patchQuestion` (auto-versions), `listQuestions`
  - `service.ts` — orchestrates repository + audit stubs + version counter
  - `routes.ts` — Fastify routes for all 12 `/admin/packs/*` + `/admin/questions/*` endpoints

**Session G1.A-04.2 — Bulk import + tag management**
- `modules/04-question-bank/src/import.ts` — CSV + JSON parsers; validates against `schemas.ts`;
  bulk-insert with version=1; returns `{ imported, errors[] }` per api-contract.md
- Tag endpoints (GET/POST `/admin/questions/tags`, PATCH `/admin/questions/:id/tags`)

**Session G1.A-04.3 — Audit stubs + RLS linter passing + tests**
- Wire `14-audit-log` stub interface (console emit for Phase 1; real table in Phase 3)
- Wire `08-rubric-engine` stub interface (identity pass-through for Phase 1)
- Vitest unit tests: question version counter under concurrent PATCH (advisory lock or serializable
  tx), pack publish snapshot integrity, pool-size validation

**Session G1.A-04.4 — Integration tests + doc update**
- Integration test suite using in-memory Postgres (PgMem or Docker Compose service)
- Same-PR doc update: append all new columns/tables to `docs/02-data-model.md`
  (schema block + migration number annotation); update `docs/03-api-contract.md` if any
  endpoint shape changed from spec

#### Doc references (with line numbers)

| Source | Relevant section | Lines |
|---|---|---|
| `docs/02-data-model.md` | question_packs, levels, questions, question_versions, tags, question_tags | 45–180 |
| `docs/03-api-contract.md` | Admin — Question Bank endpoints | 55–66 |
| `modules/04-question-bank/SKILL.md` | Full file | 1–79 |
| `docs/01-architecture-overview.md` | RLS posture | 80–92 |
| `CLAUDE.md` | Hard rules #4 (no domain branch), #5 (same-PR docs), RLS linter | project overlay |

#### Verification checklist

- [ ] `pnpm --filter @assessiq/question-bank test` passes (>=90% coverage on service.ts)
- [ ] `tools/lint-rls-policies.ts` passes on all 4 new tables
- [ ] `PATCH /admin/questions/:id` on a question with `version=3` inserts a row to `question_versions` with `version=3` (previous content) BEFORE updating `questions`
- [ ] `POST /admin/packs/:id/publish` returns 422 when zero questions in pack
- [ ] All 5 question type Zod schemas reject malformed payloads
- [ ] Bulk import: 1000-row CSV completes without timeout at default Postgres config
- [ ] No `if (domain === "soc")` anywhere in module source
- [ ] `docs/02-data-model.md` updated in same PR (migration numbers annotated)

#### Anti-pattern guards

- **Do not** implement `generateDraft()` — deferred to Phase 2 (D6). If stub is referenced, throw `NotImplementedError('generateDraft is Phase 2')`.
- **Do not** use `uuidv7()` at SQL level — always pass explicit UUID from app layer (`gen_random_uuid()` is the SQL DEFAULT; app overrides with `crypto.randomUUID()`).
- **Do not** use `if (pack.domain === 'soc')` branches — domain is metadata only.
- **Do not** import from `07-ai-grading` or `09-scoring` — neither exists in Phase 1.
- **Do not** let version counter increment outside a serializable transaction or advisory lock — concurrent PATCH race is gap A11.

#### Four-step DoD

1. **Commit** `docs(04): question-bank schema, routes, import, tests` with noreply email pattern.
2. **Deploy** `pnpm --filter @assessiq/api build && ssh vps "systemctl restart assessiq-api"`. Verify VPS health endpoint returns 200.
3. **Document** same-PR: `docs/02-data-model.md` schema block updated; `docs/03-api-contract.md` bulk-import body shape confirmed.
4. **Handoff** to Orchestrator: diff + change log (<=200 words), test pass count, open questions surfaced.

---

### G1.A-16 — 16-help-system (+ Tooltip in 17-ui-system)

#### What to implement

**Session G1.A-16.1 — Tooltip primitive in 17-ui-system**
- `modules/17-ui-system/src/components/Tooltip.tsx` — floating-ui based, `delay=200ms`,
  `placement="top"` default, `maxWidth=280px`, keyboard-dismissable (Escape), ARIA role=tooltip,
  `data-test-id` support. Props: `content: ReactNode`, `children`, `disabled?`, `delay?`, `placement?`.
- `apps/storybook/src/stories/Tooltip.stories.tsx` — all variants (top/bottom/left/right, long content, disabled)
- Export from `modules/17-ui-system/index.ts`
- **Prerequisite for 16-help-system to proceed — merge this PR first**

**Session G1.A-16.2 — DB layer + seed content**
- `modules/16-help-system/migrations/`
  - `0001_help_content.sql` — `help_content` table with RLS variant:
    `USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')::uuid)`
  - `0002_seed_help_content.sql` — idempotent `INSERT ... ON CONFLICT DO NOTHING` for all 22
    Phase 1 help IDs from `modules/16-help-system/content/en/*.yml`
- `modules/16-help-system/content/en/admin.yml` — entries for all `admin.*` help IDs
- `modules/16-help-system/content/en/candidate.yml` — entries for all `candidate.*` help IDs
- `modules/16-help-system/src/seed.ts` — TypeScript seeder (reads YAML, upserts via `ON CONFLICT`)

**Session G1.A-16.3 — React provider + components + API routes**
- `modules/16-help-system/src/`
  - `provider.tsx` — `<HelpProvider page audience locale>`: bulk-fetches by page+audience+locale on mount;
    caches in `Map<key, HelpEntry>` + `localStorage` (TTL 1h)
  - `HelpTip.tsx` — wraps `<Tooltip>` (from 17-ui-system); shows `short_text`; `?` icon triggers drawer
  - `HelpDrawerTrigger.tsx` — 480px wide Drawer; `Cmd/Ctrl+/` global shortcut
  - `useHelp.ts` — `useHelp(helpId): { shortText, longMd, openDrawer }`
  - `routes.ts` — Fastify routes: `GET /help/:key`, `GET /api/help`, `GET /api/help/:key`,
    `PATCH /api/admin/help/:key`, `GET /api/admin/help/export`, `POST /api/admin/help/import`
  - `telemetry.ts` — appends to `audit_log`: `help.tooltip.shown` (10% sample), `help.drawer.opened`, `help.feedback`

#### Doc references (with line numbers)

| Source | Relevant section | Lines |
|---|---|---|
| `docs/07-help-system.md` | Full spec — 3 layers, ID convention, seeding, per-tenant override | 1–240 |
| `docs/02-data-model.md` | `help_content` table | 516–528 |
| `docs/03-api-contract.md` | Help endpoints | 151, 189–209 |
| `modules/16-help-system/SKILL.md` | Full file | 1–end |
| `modules/17-ui-system/SKILL.md` | Component contract, deferred list | 1–68 |

#### Verification checklist

- [ ] `pnpm --filter @assessiq/ui-system test` — Tooltip passes a11y (axe) and dark-mode stories
- [ ] `tools/lint-rls-policies.ts` passes on `help_content` with the nullable-tenant variant
- [ ] `GET /help/:key` returns 200 with no auth header (public anonymous endpoint)
- [ ] `GET /api/help?page=admin.assessments.create&audience=admin` returns 6 entries (all `admin.assessments.*` IDs seeded)
- [ ] `PATCH /api/admin/help/:key` increments `version`; old version still retrievable
- [ ] A tenant with a custom override receives the override; another tenant receives the global default
- [ ] `HelpProvider` cache: a `GET /api/help` is NOT re-issued within the 1h TTL window (localStorage)
- [ ] No `import` from `@monaco-editor/react` in 16-help-system source

#### Anti-pattern guards

- **Do not** apply standard RLS template (`tenant_id = current_setting(...)`) to `help_content` — it will make global defaults invisible (C2, D11).
- **Do not** seed at runtime startup — use SQL migration `0002_seed_help_content.sql` that runs once and is idempotent.
- **Do not** implement SSE for live updates — deferred (C6). Return a 501 stub if the endpoint is referenced.
- **Do not** create a `help_usage` table in Phase 1 — telemetry goes to `audit_log` (D12).
- **Tooltip in 17-ui-system** must export from the public barrel (`index.ts`) before any consumer imports it.

#### Four-step DoD

1. **Commit** in two PRs: first `feat(17-ui-system): Tooltip primitive` (G1.A-16.1), then `feat(16-help-system): help provider, seeder, routes` (G1.A-16.2+3).
2. **Deploy** Tooltip storybook story visible at `/storybook`. API routes live on VPS.
3. **Document** same-PR: `docs/07-help-system.md` implementation notes section updated with seed migration number and RLS variant decision.
4. **Handoff** to Orchestrator: 22 help IDs seeded confirmed (query `SELECT count(*) FROM help_content WHERE tenant_id IS NULL`).

---

### G1.B-05 — 05-assessment-lifecycle

#### What to implement

**Session G1.B-05.1 — DB layer + state machine + pack association**
- `modules/05-assessment-lifecycle/migrations/`
  - `0001_assessments.sql` — `assessments` table (status ENUM, settings JSONB per Pre-P2),
    `tenant_id` + RLS; ENUM type: `draft | published | active | closed | cancelled`
  - `0002_assessment_invitations.sql` — `assessment_invitations` table, UNIQUE `(assessment_id, user_id)`,
    `token_hash`, `expires_at`
- `modules/05-assessment-lifecycle/src/`
  - `schemas.ts` — Zod for `assessments.settings` (per Pre-P2 doc), invitation payload
  - `repository.ts` — `createAssessment`, `getAssessment`, `patchAssessment`, `publishAssessment`
    (pool-size pre-flight, D8), `closeAssessment`, `cancelAssessment`
  - `service.ts` — state-machine guard: only valid transitions allowed; invalid transition → 409
  - `invitation.ts` — `inviteUsers({userIds[]})`: generates `randomBytes(32).toString('base64url')`,
    stores `sha256(token)` as `token_hash`, `expires_at = now + 72h`; deduplicates via UNIQUE constraint
  - `routes.ts` — all 7 `/admin/assessments/*` endpoints including `POST /admin/assessments/:id/invite`

**Session G1.B-05.2 — Attempt listing + 13-notifications stub**
- `GET /admin/assessments/:id/attempts` — paginated attempt list for admin review
- Wire `13-notifications` stub: `sendInvitationEmail(to, token, expiresAt)` → console+file for Phase 1;
  actual email template at `modules/13-notifications/templates/assessment-invitation.html`
  (ship the template even if delivery is stubbed, so Phase 3 can wire SMTP without a rewrite)

**Session G1.B-05.3 — Integration tests + doc update**
- State-machine exhaustive test: all invalid transitions return 409
- Pool-size pre-flight: `publishAssessment` on empty pack returns 422; on pack with exactly `question_count` questions succeeds
- Invitation deduplication: double-invite same user returns existing invitation (not 500)
- Same-PR doc update: `assessments` and `assessment_invitations` schema in `docs/02-data-model.md`

#### Doc references (with line numbers)

| Source | Relevant section | Lines |
|---|---|---|
| `docs/02-data-model.md` | assessments, assessment_invitations | 280–370 |
| `docs/03-api-contract.md` | Admin — Assessment Lifecycle endpoints | 72–78 |
| `docs/04-auth-flows.md` | Invitation token flow | 147–164 |
| `modules/05-assessment-lifecycle/SKILL.md` | Full file | 1–end |

#### Verification checklist

- [ ] `pnpm --filter @assessiq/assessment-lifecycle test` passes (state machine coverage 100%)
- [ ] `tools/lint-rls-policies.ts` passes on `assessments` and `assessment_invitations`
- [ ] `POST /admin/assessments/:id/publish` returns 422 when `pack.question_count > pool_size`
- [ ] `POST /admin/assessments/:id/publish` on `active` assessment returns 409
- [ ] `POST /admin/assessments/:id/invite` with 50 `user_ids` inserts exactly 50 rows (UNIQUE guards against duplicates on re-invite)
- [ ] Invitation `token_hash` is `sha256(base64url_token)`, not the raw token (verify via regression test)
- [ ] `assessments.settings` JSONB validated against Zod schema on every write
- [ ] API contract `status:'pending_admin_grading'` reflected in `docs/03-api-contract.md` before this PR merges

#### Anti-pattern guards

- **Do not** allow arbitrary state transitions — guard every PATCH/POST that changes status through the state machine; reject with 409 and a human-readable `transition_error` field.
- **Do not** validate pool size at attempt-start time (candidate-facing) — only at `publishAssessment()` (D8).
- **Do not** store the raw invitation token — always store `sha256(token)` in `token_hash` (constant-time compare on read).
- **Do not** call `13-notifications` synchronously in the request path if it makes network calls — keep it fire-and-forget with `setImmediate` so invitation endpoint stays fast.
- **Do not** reference `07-ai-grading` — it does not exist in Phase 1.

#### Four-step DoD

1. **Commit** `feat(05): assessment-lifecycle schema, state machine, invitations`
2. **Deploy** VPS; smoke-test `GET /admin/assessments` returns 200.
3. **Document** same-PR: `docs/02-data-model.md` assessments block updated; `docs/03-api-contract.md` status enum updated to include `pending_admin_grading`.
4. **Handoff** to Orchestrator: state-machine diagram as ASCII art in change log; all 7 endpoints live.

---

### G1.C-06 — 06-attempt-engine

> Runs in parallel with G1.C-11 after G1.B-05 merges.

#### What to implement

**Session G1.C-06.1 — DB layer + startAttempt**
- `modules/06-attempt-engine/migrations/`
  - `0001_attempts.sql` — `attempts` table (status ENUM per D3), `tenant_id` + RLS
  - `0002_attempt_questions.sql` — `attempt_questions` (frozen `question_version` FK), `attempt_answers`, `attempt_events` (BIGSERIAL PK)
- `modules/06-attempt-engine/src/`
  - `schemas.ts` — Zod for `attempt_events.payload` per signal type (tab_blur, tab_focus, copy, paste, nav_back, time_milestone, question_view, answer_save, flag, unflag)
  - `service.ts` — `startAttempt`: validates invitation token (sha256 compare), checks assessment is `active`,
    seeds `attempt_questions` from frozen question versions, sets `started_at`, returns `{ attempt, questions[], remainingSeconds }`

**Session G1.C-06.2 — Answer save + flag + event + submit**
- `saveAnswer(attemptId, questionId, payload)`: validates `attempt.status = 'in_progress'` + time not expired; upserts `attempt_answers` (last-write-win, D9)
- `toggleFlag`: flips `attempt_answers.flagged`
- `recordEvent`: inserts to `attempt_events`; signal types limited to enum (rejects unknown signals)
- `submitAttempt`: idempotency check on `attempts.status`; transitions to `pending_admin_grading` (D2, D3); fires `13-notifications` stub for submission acknowledgement

**Session G1.C-06.3 — Timer sweep + embed JWT validation**
- `sweepStaleTimers()` — BullMQ repeating job (non-AI, confirmed OK per CLAUDE.md); auto-submits all `in_progress` attempts past `ends_at`; logs count
- Embed JWT validation middleware: HS256, `tenant.embed_secret`; mints short-lived session on verify
- `GET /take/:token` — resolves invitation token, returns assessment intro data; user record MUST pre-exist (JIT is Phase 3; documented in Pre-P3)
- Integration tests: timer sweep auto-submits 3 stale rows; answer save after expiry is rejected 409

#### Doc references (with line numbers)

| Source | Relevant section | Lines |
|---|---|---|
| `docs/02-data-model.md` | attempts, attempt_questions, attempt_answers, attempt_events | 365–410 |
| `docs/03-api-contract.md` | Candidate endpoints | 129–143 |
| `docs/05-ai-pipeline.md` | Phase 1 grading — sync-on-click | 1–64 |
| `modules/06-attempt-engine/SKILL.md` | Full file | 1–end |

#### Verification checklist

- [ ] `pnpm --filter @assessiq/attempt-engine test` passes
- [ ] `tools/lint-rls-policies.ts` passes on `attempts`, `attempt_questions`, `attempt_answers`, `attempt_events`
- [ ] `submitAttempt` called twice returns same `{ status: 'pending_admin_grading' }` without side effects
- [ ] `saveAnswer` after `attempt.ends_at` returns 409 (timer authority)
- [ ] `sweepStaleTimers()` auto-submits exactly N stale rows in test fixture
- [ ] `GET /take/:invalid_token` returns 401 (sha256 compare fails)
- [ ] No `07-ai-grading` import anywhere in module source
- [ ] `attempt_events.payload` validated against per-signal Zod schema on insert

#### Anti-pattern guards

- **Do not** enqueue a grading job in `submitAttempt` — there is no grader in Phase 1 (D1, D2).
- **Do not** block the request path on `sweepStaleTimers` results — it is a background job.
- **Do not** use raw invitation token in DB query — always hash to sha256 before compare.
- **Do not** allow `attempt_events` with unknown signal types — reject with 422 to prevent payload-shape drift.
- **Do not** implement save-and-resume (explicit non-goal per 11 SKILL.md).

#### Four-step DoD

1. **Commit** `feat(06): attempt-engine — start, save, submit, timer sweep, embed JWT`
2. **Deploy** VPS; verify `POST /take/start` returns 201 with a test invitation.
3. **Document** same-PR: `docs/02-data-model.md` attempt status enum updated to include `pending_admin_grading`; `docs/05-ai-pipeline.md` Phase 1 boundary note updated.
4. **Handoff** to Orchestrator: diff + change log; confirm `sweepStaleTimers` BullMQ job registered.

---

### G1.C-11 — 11-candidate-ui

> Runs in parallel with G1.C-06 after G1.B-05 merges. Consumes G1.C-06 API + G1.A-16 help primitives.

#### What to implement

**Session G1.C-11.1 — Routing skeleton + Monaco dep + answer components**
- `apps/web/src/routes/take/` — React Router subtree for `/take/*`
- `@monaco-editor/react` — add to workspace deps; lazy-load in `KqlEditor` only (`React.lazy + Suspense`)
- `modules/11-candidate-ui/src/components/`
  - `McqOption.tsx` — radio card; hover/focus/selected states; maps to 17-ui-system tokens
  - `SubjectiveEditor.tsx` — controlled textarea with word count, autosave trigger hook
  - `KqlEditor.tsx` — lazy Monaco with KQL keyword syntax; tab indents, Escape focuses next element
  - `ScenarioStepper.tsx` — step indicator "Step N of M"; renders per-step component

**Session G1.C-11.2 — Page tree + autosave + integrity hooks**
- All 7 pages: Landing, Intro, QuestionRunner, Review, Submit, Done, Result
- `useAutosave(attemptId, questionId, answer)` — debounced 5s; immediate on blur; on failure: queue locally
  + exponential backoff; on hard-stale (>2min): localStorage backup
  (key: `aiq_attempt_${attemptId}_q_${questionId}`, value: serialized answer JSONB)
- `useIntegrityReporter(attemptId)` — wires Page Visibility API, ClipboardEvent, `fullscreenchange`,
  keystroke-pause detector (>30s idle); calls `POST /me/attempts/:id/event` fire-and-forget;
  rate-limited to max 1 event/signal/5s to cap `attempt_events` volume

**Session G1.C-11.3 — Timer + help IDs + embed mode**
- `useTimer(endsAt)` — countdown from server-derived `remainingSeconds`; displays `MM:SS`; on zero: triggers submit flow
- All `<HelpTip>` wiring for the 11 candidate-side help IDs (from Cluster C § 10 report)
- Embed mode: `?embed=true` strips `<TopNav>` / `<Footer>`; `applyEmbedTheme` on postMessage `aiq.theme`;
  `postMessage({ type: 'aiq.attempt.submitted', attemptId, summary })` on submit

**Session G1.C-11.4 — Result page + E2E smoke test**
- Result page: renders `pending_admin_grading` state when `attempt.status` is `pending_admin_grading`;
  shows "Your submission is with the reviewer — results will be available once grading is complete"
  (no spinner loop; no polling in Phase 1)
- E2E smoke (Playwright): magic-link → intro → MCQ answer → submit → Done page visible
- Bundle audit: `pnpm --filter @assessiq/web build` must complete; Monaco lazy chunk confirmed separate

#### Doc references (with line numbers)

| Source | Relevant section | Lines |
|---|---|---|
| `modules/11-candidate-ui/SKILL.md` | Full file | 1–79 |
| `docs/03-api-contract.md` | Candidate + Embed endpoints | 129–143 |
| `docs/04-auth-flows.md` | Magic-link flow + postMessage schema | 147–164, 216–219 |
| `modules/16-help-system/SKILL.md` | Help IDs for candidate surface | 54–74 |
| `docs/01-architecture-overview.md` | Embed data flow, postMessage schema | 120–138 |

#### Verification checklist

- [ ] `pnpm --filter @assessiq/web build` succeeds; Monaco appears as a separate async chunk (>=1.5 MB)
- [ ] `McqOption` passes axe a11y audit (role=radio, aria-checked, keyboard nav)
- [ ] `SubjectiveEditor` autosave fires on blur immediately (unit test with fake timers)
- [ ] `useAutosave` retries on failure with exponential backoff; writes localStorage backup key correctly
- [ ] `KqlEditor` lazy-loads: initial render does NOT include Monaco in synchronous JS
- [ ] Integrity hook rate-limits to <=1 event/signal/5s (unit test)
- [ ] `?embed=true` hides TopNav/Footer in DOM (Playwright assertion)
- [ ] Result page with `status=pending_admin_grading` shows static message; makes NO polling calls
- [ ] All 11 candidate help IDs wired to `<HelpTip>` (grep for each ID in source)

#### Anti-pattern guards

- **Do not** poll `/me/attempts/:id/result` for grading completion in Phase 1 — result is static `pending_admin_grading` until admin action (Phase 2 workflow).
- **Do not** import Monaco at the top level — always `React.lazy` to keep initial bundle < 200 KB JS (gzipped).
- **Do not** block submit on integrity signal upload — fire-and-forget only.
- **Do not** implement save-and-resume (explicit non-goal per 11 SKILL.md).
- **Do not** strip `?embed=true` from child navigations — embed flag must persist through the full page tree.

#### Four-step DoD

1. **Commit** `feat(11): candidate-ui — page tree, answer components, autosave, embed, result`
2. **Deploy** VPS; smoke: navigate to `/take/<test_token>` via browser, complete MCQ, submit, see Done page.
3. **Document** same-PR: add postMessage TypeScript interface (from auth-flows.md:216–219) to `docs/04-auth-flows.md` as a code block.
4. **Handoff** to Orchestrator: E2E test pass, bundle sizes (total + Monaco chunk), help IDs wired count.

---

## 6  Orchestrator-Only Verification Pass

After **all** G1.C PRs merge, the Orchestrator (Opus main session) runs this gate before
declaring Phase 1 complete. No subagent runs this.

```bash
# 1 — Full test suite
pnpm test --filter "@assessiq/*" 2>&1 | tail -20

# 2 — RLS linter on all Phase 1 tables
pnpm tsx tools/lint-rls-policies.ts

# 3 — Domain-branch scan (must return empty)
grep -r 'domain === ' modules/04-question-bank/src modules/05-assessment-lifecycle/src \
  modules/06-attempt-engine/src modules/16-help-system/src

# 4 — Secrets scan (AWS/OpenAI/Anthropic patterns)
grep -rE 'AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{30,}' \
  modules/ apps/ --include='*.ts' --include='*.tsx'

# 5 — Help IDs seeded
psql $DATABASE_URL -c "SELECT count(*) FROM help_content WHERE tenant_id IS NULL"
# expect: 22

# 6 — attempt.status enum check
psql $DATABASE_URL -c "dT+ attempt_status"
# expect: draft, in_progress, submitted, pending_admin_grading, auto_submitted, graded, released, cancelled

# 7 — Monaco bundle check
ls -lh apps/web/dist/assets/ | grep -i monaco
# expect: at least one file >=1 MB (lazy chunk)

# 8 — Haiku post-deploy sweep (delegate to Haiku subagent)
# Subagent: curl-grid all Phase 1 endpoints, return checkmark table.
# Orchestrator approves table. No Opus curl loops.
```

---

## 7  Routing Summary

| Session | Module | Runs on | Model | isolation |
|---|---|---|---|---|
| G1.A-04.1–4 | 04-question-bank | Sonnet subagent | sonnet | worktree (writes load-bearing tables) |
| G1.A-16.1 | Tooltip in 17-ui-system | Sonnet subagent | sonnet | worktree |
| G1.A-16.2–3 | 16-help-system | Sonnet subagent | sonnet | worktree |
| Pre-P1, Pre-P2, Pre-P3 | Doc authoring (prerequisites) | Opus main session | opus | no worktree (doc-only) |
| G1.B-05.1–3 | 05-assessment-lifecycle | Sonnet subagent | sonnet | worktree |
| G1.C-06.1–3 | 06-attempt-engine | Sonnet subagent | sonnet | worktree |
| G1.C-11.1–4 | 11-candidate-ui | Sonnet subagent | sonnet | worktree |
| Verification sweeps | Post-deploy curl grid | Haiku subagent | haiku | no worktree (read-only) |
| Security review | Any diff touching auth, embed JWT | codex:rescue | — | — |

---

## 8  Status

- [x] Discovery complete (3 Haiku clusters, 37 sources)
- [x] Decisions captured (D1–D14)
- [ ] Pre-P1 doc prerequisites authored (BLOCKS G1.A-04)
- [ ] Pre-P2 doc prerequisites authored (BLOCKS G1.B-05)
- [ ] Pre-P3 doc prerequisite authored (BLOCKS G1.C-06)
- [ ] G1.A-04 sessions 1–4 complete
- [ ] G1.A-16 sessions 1–3 complete
- [ ] G1.B-05 sessions 1–3 complete
- [ ] G1.C-06 sessions 1–3 complete
- [ ] G1.C-11 sessions 1–4 complete
- [ ] Orchestrator verification pass

---

## 9  Default Help-ID Seed Catalog

These 22 help IDs must have default content in `modules/16-help-system/content/en/` before
Phase 1 ships. Sourced from Cluster C discovery (SKILL.md cross-section, all Phase 1 modules).

```
admin.assessments.close.early
admin.assessments.create.duration
admin.assessments.create.question_count
admin.assessments.create.randomize
admin.assessments.invite.bulk
admin.assessments.publish
admin.packs.create.domain
admin.questions.generate.draft   # stub only — content says "Available in Phase 2"
admin.questions.import.format
admin.questions.type.kql.expected_keywords
admin.questions.type.scenario.step_dependency
admin.questions.type.subjective.rubric
candidate.attempt.disconnect
candidate.attempt.flag
candidate.attempt.kql.editor
candidate.attempt.scenario.steps
candidate.attempt.subjective.length
candidate.attempt.submit.confirm
candidate.attempt.timer
candidate.intro.integrity
candidate.result.bands
candidate.submit.confirm
```
