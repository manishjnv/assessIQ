# 06-attempt-engine — Taking the assessment

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

## Public surface
```ts
startAttempt({ userId, assessmentId, invitationToken? }): Promise<Attempt>
getAttemptForCandidate(attemptId): Promise<{ attempt, questions[], remainingSeconds }>
saveAnswer(attemptId, questionId, payload): Promise<void>
toggleFlag(attemptId, questionId): Promise<{ flagged: boolean }>
recordEvent(attemptId, event): Promise<void>
submitAttempt(attemptId): Promise<{ status: 'grading' }>

// background
sweepStaleTimers(): Promise<{ autoSubmitted: number }>   // cron every 30s
```

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
Owns: `attempts`, `attempt_questions`, `attempt_answers`, `attempt_events`.

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

## Open questions
- Live grading status updates via WebSocket vs polling — start with polling, add WS in Phase 3 if perceived latency matters
- Mid-attempt "save and resume later" — explicitly NOT supported in v1; once started, must finish or abandon
