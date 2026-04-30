# Phase 1 — Author & Take Kickoff Plan

> **Generated:** 2026-05-01 by Opus 4.7 after parallel doc-discovery sweeps (3 Haiku Explore agents, one per module cluster).
> **Phase scope:** Modules `04-question-bank`, `05-assessment-lifecycle`, `06-attempt-engine`, `11-candidate-ui`, `16-help-system`.
> **Outcome:** SOC pack authored end-to-end. Admin creates question packs/levels/questions, builds an assessment, invites candidates. Candidates take the assessment with autosave + integrity signals + per-element help. No grading yet — that lands Phase 2.
> **Window:** Week 3–5 per `PROJECT_BRAIN.md` § Build phases.

This plan is the source of truth for Phase 1 across multiple VS Code sessions. Every session reads this doc as part of its Phase 0 warm-start (`CLAUDE.md` § Phase 0 reading list — Phase 1 sessions inherit the same warm-start pattern, swapping in this file).

---

## Discovery summary (consolidated)

Three Haiku discovery agents reported on 2026-05-01 against `04+05`, `06+11`, and `16 + cross-cuts`. Consolidated facts below; line citations preserved so future sessions can verify without re-reading the agents' output.

### Repo state at Phase 1 start

- **Phase 0 G0.A + G0.B fully shipped.** G0.A (`00-core` + repo bootstrap, commit `beca1f2`), G0.B-2 (`02-tenancy` tenants table + RLS isolation + middleware, commit `7923492`), G0.B-3 (`17-ui-system` Vite SPA + 8 typed components, commit `f21ac4d`) all on `main`.
- **G0.C-4 pre-flight done; implementation pending.** `modules/01-auth/SKILL.md` carries a 10-bucket "Decisions captured (2026-05-01)" addendum (commit `1cf5066`); migration filenames + schema sketches are scaffolded under `modules/01-auth/migrations/README.md`. The implementation diff (migrations, middleware, JWT verify, TOTP, sessions, embed, API keys) has NOT yet shipped — that's Window 4 still.
- **G0.C-5 not opened.** `03-users` + admin login screen has not started. Phase 1 G1.A cannot begin until G0.C-4 implementation lands (admin endpoints need `requireAuth` + `requireRole('admin')`) and G0.C-5 ships (`created_by` FKs need a real `users` table).
- **17-ui-system shipped components:** `Button`, `Card`, `Field` (`Input` + `Label` + `FieldHelp`), `Chip`, `Icon` (22 SVG paths), `Logo`, `Num` + `useCountUp`, `ThemeProvider`. **Not yet shipped:** `Tooltip`, `ScoreRing`, `Sparkline`, `QuestionNavigator`. `Tooltip` is a Phase 1 G1.A blocker for 16-help-system; the other three are Phase 2+ (`ScoreRing`/`Sparkline` need grading, `QuestionNavigator` is a Phase 1 candidate-UI internal — see Session 5).
- **No grading runtime exists.** Phase 1 is grading-free per `CLAUDE.md` rule #1 and `docs/05-ai-pipeline.md` § Phase 1. `submitAttempt` enqueues nothing — it transitions `attempts.status` to `submitted` and stops there. The result page renders a "submitted, grading pending admin review" placeholder until Phase 2 lands.

### Module contracts (extracted, not invented)

- **`04-question-bank` — depends on `00-core`, `02-tenancy`, `03-users` (created_by FK), `08-rubric-engine` (deferred), `14-audit-log` (deferred), `07-ai-grading` (deferred — only for `generateDraft()`).** Owns `question_packs`, `levels`, `questions`, `question_versions`, `tags`, `question_tags`. Per-type `questions.content` JSONB shapes for `mcq`, `subjective`, `kql`, `scenario` are documented (`docs/02-data-model.md:258–321`); `log_analysis` is declared as a valid type (`02-data-model.md:219`) but its content shape is **not documented** — see open question #3. Versioning rule: every PATCH snapshots prior `(content, rubric)` to `question_versions` BEFORE the update; `attempt_questions.question_version` freezes the snapshot at attempt-start (`SKILL.md:43–44`, `02-data-model.md:381`).
- **`05-assessment-lifecycle` — depends on `00-core`, `02-tenancy`, `03-users`, `04-question-bank`, `13-notifications` (stubbed), `14-audit-log` (deferred).** Owns `assessments`, `assessment_invitations`. State machine: `draft → published → active → closed → (terminal)` with branches to `cancelled` and `unpublish (if no invitations)` (`SKILL.md:32–50`). Reopen allowed only if before `closes_at`. Question selection at `attempt.start`: pull `(pack_id, level_id, status='active')`, slice to `question_count`, shuffle if `randomize`, snapshot `(question_id, question_version)` to `attempt_questions` (`SKILL.md:52–58`). Pre-flight pool-size check fires at `publishAssessment` time (admin time, not candidate time). UNIQUE `(assessment_id, user_id)` on `attempts` enforces one-attempt-per-candidate-per-assessment in v1 (`02-data-model.md:374`).
- **`06-attempt-engine` — depends on `00-core`, `02-tenancy`, `01-auth`, `03-users`, `05-assessment-lifecycle`, `04-question-bank`, `07-ai-grading` (Phase 2 — Phase 1 stops at `submitted`), `13-notifications` (stubbed for ack email).** Owns `attempts`, `attempt_questions`, `attempt_answers`, `attempt_events`. Public surface: `startAttempt`, `getAttemptForCandidate`, `saveAnswer`, `toggleFlag`, `recordEvent`, `submitAttempt`, `sweepStaleTimers()` (cron every 30s — non-AI BullMQ repeating job, allowed per `CLAUDE.md` rule #1). Server-authoritative timer; auto-submit on `now > ends_at`. Submit is idempotent via `attempts.status` check (`SKILL.md:51–52`). Behavioral signals captured for downstream Phase 2 archetype: `question_view`, `answer_save`, `flag`/`unflag`, `tab_blur`/`tab_focus`, `copy`/`paste`, `nav_back`, `time_milestone` (`SKILL.md:36–46`).
- **`11-candidate-ui` — depends on `17-ui-system` (shipped + needs `Tooltip` from G1.A Session 2), `16-help-system` (G1.A Session 2), `06-attempt-engine` API (G1.C), `01-auth` (G0.C).** Page tree under `/take/*` (`SKILL.md:16–26`). Embed mode (`?embed=true`): strip `<TopNav>` + `<Footer>`, postMessage-based theming and submit confirmation. Type-specific answer components: `<McqOption>`, `<SubjectiveEditor>`, `<KqlEditor>` (Monaco-based — non-trivial dep, ~3MB minified), scenario stepper. Integrity hooks **passive — never blocking**: tab visibility, copy/paste on answer fields, window resize / fullscreen exit, keystroke pauses > 30s (`SKILL.md:56–62`). Connectivity resilience: 5s debounced autosave + immediate on blur, `Reconnecting…` pill, exponential backoff, localStorage backup on hard-stale connection > 2min.
- **`16-help-system` — depends on `00-core`, `02-tenancy` (tenant-overridable content), `17-ui-system` (`Tooltip` primitive — must ship in G1.A Session 2 to unblock everything else), `13-notifications` (Phase 2 — admin notifications based on usage).** Owns `help_content` (single table). Three layers: tooltip (≤120 chars), inline note (1–2 sentences), drawer (markdown, unbounded) (`docs/07-help-system.md:13–19`). Help-ID convention: `<audience>.<area>.<page>.<element>` (`07-help-system.md:23–38`). Audience tracks: `admin`/`reviewer`/`candidate`/`all`. Default content seeded from `modules/16-help-system/content/{en}/{admin,reviewer,candidate}.yml`; tenant rows override globals at read time.

### Allowed APIs (cite-only — do not invent)

- **Question content validation:** Zod schema per `questions.type`, keyed off `02-data-model.md:258–321`. Add a Zod schema for `log_analysis` once open question #3 is resolved.
- **Assessment status enum:** Postgres native enum `assessment_status` per `02-data-model.md:327`. Use `assessment_status` in migrations, not `TEXT CHECK`.
- **Attempt status enum:** TEXT with CHECK constraint over `('in_progress','submitted','auto_submitted','abandoned','grading','graded','reviewed','released')` (`02-data-model.md:368`). Phase 1 only writes `in_progress`, `submitted`, `auto_submitted`, `abandoned` — `grading/graded/reviewed/released` are Phase 2 territory.
- **Invitation token:** `randomBytes(32).toString('base64url')` → sha256 stored in `assessment_invitations.token_hash`. Same pattern as `01-auth` magic-link tokens — re-use the helper from 01-auth's `src/tokens.ts` once it ships.
- **Help-content read merge:** at API time, fetch global default (`tenant_id IS NULL`) + tenant override (`tenant_id = current`) and prefer tenant override per `(key, locale)`. RLS policy MUST be the nullable-tenant variant — see open question #2.
- **Embed postMessage event types** (from `docs/04-auth-flows.md` if present, else from `docs/01-architecture-overview.md:120–138`): `aiq.attempt.started`, `aiq.attempt.submitted`, `aiq.height` (auto-resize), `aiq.theme` (host → AssessIQ), `aiq.locale`. Origin-pinned via `tenant.embed_origins` allowlist.

### Anti-patterns to refuse

- Any `if (domain === "soc")` branch — domain lives in `question_packs.domain` (data), not in code (`CLAUDE.md` rule #4).
- Adding a Phase 1 domain table without `tenant_id` + the two RLS policies — `tools/lint-rls-policies.ts` will reject.
- Adding the `help_content` RLS policy with the standard template — globals (`tenant_id IS NULL`) become invisible. Must use the nullable variant `tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')::uuid`.
- Importing **anything** from `modules/17-ui-system/AccessIQ_UI_Template/` at runtime (Phase 0 invariant — still applies).
- Any `claude` / `anthropic` / `@anthropic-ai/claude-agent-sdk` import. Phase 1 is grading-free; the `lint-no-ambient-claude.ts` guard will land in Phase 2 but its spirit applies now.
- Wiring `submitAttempt` to enqueue an AI grading job. Phase 1 stops at `attempts.status = 'submitted'`; Phase 2 swaps the no-op for the admin-triggered Claude Code grader.
- Filtering by `WHERE tenant_id = $1` in repositories — RLS is the enforcement layer (Phase 0 G0.B-2 invariant — still applies).
- Storing invitation tokens plaintext — only `sha256(token)` in `assessment_invitations.token_hash`.
- TOTP / fresh-MFA gates on candidate endpoints (`/me/*`, `/take/*`) — candidates skip MFA per Phase 0 G0.C-4 magic-link spec; only admin overrides require fresh MFA (Phase 2).
- Surfacing `attempt_events.payload` JSONB to candidates (or in any cross-tenant log line) — the data is for downstream behavioral scoring; treat as confidential.
- Mounting Monaco editor as a global import in `apps/web/src/main.tsx` — code-split it behind the `<KqlEditor>` component to keep the initial SPA bundle small. The Phase 0 build is 156 KB JS / 12 KB CSS gzipped 50/3 KB; an unsplit Monaco would blow that by ~10×.

---

## Decisions captured (2026-05-01)

Twelve open questions surfaced during discovery. All twenty-three rows below are now resolved as of 2026-05-01 — the four originally user-blocking decisions (#3, #4, #12, #13) were confirmed at orchestrator defaults by the user on 2026-05-01 and pinned into the relevant SKILL.md addenda + `docs/02-data-model.md` § log_analysis.

| # | Decision | Source |
| --- | --- | --- |
| 1 | **Tooltip primitive lands in G1.A Session 2.** Added to `modules/17-ui-system/src/components/Tooltip.tsx` as part of the same session that ships 16-help-system, since 16 owns the only consumer. Ports the floating-popover idiom from `AccessIQ_UI_Template/`. Storybook story added; ESLint `no-restricted-imports` continues to forbid template runtime imports. | Orchestrator default |
| 2 | **`help_content` RLS uses the nullable-tenant variant.** Migration creates `CREATE POLICY tenant_isolation ON help_content USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')::uuid);` and a parallel `tenant_isolation_insert` that only allows tenant rows (admins cannot author globals at runtime — globals come from the YAML seed). The `lint-rls-policies.ts` linter must learn to special-case `help_content` (similar to how it special-cases `tenants`). | Orchestrator default; flagged as a special-case in the linter exemption list |
| 3 | **`log_analysis` content shape — RESOLVED 2026-05-01 at orchestrator default.** Mirrors `kql` with `log_excerpt` + `log_format` (enum `syslog\|json\|csv\|freeform`) + `expected_findings: string[]` (anchor-style fuzzy match). Pinned in `docs/02-data-model.md` § "questions.content shapes by type" → "**Log_analysis**" and `modules/04-question-bank/SKILL.md` § "Decisions captured (2026-05-01)". | User confirmed orchestrator default |
| 4 | **Bulk import format — RESOLVED 2026-05-01 at orchestrator default.** Phase 1 ships JSON-only; CSV deferred to Phase 2. One file per pack with top-level `{ pack, levels, questions }`; questions reference levels by `level_position`; transactional all-or-nothing import. Schema file lives at `modules/04-question-bank/schemas/import.schema.json` (ships in G1.A Session 1). Pinned in `modules/04-question-bank/SKILL.md` § "Decisions captured (2026-05-01)" with the canonical JSON example. | User confirmed orchestrator default |
| 5 | **`assessments.settings` JSONB stays empty in Phase 1.** Schema declares the column (`02-data-model.md:341`) "for per-assessment overrides" but no overrides are needed for Phase 1 — duration/question_count/randomize live as first-class columns. Treat as a forward-compat stub; add a Zod schema `AssessmentSettingsSchema = z.object({}).passthrough()` so future overrides validate. | Orchestrator default |
| 6 | **Phase 1 `submitAttempt` stops at `submitted`.** Does not enqueue grading. The `/me/attempts/:id/result` endpoint returns `202 { status: "pending_admin_review" }` until Phase 2 wires the admin-triggered Claude Code grader (per `docs/05-ai-pipeline.md`). The `attempts.status` enum (`02-data-model.md:368`) ALREADY includes both `submitted` and `grading` — Phase 1 simply never writes `grading`. **`docs/03-api-contract.md` line ~217 must update** to show the Phase 1 response shape alongside the Phase 2 one. | Orchestrator default; api-contract.md update is part of Session 4's DoD |
| 7 | **Multi-tab autosave: last-write-wins on `(attempt_id, question_id)`.** Add `attempt_answers.client_revision` (INT, increments per save from one tab) for *visibility* but do NOT use it as a blocking optimistic-lock — too easy to UX-trap a candidate mid-attempt. Server logs a `multi_tab_conflict` event to `attempt_events` when a save arrives with a `client_revision` lower than the stored one. Phase 2 scoring can use the event count as an integrity signal. | Orchestrator default |
| 8 | **localStorage backup schema:** key `aiq:attempt:<attemptId>:answers`, value JSON `{ "answers": Record<questionId, payload>, "savedAt": isoString, "clientRevision": number }`. TTL via storage-event cleanup on submit/abandon. Documented in `docs/11-candidate-ui-resilience.md` (new doc, ships in Session 5). | Orchestrator default |
| 9 | **postMessage protocol formalized in `docs/09-integration-guide.md`** (existing doc per `PROJECT_BRAIN.md:108`). One TypeScript discriminated-union schema lives at `modules/11-candidate-ui/src/embed/postMessage-protocol.ts`, exported from the SDK in Phase 4. Events: `aiq.ready`, `aiq.attempt.started`, `aiq.attempt.submitted`, `aiq.height`, `aiq.theme`, `aiq.locale`. Schema validation on both ends. Origin pinned. | Orchestrator default |
| 10 | **Help-ID rename policy:** `help_content.key` is treated as **stable forever** once seeded. Page or element renames in code MUST keep the old `help_id` (with a code comment explaining the historical name) OR ship a paired `help_content` row migration: `INSERT new key, UPDATE references, MARK old key status='archived'` in the same PR. CI lint (deferred to Phase 2; manual review in Phase 1): grep for orphaned `helpId="..."` attributes referencing keys not in the seed YAML. Documented as an invariant in `docs/07-help-system.md` § "Help ID stability". | Orchestrator default |
| 11 | **`generateDraft()` deferred to Phase 2.** AI-assisted question generation is the only AI-touching surface in 04-question-bank's public API (`SKILL.md:35`). Phase 1 grading-free policy applies symmetrically — admins author by hand or import JSON. Public surface keeps the function signature with `throw new NotImplementedError("Phase 2: AI question generation lands with grading runtime")`. | Orchestrator default + `CLAUDE.md` rule #1 |
| 12 | **`13-notifications` Phase 1 scope — RESOLVED 2026-05-01 at orchestrator default.** Real SMTP via Hostinger relay ships in G1.B Session 3 — `nodemailer` + `tenants.smtp_config` JSONB column (additive migration), fail-closed if no config (`503 SmtpNotConfigured`). Webhook delivery still deferred to Phase 3. Pinned in `modules/05-assessment-lifecycle/SKILL.md` § "Decisions captured (2026-05-01)" with the canonical `smtp_config` JSONB shape. | User confirmed orchestrator default |
| 13 | **Bulk-import UX — RESOLVED 2026-05-01 at orchestrator default.** Phase 1 ships the API endpoint + a CLI helper (`pnpm aiq:packs:import --tenant <slug> <file>`); browser UI defers to Phase 2 (admin-dashboard, module 10). CLI wraps `bulkImport` with the `assessiq_system` BYPASSRLS role + a `withTenant` shim. Pinned in `modules/04-question-bank/SKILL.md` § "Decisions captured (2026-05-01)". | User confirmed orchestrator default |
| 14 | **`attempt_events.payload` JSONB shapes** documented per event type in a new appendix at `modules/06-attempt-engine/EVENTS.md`. Phase 1 ships at minimum `question_view {questionId}`, `answer_save {questionId, clientRevision, sizeBytes}`, `flag/unflag {questionId}`, `tab_blur/tab_focus {at}`, `copy/paste {questionId, sizeChars}`, `nav_back {fromQid, toQid}`, `time_milestone {questionId, seconds}`, `multi_tab_conflict {questionId, expectedRev, gotRev}`. Schema is internal — never returned to candidates. | Orchestrator default |
| 15 | **Behavioral-signals → archetype computation deferred** to Phase 2 (09-scoring). Phase 1 leaves `attempt_scores` table unwritten; the table itself is a Phase 2 migration. `attempt_events` rows accumulate during Phase 1 attempts and are ready for batch backfill once 09-scoring lands. | Orchestrator default; consistent with `docs/05-ai-pipeline.md` |
| 16 | **Telemetry for help usage:** Phase 1 logs `help.tooltip.shown`, `help.drawer.opened`, `help.feedback` to `audit_log` (one row per event, sampled 10% for tooltip/drawer, 100% for feedback). Dedicated `help_usage` table + dashboarding deferred to Phase 3. | Orchestrator default |
| 17 | **Locale fallback chain:** per-key fallback, not per-page. If `(key='candidate.attempt.flag', locale='hi-IN')` is missing, the read API returns the `(key='candidate.attempt.flag', locale='en')` row with `_fallback: true` in the response. Frontend can surface a "translation missing" indicator if desired. | Orchestrator default |
| 18 | **Help YAML seed timing: deploy-time SQL migration.** A migration at `modules/16-help-system/migrations/0010_seed_help_content.sql` runs `INSERT INTO help_content … ON CONFLICT (tenant_id, key, locale, version) DO NOTHING`, generated from the YAML files at build time by `tools/generate-help-seed.ts`. Idempotent. Re-running the migration after editing YAML inserts only new keys; existing keys stay frozen at v1 unless an admin re-edits via UI (then it's v2). | Orchestrator default |
| 19 | **Magic-link `/take/:token` requires pre-existing user.** Per `05-lifecycle.inviteUsers(assessmentId, userIds)`, candidates must already exist in `users` (created via 03-users `inviteUser` flow that lands in G0.C-5). JIT user creation from magic link is explicitly OUT of Phase 1 scope; defer to Phase 4 (embed) where host apps mint user records via JWT claims. | Orchestrator default + `02-data-model.md:347` (`assessment_invitations.user_id` NOT NULL) |
| 20 | **Question selection RNG:** `crypto.randomUUID()`-seeded Fisher-Yates shuffle, no playback. The shuffle is non-reproducible — if a candidate's attempt is destroyed and re-created (admin support op), the question order may differ. Acceptable trade-off; reproducibility costs more than it gains in v1. | Orchestrator default |
| 21 | **Pack publish snapshot:** `publishPack(id)` flips `question_packs.status` to `published` and writes a `question_versions` row for every question in the pack at the current `(content, rubric)`, even if no edit happened. This guarantees a permanent immutable snapshot keyed by `(question_id, version)` for the published pack version. Subsequent question edits create new `question_versions` rows but do NOT alter the published snapshot — until `publishPack` is called again, which bumps `question_packs.version` and re-snapshots. | Orchestrator default; resolves SKILL.md ambiguity |
| 22 | **Re-attempts:** `UNIQUE (assessment_id, user_id)` on `attempts` (`02-data-model.md:374`) caps Phase 1 at one attempt per candidate per assessment. v2+ may add `attempt_number` column per the SKILL.md open-question note — explicitly out of Phase 1 scope. | Orchestrator default |
| 23 | **Browser API event-volume cap on `attempt_events`:** server-side rate limit of 10 events/sec per attempt; bursts above the cap are dropped (no error to client to avoid leaking the rate logic). Per-attempt total cap: 5000 events; further events ignored with a single `event_volume_capped` event recorded once per attempt. Protects `attempt_events` from keystroke-storm flooding. | Orchestrator default |

### User-blocking questions

**RESOLVED 2026-05-01.** All four user-blocking decisions confirmed at orchestrator defaults by the user. The "decisions captured" PR (commit landed alongside this update) pins:

- `docs/02-data-model.md` — adds the **Log_analysis** content shape (decision #3) after the Scenario block in § "questions.content shapes by type".
- `modules/04-question-bank/SKILL.md` — appends `## Decisions captured (2026-05-01)` covering decisions #3 (log_analysis), #4 + #13 (bulk import format + CLI UX), #11 (`generateDraft` deferred), #21 (publish snapshot semantics).
- `modules/05-assessment-lifecycle/SKILL.md` — appends `## Decisions captured (2026-05-01)` covering decision #12 (real SMTP via Hostinger relay + `tenants.smtp_config` JSONB column) plus baked-in #5/#19/#20/#22.

G1.A opens once the two outstanding Phase 0 predecessors land: G0.C-4 `01-auth` implementation and G0.C-5 `03-users` + admin login screen.

---

## Session plan

Five sessions across four serial groups: **G1.A** (two parallel sessions, blocking), **G1.B** (one session), **G1.C** (one session), **G1.D** (one session). Each session is a separate VS Code window with a fresh Claude conversation.

```
G1.A (parallel) ──▶ G1.B ──▶ G1.C ──▶ G1.D
   ├─ S1: 04             S3: 05      S4: 06   S5: 11
   └─ S2: 16+Tooltip
```

### Group G1.A — Foundations (parallel, blocks the chain)

#### Session 1 — `04-question-bank`

##### What to implement

1. **Migrations** at `modules/04-question-bank/migrations/`:
   - `0010_question_packs.sql` — `question_packs` + indexes per `02-data-model.md:188–201`. RLS via the standard template.
   - `0011_levels.sql` — `levels` table per `02-data-model.md:203–213`. No `tenant_id` (denormalized via `pack_id` FK); RLS via JOIN-based USING clause `EXISTS (SELECT 1 FROM question_packs p WHERE p.id = levels.pack_id AND p.tenant_id = current_setting('app.current_tenant')::uuid)`. **Update `lint-rls-policies.ts` to recognize the JOIN-based variant** for tables that derive tenancy through a parent FK — add `levels`, `attempt_questions`, `attempt_answers`, `attempt_events` to the exemption-with-alternative-policy list.
   - `0012_questions.sql` — `questions` + index `questions_pack_level_idx` per `02-data-model.md:230`. RLS via JOIN through `question_packs`.
   - `0013_question_versions.sql` — `question_versions` table per `02-data-model.md:232–241`. RLS via JOIN through `questions → question_packs`.
   - `0014_tags.sql` — `tags` + `question_tags` per `02-data-model.md:243–255`. `tags` has direct `tenant_id` + standard RLS; `question_tags` uses JOIN-based RLS through `questions`.
2. **`modules/04-question-bank/src/`**:
   - `types.ts` — Zod schemas for every `questions.content` shape (`mcq`, `subjective`, `kql`, `scenario`, `log_analysis` once decision #3 lands), `RubricSchema` for the subjective/scenario rubric column.
   - `repository.ts` — pg queries via the tenancy middleware's `req.db`; no `WHERE tenant_id = $1` clauses. Queries cover: pack CRUD, level CRUD, question CRUD with version snapshot in a transaction, version listing, restore.
   - `service.ts` — orchestrates business rules: `publishPack` snapshots all questions to `question_versions` + bumps `question_packs.version`; `archivePack` only allowed when no `assessments` reference the pack at `published`/`active`; `updateQuestion` opens a transaction, writes the previous `(content, rubric)` to `question_versions`, then UPDATEs `questions`; `bulkImport(buffer, 'json')` validates against the importer JSON schema, runs in a single transaction with all-or-nothing semantics.
   - `routes.ts` — Fastify plugin registering every endpoint from the Phase 1 endpoint catalog (Module 04 section). Each route attaches `requireAuth` + `requireRole('admin')` middleware from 01-auth.
   - `index.ts` — public barrel: `routes`, `service` types, `bulkImport` for the CLI.
   - `__tests__/` — vitest with testcontainers Postgres: pack lifecycle, version snapshot integrity (PATCH n times → n−1 version rows), publish snapshot (every question gets a row even if unchanged), JSON bulk-import happy path + validation rejection, RLS isolation (cross-tenant pack invisible), JOIN-RLS for `levels`.
3. **CLI helper** at `tools/aiq-import-pack.ts` — wraps `bulkImport`, takes a tenant slug + JSON file path, invokes the service through a one-off pg client. Used by admins until the Phase 2 admin UI ships.
4. **Default SOC pack JSON** at `packs/soc-skills-2026q2.json` — the actual Phase 1 deliverable content. **Out of scope for the code session** — content authoring is the user's job; the code session ships the schema + importer + a tiny `examples/sample-pack.json` smoke fixture.

##### Documentation references

- `modules/04-question-bank/SKILL.md` — full contract.
- `docs/02-data-model.md:188–321` — schema + content shapes.
- `docs/03-api-contract.md:51–66` — endpoint shapes + worked examples (`:155–187`).
- Decisions captured #3, #4, #11, #21.

##### Verification checklist

- [ ] All five migrations apply cleanly to a fresh Postgres 16; `lint-rls-policies.ts` passes (with JOIN-based-variant exemptions added).
- [ ] Vitest suite green; coverage ≥ 90% on `service.ts` (versioning logic is the trap).
- [ ] Cross-tenant RLS test: tenant A creates a pack; as tenant B, `listPacks()` returns zero rows.
- [ ] Publish snapshot: pack with 12 questions; `publishPack(id)` produces 12 new `question_versions` rows; subsequent edit → 13 rows; second `publishPack(id)` → 24 rows total + `question_packs.version=2`.
- [ ] `bulkImport` happy path: `tools/aiq-import-pack.ts examples/sample-pack.json` produces N packs/levels/questions; rerun is idempotent (UNIQUE constraint violation on `(tenant_id, slug, version)` → caller-friendly error).
- [ ] `bulkImport` rejection: malformed JSON → `ValidationError` from `00-core`; partial-import never lands (transaction rollback verified via `SELECT count(*)` before/after).
- [ ] `generateDraft()` throws `NotImplementedError` with the Phase 2 deferral message.
- [ ] `grep -r "claude\|anthropic" modules/04-question-bank/src/` returns zero hits.

##### Anti-pattern guards

- No `WHERE tenant_id = $1` in repositories — RLS is the enforcement.
- No `console.log`; use `00-core/logger`.
- Don't snapshot `question_versions` outside a transaction — a partial write leaves the version log lying.
- Don't run `publishPack` if any question's rubric fails Zod validation — fail closed at publish time.
- Don't allow PATCH on a question whose pack is `archived` — validate at the service layer.
- Don't import Monaco from this module (UI concern, lives in 11-candidate-ui).
- Don't add `if (domain === 'soc')` — domain comparisons happen against `question_packs.domain` data only.

##### DoD

1. **Pre-commit:** Phase 2 deterministic gates (tests, secrets-scan, RLS linter with the new JOIN-variant exemptions, TODO/FIXME count). **Phase 3:** Opus reviews the diff. `04-question-bank` is **not** in `CLAUDE.md`'s load-bearing path list — `codex:rescue` is judgment-call, not mandatory. Recommend: invoke `codex:rescue` once on the migration + service combo because of the version-snapshot transaction logic (a bug here corrupts the canonical history of every question).
2. Commit `feat(question-bank): packs + levels + questions + versioning + json import`. Noreply env-var pattern.
3. Deploy: additive — apply migrations, restart `assessiq-api` to load the new routes. Smoke: `curl -H "Cookie: aiq_sess=..." https://assessiq.automateedge.cloud/api/admin/packs` returns `{ items: [], page: 1, ... }`.
4. Document: `docs/02-data-model.md` Status fields → live for `question_packs`/`levels`/`questions`/`question_versions`/`tags`/`question_tags`; add the `log_analysis` content shape (decision #3); `docs/03-api-contract.md` confirms shipped Module-04 endpoints; `modules/04-question-bank/SKILL.md` resolves the open questions baked in (#3, #4, #11, #21); add `docs/02-data-model.md` § "JOIN-based RLS for child tables" appendix documenting the new lint-policy variant.
5. Handoff: SESSION_STATE entry.

---

#### Session 2 — `16-help-system` + `Tooltip` for `17-ui-system`

##### What to implement

1. **`Tooltip` primitive in `modules/17-ui-system/src/components/Tooltip.tsx`** — floating popover, 200ms delay, dismisses on blur, keyboard-accessible (Tab to trigger, Enter/Space opens, Escape closes). Pure CSS positioning where possible; floating-ui as a dep if absolutely needed (small, tree-shakeable). Storybook story demonstrating top/bottom/left/right placements + truncated text. Re-uses the `--aiq-*` token namespace (no new tokens). **No template runtime imports.**
2. **Migration** `modules/16-help-system/migrations/0010_help_content.sql` — `help_content` table per `02-data-model.md:516–528`. RLS uses the **nullable-tenant variant** (decision #2):
   ```sql
   ALTER TABLE help_content ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON help_content
     USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')::uuid);
   CREATE POLICY tenant_isolation_insert ON help_content
     FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
   ```
   `lint-rls-policies.ts` exemption added for `help_content`.
3. **Migration `0011_seed_help_content.sql`** — generated by `tools/generate-help-seed.ts` from `modules/16-help-system/content/en/{admin,reviewer,candidate}.yml`. Idempotent: `ON CONFLICT (tenant_id, key, locale, version) DO NOTHING`.
4. **`tools/generate-help-seed.ts`** — reads YAML, validates against `HelpEntrySchema` (Zod), emits the SQL migration. Run as part of CI on every YAML edit; commits the regenerated SQL.
5. **`modules/16-help-system/content/en/{admin,reviewer,candidate}.yml`** — seed the 22 help_ids extracted from the four module SKILLs (catalog in the discovery report; full list in the appendix below). Each entry: `short_text` (≤120 chars), `long_md` (markdown, optional), `related_keys` (optional). Copy must be production-quality — this is the user-facing default.
6. **`modules/16-help-system/src/`**:
   - `types.ts` — `HelpEntrySchema` Zod, audience union, locale string.
   - `repository.ts` — `getHelpForPage(page, audience, locale)` returns merged global+tenant rows preferring tenant override per `(key, locale)` with locale fallback per decision #17; `getHelpKey(key, locale)` single-key variant; `upsertHelp(key, audience, locale, ...)` admin write that bumps `version`.
   - `service.ts` — wraps repository + telemetry emit (logs `help.tooltip.shown` etc to `audit_log`).
   - `routes.public.ts` — `GET /help/:key` (anonymous, for embed candidate UI).
   - `routes.auth.ts` — `GET /api/help`, `GET /api/help/:key` (cookie-auth, any role).
   - `routes.admin.ts` — `PATCH /api/admin/help/:key`, `GET /api/admin/help/export`, `POST /api/admin/help/import` (admin-only).
   - `index.ts` — public barrel.
7. **React components in `modules/16-help-system/components/`**:
   - `HelpProvider.tsx` — context, fetches `/api/help?page=...&audience=...&locale=...` once on mount, caches in memory + localStorage (TTL 1h), exposes `useHelp(key)`.
   - `HelpTip.tsx` — wraps children with `<Tooltip>` (from 17-ui-system), shows `(?)` icon, hover/focus pops `short_text`, click on icon emits `openDrawer(key)` event.
   - `HelpDrawer.tsx` — right-side drawer (480px), markdown rendering with safe HTML, anchor scroll to key, 👍/👎 feedback buttons.
   - `HelpDrawerTrigger.tsx` — `(?)` icon for page header + `Cmd/Ctrl+/` keyboard handler.
8. **Admin authoring UI** — defer to Phase 2 admin-dashboard module (per CLAUDE.md routing). Phase 1 admins author via direct `PATCH /api/admin/help/:key` calls (curl/Postman) or by editing the YAML and redeploying. Document this in the handoff.
9. **`__tests__/`** — vitest: RLS nullable-tenant test (global rows visible across tenants, tenant overrides preferred at read), seed migration idempotency, locale fallback returns `_fallback: true`, `upsertHelp` bumps version, `useHelp` hook returns `shortText` and `openDrawer` callback.

##### Documentation references

- `modules/16-help-system/SKILL.md` — public surface.
- `docs/07-help-system.md` — full architecture, three layers, audience tracks, YAML format, telemetry.
- `docs/02-data-model.md:516–528` — `help_content` schema.
- `docs/03-api-contract.md:121–124, 151` — endpoint catalog.
- Decisions captured #1, #2, #10, #16, #17, #18.

##### Verification checklist

- [ ] `Tooltip` renders in Storybook with all 4 placements; keyboard shortcuts work; Storybook visual smoke green.
- [ ] Migration applies cleanly; `lint-rls-policies.ts` passes (with `help_content` exemption).
- [ ] Seed migration loads 22 help_ids into `help_content` with `tenant_id IS NULL`. Re-running is a no-op.
- [ ] RLS visibility test: tenant A and tenant B both `SELECT *` from `help_content` and see all 22 globals; tenant A creates an override for `admin.assessments.create.duration`; tenant A sees the override (preferred), tenant B sees the global.
- [ ] Locale fallback: request `(key='candidate.attempt.flag', locale='hi-IN')` returns the `en` row with `_fallback: true`.
- [ ] `<HelpProvider>` mount triggers exactly one `/api/help?page=...` fetch (not per `<HelpTip>`); subsequent mounts within 1h hit localStorage.
- [ ] `<HelpTip>` keyboard: Tab to icon, Enter opens drawer, Escape closes drawer.
- [ ] Telemetry: hovering a tooltip writes a sampled `help.tooltip.shown` row to `audit_log` (~10% sample rate verified statistically over 100 hovers).
- [ ] No `AccessIQ_UI_Template/` runtime import in `Tooltip.tsx` or anywhere in `modules/16-help-system/`.
- [ ] `pnpm --filter @assessiq/web build` still under 200 KB JS gzipped (Tooltip + help components shouldn't blow the budget).

##### Anti-pattern guards

- Don't ship `help_content` with the standard RLS template — globals become invisible. Use the nullable-tenant variant (decision #2).
- Don't allow admins to write rows with `tenant_id IS NULL` at runtime — globals come from the YAML seed only. Insert policy enforces this.
- Don't import `AccessIQ_UI_Template/*` anywhere in `Tooltip.tsx` or help components — port the floating-popover idiom by hand.
- Don't fetch `/api/help/:key` per `<HelpTip>` — `<HelpProvider>` does one batched fetch per page.
- Don't render markdown without sanitization — use a tested sanitizer (DOMPurify or remark-rehype with safe defaults). Help content is admin-authored but should still pass through a sanitizer for tenant-override defense-in-depth.
- Don't gate the public `GET /help/:key` behind cookie auth — it's anonymous for embed candidate UI.
- Don't log `long_md` content at INFO level — admins may paste sensitive screenshots/URLs into help content.

##### DoD

1. **Pre-commit:** Phase 2 gates pass; **Phase 3:** Opus reviews the RLS migration + service merge logic carefully (tenant override correctness is the trap). `16-help-system` is not load-bearing per `CLAUDE.md`; `codex:rescue` is judgment-call. Recommend: skip rescue (read-only data path, no auth/PII concern) unless the diff exposes a non-obvious surface.
2. Commit `feat(help): help_content + tooltip primitive + provider + seed pipeline`. Noreply env-var pattern.
3. Deploy: additive — apply migrations, restart `assessiq-api`. Smoke: `curl https://assessiq.automateedge.cloud/help/candidate.attempt.flag` returns the seed `short_text`.
4. Document: `docs/02-data-model.md` Status: live for `help_content`; `docs/03-api-contract.md` confirms shipped help endpoints; `docs/07-help-system.md` Status fields → live, add § "Help ID stability" (decision #10), § "Locale fallback" (decision #17), § "Telemetry sample rates" (decision #16); `modules/16-help-system/SKILL.md` resolves decisions #1, #2, #10, #16, #17, #18; `docs/08-ui-system.md` adds `Tooltip` to the shipped-components list.
5. Handoff: SESSION_STATE entry.

---

### Group G1.B — Lifecycle (after G1.A merges)

#### Session 3 — `05-assessment-lifecycle`

##### What to implement

1. **Migrations** at `modules/05-assessment-lifecycle/migrations/`:
   - `0020_assessment_status_enum.sql` — `CREATE TYPE assessment_status AS ENUM (...)` per `02-data-model.md:327`.
   - `0021_assessments.sql` — `assessments` per `02-data-model.md:329–345`. Standard RLS template.
   - `0022_assessment_invitations.sql` — `assessment_invitations` per `02-data-model.md:347–357`. JOIN-based RLS through `assessments`.
2. **`modules/05-assessment-lifecycle/src/`**:
   - `types.ts` — Zod schemas for `assessments.settings` (`AssessmentSettingsSchema` per decision #5), invitation status enum, `AssessmentStateMachine` types.
   - `state-machine.ts` — pure functions encoding the state diagram: `canTransition(from, to)`, `nextStateOnTimeBoundary(now, assessment)` (returns `'active'` if `published` and `now >= opens_at`, `'closed'` if `active` and `now >= closes_at`, else current). Unit-tested exhaustively; this is the trap surface.
   - `repository.ts` — pg queries through the tenancy middleware. No `WHERE tenant_id = $1`.
   - `service.ts` — public surface from SKILL.md: `listAssessments`, `createAssessment`, `publishAssessment` (calls `state-machine.canTransition` and the pre-flight pool-size check from 04 — query `questions WHERE pack_id=? AND level_id=? AND status='active'` and confirm count ≥ `assessments.question_count`), `closeAssessment`, `reopenAssessment` (rejects if `now > closes_at`), `inviteUsers`, `listInvitations`, `revokeInvitation`, `previewAssessment`.
   - `tokens.ts` — invitation token generation. Re-uses 01-auth's helper if exported; else re-implements `randomBytes(32).toString('base64url')` + `sha256`.
   - `boundaries.ts` — BullMQ repeating job (every 60s) that scans `assessments WHERE status='published' AND opens_at <= now()` → bulk UPDATE to `active`; same for `active → closed` on `closes_at`. Idempotent.
   - `email.ts` — invitation email rendering. Calls 13-notifications interface (decision #12 — if user picks SMTP, real send; if stubbed, logs to `/var/log/assessiq/dev-emails.log`).
   - `routes.ts` — Fastify plugin for every Module-05 endpoint with `requireAuth` + `requireRole('admin')`.
   - `index.ts` — public barrel.
   - `__tests__/` — vitest with testcontainers: state machine exhaustive transition tests, pool-size check rejects publish when pool < count, invitation token cannot be replayed (UNIQUE on `token_hash`), revoke marks status `expired` and cannot be re-accepted, BullMQ boundary job advances states correctly across the time boundary.
3. **Help-content YAML additions** for `admin.assessments.*` keys — already seeded in G1.A Session 2; this session verifies they render correctly in the admin UI placeholder pages and adjusts copy if needed.

##### Documentation references

- `modules/05-assessment-lifecycle/SKILL.md` — full contract + state diagram.
- `docs/02-data-model.md:324–357` — schema.
- `docs/03-api-contract.md:68–78` — endpoint catalog + worked example (`:155–187`).
- `modules/04-question-bank/SKILL.md` — pool-size pre-flight reference.
- Decisions #5, #6, #12, #19, #20, #22.

##### Verification checklist

- [ ] All migrations apply; `lint-rls-policies.ts` passes (JOIN-RLS for `assessment_invitations`).
- [ ] State machine: every illegal transition (`closed → draft`, `cancelled → published`, etc.) rejected with `ValidationError`.
- [ ] Pre-flight pool-size: pack with 5 active questions, assessment with `question_count=12`, `publishAssessment` → `ValidationError("Question pool too small: 5 < 12")`.
- [ ] BullMQ boundary job: assessment `published` with `opens_at` 5min in past → after one cron tick (60s), status is `active`. Same for `active → closed`.
- [ ] Reopen reject: assessment `closed` with `closes_at` 1h in past → `reopenAssessment` returns `ValidationError`.
- [ ] Invitation flow: `inviteUsers(assessmentId, [u1, u2])` → 2 rows in `assessment_invitations` with status `pending`; revoking one → status `expired`, re-`inviteUsers(assessmentId, [u1])` → UNIQUE violation friendly error.
- [ ] Cross-tenant RLS: tenant A's assessment invisible to tenant B's `listAssessments`.
- [ ] Email send (decision #12): if SMTP wired, an actual email lands in the test mailbox; if stubbed, `dev-emails.log` has the rendered template.
- [ ] No `if (domain === 'soc')` anywhere in `05-assessment-lifecycle/src/`.

##### Anti-pattern guards

- Don't allow `closeAssessment` on a `draft` assessment — illegal transition; throws.
- Don't snapshot the question set in `inviteUsers` — snapshot happens at `attempt.start` (06's territory).
- Don't store invitation tokens plaintext — sha256 only.
- Don't email candidates from the application code without going through the 13-notifications stub — audit-log requires a single chokepoint.
- Don't update `assessment_status` directly via SQL UPDATE outside the service — the state machine + audit hook lives in `service.ts`.
- Don't run the BullMQ boundary job as a regular queue worker — it's a repeating job; misconfiguring it as a regular queue causes time-drift and missed boundaries.

##### DoD

1. **Pre-commit:** Phase 2 gates pass; **Phase 3:** Opus reviews diff. `05-assessment-lifecycle` is not load-bearing per `CLAUDE.md`; `codex:rescue` judgment-call. Recommend: invoke once on the state-machine + boundary-cron combo (state corruption is the trap).
2. Commit `feat(lifecycle): assessments + invitations + state machine + boundary cron`. Noreply env-var pattern.
3. Deploy: additive — apply migrations, restart `assessiq-api`, restart `assessiq-worker` to pick up the BullMQ boundary repeating job. Smoke: create + publish + invite a 2-user cohort end-to-end via `curl`.
4. Document: `docs/02-data-model.md` Status: live for `assessments`/`assessment_invitations`; `docs/03-api-contract.md` Module-05 endpoints confirmed; `modules/05-assessment-lifecycle/SKILL.md` resolves decisions #5, #19, #20, #22; `docs/04-auth-flows.md` confirms invitation-token flow shape (decision #12 outcome documented).
5. Handoff: SESSION_STATE entry.

---

### Group G1.C — Engine (after G1.B merges)

#### Session 4 — `06-attempt-engine`

##### What to implement

1. **Migrations** at `modules/06-attempt-engine/migrations/`:
   - `0030_attempts.sql` — `attempts` per `02-data-model.md:362–375`. Standard RLS template + `UNIQUE (assessment_id, user_id)`.
   - `0031_attempt_questions.sql` — `attempt_questions` per `02-data-model.md:377–383`. JOIN-based RLS through `attempts`.
   - `0032_attempt_answers.sql` — `attempt_answers` per `02-data-model.md:385–394` + `client_revision INT NOT NULL DEFAULT 0` column (decision #7). JOIN-based RLS.
   - `0033_attempt_events.sql` — `attempt_events` per `02-data-model.md:396–404`. JOIN-based RLS. Index `attempt_events (attempt_id, at)` + new partial index `attempt_events (attempt_id) WHERE event_type = 'event_volume_capped'` for the cap-once invariant.
2. **`modules/06-attempt-engine/src/`**:
   - `types.ts` — Zod schemas for every `attempt_events.payload` shape (decision #14), `AnswerPayload` union per `questions.type`.
   - `repository.ts` — pg queries through tenancy middleware. No `WHERE tenant_id = $1`.
   - `service.ts` — full public surface from SKILL.md.
     - `startAttempt` — guards: assessment is `active`, invitation is `pending` (or magic-link token validates), no existing attempt for `(assessment_id, user_id)`. Inside a transaction: insert `attempts`, snapshot question pool to `attempt_questions` (Fisher-Yates per decision #20), insert empty `attempt_answers` rows, mark invitation `started`. Returns `Attempt` + `endsAt` derived from `started_at + level.duration_minutes`.
     - `getAttemptForCandidate` — returns `{attempt, questions[], remainingSeconds}` where `questions` are the frozen `(content, rubric)` joined from `question_versions`. Server computes `remainingSeconds` from `ends_at - now()`. If `now > ends_at` and status is `in_progress`, transitions to `auto_submitted` and returns the post-submit shape.
     - `saveAnswer` — last-write-wins on `(attempt_id, question_id)` (decision #7). Increments `client_revision` to MAX(stored, incoming)+1. If `incoming < stored`, log a `multi_tab_conflict` event but accept the write.
     - `toggleFlag`, `recordEvent` — straightforward; `recordEvent` enforces the rate cap (decision #23) via Redis token bucket keyed `aiq:attempt:<attemptId>:events`.
     - `submitAttempt` — idempotent via status check (decision per SKILL.md:51–52). Transitions `in_progress → submitted`. **Phase 1: does not enqueue grading** (decision #6); Phase 2 will swap the no-op for the admin-grader trigger.
     - `sweepStaleTimers` — BullMQ repeating job, every 30s, scans `attempts WHERE status='in_progress' AND ends_at < now()`, bulk-transitions to `auto_submitted`. Records a `time_milestone` event with `{questionId: null, seconds: ends_at - started_at, kind: 'auto_submit'}`.
   - `routes.candidate.ts` — Fastify plugin for `GET /me/assessments`, `POST /me/assessments/:id/start`, `GET /me/attempts/:id`, `POST /me/attempts/:id/answer`, `POST /me/attempts/:id/flag`, `POST /me/attempts/:id/event`, `POST /me/attempts/:id/submit`, `GET /me/attempts/:id/result`. All require candidate session (`requireAuth` with role `candidate` allowed).
   - `routes.magic-link.ts` — `GET /take/:token`, `POST /take/start` per `03-api-contract.md:33–34`. Uses 01-auth's magic-link helper to mint the candidate session.
   - `routes.embed.ts` — `GET /embed?token=<JWT>`, `GET /embed/health`. Uses 01-auth's embed-JWT verifier + `embed_secrets`. **Algorithm whitelist `["HS256"]` is non-negotiable** (Phase 0 G0.C-4 invariant).
   - `index.ts` — public barrel.
   - `__tests__/` — vitest with testcontainers Postgres + Redis: startAttempt happy path + double-start rejection, frozen-question integrity (admin edits question after attempt start; candidate sees old version), autosave last-write-wins + multi_tab_conflict event, rate cap drops events above 10/sec, idempotent submit (call twice, single status transition), sweepStaleTimers auto-submits past-ends_at attempts.
3. **EVENTS appendix** at `modules/06-attempt-engine/EVENTS.md` — documents every event_type and its payload schema (decision #14). Linked from SKILL.md.

##### Documentation references

- `modules/06-attempt-engine/SKILL.md` — full contract.
- `docs/02-data-model.md:360–404` — schema.
- `docs/03-api-contract.md:33–34, 125–143` — endpoint catalog + worked example (`:190–224`).
- `docs/01-architecture-overview.md:93–138` — data flow + embed flow.
- `docs/05-ai-pipeline.md` — Phase 1 grading-free invariant (decision #6).
- Decisions #6, #7, #14, #15, #19, #20, #23.

##### Verification checklist

- [ ] All migrations apply; `lint-rls-policies.ts` passes (JOIN-RLS for `attempt_questions`/`attempt_answers`/`attempt_events`).
- [ ] startAttempt: happy path creates `attempts` + `attempt_questions` + empty `attempt_answers` rows in one transaction.
- [ ] startAttempt: second call for same `(assessment_id, user_id)` returns the existing attempt (idempotent), does NOT duplicate.
- [ ] Frozen version: admin PATCHes a question after attempt start → `getAttemptForCandidate` returns the old `(content, rubric)` from `question_versions`.
- [ ] Multi-tab autosave: two saves with `client_revision=1` then `client_revision=0` → both accepted (last-write-wins), `multi_tab_conflict` event recorded for the second.
- [ ] Rate cap: 100 `recordEvent` calls in 1 second → 10 stored, 89 dropped silently, 1 `event_volume_capped` event recorded once per attempt.
- [ ] Submit idempotency: `submitAttempt` twice → single status transition `in_progress → submitted`, second call returns current state.
- [ ] Phase 1 grading-free: `submitAttempt` does NOT call any grading enqueue; `submitted` status is terminal until Phase 2.
- [ ] sweepStaleTimers: attempt with `ends_at` 1min in past → next 30s tick transitions to `auto_submitted`.
- [ ] Magic-link: `GET /take/<valid_token>` returns 200 with assessment intro; `POST /take/start` mints candidate session and creates attempt; replay of same token after `start` rejected.
- [ ] Embed JWT: `alg:none` token rejected; HS256 token with valid signature accepted; modified payload rejected; replayed `jti` rejected (Redis cache).
- [ ] Cross-tenant RLS: tenant A's attempt invisible to tenant B (even via `attempt_events` JOIN bypass attempt).
- [ ] No `claude` / `anthropic` / `claude-agent-sdk` import.

##### Anti-pattern guards

- Don't snapshot questions outside the `startAttempt` transaction — partial snapshot leaves the attempt unrecoverable.
- Don't write `attempt_answers` after `attempts.status` becomes `submitted`/`auto_submitted` — server must reject.
- Don't reveal `attempt_events` to candidates — internal observability only.
- Don't compute `remainingSeconds` on the client and trust it — server is authority.
- Don't enqueue an AI grading job in `submitAttempt` — Phase 1 is grading-free (decision #6).
- Don't run `sweepStaleTimers` as a regular BullMQ worker — it's a repeating job; misconfiguration will cause time-drift.
- Don't omit the embed JWT algorithm whitelist — `algorithms: ["HS256"]` non-negotiable.
- Don't log full embed JWTs — sha256 prefix only.
- Don't store more than 5000 events per attempt — the cap protects `attempt_events` from keystroke-storm flooding.
- Don't add `if (domain === 'soc')` — domain decisions belong in pack/level data.

##### DoD

1. **Pre-commit:** Phase 2 gates pass. **Phase 3:** Opus reviews diff line-by-line — this is the largest single Phase 1 surface. **codex:rescue mandatory** — `06-attempt-engine` touches embed JWT verification + magic-link sessions (delegated from 01-auth) + multi-tab concurrency + RLS via JOIN. While not in `CLAUDE.md`'s explicit load-bearing list, the embed-JWT and magic-link surfaces are security-adjacent enough to warrant rescue. Log verdict in handoff.
2. Commit `feat(attempt-engine): start + autosave + integrity events + magic-link + embed`. Noreply env-var pattern.
3. Deploy: additive — apply migrations, restart `assessiq-api` + `assessiq-worker` (sweepStaleTimers cron). Smoke: real candidate magic-link → start → save 3 answers → submit → result page shows "pending admin review".
4. Document: `docs/02-data-model.md` Status: live for `attempts`/`attempt_questions`/`attempt_answers`/`attempt_events`; `docs/03-api-contract.md` Module-06 endpoints confirmed (especially the Phase 1 vs Phase 2 result shape per decision #6); `docs/05-ai-pipeline.md` confirms Phase 1 stops at `submitted`; `modules/06-attempt-engine/SKILL.md` resolves decisions #6, #7, #14, #19, #20, #23; `modules/06-attempt-engine/EVENTS.md` ships as the canonical event-shape reference.
5. Handoff: SESSION_STATE entry with **codex:rescue verdict line in the agent-utilization footer**.

---

### Group G1.D — Candidate experience (after G1.C merges)

#### Session 5 — `11-candidate-ui`

##### What to implement

1. **Routes in `apps/web/src/pages/take/`** mirroring the SKILL.md page tree:
   - `/take/:invitationToken` — landing; calls `POST /api/take/start`.
   - `/take/a/:attemptId/intro` — assessment overview + integrity rules + "Begin" button.
   - `/take/a/:attemptId/q/:qid` — question runner.
   - `/take/a/:attemptId/review` — review screen.
   - `/take/a/:attemptId/submit` — submit confirmation modal.
   - `/take/a/:attemptId/done` — "submitted, results in N minutes" pending state. **Phase 1: this is the terminal state** — no result page until Phase 2.
   - `/take/a/:attemptId/result` — result page, hidden behind a `assessments.status === 'released'` check that always returns false in Phase 1. Renders a "results pending admin review" placeholder.
2. **Components** in `modules/11-candidate-ui/src/`:
   - `<AttemptShell>` — top bar (topic chip, "Question N of M", timer, help icon), main pane, footer (Flag, Prev/Next). Embed mode strips topbar/footer per decision #9.
   - `<QuestionRunner>` — orchestrator that switches on `question.type` and renders the matching answer component.
   - `<McqOption>` — radio cards per `11-candidate-ui/SKILL.md:51`.
   - `<SubjectiveEditor>` — autosaving textarea + word count + 5s debounced save + immediate-on-blur save.
   - `<KqlEditor>` — Monaco-based, lazy-imported via `React.lazy` to keep initial bundle small. KQL keyword highlighting (basic — full KQL grammar deferred), tab indent, escape exits to next focus, no execution.
   - `<ScenarioRunner>` — stepper + per-step answer component (recurses into MCQ/Subjective/KQL).
   - `<QuestionNavigator>` — side panel grid (12 squares colored by status). Ports the layout idiom from `AccessIQ_UI_Template/screens/` without runtime import.
   - `<TimerBar>` — server-authoritative; receives `endsAt` from API + ticks locally, every 30s polls server for drift correction.
   - `<IntegrityListener>` — non-rendering; attaches `visibilitychange`, `clipboardchange`, `fullscreenchange`, `resize`, `keydown`-debounced listeners; throttles to ≤ 10 events/sec per decision #23; calls `POST /me/attempts/:id/event` for each.
   - `<ConnectivityBanner>` — `Reconnecting…` pill on save failure; full-banner reload prompt on hard-stale > 2min.
   - `<HelpTip>` and `<HelpProvider>` consumed from G1.A Session 2.
3. **Resilience layer** at `modules/11-candidate-ui/src/resilience/`:
   - `localStorage-backup.ts` — write the schema from decision #8 on every save.
   - `retry-queue.ts` — exponential backoff (1s, 2s, 4s, ..., capped at 30s).
   - `tab-visibility-warning.ts` — the multi-tab open detection (BroadcastChannel API): if another tab opens with the same `attemptId`, show a banner advising to close one. (Doesn't *prevent* multi-tab — decision #7 — just warns.)
4. **Embed mode** — `apps/web/src/pages/embed/` mounting the same `<AttemptShell>` wrapped in an `<EmbedRoot>` that:
   - Skips top nav and footer.
   - Wires postMessage protocol (decision #9 — schema in `modules/11-candidate-ui/src/embed/postMessage-protocol.ts`).
   - Listens for `aiq.theme` to apply tenant override at runtime.
   - On submit, posts `aiq.attempt.submitted` to parent + shows inline confirmation.
5. **Help-content YAML additions** — verify `candidate.*` keys (already seeded G1.A Session 2) render correctly in the candidate UI flows. Adjust copy if needed.
6. **`modules/11-candidate-ui/RESILIENCE.md`** — new doc per decision #8, documents localStorage backup schema + multi-tab semantics. Linked from SKILL.md.
7. **E2E tests** — Playwright. Critical paths: full happy path (magic-link → intro → answer 12 questions → review → submit → done page); auto-submit on timer expiry; reconnection after simulated network drop; embed mode with mocked parent window.

##### Documentation references

- `modules/11-candidate-ui/SKILL.md` — full page tree + component spec + integrity hooks.
- `modules/06-attempt-engine/SKILL.md` — API consumed.
- `docs/03-api-contract.md:33–34, 125–143` — candidate + embed endpoints + Phase 1 result-pending shape (decision #6).
- `docs/01-architecture-overview.md:120–138` — embed flow.
- `docs/08-ui-system.md` — UI primitives + density mechanic.
- `docs/10-branding-guideline.md` — visual invariants (pill buttons, no card shadow, serif tabular-nums, etc.).
- Decisions #6, #7, #8, #9, #15.

##### Verification checklist

- [ ] Playwright E2E happy path green: magic-link → intro → 12 questions → review → submit → `/done` shows "pending admin review".
- [ ] Auto-submit on timer expiry: Playwright fast-forwards `Date.now()` past `endsAt` → server transitions, UI redirects to `/done`.
- [ ] Reconnection: simulated `offline` event → save fails → `Reconnecting…` pill appears → `online` event → queue drains → pill clears.
- [ ] Multi-tab warning: second tab on same `attemptId` → banner shown via BroadcastChannel.
- [ ] localStorage backup: hard-stale (>2min) → reload preserves answers from `aiq:attempt:<id>:answers` key.
- [ ] Embed mode: `?embed=true` strips top nav and footer; `aiq.attempt.submitted` postMessage fires on submit; origin pinned to allowlist.
- [ ] Monaco lazy-loaded: initial SPA bundle still under 200 KB JS gzipped (decision #11 ensures KQL pages incur a separate ~3MB chunk only when reached).
- [ ] Integrity events: `tab_blur`/`copy`/`paste` rate-limited to 10/sec; `<IntegrityListener>` doesn't flood the API.
- [ ] Help tooltips render on all candidate.* keys; no orphan `helpId="..."` references.
- [ ] Result page: status `submitted` shows "pending admin review" placeholder; never crashes waiting for nonexistent grading.
- [ ] All buttons render as pills; no card shadows; big numbers in serif tabular-nums (Phase 0 invariants).
- [ ] No `AccessIQ_UI_Template/` runtime imports; no `claude`/`anthropic` references.
- [ ] No `if (domain === 'soc')` anywhere.

##### Anti-pattern guards

- Don't trust client time — `<TimerBar>` polls server for drift correction every 30s.
- Don't block the UI on save failure — degrade gracefully via `<ConnectivityBanner>`.
- Don't skip Monaco code-split — embedding it eagerly blows the bundle budget.
- Don't render markdown from `attempt_answers` (subjective) without sanitization — candidates can paste arbitrary content.
- Don't surface `attempt_events.payload` to the candidate UI — internal observability.
- Don't emit integrity events without rate-limiting — flooding the API costs the whole tenant.
- Don't show a result page until `assessments.status === 'released'` — Phase 1 never reaches that state.
- Don't import from `AccessIQ_UI_Template/` at runtime (Phase 0 invariant).
- Don't render `<HelpTip>` outside a `<HelpProvider>` — fail loudly in dev, gracefully in prod (return raw children).

##### DoD

1. **Pre-commit:** Phase 2 gates pass. **Phase 3:** Opus reviews diff. `11-candidate-ui` is presentation + a small embed surface; not in `CLAUDE.md` load-bearing list. `codex:rescue` judgment-call. Recommend: invoke once on the embed `postMessage` + integrity-event surfaces (origin-pinning is a defense-in-depth seam where mistakes leak across iframe boundaries).
2. Commit `feat(candidate-ui): take flow + embed + resilience + integrity hooks`. Noreply env-var pattern.
3. Deploy: redeploy `assessiq-frontend` (apps/web build). Smoke: real candidate magic-link end-to-end through a real browser → submit → `/done`.
4. Document: `modules/11-candidate-ui/SKILL.md` Status: live for Phase 1 surface; `modules/11-candidate-ui/RESILIENCE.md` shipped (decision #8); `docs/03-api-contract.md` Phase 1 result shape confirmed (decision #6); `docs/09-integration-guide.md` updated with formalized postMessage protocol (decision #9); help YAML updates committed if any copy tweaks landed.
5. Handoff: SESSION_STATE entry. **Phase 1 closes here.**

---

## Final phase — Phase 1 verification (orchestrator-only, no new session)

After all five sessions land, the orchestrator runs a single verification pass:

1. **Manual full-stack smoke** — fresh browser, admin logs into `/admin/login` (Phase 0 G0.C-5 surface) → MFA verify → creates a question pack via the importer CLI (`pnpm aiq:packs:import packs/soc-skills-2026q2.json` if user supplies the SOC pack JSON) → builds an L1 assessment via `curl POST /api/admin/assessments` (or the Phase 2 admin UI if it ships in parallel) → invites a test candidate → opens the magic-link in an incognito window → completes 12 questions → submits → sees the "pending admin review" placeholder.
2. **Cross-tenant isolation drill** — using `assessiq_system` role, insert a second tenant with its own pack + assessment + invitation. As tenant A's admin, hit `/api/admin/packs` and `/api/admin/assessments` and confirm tenant B's rows are absent. Repeat for tenant B's candidate magic-link from a third browser.
3. **Frozen-version drill** — admin starts editing a question while a candidate has an attempt open with that question; refresh candidate; verify the candidate sees the pre-edit version.
4. **Embed JWT drill** — craft an `alg: none` token and hit `/embed?token=...`; expect 401. Replay a valid token; second use returns 401 (replay cache).
5. **Auto-submit drill** — start an attempt with a 2-minute duration; wait 2.5 minutes; verify the cron transitions to `auto_submitted` and the candidate sees `/done` on next interaction.
6. **VPS additive-deploy audit** — `ssh assessiq-vps`, run `docker ps` (only `assessiq-*` added beyond Phase 0), `systemctl list-units --state=running --no-pager` (no new units beyond Phase 0), `diff /opt/ti-platform/caddy/Caddyfile.bak.<latest> /opt/ti-platform/caddy/Caddyfile` (no changes from Phase 0 — Phase 1 doesn't touch edge config), `ls /opt/ti-platform/caddy/ssl/` (no changes). Confirm no other apps' configs or containers touched.
7. **Doc drift sweep** — for each of the five Phase 1 modules: `SKILL.md` Status reflects live; `docs/02-data-model.md`, `docs/03-api-contract.md`, `docs/07-help-system.md` reflect what shipped. New docs `modules/06-attempt-engine/EVENTS.md` and `modules/11-candidate-ui/RESILIENCE.md` exist and are linked from their SKILLs. Phase 1 entry appended to a "Phase Log" section in `PROJECT_BRAIN.md`.
8. **codex:rescue final pass** on the merged Phase 1 surface — embed-JWT verifier (re-checked), multi-tab autosave concurrency, JOIN-based RLS correctness (5 new tables use it), magic-link session minting. Log final verdict.

If any step fails: open one bounce-back session, fix, re-verify the failed step only.

---

## Routing summary (for future-me)

| Activity | Where |
|---|---|
| This plan | Anyone reads `docs/plans/PHASE_1_KICKOFF.md` |
| Each session's day-one read | `PROJECT_BRAIN.md` + `docs/01-architecture-overview.md` + `docs/SESSION_STATE.md` + `docs/RCA_LOG.md` + this file's session block + the module's `SKILL.md` (per `CLAUDE.md` § Phase 0 reading list) |
| Subagent delegation inside a session | Per global `CLAUDE.md` orchestration playbook (Sonnet for mechanical implements, Haiku for grep sweeps, Opus for diff critique) |
| Adversarial review | `codex:rescue` mandatory on Session 4 (`06-attempt-engine` — embed JWT + magic-link surfaces); judgment-call on 1, 2, 3, 5 (recommended on each per the Session DoD notes) |
| Out-of-scope deferrals | `generateDraft()` AI question gen → Phase 2; `08-rubric-engine` module abstraction → Phase 2 (Phase 1 inlines rubric Zod into 04); `14-audit-log` real writes → Phase 3 (Phase 1 continues `// TODO(audit)` comment pattern); admin help-authoring UI → Phase 2 admin-dashboard; `ScoreRing`/`Sparkline` → Phase 2 results UI; behavioral-signals → archetype computation → Phase 2 (09-scoring); webhook delivery → Phase 3; `13-notifications` real SMTP → decision #12; CSV bulk import → Phase 2 (decision #4 default) |

---

## Appendix — 22 help_ids to seed in G1.A Session 2

```
admin.assessments.close.early
admin.assessments.create.duration
admin.assessments.create.question_count
admin.assessments.create.randomize
admin.assessments.invite.bulk
admin.assessments.publish
admin.packs.create.domain
admin.questions.generate.draft
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

Plus page-level keys for every `*.page` drawer (one per admin/candidate page touched in Phase 1 — generated from the page tree).

---

## Status

- **Plan version:** 1.1 (2026-05-01, orchestrator: Opus 4.7) — v1.0 shipped with 4 [USER]-flagged decisions; v1.1 pins all four at orchestrator defaults per user confirmation.
- **Open questions outstanding:** none. All 23 decisions captured at orchestrator defaults.
- **Blocking dependencies before G1.A opens:** G0.C-4 (`01-auth` implementation) and G0.C-5 (`03-users` + admin login) shipped per Phase 0 plan. G0.B-2 (`02-tenancy`) already shipped at commit `7923492`.
- **Next action:** wait for G0.C-4 + G0.C-5 to land, then open G1.A (Sessions 1 + 2 in parallel — Session 1 = `04-question-bank`, Session 2 = `16-help-system` + `Tooltip` for `17-ui-system`).
