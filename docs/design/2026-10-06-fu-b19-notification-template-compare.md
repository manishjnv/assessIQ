# FU-B19 — Rule B compare: parked templates vs their live equivalents (2026-10-06)

Design note only, no code change. Compares the Zod var schemas in
`modules/13-notifications/src/types.ts`.

## `attempt_graded_candidate` (parked) vs `result_released` (live, SP4)

| Field | `attempt_graded_candidate` | `result_released` |
|---|---|---|
| `candidateName` | yes | yes |
| `assessmentName` | yes | yes |
| `tenantName` | yes | yes |
| `resultsLink` / `portalLink` | `resultsLink` — optional | `portalLink` — **required** |
| `scoreText` | **missing** | yes (e.g. "42 / 60 (70%)") |
| `resultText` (`Passed`/`Not passed`) | **missing** | yes |
| `certificateLink` | **missing** | yes (optional) |

**What `attempt_graded_candidate` lacks that `result_released` has:** the score
itself, the pass/fail text, and the certificate link. It is a weaker, link-only
"your result is ready, go look" shape — `result_released` is the complete,
owner-rule-compliant shape (P1: "students see only a complete score").

**What `attempt_graded_candidate` has that `result_released` lacks:** nothing.
`resultsLink` is the same concept as `portalLink`, just optional instead of
required — a strict subset.

**Conclusion.** `result_released` fully supersedes `attempt_graded_candidate`.
No field needs to be carried over. Keep the old template file (Rule A) with
the "parked" marker added in `modules/13-notifications/SKILL.md` (FU-B22).

## `attempt_ready_for_review_admin` (parked) vs `evaluation_queue_alert` (live, SP11)

| Field | `attempt_ready_for_review_admin` | `evaluation_queue_alert` |
|---|---|---|
| `tenantName` | yes | — (platform-level, not tenant-scoped) |
| `candidateName` | yes | **missing** |
| `assessmentName` | yes | **missing** |
| `attemptId` | yes | **missing** |
| `reviewLink` (per-attempt) | yes, required | **missing** |
| `count` (queue depth) | **missing** | yes |
| `oldestAgeHours` (age/urgency) | **missing** | yes |
| `queueLink` (platform queue, not one attempt) | **missing** | yes |

**What `attempt_ready_for_review_admin` has that `evaluation_queue_alert`
lacks:** everything that identifies *one* attempt — candidate, assessment,
attempt id, a direct per-attempt review link.

**What `evaluation_queue_alert` has that `attempt_ready_for_review_admin`
lacks:** aggregate signals — how many are waiting, how old the oldest is, and
a link to the whole queue rather than one item.

**Conclusion.** These are not strict supersets of each other — they are two
different notification *shapes* (per-item vs aggregate). `evaluation_queue_alert`
is the one actually wired (hourly worker job, SP11). `attempt_ready_for_review_admin`
is a per-attempt alert that was never wired to a send call site; it would only
be worth reviving if the platform queue needs a "this specific attempt just
became reviewable" push in addition to the hourly aggregate. No current task
asks for that. Keep parked (Rule A); marker added in `modules/13-notifications/SKILL.md`
(FU-B22).

## `weekly_digest_admin` (parked, no comparison target)

No newer template replaces it — it has no live equivalent to compare against.
It is parked because no digest-email feature was ever built (the Pulse kit
mockup inspired only the *visual philosophy*, not a new product surface — see
`docs/13-email-system.md` § 0, point 1). Marker added in
`modules/13-notifications/SKILL.md` (FU-B22).
