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
