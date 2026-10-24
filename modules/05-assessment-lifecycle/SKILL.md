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

inviteUsers(assessmentId, userIds): Promise<{ invited, skipped }>   // re-activates revoked/lapsed invitations (see "Resend")
listInvitations(assessmentId, { status? }): Promise<{ items, page, pageSize, total, resendable }>  // items carry can_resend
revokeInvitation(id): Promise<void>
resendInvitation(id, actorUserId): Promise<Invitation>              // new token + 7 days + email (after commit)
resendInvitations(assessmentId, actorUserId): Promise<{ resent, skipped: [{ id, code }], remaining }>  // bulk, max 200/call

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
- `admin.assessments.invitations.resend` / `.resend_all` / `.resend_result` — resend one / resend everyone who has not started / the outcome chips (migration `16-help-system/0120`)

## Open questions
- Re-attempts (one user, multiple attempts) — v1 caps at 1 per assessment via DB UNIQUE; v2 may allow with new `attempt_number` column
- Cohort-based scheduling (different windows per group) — defer to v2

## Decisions captured (2026-05-01)

Pinned ahead of Phase 1 G1.B Session 3 per `docs/plans/archive/PHASE_1_KICKOFF.md` § Decisions captured.

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
- **Not built:** a `503 SmtpNotConfigured` error does not exist in code (grep 2026-10-02). Email goes through the platform SMTP transport. The idea belongs to a parked per-tenant email sender feature.
- The `13-notifications` module owns the driver + template rendering. `05-assessment-lifecycle` calls `notifications.sendInvitationEmail(invitation)` and never touches SMTP directly.
- Inbound webhooks + outbound webhook delivery still deferred to Phase 3.

**`assessment_invitations.token_hash` generation:** `randomBytes(32).toString('base64url')` → sha256, stored in `token_hash`. **TTL 7 days / 168 h** (`DEFAULT_INVITATION_TTL_HOURS` in `tokens.ts`; it was 72 h until 2026-10-01 while the candidate help + admin guide already promised 7 days — fixed so behaviour matches the copy; invitations issued before that keep their old `expires_at` until resent). The plaintext token goes ONLY into the email body, never logged.

**Magic-link flow assumption:** invitations target users that ALREADY exist in `users` (decision #19 in Phase 1 plan). JIT user creation from magic link is explicitly out of Phase 1 scope; defer to Phase 4 embed where host apps mint user records via JWT claims.

### Other decisions baked in (#5, #19, #20, #22)

- `assessments.settings` JSONB stays empty in Phase 1 (decision #5). Schema declares the column for forward-compat; Zod validates as `z.object({}).passthrough()`.
- Magic-link requires pre-existing user (decision #19) — see above.
- Question selection RNG uses `crypto.randomUUID()`-seeded Fisher-Yates shuffle, no playback (decision #20). Acceptable trade-off; reproducibility costs more than it gains in v1.
- Re-attempts capped at 1 per `(assessment_id, user_id)` via UNIQUE constraint on `attempts` (decision #22). v2+ may add an `attempt_number` column — explicitly out of Phase 1 scope.

## Status

**Phase 1 G1.B Session 3 shipped — 2026-05-02.** Full module live: migrations applied, service surface implemented, Fastify routes registered, 69 testcontainer integration tests green.

### What is live

- **Migrations** — `0020_assessment_status_enum.sql`, `0021_assessments.sql` (with `pack_version` frozen-contract column + window CHECK + `(tenant_id,status)` and partial-index pair for boundary cron), `0022_assessment_invitations.sql` (JOIN-based RLS through `assessments.tenant_id`). Plus additive `02-tenancy/migrations/0004_tenants_smtp_config.sql` (column only; SMTP driver swap-in deferred).
- **Source** — 9 files in `src/`: `types.ts` (Zod settings + domain types + `AL_ERROR_CODES`), `state-machine.ts` (pure functions: `canTransition`, `assertCanTransition`, `nextStateOnTimeBoundary`, `assertValidWindow`, `assertReopenAllowed`), `tokens.ts` (CSPRNG + sha256), `email.ts` (shim over `13-notifications.sendAssessmentInvitationEmail`), `repository.ts` (RLS-aware pg queries — 13 functions), `service.ts` (full public surface), `routes.ts` (11 admin Fastify endpoints), `boundaries.ts` (`processBoundariesForTenant` — pure idempotent logic), `index.ts` (barrel).
- **Wiring** — `apps/api/package.json` adds `@assessiq/assessment-lifecycle` workspace dep; `apps/api/src/server.ts` calls `registerAssessmentLifecycleRoutes(app, { adminOnly: authChain({ roles: ['admin'] }) })`. `tools/lint-rls-policies.ts` extends `JOIN_RLS_TABLES` with `assessment_invitations`.
- **Tests** — `src/__tests__/lifecycle.test.ts` covers every KICKOFF verification item: state-machine exhaustive transitions (legal + illegal), pool-size pre-flight (POOL_TOO_SMALL + exact-match success), illegal close-on-draft, time-boundary reject on past-closes_at reopen, boundary cron (activate, close, idempotency, stale-window-skip-active, draft/cancelled untouched), invitation flow (token uniqueness, INVITATION_EXISTS skip, USER_NOT_CANDIDATE skip, USER_NOT_FOUND skip, draft-assessment reject, revoke + idempotent revoke, sha256 verify), cross-tenant RLS (assessments + JOIN-RLS on invitations), dev-emails.log assertion (template_id, plaintext-token-only-in-body), preview smoke. 69 it / 69 passing.

### What is deferred to follow-up sessions

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

## settings.integrity (Integrity v1, 2026-10-01)
`settings.integrity = { fullscreen?: boolean, block_copy_paste?: boolean }`, both default false. Typed with `AssessmentIntegritySettingsSchema` (strict: unknown keys rejected) and checked by `assertIntegritySettings` in createAssessment / updateAssessment / createAssessmentFromSet (via createAssessment). Why: the university campus tests need basic anti-cheating switches; they live in the existing settings JSONB so there is no migration. Read by 06 getAttemptForCandidate; enforced client-side only. Note: updateAssessment replaces `settings` wholesale (existing behaviour), so an editor must send the full object. Not included: any server enforcement.

**Editing after creation (2026-10-02):** `PATCH /api/admin/assessments/:id/integrity`, body `{ fullscreen: boolean, block_copy_paste: boolean }` (zod strict, both required), returns the updated Assessment. Service `updateAssessmentIntegrity` runs ONE `UPDATE ... settings = jsonb_set(coalesce(settings,'{}'), '{integrity}', $2::jsonb)` so `blueprint` and any other settings keys survive (considered and rejected: sending the whole `settings` through updateAssessment, which replaces it wholesale and is draft-only, and which also trips the super_admin blueprint gate). Allowed in ANY status including after publish: the candidate view reads settings live at load, so it affects attempts started afterwards and a student mid-test picks it up on their next page load. Same `adminOnly` chain as the other mutations, tenant from the session (other tenant -> 404), audit action `assessment.updated` with `before/after = { integrity }` (plain JSON; the audit action registry is closed, so a new action name was not added). Test: `src/__tests__/integrity-route.test.ts`; `audit-writes.test.ts` call-site count is now 11.

## Section subject guard and section node (Z-122, Z-123, 2026-10-21)

- **Guard (writes and publish only).** `assertSectionCategoriesMatchPack` (`service/blueprint.ts`) runs on create, from-set and PATCH of `settings`. Each section `category_ids` entry must be a category of the same tenant whose domain slug equals `question_packs.domain`. A `node_id` must be visible to the tenant (RLS; global nodes are allowed). Why: a Finance category on an Aptitude set passed before and failed only at the first candidate's start.
- **Publish.** `assertSectionPoolsFillable` counts each section's own pool with the draw's filter (node, else categories, else the whole pool). It counts live active questions of the pack and level; the draw is the final authority (overlap between sections and passage groups are not modelled).
- **Section `node_id`.** Optional, wins over `category_ids`. Module 06 `startAttempt` filters that section by `question_taxonomy` descendants (`listQuestionIdsUnderNode`, the Z-43 predicate). Sections without `node_id` draw as before. `mock.ts` sets it from the blueprint subject node.
- **Rejected.** A mock subject-mismatch rule without a data link (it would be a `domain ===` branch); see row Z-128. **Not included.** Re-checking old assessments (Rule A and zero-fail); a prod audit before the build found 0 mismatches.

## Invitation resend / re-invite (2026-10-01)

**Why:** links expired after 72 h (copy promised 7 days), a student who missed the window was locked out with no UI fix, and a revoked invitation blocked re-inviting the same student (UNIQUE `(assessment_id, user_id)` → `INVITATION_EXISTS`). First real user = a campus placement drive (100+ students).

**What exists**
- `DEFAULT_INVITATION_TTL_HOURS = 168` — used by invite, resend and re-invite.
- `POST /api/admin/invitations/:id/resend` — same `adminOnly` chain as `DELETE /api/admin/invitations/:id`. One transaction (`withTenant`): row lock → assessment must be `published`/`active` → candidate must NOT have started → user must be an active candidate → **fresh token, `expires_at = now + 7 d`, `status = 'pending'`, `last_resent_at = now()`, exactly one audit row** (`reissueInvitationInTx`). The email goes out **after commit** via the same `sendInvitationEmail` shim as invite (a rollback must never leave a student holding a link whose hash was never saved). 200 = updated invitation; 404 `INVITATION_NOT_FOUND` (other tenant / unknown / malformed id); 409 `INVITATION_ALREADY_STARTED`, `ASSESSMENT_NOT_ACTIVE` (draft/closed/cancelled), `USER_INACTIVE`; 502 `INVITATION_EMAIL_FAILED` (link already rotated — Resend again is safe). Domain codes live in `error.details.code`.
- `POST /api/admin/assessments/:id/invitations/resend` — bulk. Eligible = `pending`/`viewed` (this includes links that **lapsed by time**: they keep status `pending`/`viewed`), candidate has no attempt, account active, link not re-issued in the last 10 minutes. **Revoked rows are excluded** (only the single resend revives them). Max 200 per call, oldest first, each invitation in its OWN transaction with its email right after ITS commit; returns `{ resent, skipped: [{ id, code }], remaining }` where `remaining` = eligible rows beyond the cap that were not touched. 409 `ASSESSMENT_NOT_ACTIVE` / 404 for the assessment.
- `inviteUsers` (and therefore the CSV import, which calls it) now **re-activates** an existing invitation instead of skipping when its link is dead (revoked, or lapsed) and the candidate has not started — same effect as Resend, audited as `assessment.invite` `after.kind=reinvite`. A live link, or a candidate who already started, stays `INVITATION_EXISTS` with no new email. (Unlike resend, the re-invite email is dispatched inline inside the batch transaction, exactly like the new-invite branch.)
- `GET /api/admin/assessments/:id/invitations` items also carry `camera_consent` (`'declined'` | `null`). Module 06 owns `camera_consents`, so the route calls the optional `declinedCameraInvitations(tenantId, idsWithNoAttempt)` option, wired in `apps/api/src/server.ts` to `listDeclinedCameraInvitationIds` from `@assessiq/attempt-engine`. No SQL join and no cross-module import here.
- `listInvitations` items carry `can_resend`; the response carries `resendable` (bulk count across ALL pages) — drives the admin UI buttons.

**Decisions / rejected alternatives**
- **"Revoked" = `status = 'expired'`** (that is what `revokeInvitation` writes); a link that merely ran out of time keeps `pending`/`viewed` with `expires_at` in the past. No `revoked` status was introduced (would break the existing revoke contract, candidate queries and tests). The UI labels status `expired` as "revoked".
- **Started check = invitation status OR an attempt row** (`attempts.status <> 'draft'`): `revokeInvitation` overwrites ANY status with `expired`, so a revoked-after-start invitation is only recognisable by its attempt.
- **Migration `0117` adds `last_resent_at`** (nullable, additive). Without it the capped bulk resend would re-select the same first 200 rows on every click (they stay pending + not started) — duplicate emails and just-sent links killed. Originals keep NULL, so bulk right after the first invite still reaches everyone. Rejected: deriving "recently re-issued" from `expires_at − created_at` (couples the SQL to the TTL constant and clock skew).
- Re-invite also covers **lapsed** links (not only revoked): the old link is dead either way, and re-importing the same CSV after day 7 is the natural "send it again". Live links are untouched.
- Not done: no automatic extension of invitations issued under the old 72 h TTL (forward-only; Resend extends them); the admin invitations list still loads the first 100 rows (bulk resend covers all pages).

## Automatic invitation reminders (2026-10-02)
`settings.reminders = { enabled: boolean, hours_before?: int 1-168 }` (strict, `AssessmentRemindersSettingsSchema`; validated on create/update via `assertRemindersSettings` and by `PATCH /api/admin/assessments/:id/reminders`, any status, merged with jsonb_set, audited as `assessment.updated`). **Default OFF** (setting absent = off): reminders are the lowest-value mail and the Brevo plan is 300/day shared across products, so an admin opts in per assessment. `hours_before` defaults to 24.
`src/reminders.ts` `sweepInvitationReminders()` is called by the worker job `invitation.reminders` (every 30 min, apps/api `jobs/invitation-reminders.ts`). Selector (one read under `assessiq_system`): published/active assessment with reminders on; invitation `pending|viewed`, `reminded_at IS NULL`, candidate active + not erased + no non-draft attempt; deadline = `LEAST(expires_at, closes_at)` is in the future and within `hours_before`; the last invite/resend email is older than 6 h; soonest deadline first; at most 25 per tick and 100 reminded rows per trailing 24 h platform-wide. Each row is claimed in its own `withTenant` tx (`UPDATE ... SET reminded_at = now(), token_hash = $new WHERE reminded_at IS NULL AND <eligible>`), then the bulk-lane email (module 13 `invitation_reminder`) is sent after commit; an email failure clears `reminded_at` so the next tick retries.
**Link:** only sha256(token) is stored, so the original link cannot be re-sent. The claim rotates `token_hash` (as a resend does) but never touches `expires_at`; the email tells the student this link replaces the earlier one. A resend / re-invite resets `reminded_at` (migration 0134 column) so the fresh 7-day link may earn one new reminder. The admin invitation list returns `reminded_at`. Logs: one counts-only summary line per tick. Not included: per-tenant caps, multiple reminders, reminders for revoked/lapsed links.

## Audit-write coverage (G3.D slice, 2026-05-11)

Every admin-mutating service method writes one `audit_log` row inside the same `withTenant` Postgres transaction as the domain mutation, via `auditInTx()` from `@assessiq/audit-log`. A successful state change without a corresponding audit row (or vice-versa) is structurally impossible — the transaction either commits both or rolls back both.

| Service function | `audit_log.action` | `entity_type` | Notes |
|---|---|---|---|
| `createAssessment` | `assessment.created` | `assessment` | `after`: pack_id, level_id, pack_version, name, question_count, randomize, status |
| `updateAssessment` | `assessment.updated` | `assessment` | `before/after`: name, question_count, randomize, opens_at, closes_at; `after.changed_fields` (no full settings JSONB) |
| `publishAssessment` | `assessment.published` | `assessment` | `before/after.status`; `after.pool_size` + `after.question_count` |
| `closeAssessment` | `assessment.closed` | `assessment` | `before/after.status` |
| `reopenAssessment` | `assessment.published` (`after.kind=reopen`) | `assessment` | Reuses `assessment.published` with marker to keep the action catalog tight — same pattern as `04-question-bank`'s `restoreVersion → question.updated kind=restore` |
| `inviteUsers` | `assessment.invite` × N | `assessment_invitation` | One row per invitation issued. Skipped users (USER_NOT_FOUND / USER_NOT_CANDIDATE / USER_INACTIVE / INVITATION_EXISTS) intentionally produce no audit row — nothing mutated |
| `revokeInvitation` | `assessment.invite` (`after.kind=revoke`) | `assessment_invitation` | Reuses `assessment.invite` with marker. Idempotent path (already-expired) writes NO new row |
| `resendInvitation` / `resendInvitations` (per row) | `assessment.invitation.resent` (`after.kind=resend`) | `assessment_invitation` | Added 2026-10-01 (naming mirrors `admin.invitation.resent`). Exactly one row per invitation, written by the shared `reissueInvitationInTx` in the SAME tx as the token rotation. `before`: status + expires_at; `after`: kind, status, expires_at, assessment_id, user_id |
| `inviteUsers` (revoked / lapsed invitation re-activated) | `assessment.invite` (`after.kind=reinvite`) | `assessment_invitation` | Same helper, same one-row rule; keeps the invite path's own action so "when was user X invited" stays one query |

`actor_kind` is always `"user"`; `actor_user_id` is the admin's session userId threaded through the service signature (added to `updateAssessment`, `publishAssessment`, `closeAssessment`, `reopenAssessment`, `revokeInvitation` in this slice).

ACTION_CATALOG additions to `modules/14-audit-log/src/types.ts`: `assessment.updated` (G3.D) and `assessment.invitation.resent` (2026-10-01). The reopen and revoke events fold under existing `assessment.published` / `assessment.invite` namespaces using `after.kind` markers (minimal-catalog-footprint pattern from the 04-question-bank G3.D template).

**Not wired in this slice:**

- `markInvitationViewedByToken` — candidate-flow, not admin-mutating.
- `resolveInvitationToken` — read-only pre-auth lookup.
- `boundaries.processBoundariesForTenant` / `repo.bulkUpdateBoundaries` — cron-driven background state transitions, not admin-triggered. Auditing these would need a separate `actor_kind="system"` design discussion.
- `getInvitationCounts`, `listAssessments`, `getAssessment`, `listInvitations`, `previewAssessment` — read-only.

Tests:

- `src/__tests__/audit-writes.test.ts` — happy-path test per wired function + atomicity proof (`publishAssessment` on non-existent id throws and writes no audit row) + coverage assertion (count of `auditInTx(` call-sites in service.ts equals 10 — the 9 admin-mutating functions plus the shared `reissueInvitationInTx`).
- `src/__tests__/lifecycle.test.ts` — testcontainer migration set extended to apply `14-audit-log/migrations/0050_audit_log.sql` plus the `assessiq_app` / `assessiq_system` role setup. All call-sites updated to thread `adminA` for the new signatures.
- `src/__tests__/invite-email.test.ts` — `@assessiq/audit-log` added to the vi.mock list (this is a pure-mock unit test, no testcontainer).


## 2026-10-02 - ISO dates in audit payloads

`redactPayload` (14-audit-log) turns a `Date` into `{}`, so `assessment.invite` stored `after.expires_at` as `{}`. Fixed at the callers (audit-log untouched): `inviteUsers` (`expires_at`), `updateAssessment` (`opens_at`/`closes_at`, before+after, null-safe) and `reopenAssessment` (`closes_at`) now pass `.toISOString()`; same for `03-users` `restoreUser` (`deleted_at`). Rule: never put a `Date` in an audit before/after. Test: `audit-writes.test.ts` asserts `after.expires_at` is an ISO string.

## settings.sections — timed test sections (2026-10-02)

`settings.sections?: Array<{ name; category_ids?; question_count?; minutes; calculator? }>` (1-10 entries, strict zod `AssessmentSectionsSchema`, minutes 1-300, each needs `question_count` and/or `category_ids`). Validated by `assertSectionsSettings` in `createAssessment` and `updateAssessment`; it cannot be combined with `settings.blueprint`.
- **Why a parallel structure and not the blueprint**: blueprint is single-domain `(category, type, count)` criteria with no time or ordering dimension and is super-admin-only; sections need a name, a deadline and a calculator flag per group and must work for the licensed-set (from-set) path that company admins use. Reusing blueprint would have forced a time model into it and coupled the two features.
- **`minutes` is required** (the contract listed it optional): a section without its own deadline would need a second timing mode.
- **Not validated**: `category_ids` are not checked for tenant ownership (they only filter the tenant's RLS-scoped pool; a foreign id matches nothing and fails the start with `POOL_TOO_SMALL`). Runtime behaviour lives in 06.

## Erased candidates (E3, 2026-10-02)

`resendInvitation` (and bulk resend, as a per-row skip) throws 409 `CANDIDATE_ERASED`; `inviteUsers` skips an erased user with reason `CANDIDATE_ERASED` (never a new token or email). Source: `users.erased_at` via `findUserForInvitation().erased`. Test DBs that call these need migration `20-data-rights/0102_users_erased_at.sql`.

## Batch 5 (2026-10-02)

- `PATCH /api/admin/assessments/:id/grading` (`updateAssessmentGrading`): body `{high_stakes: boolean}` strict, any status, merges only `settings.high_stakes` via `jsonb_set`, audited `assessment.updated`. 07 reads the flag live. Why separate: same pattern as `/integrity` and `/reminders`.
- `SECTIONS_LOCKED` (409, `AL_ERROR_CODES`): `updateAssessment` refuses a `settings.sections` change once any attempt exists (canonical JSON compare, key order ignored). Draws and deadlines are frozen per attempt, so edits cannot be made consistent. Not included: a section edit UI (PENDING N6), a DB-level guard.

## Preview reads the frozen pool (RV63, 2026-10-03)

`previewAssessment` (`src/service.ts`) checks `assessment_frozen_pool` first. When the assessment is not `draft` and frozen rows exist, the count and the sample come from the frozen rows (blueprint criteria filter by `domain_id`, `category_id`, `type` on the frozen table; legacy preview lists all frozen rows). The result has `frozen: true`. Draft and pre-0096 assessments keep the live path. Read helpers: `countFrozenPoolRows`, `countFrozenForCriterion`, `listFrozenForCriterionPreview`, `listFrozenForPreview` in `src/repository.ts`. Why: after a pack revision or a clone re-sync the admin saw a different pool than candidates got. Not included: content from the frozen version (the sample shows the live question text), no UI badge yet. Rejected: a cross-module import of the module 06 frozen-pool readers.

## Cron finds due tenants with one query (RW-39, 2026-10-11)

`listTenantsWithDueBoundaries(now)` (`src/boundaries.ts`, repository query in `src/repository.ts`) runs under `withSystemRole` and returns the active tenants with a due `opens_at` or `closes_at`. The boundary cron then calls `processBoundariesForTenant` under `withTenant` for those tenants only. Why: no empty transaction per idle tenant. Rejected: a per-tenant fallback loop, and a cross-tenant mutation (it must stay RLS-scoped and audited). Not included: auto-release (unchanged), new indexes (the 0021 partial indexes serve the query). Details: `docs/11-observability.md` section 13.2.

## `service.ts` is a barrel over `src/service/` (RW-53, S10, 2026-10-16)

- **What.** `src/service.ts` went from 2423 to 43 lines (a header comment and re-exports). Import paths do not change. This is a mechanical split with no behaviour change.
- **Layout** (`src/service/`).
  - `_shared.ts`: the logger, `assertPageSize`, `countActiveQuestionsForLevel`, `listActiveQuestionsForPreview`.
  - `blueprint.ts`: blueprint resolution (`resolveBlueprint`, `resolveBlueprintNodes`, `resolveBlueprintPackLevel`, `assertBlueprintFKOwnership`, the criterion counters).
  - `assessments.ts`: list, get, create, update, create from a set, licensed set import and resync, integrity and grading settings.
  - `lifecycle.ts`: publish, close, cancel, delete, reopen.
  - `invitation-token.ts`: the pre-auth resolver (`resolveInvitationToken`, `markInvitationViewedByToken`).
  - `invitations.ts`: invite, resend, list, revoke.
  - `preview.ts`: `previewAssessment`.
- **Older text in this file.** Lines that say `src/service.ts` hold a function now mean the matching file in `src/service/`.
- **Not included.** A change to the exports, the RLS-only rule or the tests.

## Z-16 pass mark (2026-10-17)

- **What.** `assessments.passing_score_pct` (migration `0198`, SMALLINT 1..100). `createAssessment` and `createAssessmentFromSet` take an optional `passing_score_pct`; the default is the level's value clamped to 1..100. `updateAssessment` accepts it only in `draft` (the existing `ASSESSMENT_NOT_DRAFT` rule). `assertPassMark` rejects 0, negatives, above 100, decimals and non-numbers (`INVALID_PARAM`).
- **Why.** The owner wants a pass mark per assessment. Edits stop at publish, so every candidate is judged by one mark. The mark is snapshotted onto `attempt_scores` (module 09).
- **Considered and rejected.** Letting an admin change the mark after publish (history would shift, or the snapshot would hide the change). A cross-module FK for the snapshot.
- **Not included.** Honors. Retake (Z-39). The result email wording.
- **Downstream.** Admin UI: a field on the New assessment form (blank means the level default) and `PassMarkCard` on the detail page. Help id `admin.assessments.pass_mark`. The welcome page shows the mark through `assessment.pass_mark_pct` of the `/take/start` preview.

## Full mock from an exam blueprint (EXP-6, 2026-10-17)

- **What.** `createMockFromBlueprint` (`src/service/mock.ts`) and `POST /api/admin/blueprints/:id/mock`. Reads the blueprint through module 04 (05 depends on 04, never the reverse) and calls `createAssessment`, so a `draft` is created with all existing guards. Fills `settings.sections`, `settings.scoring.negative_marks_default` and `settings.exam_blueprint`. Section schema gains optional `qualifying` and `cutoff_marks`.
- **Why.** One click gives the right sections and negative marking. The cutoff keys feed section results (module 09).
- **Gaps, stated plainly.** (1) Sections are always timed one by one (module 06). A blueprint with one overall timer gets an even split of the minutes and a `warnings` entry. (2) The draw ignores `subject_node_id`: a section draws `question_count` questions from the pack and level pool. Draw by node needs the frozen-pool work. (3) Marks per question come from `questions.points`; the blueprint's value is not applied. (4) One negative value for the whole assessment: a blueprint with different values is rejected (400).
- **Not included.** UI, draw by node, a single whole-test timer, publishing the draft.
- **Tests.** `src/__tests__/mock-from-blueprint.test.ts`.
- **Z-43 node draw on a frozen assessment.** A node draw on a published (frozen) assessment reads live `question_taxonomy` links, live `parent_id` and live `difficulty_est`. A taxonomy edit after publish can change which frozen questions a candidate is drawn from. It can never add a question outside the frozen set. Descendants deeper than 10 levels are not included. Write time rejects `difficulty_min` > `difficulty_max`, and a difficulty range on a category criterion, with `BLUEPRINT_DIFFICULTY_INVALID`.

## Z-39 retake policy (2026-10-18)

- **What.** `assessments.max_attempts` (migration `0203_assessments_max_attempts.sql`; `NULL` or 1 = one attempt, 2 to 10 = attempts allowed; draft-only edit, `assertMaxAttempts`) and `settings.score_counts` (`latest` default or `best`, `assertScoreCounts`). `assessment_invitations.extra_attempts` holds the extra attempts granted to one candidate. Services in `service/invitations.ts`: `grantExtraAttempt(tenantId, invitationId, reason, actor)` (reason required, one `assessment.invitation.extra_attempt_granted` audit row in the same transaction, invitation row locked) and `reopenInvitationForRetake(tenantId, invitationId, actor)` (submitted invitation, no unfinished attempt, used < `attemptsAllowed(max_attempts, extra_attempts)`, fresh link, audit `assessment.invitation.reopened`, email after commit). `resolveInvitationToken` returns `attempts_used` and `attempts_allowed`; `already_submitted` is true only when no attempt is left, so a retake no longer gets `410`. `listInvitationRows` returns ONE row per candidate: the attempt picked by `score_counts` (lateral join).
- **Why.** Owner decision 2026-10-17 (Z-39). The limit rule is one function, `attemptsAllowed` in `@assessiq/core`, used here and in module 06.
- **Considered and rejected.** A separate grants table (a counter plus one audit row per grant is enough). Letting `resendInvitation` handle submitted rows (its "not started" rule protects live attempts). A `score_counts` column (it is a presentation setting, so it stays in `settings`).
- **Not included.** Cooling-off timer, paid retakes, other question draws per retake, editing `max_attempts` after publish.
- **Downstream.** Module 06 `startAttempt` (the real guard, with the unique key). Module 18 (one certificate per assessment and candidate). Admin UI: `RetakeCard` and the `Re-open` and `Give extra attempt` buttons in the invitations list. Routes: `POST /api/admin/invitations/:id/extra-attempt` and `/reopen`. Tests: `modules/06-attempt-engine/src/__tests__/retake.test.ts` (this module's harness has no `attempts` table).

## Whole-test timer and section marks (Z-42, 2026-10-18)

- **What.** `settings.whole_test_minutes` and `sections[].marks_per_question` / `negative_marks_per_question` (see `docs/02-data-model.md` "Whole-test timer and marks per question"). `sections[].minutes` became optional; `sectionTimingProblem` (`src/types.ts`) enforces "all sections have minutes, or none and `whole_test_minutes` is set". `assertSectionsSettings` calls it. `createMockFromBlueprint` now copies minutes (sectional) or sets `whole_test_minutes` (not sectional) and copies marks and penalties per section.
- **Why.** The even split and the unused `marks_per_question` made a full mock differ from the real exam. This closes both gaps listed in the EXP-6 section above (gaps 1 and the marks note).
- **Considered and rejected.** Scaling bank points in module 04 (the bank must stay untouched); one default penalty for the whole assessment (blueprints may differ per section).
- **Not included.** UI to edit the new keys (the admin SectionsEditor still writes `minutes` only), draw by node (Z-43 covers blueprints, not sections).
- **Tests.** `src/__tests__/sections-settings.test.ts`, `src/__tests__/mock-from-blueprint.test.ts`.
- **Z-42 hardening.** `updateAssessment` also locks `settings.whole_test_minutes` and `settings.scoring.negative_marks_default` (409 `SECTIONS_LOCKED`) once an attempt exists; test in `src/__tests__/sections-locked.test.ts`.

### Publish review gate (EXP-18, 2026-10-18)

- **What.** `publishAssessment` (module 05, `service/lifecycle.ts`) refuses with 422 `QUESTIONS_NOT_VERIFIED` while any ACTIVE question of the assessment's (pack, level) pool has `review_state` of `in_review`, `disputed` or `needs_fix`. `details` carries `count` (total) and `question_ids` (ids only, first 50). The check runs after the entitlement and pool-size checks and before the status change, in the same tenant transaction, so a blocked publish writes nothing.
- **Why the whole (pack, level) pool.** `freezeAssessmentPool` snapshots that whole set, and the whole-pool, section, blueprint-category and Z-43 node draws all read the frozen set. One check covers every draw path. A blueprint that draws only one category still waits for the other unverified questions of that pool (strict, simple, no false pass).
- **NULL does not block.** `review_state IS NULL` means no verification concept (legacy and ungated content). 0194 grandfathered every active question as `verified`. So existing assessments and packs publish exactly as before. Archived and draft questions are outside the pool and never block.
- **Considered and rejected.** Blocking NULL too: the row says "not verified", but no route or screen sets `review_state` yet (only `repository.updateQuestion` can), so a NULL block would stop every new tenant-authored question from ever publishing. Reopen is not gated (its freeze is a no-op for a normally published assessment).
- **Not included (rest of row EXP-18).** Done in part 2 (next section): review screen, audit rows, bulk verify, `in_review` on import, the invite and resend gate. Still open: organisation upload (EXP-17), clone reset (decided: clones keep the state).
- **Tests.** `src/__tests__/publish-review-gate.test.ts` (blocked, allowed after verify, NULL regression, archived, sections, blueprint category and node, tenant isolation).
- **Rollback.** Remove the `listUnverifiedPoolQuestions` call in `publishAssessment`.

### Invite and resend gate, and the publish race (EXP-18 part 2, 2026-10-18)

- **What.** `inviteUsers`, `resendInvitation`, `resendInvitations` (one check before the loop), and `reopenInvitationForRetake` call `assertPoolVerifiedForInvites` (`service/_shared.ts`). It refuses with 422 `QUESTIONS_NOT_VERIFIED` (same code and `details` as publish) while a question in the assessment's FROZEN pool is `in_review`, `disputed` or `needs_fix`. An assessment with no frozen rows (published before migration 0096) is checked against the live (pack, level) pool. NULL passes.
- **Why the frozen pool.** It holds the questions candidates really get. A question activated later and not in the frozen pool does not block (test). A frozen question flagged `needs_fix` after publish blocks new invites until it is verified.
- **Race.** Before: the pool check and the freeze were separate statements. Now: (1) `listUnverifiedPoolQuestions` first share-locks the pool rows (`FOR SHARE`, id order); a concurrent review write waits for our commit, or committed first and is read. (2) After the freeze, `listUnverifiedFrozenQuestions` re-checks the rows the freeze captured (this also covers a question activated as `in_review` between the check and the freeze). A failure throws, so the status change and the frozen rows roll back together.
- **Considered and rejected.** A table lock on `questions` (blocks all writers). Only a re-check without the lock (a review write could still land between the re-check and the commit). Gating `reopenAssessment` (its freeze is a no-op and no link is sent). Gating `grantExtraAttempt` (no link is sent).
- **Not included.** The review screen and writers (module 04), EXP-20 (frozen pool and a later withdraw).
- **Downstream.** Admin invite and resend screens show the server message. Module 04 review writes use `FOR UPDATE` in id order, which pairs with these locks.
- **Tests.** `src/__tests__/publish-review-gate.test.ts`: invite blocked and then allowed, NULL passes, a late unverified question does not block, resend blocked, publish waits for an uncommitted Needs fix and then refuses (the race), a review committed after publish blocks invites.
- **Rollback.** Remove the `assertPoolVerifiedForInvites` calls and the post-freeze re-check; the share-lock in `listUnverifiedPoolQuestions` can stay.

## Clear empty drafts (Q44, 2026-10-19)

`clearEmptyDrafts(tenantId, ids, userId)` in `service/lifecycle.ts` backs `POST /api/admin/assessments/clear-empty-drafts`. Empty means draft, zero attempts and zero invitations. It runs in one `withTenant` transaction. Each eligible row is audited as `assessment.deleted` (with `after: {bulk: true}`) and then deleted, like `deleteAssessment`. Other rows are skipped with a reason (`not_draft`, `has_attempts`, `has_invitations`, `not_found`). Other-tenant ids are invisible under RLS, so they are `not_found`. Not included: no soft delete and no undo. The admin list status tabs (All, Drafts, Live, Finished) are client-side groups of the single-status list API; the API is unchanged.

## Test type: real exam or mock test (Z-89, 2026-10-20)

- **What.** `assessments.delivery_mode` is the default test type. `assessment_invitations.delivery_mode` is the type of one invitation. Values: `real` (default) or `mock`. `inviteUsers(tenantId, assessmentId, userIds, actor, deliveryMode?)` stores the mode on the new invitation. The default is the assessment's mode. A re-invite of a dead, never-started invitation can switch the mode. Create and update accept `delivery_mode` (update is draft-only like every other edit). The route and the service validate it by hand: any other value is `400 INVALID_PARAM`. The invitation list and the assessment detail return it. The audit rows (`assessment.invite`, `assessment.update`) include it.
- **Why.** The type decides the rules at start: real = laptop or desktop only plus a readiness check (module 06); mock = any device, no certificate, kept out of real reports. The admin decides on the server. The candidate cannot change it.
- **Attempt allowance.** The `attempts_used` counts in `resolveInvitationToken` and in the invitation list count only attempts with the same mode as the invitation (a mock does not use up the real allowance).
- **Rejected.** A candidate-chosen mode (a bypass). A per-organisation opt-out of the desktop rule (owner: no opt-out).
- **Not included.** A secure or lockdown browser. Camera, photos and video (Wave 2). Credit burn by type (Z-93). The mock dashboard (Z-90).
- **Downstream.** Module 06 copies the mode to the attempt. Module 09 skips the certificate for a mock. Module 15 reports count real attempts only. UI: invite form radio, Test type card, Mock badge in the invitation list.

## Camera line in invitation and reminder email (S39 follow-up, 2026-10-21)

- What: `email.ts` `sendInvitationEmail` and `sendReminderEmail` take `deliveryMode` (from the invitation row, never the request) and pass a plain `cameraRequired` boolean to 13-notifications. Callers set it in `service/invitations.ts` (invite, re-invite, resend) and `reminders.ts` (the claimed row).
- Rule: true only when `deliveryMode` is `real` and the injected resolver says yes. Mock, no tenant, no resolver or a resolver error give false; the email still goes out.
- How: module 05 cannot import module 06 (`lint:cross-module-deps`), so `setCameraRequiredResolver(isCameraRequired)` is called at boot in `apps/api/src/server.ts` and `worker.ts`. It is a module-level slot, not threaded through each service call (less wiring; one process, one resolver).
- Not included: a privacy notice link in the email; per-request override.

## Assessment time limit (2026-10-21)

- **What.** `assessments.duration_minutes` (migration `0233_assessment_time_limit.sql`; NULL = level time, else 1 to 600; `assertDurationMinutes`). `createAssessment`, `createAssessmentFromSet` and the draft `updateAssessment` accept it. `updateAssessmentDuration(tenantId, id, minutes | null, actor)` (route `PATCH /api/admin/assessments/:id/time-limit`) changes only this field in any status and writes one `assessment.updated` audit row with the old and new value in the same transaction. The read model adds `effective_duration_minutes` (detail and list joins) through `effectiveDurationMinutes` from module 00. `resolveInvitationToken` adds `level.effective_duration_minutes` next to the level's own `duration_minutes`.
- **Why.** Owner decision 2026-10-21: a manual time per assessment, no automatic suggestion.
- **Considered and rejected.** Automatic time from question count and difficulty. Per-section times. Opening the main `PATCH` after publish.
- **Not included.** Automatic or suggested time, per-question time, extra time for one candidate.
- **Downstream.** Module 06 reads the effective time at start. Module 10 has the field on Start a test and a Time limit card. Module 19 `available-sets` adds `level_minutes`.

## Change history

### 2026-10-21 — Assessment time limit (migrations 0233, 0234)

Folded from `docs/archive/2026-10-21-assessment-time-limit-change-record.md`. Commit `5f72240c` (also carries the camera pool-deadlock gate fix).

**What changed.**
- New optional column `assessments.duration_minutes` (migration `0233_assessment_time_limit.sql`). NULL means the level time. A number from 1 to 600 is the time in minutes.
- Effective time = `COALESCE(assessments.duration_minutes, levels.duration_minutes)`. One TS helper: `effectiveDurationMinutes` in `modules/00-core/src/pass-mark.ts`. Same rule as SQL in `modules/06-attempt-engine/src/routes.candidate.ts` (invited list) and in the 05 repository joins (`effective_duration_minutes`).
- Places that use the effective time: `modules/05-assessment-lifecycle/src/service/invitation-token.ts` (invitation preview, `level.effective_duration_minutes`); `modules/06-attempt-engine/src/routes.take.ts` (`/take/start` preview and start); `routes.candidate.ts` (`GET /api/me/assessments`); `modules/06-attempt-engine/src/service.ts` `startAttempt` (`ends_at` and `duration_seconds`); the admin detail and list read model (`effective_duration_minutes`).
- API: create, from-set and draft `PATCH` accept `duration_minutes`. New `PATCH /api/admin/assessments/:id/time-limit` works in any status.
- UI: a "Time limit (minutes)" field on Start a test (hidden for a full mock) and a "Time limit" card on the assessment detail page.
- Help: migration `0234_assessment_time_limit_help.sql`, two keys (`admin.start_test.time_limit`, `admin.assessments.time_limit`). Help count 587 to 589.
- Billing `available-sets` adds `level_minutes` so the form can show the level default as placeholder.

**Why.** Owner decision 2026-10-21. The level set the time and the admin could not change it for one test. The admin now types a number. There is no automatic suggestion.

**Considered and rejected.** Automatic suggestion from question count and difficulty (the owner wants a manual field). Per-section times (sections already have their own times). Opening the main `PATCH` to published assessments (a small dedicated route, like `/integrity`, keeps the change narrow).

**Not included.** Automatic or suggested time, per-question time, extra time for one candidate. A change to a running attempt: it keeps the seconds it copied at start. Full mock and sectioned assessments: their own section or whole-test time still wins in `startAttempt`.

**Downstream.** 06: `startAttempt` and the two candidate reads. 10: new field and card. 16: two help keys. 19: `level_minutes` on `available-sets`. 14: the update audit row carries `duration_minutes` before and after.

**How to verify.**
1. `pnpm exec vitest run modules/06-attempt-engine/src/__tests__/time-limit.test.ts`.
2. `pnpm exec vitest run modules/10-admin-dashboard/src/__tests__/start-test.test.tsx`.
3. On a test system: start a test with 20 minutes, open the invitation link, check the welcome page shows 20 minutes.

**Rollback.** Leave the column NULL for every assessment (`UPDATE assessments SET duration_minutes = NULL`) and revert the code. The migration stays; the column is harmless.

**Review gate (2026-10-21).** One Sonnet-takeover gate. Verdict revise (one medium, rest low), plus a check of the two package version bumps in the other session's commit (accept).
- Fixed (medium): the card and the route accepted a time limit on a test with sections or a whole-test timer, where `startAttempt` uses the section minutes. The screen would have said "30 minutes" while the clock used the section total. Now the server refuses a non-empty value there (`TIME_LIMIT_NOT_ALLOWED`, 400; create, main PATCH and `PATCH .../time-limit`) and the card is hidden for those tests. Clearing the limit (null) is always allowed. Test: `time-limit.test.ts` (6 tests).
- Accepted, low: the pre-start preview and the invited list show the override or the level time and ignore section or whole-test time (the old code did the same). The time-limit edit is allowed in any status including closed (a running attempt keeps its copied time; a new start after an edit gets the new time, by design).
- Dependency bumps (fastify patch in 07-ai-grading and 14-audit-log, minor and patch bumps in the lockfile): no new package, no install script, no registry change.

## Z-42 S42: blueprint timer and marks applied (2026-10-22)

- **What.** `AssessmentBlueprintSchema.marks_per_question` is now a whole number 1 to 1000 (`.int()`, min 1; 0 and 2.5 are refused because `attempt_questions.points` is an INT). Module 06 `startAttempt` reads `settings.blueprint.whole_test_minutes` and `marks_per_question` (see its SKILL.md).
- **Timer precedence (rule).** 1) `settings.whole_test_minutes` with sections (S21, unchanged); 2) `settings.blueprint.whole_test_minutes`; 3) section minutes total; 4) `assessments.duration_minutes`; 5) level `duration_minutes`. A blueprint test has no sections, so 1 and 3 do not meet 2. `assertDurationAllowedFor` is NOT changed: a blueprint test may keep `duration_minutes`, it is ignored while the blueprint minutes are set (the guard stays for `settings.whole_test_minutes` and sections).
- **Why.** The blueprint fields were stored but ignored (Z-51 option b). **Rejected:** refusing `duration_minutes` next to blueprint minutes (it would break assessments that already hold both); scaling points per section (marks are one value for the whole blueprint). **Not included:** admin UI changes beyond the help text; negative marks for blueprint tests (the question's own penalty or the assessment default stays). **Downstream:** module 09 reads the frozen points unchanged; help keys v2 (migration 0240).
- **Tests.** `src/__tests__/blueprint-whole-test.test.ts` (0 and 2.5 refused); 06 `whole-test-timer.test.ts` (set, empty, running attempt).


## S50 additions (2026-10-22)
- A section may name `pack_id` (EXP-23). It must be a published pack of the tenant (checked at create and PATCH). Publish and reopen check the entitlement of every section pack. The freeze adds the section packs' questions at the same level position and stores `assessment_frozen_pool.pack_id` (NULL = old pool = the assessment pack). A pack with no level at that position fails the fill check.
- `revokeInvitation` also ends the candidate's `in_progress` attempt in the same transaction (GATE-8 A3-2; see the 2026-10-22 update below: it submits and grades it); the audit row carries `submitted_attempt_ids`. The frozen pool also stores `node_ids` (FUT-8).

- Update 2026-10-22: `revokeInvitation` SUBMITS and GRADES a running attempt (not cancelled): module 06's `submitAttemptForRevokeInTx` is injected at boot with `setRevokeAttemptSubmitter` (`service/revoke-submitter.ts`); no submitter registered = the revoke fails and rolls back. Audit `after.submitted_attempt_ids`.

## EXP-37 (2026-10-23)
- `assertInviteCapacity` (`service/_shared.ts`) refuses with 409 `INVITE_LIMIT_EXCEEDED` when the active invitations (pending, viewed, started) of one assessment plus the new ones pass the plan limit. Called by `inviteUsers` (once per batch, before any insert or mail), resend of a revoked invitation, and reopen for retake. A per-assessment advisory lock serialises concurrent invites. A refusal writes the audit action `assessment.invite_limit_blocked` and calls `notifyInviteLimitBlocked` (module 13, best effort, once per assessment per day).


## Test-type cards (Z-142, Z-145, Z-147, Z-152; 2026-10-24)

- **What.** `assessments.camera_required` (migration 0259) plus `delivery_mode` give the three cards: Mock, Real, Real + camera. `assertTypeCard` (service/assessments.ts) enforces: camera with mock gives 422 INVALID_PARAM; a Real assessment with an integrity switch off in a SENT body gives 409 INTEGRITY_FIXED; camera tests also need `assertCameraTestAllowed` (02-tenancy) on create and PATCH (switch on, school camera on) and with the notice confirmed on publish and invite. Type and camera change only while draft (ASSESSMENT_NOT_DRAFT). The invitation takes the assessment mode; the invite body no longer reads `delivery_mode`.
- **Feedback.** `settings.feedback_level` is validated by `assertFeedbackLevel` (create, from-set, PATCH). Only a Mock attempt that is not embed shows it (06 and 13 read it).
- **Credit hold.** `assertCreditsAvailable` (service/_shared.ts) runs before `assertInviteCapacity` in `inviteUsersTx`, the resend of a revoked row and the reopen. Lock order: per-tenant `credit_hold` advisory lock first, then per-assessment `invite_limit`. `precheckInvites` and `POST /api/admin/assessments/precheck-invites` run the same two asserts read-only (import and Start a test call it first).
- **Why / rejected / not included.** See docs/plans/test-type-cards-plan.md. Not included: a rollback of a published assessment; a credit check on the resend of a pending invitation whose link already lapsed.


## Limits and scopes (S59, 2026-10-25)

- **100-question cap.** `MAX_QUESTIONS_PER_ASSESSMENT` (`types.ts`) and `assertQuestionLimit` (`service/assessments.ts`, called from create and update). Module 06 keeps a copy of the number and re-checks at `startAttempt`. API detail: `docs/03-api-contract.md`.
- **Mock scopes.** One engine, three scopes: full blueprint (`createMockFromBlueprint`), chosen subjects and smaller size (`section_positions`, `scale_percent`, EXP-35), chosen topics (`service/drill.ts`, `POST /api/admin/drills`, EXP-11). All are mocks and burn mock credits. The topic scope has no admin screen yet and no student entry.
- **Section draw rules.** `allowed_types`, `difficulty_min`, `difficulty_max` (EXP-34, FUT-9), enforced in module 06.
