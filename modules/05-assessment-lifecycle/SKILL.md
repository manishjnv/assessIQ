# 05-assessment-lifecycle — Cycles, invitations, state machine

## Purpose
Compose questions from packs into a runnable assessment, schedule its open/close window, invite candidates, drive the state machine from draft → published → active → closed.

## Scope
- **In:** `assessments` CRUD, scheduling (opens_at/closes_at), invitation issuance and lifecycle, question selection (random subset from pack/level), preview mode for admins, close + re-open semantics.
- **Out:** taking the assessment (06), grading (07), reporting (15).

## Dependencies
- `00-core`, `02-tenancy`
- `03-users` — to validate invitee user IDs exist
- `04-question-bank` — to pull question pool
- `13-notifications` — to send invitation emails
- `14-audit-log`

## Public surface
```ts
listAssessments({ status?, packId? }): Promise<PaginatedAssessments>
createAssessment(input): Promise<Assessment>
publishAssessment(id): Promise<Assessment>      // draft → published
closeAssessment(id): Promise<Assessment>        // → closed; submitted attempts can still be graded
reopenAssessment(id): Promise<Assessment>       // closed → published if not past closes_at

inviteUsers(assessmentId, userIds): Promise<{ invited, skipped }>
listInvitations(assessmentId, { status? }): Promise<Invitation[]>
revokeInvitation(id): Promise<void>

previewAssessment(id): Promise<PreviewQuestionSet>   // admin-only; doesn't create attempt
```

## State machine
```
       create
draft ────────▶ published ────▶ active ────▶ closed
   ▲              │  ▲             │            │
   │              ▼  │             │            │
   │        cancelled│             │            │
   │                  └─reopen     │            │
   └──unpublish (if no invitations)             │
                                                ▼
                                          (terminal)
```

- `draft`: editable, no candidates can see it
- `published`: visible to admins; if `opens_at` passed, transitions to `active`
- `active`: invited candidates can start
- `closed`: no new starts; in-progress attempts can submit; admin can re-open if before `closes_at`
- `cancelled`: terminal; for created-by-mistake assessments

## Question selection
At `attempt.start`:
1. Pull all `questions` matching `(pack_id, level_id, status='active')`
2. Filter to `question_count` count
3. If `randomize=true`, shuffle; else order by `position` field
4. Snapshot `(question_id, question_version)` to `attempt_questions`

If pool < `question_count`: fail with explicit error during publish (admin time, not candidate time).

## Data model touchpoints
Owns: `assessments`, `assessment_invitations`.

## Help/tooltip surface
- `admin.assessments.create.duration` — see `docs/07-help-system.md` example
- `admin.assessments.create.question_count` — pool sizing implications
- `admin.assessments.create.randomize` — when to randomize, when to keep order
- `admin.assessments.publish` — what changes when you publish (irreversible parts)
- `admin.assessments.close.early` — what happens to in-progress attempts
- `admin.assessments.invite.bulk` — CSV format

## Open questions
- Re-attempts (one user, multiple attempts) — v1 caps at 1 per assessment via DB UNIQUE; v2 may allow with new `attempt_number` column
- Cohort-based scheduling (different windows per group) — defer to v2

## Decisions captured (2026-05-01)

Pinned ahead of Phase 1 G1.B Session 3 per `docs/plans/PHASE_1_KICKOFF.md` § Decisions captured.

### `13-notifications` Phase 1 scope: real SMTP via Hostinger relay (decision #12)

Phase 0 G0.C-5 ships the console+file logger stub. Phase 1 G1.B Session 3 swaps in a thin SMTP driver — invitation emails must actually reach candidates, otherwise `inviteUsers` is a write-only op.

**Implementation:**

- Add `tenants.smtp_config` JSONB column (migration in G1.B Session 3, additive). Shape:
  ```json
  {
    "host": "smtp.hostinger.com",
    "port": 465,
    "secure": true,
    "user": "no-reply@<tenant-domain>",
    "password_enc": "<base64 AES-256-GCM ciphertext, encrypted with ASSESSIQ_MASTER_KEY>",
    "from_address": "no-reply@<tenant-domain>",
    "from_name": "AssessIQ"
  }
  ```
- Driver: `nodemailer` with `pool: true` (single shared connection per tenant per worker process).
- **Fail-closed:** if a tenant's `smtp_config` is null, `inviteUsers` returns `503 SmtpNotConfigured` — the admin sees a clear "configure SMTP first" error rather than silent send-to-nowhere.
- The `13-notifications` module owns the driver + template rendering. `05-assessment-lifecycle` calls `notifications.sendInvitationEmail(invitation)` and never touches SMTP directly.
- Inbound webhooks + outbound webhook delivery still deferred to Phase 3.

**`assessment_invitations.token_hash` generation:** `randomBytes(32).toString('base64url')` → sha256, stored in `token_hash`. TTL 72 hours (decided by parallel session — see prior observation 147 in claude-mem). The plaintext token goes ONLY into the email body, never logged.

**Magic-link flow assumption:** invitations target users that ALREADY exist in `users` (decision #19 in Phase 1 plan). JIT user creation from magic link is explicitly out of Phase 1 scope; defer to Phase 4 embed where host apps mint user records via JWT claims.

### Other decisions baked in (#5, #19, #20, #22)

- `assessments.settings` JSONB stays empty in Phase 1 (decision #5). Schema declares the column for forward-compat; Zod validates as `z.object({}).passthrough()`.
- Magic-link requires pre-existing user (decision #19) — see above.
- Question selection RNG uses `crypto.randomUUID()`-seeded Fisher-Yates shuffle, no playback (decision #20). Acceptable trade-off; reproducibility costs more than it gains in v1.
- Re-attempts capped at 1 per `(assessment_id, user_id)` via UNIQUE constraint on `attempts` (decision #22). v2+ may add an `attempt_number` column — explicitly out of Phase 1 scope.

## Status

**Phase 1 G1.B Session 3 shipped — 2026-05-02.** Full module live: migrations applied, service surface implemented, Fastify routes registered, 69 testcontainer integration tests green.

### What's live

- **Migrations** — `0020_assessment_status_enum.sql`, `0021_assessments.sql` (with `pack_version` frozen-contract column + window CHECK + `(tenant_id,status)` and partial-index pair for boundary cron), `0022_assessment_invitations.sql` (JOIN-based RLS through `assessments.tenant_id`). Plus additive `02-tenancy/migrations/0004_tenants_smtp_config.sql` (column only; SMTP driver swap-in deferred).
- **Source** — 9 files in `src/`: `types.ts` (Zod settings + domain types + `AL_ERROR_CODES`), `state-machine.ts` (pure functions: `canTransition`, `assertCanTransition`, `nextStateOnTimeBoundary`, `assertValidWindow`, `assertReopenAllowed`), `tokens.ts` (CSPRNG + sha256), `email.ts` (shim over `13-notifications.sendAssessmentInvitationEmail`), `repository.ts` (RLS-aware pg queries — 13 functions), `service.ts` (full public surface), `routes.ts` (11 admin Fastify endpoints), `boundaries.ts` (`processBoundariesForTenant` — pure idempotent logic), `index.ts` (barrel).
- **Wiring** — `apps/api/package.json` adds `@assessiq/assessment-lifecycle` workspace dep; `apps/api/src/server.ts` calls `registerAssessmentLifecycleRoutes(app, { adminOnly: authChain({ roles: ['admin'] }) })`. `tools/lint-rls-policies.ts` extends `JOIN_RLS_TABLES` with `assessment_invitations`.
- **Tests** — `src/__tests__/lifecycle.test.ts` covers every KICKOFF verification item: state-machine exhaustive transitions (legal + illegal), pool-size pre-flight (POOL_TOO_SMALL + exact-match success), illegal close-on-draft, time-boundary reject on past-closes_at reopen, boundary cron (activate, close, idempotency, stale-window-skip-active, draft/cancelled untouched), invitation flow (token uniqueness, INVITATION_EXISTS skip, USER_NOT_CANDIDATE skip, USER_NOT_FOUND skip, draft-assessment reject, revoke + idempotent revoke, sha256 verify), cross-tenant RLS (assessments + JOIN-RLS on invitations), dev-emails.log assertion (template_id, plaintext-token-only-in-body), preview smoke. 69 it / 69 passing.

### What's deferred to follow-up sessions

- **BullMQ repeating job** runtime — `boundaries.ts` is pure logic; an `apps/worker/` Node process to host the BullMQ scheduler does not exist yet (apps/api is the only application; no BullMQ in any package.json). Follow-up: create `apps/worker/`, add `bullmq` + `ioredis` deps, schedule `processBoundariesForTenant(tenant.id, new Date())` per active tenant every 60s. Until then admins must trigger close/reopen manually via the routes; assessments with `opens_at <= now` stay in `published` until processed.
- **SMTP driver** in `13-notifications` — the dev-emails.log stub still handles all sends. The `tenants.smtp_config` column is in place for Phase 1.5 nodemailer wiring (decision #12).
- **`tenantName`** is passed as empty string in `service.inviteUsers`'s call to `email.sendInvitationEmail` — `02-tenancy` does not yet expose a `getTenantName(client, tenantId)` helper. Phase 1.5: add the helper + populate the field.
- **Cross-module repository import**: `service.ts` reaches into `../../04-question-bank/src/repository.js` for `findPackById`/`findLevelById`. Architectural smell, deliberately documented; the cleanup is to add an internal `/repository` export entry to 04's `package.json` `exports` map.
- **Inline SQL** in `service.ts` (`countActiveQuestionsForLevel`, `listActiveQuestionsForPreview`) — direct `client.query` against `questions`. Should be moved to `04-question-bank`'s repository as `countActiveQuestionsForLevel(client, packId, levelId)` + `listActiveQuestionsForLevel(client, packId, levelId, limit)`.
- **Question status workflow gap (discovered during testing)**: `04-question-bank.createQuestion` defaults to `status='draft'`; module 04's `publishPack` does NOT auto-flip questions to `status='active'`. The pool-size pre-flight in `publishAssessment` looks for `status='active'` questions per the spec (`docs/02-data-model.md:362` schema docblock), so an admin must explicitly PATCH each question to `status='active'` (or bulk via tooling) before an assessment over that pack/level can publish. Phase 1.5 should either (a) auto-activate questions on publishPack, or (b) ship an admin "activate all" UI affordance. RCA entry appended.

### Decisions resolved this session

- **#5** — `settings` JSONB stays empty (Zod `passthrough` schema; column live).
- **#12** — `tenants.smtp_config` column live (driver swap-in deferred; dev-emails.log stub continues for now).
- **#19** — magic-link requires pre-existing user (`findUserForInvitation` returns null → `USER_NOT_FOUND` skip; no JIT user creation).
- **#20** — RNG / no playback — Phase 1 lands on attempt.start in module 06; the lifecycle module does not perform selection.
- **#22** — `(assessment_id, user_id)` UNIQUE constraint on `assessment_invitations` enforces v1's "one invitation per user per assessment" cap.
