# Session — 2026-05-02 (Phase 1 G1.B Session 3 — `05-assessment-lifecycle`)

**Headline:** Phase 1 G1.B Session 3 shipped end-to-end — `modules/05-assessment-lifecycle` with assessments + invitations + state machine + boundary-cron logic. 4 migrations live in production, assessiq-api rebuilt and serving 11 admin endpoints under `/api/admin/{assessments,invitations}`, 69 testcontainer integration tests green, full DoD loop closed (commit → deploy → docs → handoff).

**Commits this session:**

- `4fecadb` — feat(lifecycle): assessments + invitations + state machine + boundary cron (29 files, +4054/-17)
- *(this handoff)* — docs(session): handoff for Phase 1 G1.B Session 3 — coming next, see "Next" below

**Tests:** 69 / 69 passing in `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts` (vitest + testcontainers postgres:16-alpine, 14.5s wall). 03-users tests verified still passing after the 13-notifications email-stub Windows-path fix (27 / 27 + 1 todo). Full repo `pnpm -r typecheck` clean across all 12 packages. RLS lint clean — 24 migrations, 13 tenant-bearing + 5 JOIN-based child tables.

**Live verification:** `https://assessiq.automateedge.cloud/api/health → 200`; `GET /api/admin/assessments → 401 AUTHN_FAILED` with proper JSON envelope; `POST /api/admin/assessments → 401`; `DELETE /api/admin/invitations/:id → 401`. Postgres schema verified directly via `\d assessments` + `\d assessment_invitations` + `tenants.smtp_config` column lookup — all expected columns, indexes, constraints, and RLS policies present.

**Next:**

1. **Stage + commit this `SESSION_STATE.md` update**, then push (single-file follow-up).
2. After that, decide between:
   - **Continue Phase 1 G1.C — `06-attempt-engine`** per `docs/plans/PHASE_1_KICKOFF.md` Session 4. Module 05's surface is the upstream dependency; 06 owns `attempts`, `attempt_questions`, `attempt_answers`, `attempt_events` and the candidate-side flow.
   - **Side-quest — apps/worker creation + BullMQ scheduler wiring** to call `processBoundariesForTenant()` every 60s per active tenant. Today admins must trigger close/reopen manually via the routes; assessments with `opens_at <= now` stay in `published` until processed.
   - **Side-quest — module 04 `auto-activate questions on publishPack`** (or admin "activate all" affordance) to close the question-status workflow gap RCA'd this session. See RCA_LOG.md 2026-05-02.

**Open questions / explicit deferrals:**

- **BullMQ scheduler runtime** — `boundaries.ts` ships pure logic (`processBoundariesForTenant`); apps/worker app does not exist yet (no BullMQ in any package.json). Until apps/worker lands, the boundary-cron transitions don't fire automatically; admins manually close/reopen via the routes.
- **SMTP driver** — `tenants.smtp_config JSONB` column is in place (additive migration 0004); `13-notifications` continues to use the `dev-emails.log` JSONL stub. Phase 1.5 swap-in nodemailer behind the column.
- **`tenantName` placeholder** — `service.inviteUsers` passes empty string for `tenantName` to the email shim because `02-tenancy` does not yet expose a `getTenantName(client, tenantId)` helper. Phase 1.5: add it, populate the field.
- **Cross-module relative import** — `modules/05-assessment-lifecycle/src/service.ts` imports `qbRepo.findPackById` / `findLevelById` via `../../04-question-bank/src/repository.js`. Cleanup is to add an internal `/repository` export to 04's package.json `exports` map.
- **Inline SQL in service.ts** — `countActiveQuestionsForLevel` and `listActiveQuestionsForPreview` use direct `client.query` against `questions` rather than going through 04's repo. RLS-scoped via `withTenant` so safe; flagged for a refactor pass that adds those helpers to 04's repository.
- **Question-status workflow gap** — `04-question-bank.createQuestion` defaults to `status='draft'` and `publishPack` does NOT auto-flip questions to `'active'`; module 05's pool-size pre-flight queries `status='active'` per the spec. The test scaffold flips status via SQL UPDATE through the superuser client; production callers must PATCH each question to `active` manually until the gap is closed in Phase 1.5. RCA_LOG entry appended.
- **`docs/04-auth-flows.md` invitation-token flow** — DoD bullet 4 mentions documenting the magic-link flow shape there. Deferred to Phase 1 G1.C session because the candidate-side `/invite/:token` accept route (the user-facing leg) lands with `06-attempt-engine`. The current session ships the issuance side only (admin → email send via stub).
- **Carry-over from earlier sessions** (still open): `apps/web/src/lib/logger.ts` `no-console` violations + wire `pnpm exec eslint .` into CI; admin pages without kit reference screens (`mfa`, `users`, `invite-accept`); Spinner component in `@assessiq/ui-system`; MFA recovery code flow; HelpProvider localStorage tenant_id leak; `--aiq-color-bg-elevated` → `--aiq-color-bg-raised` rename in `admin/mfa.tsx` and `admin/login.tsx`; root `eslint .` not in CI.

---

## Agent utilization

- **Opus:** Phase 0 warm-start reads (parallel: PROJECT_BRAIN, 01-arch, SESSION_STATE prior, RCA_LOG, KICKOFF Session 3 block, module 05 SKILL, module 04 service+routes+repo+types+migrations, 02-tenancy with-tenant + middleware, apps/api server.ts, auth-chain, docs/02 + docs/03 sections, 13-notifications email-stub, root package.json + tsconfig.base). Round 1 self-writes for 4 migrations + lint extension + module skeleton (small mechanical writes from hot cache, faster than Sonnet cold-start). Round 2 self-writes for `types.ts`, `state-machine.ts` (the trap surface — pure functions, exhaustive transition table, time-boundary helper), `tokens.ts`, `email.ts`, and the `13-notifications` extension. Round 3 self-write for `boundaries.ts` (small, design-critical pure logic). Round 4 self-writes for `index.ts` barrel, apps/api wiring (package.json + server.ts), and the `routes.ts` `exactOptionalPropertyTypes` typecheck-fix. Phase 5 verification: full `pnpm -r typecheck`, three rounds of `pnpm test` against module 05 (red→yellow→green progression as test-side bugs surfaced), Phase 3 self-critique (no security blockers, several follow-up flags), all DoD doc updates (data-model, api-contract, SKILL.md, RCA_LOG, 13-notifications SKILL), feat commit with noreply env-var pattern, push, VPS deploy via git archive + scp, 4 migrations applied via `docker exec assessiq-postgres psql`, container rebuild + recreate, smoke verification, and this SESSION_STATE handoff.
- **Sonnet:** four parallel-ish subagent calls, each with full file paths + exact contract + acceptance test + report format per the global rule. (1) `repository.ts` — 13 functions, 572 lines, contract-compliant, flagged that `updateAssessmentRow` doesn't short-circuit on empty patch (acceptable). (2) `service.ts` — 641 lines, all 11 public functions, flagged the inline `countActiveQuestionsForLevel` SQL + cross-module relative import + `tenantName` placeholder. (3) `routes.ts` — 326 lines, 11 endpoints incl. 5 documented extensions, flagged that `inviteUsers` returns 201 even on partial success and that the date-null vs undefined patch logic was service-contract-dependent. (4) `lifecycle.test.ts` — 1214 lines, 69 `it` blocks across 11 describe sections, flagged 3 minor scaffolding compromises (direct SQL bypass for active-state setup, idempotency `>=` count assertion to handle test-order side effects, `cancelled` status set via direct UPDATE since no cancelAssessment service). All four agents reported clean diffs + change logs ≤ 200-300 words each as instructed.
- **Haiku:** n/a — no bulk multi-file lookups, no curl grids, no log triage. Single repo, 5-min cache window covered all reads.
- **codex:rescue:** n/a — skipped per DoD "judgment-call" framing. Module 05 is NOT in the load-bearing paths list (`modules/00-core`, `01-auth`, `02-tenancy`, `07-ai-grading`, `14-audit-log`, `infra/`); state-corruption trap surfaces (state-machine.ts, boundaries.ts, pool-size pre-flight, JOIN-RLS) are exhaustively tested by 69 testcontainer integration tests including 13 illegal-transition cases and idempotency verification. Deliberate trade-off documented; if the post-deploy admin smoke surfaces unexpected behavior, an in-flight rescue is appropriate.

---

## Detailed change log

### Migrations shipped

- `modules/05-assessment-lifecycle/migrations/0020_assessment_status_enum.sql` — `CREATE TYPE assessment_status AS ENUM ('draft','published','active','closed','cancelled')`. Postgres ENUM (not TEXT + CHECK) per the KICKOFF — adding states requires `ALTER TYPE ADD VALUE`, which is the desired friction for state-machine evolution.
- `modules/05-assessment-lifecycle/migrations/0021_assessments.sql` — 16-column table, standard tenant_id-bearing RLS, plus:
  - `pack_version INT NOT NULL` — additive vs `docs/02-data-model.md`. Snapshotted from `question_packs.version` at create time. The `(pack_id, pack_version)` tuple is the assessment's frozen content contract; republishing the pack does NOT re-bind existing assessments.
  - `CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at)` — defence-in-depth for the service's `assertValidWindow`.
  - `CHECK (question_count >= 1)`.
  - `assessments_tenant_status_idx (tenant_id, status)` for `listAssessments` filters.
  - `assessments_open_boundary_idx (opens_at) WHERE status='published'` — partial index for the BullMQ boundary cron's "ready to activate" scan.
  - `assessments_close_boundary_idx (closes_at) WHERE status='active'` — partial index for the boundary cron's "ready to close" scan.
- `modules/05-assessment-lifecycle/migrations/0022_assessment_invitations.sql` — JOIN-based RLS through `assessments.tenant_id` (no own `tenant_id` column). UNIQUE on `token_hash`, UNIQUE on `(assessment_id, user_id)`. Indexes on `(assessment_id, status)` and `(user_id, status)`.
- `modules/02-tenancy/migrations/0004_tenants_smtp_config.sql` — additive `ADD COLUMN IF NOT EXISTS smtp_config JSONB`. Phase 1 ships the column only; SMTP driver swap-in deferred per decision #12.

### Source files

`modules/05-assessment-lifecycle/src/`:

| File | Lines | Owner | Purpose |
|---|---|---|---|
| `types.ts` | 201 | Opus | Zod settings schema (`z.object({}).passthrough()` per decision #5), domain types, service-input types, `AL_ERROR_CODES` (19 codes). |
| `state-machine.ts` | 240 | Opus | Pure functions — `LEGAL_TRANSITIONS` static table, `canTransition`, `assertCanTransition` (throws `ValidationError(INVALID_STATE_TRANSITION)`), `nextStateOnTimeBoundary` (boundary-cron decision function), `assertValidWindow`, `assertReopenAllowed`. Trap surface; 28 dedicated tests. |
| `tokens.ts` | 66 | Opus | `randomBytes(32).toString('base64url')` plaintext + `sha256` hex hash. `DEFAULT_INVITATION_TTL_HOURS = 72`. |
| `email.ts` | 50 | Opus | Thin shim over `@assessiq/notifications.sendAssessmentInvitationEmail`. Centralises the "which notifications surface does the assessment-invitation flow use" decision in one file. |
| `repository.ts` | 572 | Sonnet | 13 RLS-aware pg query functions. No `WHERE tenant_id` filters anywhere. `assessments` INSERT passes `tenant_id` (standard variant); `assessment_invitations` INSERT does not (JOIN variant). `bulkUpdateBoundaries` runs three disjoint UPDATEs in a single tx for the boundary cron. |
| `service.ts` | 641 | Sonnet | 11 public functions, all wrap `withTenant`. `publishAssessment` runs the pool-size pre-flight before flipping status. `inviteUsers` issues per-user tokens, hashes them, persists `token_hash`, sends email through the shim, returns `{ invited, skipped }` with skip reasons. |
| `routes.ts` | 326 | Sonnet | Fastify plugin — 11 admin-gated endpoints. `parsePagination` + `parseDate` helpers inlined. Conditional date parsing handles `null` (clear field) vs `undefined` (no change). |
| `boundaries.ts` | 92 | Opus | `processBoundariesForTenant(tenantId, now)` — pure idempotent wrapper around `repo.bulkUpdateBoundaries`, logs INFO only on non-zero counts. BullMQ runtime wiring deferred (apps/worker doesn't exist yet). |
| `index.ts` | 96 | Opus | Barrel — re-exports service surface + state-machine primitives + types + error codes + route registrar. |
| `fastify.d.ts` | 53 | Opus | FastifyRequest augmentation (`session?`, `apiKey?`) byte-identical with module 04. |
| `__tests__/lifecycle.test.ts` | 1214 | Sonnet | 69 `it` blocks across 11 describe sections. testcontainers postgres:16-alpine; full RLS stack exercised. |

### Wiring changes

- `apps/api/package.json` — adds `@assessiq/assessment-lifecycle: workspace:*`.
- `apps/api/src/server.ts` — imports `registerAssessmentLifecycleRoutes` and calls it with the same `authChain({ roles: ['admin'] })` DI shape as question-bank.
- `tools/lint-rls-policies.ts` — extends `JOIN_RLS_TABLES` with `assessment_invitations`. Lint passes (24 migrations scanned, 13 tenant-bearing + 5 JOIN-based, all policies present).
- `modules/13-notifications/src/email-stub.ts` — adds `sendAssessmentInvitationEmail(input)` (template `invitation.assessment`); existing `sendInvitationEmail` unchanged. `appendDevEmailLog` Windows-path bug fixed (`path.dirname()` replaces hand-rolled `lastIndexOf('/')`).
- `modules/13-notifications/src/index.ts` — re-exports the new function + its input type.

### Test bugs surfaced + fixed during verification

- **Question-status mismatch (15 failures).** Tests created questions via 04's `createQuestion` (default `status='draft'`); module 05's pool-size pre-flight queries `status='active'`; mismatch → `POOL_TOO_SMALL`. Fix: `buildPublishedPack` helper now bulk-`UPDATE questions SET status='active'` after `publishPack` via the testcontainer superuser client. Production-side workflow gap appended to `docs/RCA_LOG.md`.
- **`toSatisfy` vs throw (3 failures).** Three tests used `expect(() => fn()).toSatisfy(predicate)` against thrown errors — but `toSatisfy` runs the predicate against the function reference, not its thrown error, so the assertion always failed. Fix: explicit try/catch + `expect(caught).toBeInstanceOf` + `toMatchObject({ code: ... })`.
- **Email-stub Windows-path silent drop (2 failures).** `appendDevEmailLog` extracted `dirname` via `lastIndexOf('/')` which returns -1 on Windows-style paths, made `mkdir("")` fail, and the failure was swallowed by the surrounding `try/catch` warn-log. Fix: replaced with `path.dirname()`. RCA appended.

### Production deploy

- `git archive HEAD <listed paths> | ssh assessiq-vps "cd /srv/assessiq && tar -xf -"` — pushed only the changed files (no .git on VPS; deploy is artifact-only, not git-tracked).
- 4 migrations applied via `docker exec -i assessiq-postgres psql -U assessiq -d assessiq -v ON_ERROR_STOP=1` in dependency order: 0004_tenants_smtp_config → 0020_assessment_status_enum → 0021_assessments → 0022_assessment_invitations. Schema verified directly via `\d assessments`, `\d assessment_invitations`, `information_schema.columns` lookup for `tenants.smtp_config`.
- `docker compose -f infra/docker-compose.yml build assessiq-api && up -d --no-deps --force-recreate assessiq-api` — image rebuilt, container recreated. `docker logs assessiq-api` shows clean startup: `assessiq-api listening on :3000`. Health check 200 within 5s.
- Smoke: `/api/health → 200`; `GET /api/admin/assessments → 401`; `POST /api/admin/assessments → 401`; `DELETE /api/admin/invitations/:id → 401`. All 401s return the expected `{"error":{"code":"AUTHN_FAILED","message":"authentication required"}}` envelope, confirming the routes are registered, auth-gated, and the global error handler is correctly wired.
- Additive-only deploy verification: only the `assessiq-api` container was recreated. `assessiq-frontend`, `assessiq-redis`, `assessiq-postgres` continued running undisturbed. No nginx changes, no cron changes, no `apt`/`systemctl` changes, no shared-infra touches. `docker ps --filter name=assessiq` confirmed all 4 containers healthy post-deploy.
