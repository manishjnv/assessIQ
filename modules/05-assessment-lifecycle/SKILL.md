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
