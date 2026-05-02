# 06-attempt-engine — Taking the assessment

> **Status (2026-05-02):** Phase 1 G1.C Session 4a — **candidate-side core LIVE.** Migrations 0030-0033, repository, service, candidate routes, testcontainer integration tests all shipped. **Deferred to Session 4b:** BullMQ runtime for `sweepStaleTimersForTenant` (apps/worker doesn't exist yet — pure logic ships now and is forward-callable from cron); magic-link `/take/:token` flow; embed routes; Redis-backed rate cap (in-process bucket today, multi-replica scale-out goal). `codex:rescue` adversarial sign-off mandated for Session 4b — embed JWT + magic-link surfaces are security-adjacent.

## Purpose
Run the candidate's assessment session: render questions, autosave answers, enforce timer, capture behavioral signals, accept submission. Same engine serves standalone and embedded modes.

## Scope
- **In:** start attempt (server-side guarded against double-start), serve question set + remaining time, persist answer updates with optimistic concurrency, capture `attempt_events` (visibility, paste, copy, edit), enforce timer with server authority, auto-submit on timeout, final submit (idempotent), client-side reconnection handling.
- **Out:** grading (07), result display (rendered by 11-candidate-ui after release), notifications (13).

## Dependencies
- `00-core`, `02-tenancy`
- `01-auth` (candidate session), `03-users` (record context)
- `05-assessment-lifecycle` (validates assessment is `active`, invitation is valid)
- `04-question-bank` (resolves frozen `question_versions`)
- `07-ai-grading` (enqueues grading job on submit)
- `13-notifications` (submission ack email)

## Public surface (LIVE)

```ts
// Candidate-side ops — all RLS-scoped via withTenant(tenantId, ...).
startAttempt(tenantId, { userId, assessmentId }): Promise<Attempt>
getAttemptForCandidate(tenantId, attemptId, userId): Promise<CandidateAttemptView>
saveAnswer(tenantId, userId, { attemptId, questionId, answer, client_revision?, edits_count?, time_spent_seconds? }): Promise<{ client_revision }>
toggleFlag(tenantId, userId, { attemptId, questionId, flagged }): Promise<{ flagged }>
recordEvent(tenantId, userId, { attemptId, event_type, question_id?, payload? }): Promise<AttemptEvent | null>
submitAttempt(tenantId, userId, attemptId): Promise<{ attempt, status: 'submitted' }>

// Reads
listAnswersForAttempt(tenantId, userId, attemptId): Promise<AttemptAnswer[]>

// Cron-callable boundary helper — ships pure, BullMQ runtime deferred.
sweepStaleTimersForTenant(tenantId, now?): Promise<{ autoSubmitted, attemptIds }>
```

`CandidateAttemptView = { attempt, questions: FrozenQuestion[], answers: AttemptAnswer[], remaining_seconds }`. The `rubric` column is intentionally NEVER selected — candidates must not see grading anchors / band thresholds.

## HTTP surface (LIVE — `/api/me/*`, candidate-only auth chain)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET    | `/api/me/assessments`              | — | `{ items: invited-and-active assessments }` |
| POST   | `/api/me/assessments/:id/start`    | — | `201 Attempt` (idempotent on second call) |
| GET    | `/api/me/attempts/:id`             | — | `200 CandidateAttemptView` |
| POST   | `/api/me/attempts/:id/answer`      | `{ question_id, answer, client_revision?, edits_count?, time_spent_seconds? }` | `204` + `X-Client-Revision` header |
| POST   | `/api/me/attempts/:id/flag`        | `{ question_id, flagged }` | `200 { flagged }` |
| POST   | `/api/me/attempts/:id/event`       | `{ event_type, question_id?, payload? }` | `201 AttemptEvent` or `204` (rate-cap dropped) |
| POST   | `/api/me/attempts/:id/submit`      | — | `202 { attempt_id, status: 'submitted', estimated_grading_seconds: null }` |
| GET    | `/api/me/attempts/:id/result`      | — | `202 { status: 'grading_pending', message }` (Phase 1 placeholder; Phase 2 returns released results) |

## Time enforcement
Server is source of truth. Client computes remaining time from `attempt.started_at + duration` provided by server, but every save/submit re-checks server-side. If `now > ends_at`, server ignores answer writes and auto-submits.

A periodic sweeper (BullMQ repeating job, every 30 seconds) finds attempts in `in_progress` past their `ends_at` and auto-submits them with status `auto_submitted`.

## Behavioral signals captured
Stored in `attempt_events` for downstream analysis (09-scoring uses these for archetype):
- `question_view` (question_id, at)
- `answer_save` (question_id, at, edits_count)
- `flag` / `unflag`
- `tab_blur` / `tab_focus` (visibility transitions)
- `copy` / `paste`
- `nav_back` (jumped backwards)
- `time_milestone` (per-question time crossed thresholds)

These power the **archetype** computation (e.g., `methodical_diligent`, `fast_then_slow`, `last_minute_rusher`) — see `09-scoring`.

## Data model touchpoints
Owns: `attempts`, `attempt_questions`, `attempt_answers`, `attempt_events`. See migrations `0030-0033`.

- `attempts` is tenant-bearing (standard RLS variant). The three child tables use JOIN-RLS through `attempt_id → attempts.tenant_id` and are forward-declared in `tools/lint-rls-policies.ts`.
- `attempts.duration_seconds` is pinned at start time from `level.duration_minutes`; admin edits to the level mid-attempt do NOT shift the candidate's timer.
- `attempt_events` carries a partial UNIQUE index on `(attempt_id) WHERE event_type='event_volume_capped'` enforcing the cap-once invariant (decision #23).

## Edge routing

Every HTTP path mounted by this module starts with `/api/` (admin routes ship in Phase 2; Session 4b adds `/embed` and `/take/<token>`). The Caddy `@api` matcher already covers `/api/*` — no additive change required for Session 4a. Session 4b WILL require adding the bare-root `/take/*` path (and possibly `/embed*` if not already covered) — see `docs/RCA_LOG.md` 2026-05-02 § "Caddy `/help/*` not forwarded" for the inode-preserving truncate-write procedure.

## Idempotency
Submit is idempotent — calling twice returns the same result. Achieved by checking `attempts.status` on entry; if already `submitted/grading/graded/released`, return current state without re-processing.

## Help/tooltip surface
- `candidate.attempt.timer` — what happens when timer hits zero
- `candidate.attempt.flag` — flagging mechanics
- `candidate.attempt.kql.editor` — KQL editor capabilities, no execution
- `candidate.attempt.subjective.length` — expected length, structure tips
- `candidate.attempt.scenario.steps` — linear stepping, can't skip back if dependency
- `candidate.attempt.submit.confirm` — what happens after submit (grading time, when results visible)
- `candidate.attempt.disconnect` — what to do if connection drops (autosaves on reconnect)

## Open questions / deferred work

- **BullMQ scheduler runtime** — `sweepStaleTimersForTenant` ships as pure idempotent logic. apps/worker doesn't exist yet (no BullMQ in any package.json); admins manually trigger it via the routes layer in tests today. Session 4b or a side-quest will add apps/worker + a 30s repeating job per active tenant. Until then the auto-submit ALSO fires opportunistically inside `getAttemptForCandidate` whenever a candidate hits the endpoint past their `ends_at` — that's the safety net.
- **Magic-link `/take/<token>` flow** — the candidate-session minting half is deferred to Session 4b. Phase 1 G1.C Session 4a admits attempts via the existing candidate auth chain (`requireAuth({ roles: ['candidate'] })`), assuming the candidate is already logged in. The token-bearing entry point lands with embed in 4b.
- **Embed routes** (`/embed?token=<JWT>`) — Phase 4 territory; Session 4b lays the groundwork.
- **Redis-backed rate cap** — Phase 1 ships an in-process `Map<attemptId, bucket>` token bucket in `src/rate-cap.ts`. Per-process buckets are fine while apps/api is single-replica; multi-replica scale-out (Phase 3+) requires moving to Redis (`aiq:attempt:<id>:events`).
- **`pending_admin_grading`/`graded`/`released` transitions** — the `status` CHECK constraint accepts them today (forward-compatible) but `submitAttempt` stops at `'submitted'` per Phase 1 grading-free contract (decision #6, CLAUDE.md AssessIQ-specific rule #1). Phase 2 wires the transitions through the admin grading flow in module 07.
- Live grading status updates via WebSocket vs polling — start with polling, add WS in Phase 3 if perceived latency matters.
- Mid-attempt "save and resume later" — explicitly NOT supported in v1; once started, must finish or abandon.

## Decisions resolved (2026-05-02 — Session 4a)

- **Decision #6** — Phase 1 `submitAttempt` stops at `'submitted'`. Result endpoint returns `202 grading_pending` until Phase 2.
- **Decision #7** — Multi-tab autosave is **last-write-wins**, not blocking optimistic-lock. `client_revision` increments via SQL `GREATEST(stored, incoming) + 1`, guaranteed monotonic; `multi_tab_conflict` event is logged when `incoming < previous`. Implemented in `repository.saveAttemptAnswer`.
- **Decision #14** — Every `attempt_events.payload` shape is governed by a Zod schema in `src/types.ts` (`EVENT_PAYLOAD_SCHEMAS`). Unknown event types rejected with `AE_UNKNOWN_EVENT_TYPE`. Catalog is closed; canonical narrative in `EVENTS.md`.
- **Decision #19** — Frozen-version contract: `attempt_questions.question_version` JOINs `question_versions` to render the post-edit-immutable content. Verified by integration test "returns frozen content even after admin edits live question".
- **Decision #20** — Fisher-Yates shuffle with `Math.random()`; non-reproducible by design.
- **Decision #23** — Two-tier rate cap: in-process per-second bucket (10/sec, drop silently); DB-enforced per-attempt total (5000, single `event_volume_capped` marker via partial UNIQUE index).
