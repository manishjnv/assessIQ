# Assessment time limit - change record (2026-10-21)

*Type: explanation and reference.*

## What changed

- New optional column `assessments.duration_minutes` (migration `0233_assessment_time_limit.sql`). NULL means the level time. A number from 1 to 600 is the time in minutes.
- Effective time = `COALESCE(assessments.duration_minutes, levels.duration_minutes)`.
  - One TS helper: `effectiveDurationMinutes` in `modules/00-core/src/pass-mark.ts`.
  - Same rule as SQL in `modules/06-attempt-engine/src/routes.candidate.ts` (invited list) and in the 05 repository joins (`effective_duration_minutes`).
- Places that now use the effective time:
  - `modules/05-assessment-lifecycle/src/service/invitation-token.ts` (invitation preview, `level.effective_duration_minutes`).
  - `modules/06-attempt-engine/src/routes.take.ts` (`/take/start` preview and start).
  - `modules/06-attempt-engine/src/routes.candidate.ts` (`GET /api/me/assessments`).
  - `modules/06-attempt-engine/src/service.ts` `startAttempt` (`ends_at` and `duration_seconds`).
  - Admin detail and list read model (`effective_duration_minutes`).
- API: create, from-set and draft `PATCH` accept `duration_minutes`. New `PATCH /api/admin/assessments/:id/time-limit` works in any status.
- UI: a "Time limit (minutes)" field on Start a test (hidden for a full mock) and a "Time limit" card on the assessment detail page.
- Help: migration `0234_assessment_time_limit_help.sql`, two new keys (`admin.start_test.time_limit`, `admin.assessments.time_limit`). Help count 587 to 589.
- Billing `available-sets` adds `level_minutes` so the form can show the level default as placeholder.

## Why

Owner decision 2026-10-21. The level set the time, and the admin could not change it for one test. The admin now types a number. There is no automatic suggestion.

## Options rejected

- Automatic suggestion from question count and difficulty: the owner wants a manual field.
- Per-section times: the sections feature already has its own times.
- Opening the main `PATCH` to published assessments: a small dedicated route, like `/integrity`, keeps the change narrow.

## Not included

- Automatic or suggested time, per-question time, extra time for one candidate.
- A change to a running attempt: it keeps the seconds it copied at start.
- Full mock and sectioned assessments: their own section or whole-test time still wins in `startAttempt`.

## Effect on other modules

- 06: `startAttempt` and the two candidate reads (above).
- 10: new field and card. 16: two help keys. 19: `level_minutes` on `available-sets`.
- 14: the update audit row now carries `duration_minutes` before and after.

## How to verify

1. `pnpm exec vitest run modules/06-attempt-engine/src/__tests__/time-limit.test.ts`.
2. `pnpm exec vitest run modules/10-admin-dashboard/src/__tests__/start-test.test.tsx`.
3. On a test system: start a test with 20 minutes, open the invitation link, check the welcome page shows 20 minutes.

## Rollback

Leave the column NULL for every assessment (`UPDATE assessments SET duration_minutes = NULL`) and revert the code. The migration stays; the column is harmless.

## Review gate (2026-10-21)

One Sonnet-takeover gate on this change. Verdict revise (one medium, rest low), plus a check of the two package version bumps in the other session's commit (accept).

- Fixed (medium): the card and the route accepted a time limit on a test with sections or a whole-test timer, where `startAttempt` uses the section minutes. The screen would have said "30 minutes" while the clock used the section total. Now the server refuses a non-empty value there (`TIME_LIMIT_NOT_ALLOWED`, 400; create, main PATCH and `PATCH .../time-limit`) and the card is hidden for those tests. Clearing the limit (null) is always allowed. Test: `time-limit.test.ts` (6 tests).
- Accepted, low: the pre-start preview and the invited list show the override or the level time and ignore section or whole-test time (the old code did the same); the time-limit edit is allowed in any status including closed (a running attempt keeps its copied time; a new start after an edit gets the new time, by design).
- The dependency bumps (fastify patch in 07-ai-grading and 14-audit-log, minor and patch bumps in the lockfile): no new package, no install script, no registry change.
