# 06-attempt-engine — Taking the assessment

> **Status (2026-05-02):** Phase 1 G1.C Session 4a — **candidate-side core LIVE.** Migrations 0030-0033, repository, service, candidate routes, testcontainer integration tests all shipped. **Deferred to Session 4b:** BullMQ runtime for `sweepStaleTimersForTenant` (shipped later in the `assessiq-worker` container, entry point `apps/api/src/worker.ts`, commit `2675e2f`; there is no `apps/worker` folder); magic-link `/take/:token` flow; embed routes; Redis-backed rate cap (in-process bucket today, multi-replica scale-out goal). `codex:rescue` adversarial sign-off mandated for Session 4b — embed JWT + magic-link surfaces are security-adjacent.
>
> **UI note (2026-05-20):** AttemptPage chrome is mobile-tuned via CSS only (M2a phase of MOBILE_KIT_PORT). Under `[data-viewport="mobile"]` the right navigator aside is hidden and is reachable via a `<Drawer>` opened by a new `aiq-attempt-nav-toggle` button in the header. **Integrity-hook surface, timer math, autosave debounce, and submit semantics are byte-identical to desktop** — the reflow is presentation only. Per-question-type mobile sizing shipped in M2b (2026-05-20): all sans textareas + the log-analysis finding `<input>` read `--aiq-answer-input-size` (15px desktop / 16px mobile); the KQL textarea reads `--aiq-answer-mono-size` (13px mono desktop / 16px mono mobile). The 16px floor on mobile defeats iOS Safari's auto-zoom-on-focus for form inputs. KQL also shows a mobile-only `aiq-attempt-kql-mobile-tip` caveat ("KQL is easier on a desktop browser") with a same-PR `candidate.attempt.kql.mobile_tip` help entry. **Grading semantics, autosave debounce, blur flush, and integrity-hook surface all unchanged across viewports.** See `docs/plans/archive/MOBILE_KIT_PORT.md` and `docs/10-branding-guideline.md § 15.3`.

## Timer starts at Begin, not at link-open (R4, 2026-10-01)

`POST /take/start` now has a read-only **preview** mode (`getTakePreview` in `service.ts`): the landing at `/take/:token` calls it, so opening the link creates no attempt and starts no clock. `startAttempt` (unchanged: it sets `started_at`/`ends_at` when it inserts the row) runs only from the **Begin** call, which also requires `consent: true` for a new attempt (`recordTakeConsent` appends a `consent_events` row, module 20 migration 0101, no new table or column). Resume = existing attempt, original `ends_at`, no consent needed; Begin twice is idempotent. The `attempts.status` enum and state machine are untouched. Rejected: adding a `draft`/not-started attempt row (extra state, second writer for the clock) and a new consent table. **Consent invariant is enforced in `startAttempt` itself** (step c2): any NEW non-embed attempt requires a `consent_events` row (purpose `data_processing`, current `TAKE_CONSENT_POLICY_VERSION`) else `422 CONSENT_REQUIRED`, so `/api/me/assessments/:id/start` cannot bypass `/take/start`; it accepts optional `{consent:true}` which records consent first. **Embed attempts (`embedOrigin: true`) are exempt: consent is host-asserted** (the host JWT authorises, host collects consent). `recordTakeConsent` is deduped (advisory lock + exists check) and `insertAttempt` runs under a SAVEPOINT: a concurrent-Begin unique violation (23505) re-reads and returns the winner's attempt (clock unchanged). Not included: per-attempt consent versioning beyond `TAKE_CONSENT_POLICY_VERSION`. Tests: `attempt-engine.test.ts` "take landing" block. Contract: `docs/03-api-contract.md` "POST /take/start modes".

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
| GET    | `/api/admin/attempts/:id/integrity` (admin chain) | — | `200 { tab_switches, copy, paste, paste_blocked, fullscreen_exits, multi_tab_conflicts }` |
| GET    | `/api/me/attempts/:id/result`      | — | `200 { status: 'released', ... }` when the result is released; otherwise `202 { status: 'pending', ... }`. The candidate sees only a complete, released result (see `src/result.ts`; checked 2026-10-02) |

## Locked sections and per-question timer (FUT-4, FUT-7, 2026-10-22)

- **Keys.** Section `locked` (free movement only) and `seconds_per_question` (10 to 3600). Schema: `modules/05-assessment-lifecycle/src/types.ts`. Enforcement: `service.ts` (`assertFreeMovementSection`, `assertQuestionTimeOpen`, `recordPosition`). State: optional `entered` and `questions` keys in `attempts.section_progress`; every writer (`saveAnswer`, `toggleFlag`, `recordPosition`, `finishSection`) takes the row lock.
- **Why.** Free-movement exams (Z-42) need a "no going back" block and a per-question limit. Server-side, so the client cannot skip it.
- **Limits.** Soft question clock (see `docs/03-api-contract.md`, `POST /api/me/attempts/:id/position`); a block that was only viewed is not closed; the take page shows no countdown yet (Z-130); no admin screen (Z-131); every save in a sectioned test reads the assessment up to 3 times.
- **Not included.** Auto-advance, a migration.

## Time enforcement
Server is source of truth. Client computes remaining time from `attempt.started_at + duration` provided by server, but every save/submit re-checks server-side. If `now > ends_at`, server ignores answer writes and auto-submits.

A periodic sweeper (BullMQ repeating job, every 30 seconds) finds attempts in `in_progress` past their `ends_at` and auto-submits them with status `auto_submitted`.

## Integrity v1 (2026-10-01)
Why: campus-placement aptitude tests need basic anti-cheating signals. What: `assessments.settings.integrity = { fullscreen?, block_copy_paste? }` (default off, validated in 05) is surfaced on `CandidateAttemptView.integrity` so the runner can enforce it; the runner records `fullscreen_enter/exit` and `blocked` copy/paste. `getAttemptIntegritySummary(tenantId, attemptId)` returns `{ tab_switches, copy, paste, paste_blocked, fullscreen_exits, multi_tab_conflicts }` (counts from `attempt_events`, RLS via the attempts join); served at `GET /api/admin/attempts/:id/integrity` (`routes.admin.ts`, admin chain, tenant from session). Counts are not scores: visible regardless of release state. Not included: any enforcement beyond cancelling clipboard events and prompting for full screen (both can be bypassed by a determined candidate; the signals are evidence, not proof); AI; per-attempt penalties.

## Behavioral signals captured
Stored in `attempt_events` for downstream analysis (09-scoring uses these for archetype):
- `question_view` (question_id, at)
- `answer_save` (question_id, at, edits_count)
- `flag` / `unflag`
- `tab_blur` / `tab_focus` (visibility transitions)
- `copy` / `paste` (optional `blocked: true` when the assessment blocks them)
- `fullscreen_enter` / `fullscreen_exit` (Integrity v1)
- `nav_back` (jumped backwards)
- `time_milestone` (per-question time crossed thresholds)

These power the **archetype** computation (e.g., `methodical_diligent`, `fast_then_slow`, `last_minute_rusher`) — see `09-scoring`.

## Data model touchpoints
Owns: `attempts`, `attempt_questions`, `attempt_answers`, `attempt_events`. See migrations `0030-0033`.

- `attempts` is tenant-bearing (standard RLS variant). The three child tables use JOIN-RLS through `attempt_id → attempts.tenant_id` and are forward-declared in `tools/lint-rls-policies.ts`.
- `attempt_questions.option_order` (migration `0119`, nullable `SMALLINT[]`) is the per-attempt MCQ option permutation — see "Per-student MCQ option shuffle" below. Server-internal; never sent to a candidate.
- `attempts.duration_seconds` is pinned at start time from `level.duration_minutes`; admin edits to the level mid-attempt do NOT shift the candidate's timer.
- `attempt_events` carries a partial UNIQUE index on `(attempt_id) WHERE event_type='event_volume_capped'` enforcing the cap-once invariant (decision #23).

## Edge routing

Every HTTP path mounted by this module starts with `/api/` (admin routes ship in Phase 2; Session 4b adds `/embed` and `/take/<token>`). The Caddy `@api` matcher already covers `/api/*` — no additive change required for Session 4a. Session 4b WILL require adding the bare-root `/take/*` path (and possibly `/embed*` if not already covered) — see `docs/RCA_LOG.md` 2026-05-02 § "Caddy `/help/*` not forwarded" for the inode-preserving truncate-write procedure.

## Idempotency
Submit is idempotent — calling twice returns the same result. Achieved by checking `attempts.status` on entry; if already `submitted/grading/graded/released`, return current state without re-processing.

## MCQ scoring at submit (2026-10-01)
`submitAttempt`, `sweepStaleTimersForTenant` and the read-time auto-submit in `getAttemptForCandidate` call `@assessiq/scoring`'s `scoreMcqAndFinalizeIfComplete` in the same transaction: MCQ gradings rows are written (deterministic, no AI); an MCQ-only attempt is finalised to `graded` + billed + audited right there. Mixed attempts stay `submitted` for the admin AI flow. The candidate-facing response shape is unchanged (`status: "submitted"`); correctness is never exposed. Tests: `src/__tests__/mcq-submit-scoring.test.ts`.

## Per-student MCQ option shuffle (2026-10-01)
Question order was already random per attempt; option order was not, and the first real drive seats students side by side. Every attempt now gets its own option order for each eligible MCQ.

- **Storage.** Migration `0119_attempt_questions_option_order.sql` adds `attempt_questions.option_order SMALLINT[] NULL`, `option_order[displayPosition] = originalIndex`. It is drawn once, in `startAttempt` step (i), from the frozen `question_versions` options (`repo.listMcqOptionsForPicks`). That is the ONLY place `attempt_questions` rows are created: `/take/start`, `/api/me/assessments/:id/start` and the embed start (`apps/api/src/routes/auth/embed.ts`, `embedOrigin: true`) all call `startAttempt`, and module 12 has no attempt writer of its own. `NULL` = authored order: every attempt created before the migration, every non-MCQ, and every MCQ the helper cannot prove safe. Additive nullable column; the existing row-level RLS on `attempt_questions` (JOIN to `attempts.tenant_id`) already covers it, no policy change.
- **Eligibility** (`src/option-shuffle.ts`, pure, unit-tested in `option-shuffle.test.ts`). 2-8 non-empty string options and no option that refers to its siblings: "All/None of the above|these", "Both A and B", "A and C", "Either A or B", "Neither ... nor ...", "Only B", "Option C", "(a) and (b)", "1 and 3 only", "Same as above", "first/last option", options that carry their own label ("A. Paris") and so on. Deliberately conservative: a false positive only keeps that question in authored order, a false negative would scramble its meaning. Plain numeric / prose options ("12", "3.5", "2/3", "Isolate the host") are shuffled. **There is no per-assessment toggle** — always on for eligible MCQs. Kill switch: make `buildOptionOrder` return null (affects new attempts only).
- **Two translation seams, nothing else changes.** Stored answers stay in ORIGINAL index space, so scoring (`09-scoring/src/mcq.ts`), admin review (07/10, reads `question_versions.content` + `answer.selected`), results export, DSAR export and analytics need no change. (1) `saveAnswer`: the candidate sends the DISPLAYED index, `answerToOriginal` stores the original one. (2) `getAttemptForCandidate` / `listAnswersForAttempt`: `displayQuestions` serves the options in this attempt's order and `displayAnswers` maps the saved selection back to the displayed position, so a reload shows the same order and the same choice. `option_order` itself is never returned. The candidate UI is unchanged: it already sends the index into the `options` array it was served and letters A, B, C... by position.
- **Invalid input behaves exactly as before.** The server never validated MCQ answer shapes at save time (anything is stored; scoring credits only the correct integer). That is preserved: an out-of-range / non-integer / malformed answer on a shuffled MCQ is stored as sent and scores 0 — a translation never turns an invalid answer into a valid one. A bare integer on a shuffled MCQ is normalised to `{selected}`. No new 4xx.
- **Fail-safe.** A stored order that is not a valid permutation is treated as NULL on BOTH seams (`usableOrder`). An order whose length differs from its frozen options cannot occur (`question_versions` is insert-only and `attempt_questions.question_version` is pinned); if it ever did, the candidate read throws rather than silently mis-scoring.
- **Rollback.** Stored answers are always original-space, so reverting the code is safe for scoring and review; only a candidate mid-attempt would see the authored order again. Do not drop the column while shuffled attempts are in flight. **Deploy order: apply 0119 BEFORE the new code** (`saveAnswer` selects the column).
- **Considered and rejected.** Storing displayed indexes and un-mapping at scoring/admin/export (touches 09, 07, 10, 15, 20 and every future reader); a client-side shuffle (the server could not score it and a reload would reshuffle); a deterministic per-user seed (predictable, and a retry would not match a stored answer); a per-assessment toggle (not requested). **Not included:** shuffling scenario-step MCQs (answered as text), any change to modules 07/09/10/15, a hard 422 for out-of-range indexes (would be new behaviour). Tests: `src/__tests__/option-shuffle.test.ts` (pure), `src/__tests__/option-shuffle-attempt.test.ts` (testcontainers: start incl. embed, save/reload mapping, scoring, invalid index, legacy NULL attempt). Ops check: `SELECT count(*) FILTER (WHERE option_order IS NOT NULL), count(*) FROM attempt_questions`.

## Help/tooltip surface
- `candidate.attempt.timer` — what happens when timer hits zero
- `candidate.attempt.flag` — flagging mechanics
- `candidate.attempt.kql.editor` — KQL editor capabilities, no execution
- `candidate.attempt.subjective.length` — expected length, structure tips
- `candidate.attempt.scenario.steps` — linear stepping, cannot skip back if dependency
- `candidate.attempt.submit.confirm` — what happens after submit (grading time, when results visible)
- `candidate.attempt.disconnect` — what to do if connection drops (autosaves on reconnect)

## Open questions / deferred work

- **BullMQ scheduler runtime** — `sweepStaleTimersForTenant` ships as pure idempotent logic. The BullMQ runtime now exists: the `assessiq-worker` container runs `apps/api/src/worker.ts` (commit `2675e2f`). The auto-submit ALSO fires opportunistically inside `getAttemptForCandidate` whenever a candidate hits the endpoint past their `ends_at` — that is the safety net.
- **Magic-link `/take/<token>` flow** — the candidate-session minting half is deferred to Session 4b. Phase 1 G1.C Session 4a admits attempts via the existing candidate auth chain (`requireAuth({ roles: ['candidate'] })`), assuming the candidate is already logged in. The token-bearing entry point lands with embed in 4b.
- **Embed routes** (`/embed?token=<JWT>`) — Phase 4 territory; Session 4b lays the groundwork.
- **Redis-backed rate cap** — Phase 1 ships an in-process `Map<attemptId, bucket>` token bucket in `src/rate-cap.ts`. Per-process buckets are fine while apps/api is single-replica; multi-replica scale-out (Phase 3+) requires moving to Redis (`aiq:attempt:<id>:events`).
- **`pending_admin_grading`/`graded`/`released` transitions** — the `status` CHECK constraint accepts them today (forward-compatible) but `submitAttempt` stops at `'submitted'` per Phase 1 grading-free contract (decision #6, CLAUDE.md AssessIQ-specific rule #1). Phase 2 wires the transitions through the admin grading flow in module 07.
- Live grading status updates via WebSocket vs polling — start with polling, add WS in Phase 3 if perceived latency matters.
- Mid-attempt "save and resume later" — explicitly NOT supported in v1; once started, must finish or abandon.

## Decisions resolved (2026-05-02 — Session 4a)

- **Decision #6** — Phase 1 `submitAttempt` stops at `'submitted'`. Result endpoint returns `202 pending` until the result is released, then `200 released` (changed after Phase 1; see `src/result.ts`).
- **Decision #7** — Multi-tab autosave is **last-write-wins**, not blocking optimistic-lock. `client_revision` increments via SQL `GREATEST(stored, incoming) + 1`, guaranteed monotonic; `multi_tab_conflict` event is logged when `incoming < previous`. Implemented in `repository.saveAttemptAnswer`.
- **Decision #14** — Every `attempt_events.payload` shape is governed by a Zod schema in `src/types.ts` (`EVENT_PAYLOAD_SCHEMAS`). Unknown event types rejected with `AE_UNKNOWN_EVENT_TYPE`. Catalog is closed; canonical narrative in `EVENTS.md`.
- **Decision #19** — Frozen-version contract: `attempt_questions.question_version` JOINs `question_versions` to render the post-edit-immutable content. Verified by integration test "returns frozen content even after admin edits live question".
- **Decision #20** — Fisher-Yates shuffle with `Math.random()`; non-reproducible by design.
- **Decision #23** — Two-tier rate cap: in-process per-second bucket (10/sec, drop silently); DB-enforced per-attempt total (5000, single `event_volume_capped` marker via partial UNIQUE index).


## Candidate result contract (SP3, 2026-10-01)

Owner rules: **P1** a candidate sees only a complete, final score (never partial / per-question / bands); **P2** if it will not be ready within ~1 minute say so at submit and point to the email. Code: `src/result.ts`.
- `POST /api/me/attempts/:id/submit` (202) adds `result_expectation` (`'soon'` iff tenant `result_release_mode='auto'` with `result_release_auto_since` set AND every attempt question is MCQ AND not an embed attempt, else `'email'`), `release_mode`, `email_masked` (`r***@gmail.com`), `turnaround_text` (config `EVALUATION_TURNAROUND_TEXT`, default "within 72 hours"); `estimated_grading_seconds` = 60 for `'soon'`, else null. The expectation lookup can never fail a submit (falls back to the conservative email promise).
- `GET /api/me/attempts/:id/result` — `released` (and a score row exists) → 200 `{status:'released', total_earned, total_max, percent (1 dp), passed (>= levels.passing_score_pct), assessment_name, released_at (grading.released audit row), certificate|null}`; otherwise 202 `{status:'pending', result_expectation, release_mode, email_masked, turnaround_text, tenant_name}`. Another candidate's attempt → 404.
- `GET /api/me/results` — released attempts only, newest release first.
- Migration `0113` adds `attempts.evaluation_released_at/_by/_note/_sent_back_at` (+ partial index for the sweep). A single finalize path sets `evaluation_released_at`; MCQ-only attempts are complete at submit.

## Frozen question points (E12, migration 0128)

`attempt_questions.points` (INT NOT NULL) is `questions.points` AT ATTEMPT START. `repository.insertAttemptQuestions` (the only INSERT site; standard and embed starts both go through `startAttempt`) writes it via `(SELECT points FROM questions WHERE id = …)` in the same statement that freezes `question_version`.
- **Why:** points live on the `questions` row, not in `question_versions`. Scoring read the live value, so a super admin editing a published question's points (04 `updateQuestion`) changed the score of every candidate not yet graded. Scoring now reads the frozen copy (09 `mcq.ts`; 07 `admin-grade`, `admin-rerun`, `admin-manual-score`, `admin-claim-release`; the candidate-facing `listFrozenQuestionsForAttempt` too, so what is shown matches what is scored).
- **Backfill / backstop:** migration 0128 backfills existing rows from the current `questions.points` (the old behaviour; there is no earlier value to recover), then sets NOT NULL. A BEFORE INSERT trigger fills a missing value from `questions.points` at insert time, so raw inserters (tests, future paths) never hit the constraint and never leave a lazily-read NULL.
- **Not included:** no per-version points history; authoring views (04 question editor, 07 `admin-generate`, 05 blueprint pool) keep reading the live `questions.points` on purpose. Apply the migration before deploying the code.
- **Test:** `src/__tests__/points-freeze.test.ts`.

## numeric / multi_select in the attempt engine (2026-10-02)

- **Candidate view**: `sanitizeContentForCandidate` keeps `question, unit` for `numeric` and `question, options` for `multi_select`. `answer`, `tolerance`, `correct`, `scoring`, `rationale` never leave the server (tests: `new-question-types.test.ts`).
- **Scenario mcq steps (2026-10-02)**: in the `scenario` branch, a step with `type === "mcq"` and an array `options` keeps `type`, `id` (string) and `options` (string items only) next to `prompt`. This is an allowlist: `correct`, `trap` and `expected` never leave the server. A step in the generated shape `{prompt, expected}` has no type and keeps `prompt` only. The runner saves the chosen option text as the step response. Tests: `sanitize-content-for-candidate.test.ts`.
- **Answer storage**: numeric = a bare number (or `null` when cleared / not a number); multi_select = `{ selected: number[] }` in ORIGINAL option indexes. `saveAnswer` is unchanged: it stores what it is given after the shuffle translation.
- **Option shuffle**: `listMcqOptionsForPicks` now includes `multi_select`; `answerToOriginal` / `answerToDisplayed` translate an array `selected` element by element and, if any element is invalid, leave the whole answer untouched (same fail-safe as a single index). `buildOptionOrder` takes a `maxOptions` argument; `startAttempt` passes `MAX_SHUFFLE_OPTIONS` (10), the default stays 8. A bare array is also translated (and stored canonically as `{selected}`); the existing "array passes through" case in `option-shuffle.test.ts` now uses a non-integer array.
- **Default answer hints**: "Select all that apply." / "Enter a number."
- **Submit expectation** (`result.ts`): the "result soon" promise counts only types outside mcq / numeric / multi_select as needing an evaluator.
- Not included: server-side numeric parsing at save time. The runner sends a number; scoring also tolerates `"1,250"` strings and `{value}`.

## Test sections with per-section timers (2026-10-02, migration 0132)

For assessments with `settings.sections` (defined in 05). Assessments without it take exactly the old path (regression-tested in `sections.test.ts`).
- **Draw (`startAttempt`)**: the pack/level pool (frozen snapshot if present, else live) is partitioned per section, in section order. A section takes questions whose `category_id` is in `category_ids` (if given) that no earlier section used, up to `question_count` (all of them if absent). Too few => `POOL_TOO_SMALL` naming the section. `assessments.randomize` shuffles inside a section. `attempt_questions.section_index` is frozen with the position; `position` runs 1..N across sections.
- **Time**: `attempts.duration_seconds`/`ends_at` = sum of section minutes (the level's duration is not used). `attempts.section_progress = {current, started_at}` (NULL = section 0 since `started_at`). `sections.ts` derives the running section: when a deadline passes the next opens at the PREVIOUS DEADLINE (lazy; applied and persisted on the next read/write), so being away loses that time and the outcome is the same whenever the server notices. Past the last deadline = `ends_at` expiry = the existing auto-submit.
- **Locking**: `saveAnswer` / `toggleFlag` on a question whose section is not the running one => 409 `AE_SECTION_LOCKED`. The check only runs when the question has a `section_index` (no extra query for plain tests).
- **View**: `getAttemptForCandidate` returns only the running section's questions/answers plus `sections {current,total,name,calculator,ends_at,remaining_seconds}`; later sections are not sent. Finished/terminal attempts return everything as before.
- **`POST /api/me/attempts/:id/finish-section`** => `{section_index}`: opens the next section now and re-pins `ends_at = now + remaining sections' minutes`. 409 `AE_SECTION_NOT_FINISHABLE` on the last section (submit instead) or a plain test.
- **Not included**: editing `settings.sections` after attempts started would move their deadlines (not guarded); no per-section score breakdown; sweep still keys on `ends_at` only.
- **Tests**: `sections.test.ts` (DB), `sections-timing.test.ts` (pure).

## Sections summary (N1c, 2026-10-02)

`src/sections.ts` `buildSectionsSummary` + `isAnsweredValue`. `getAttemptForCandidate` adds `sections_summary` (every section: index, name, question_count, answered_count, status done/current/upcoming) for sectioned attempts. Counts only, no ids or content, so it leaks nothing about locked sections. Used by the final submit dialog to count unanswered across ALL sections (it only counted the running one before). "Answered" matches the take page rule. Test: `sections-summary.test.ts`.

## Scenario answer check at save (N15, 2026-10-03)

`checkAnswerForSave(type, answer)` in `src/types.ts`, called by `saveAnswer` in `src/service.ts` after the lock, owner, status, timer and section checks. The key is the question TYPE (read by `findQuestionType` in `src/repository.ts`), never the answer shape. Only `scenario` is checked, with the existing `ScenarioAnswerPayloadSchema`: `{ steps: [{ stepIndex, response }] }` or `null`. A wrong shape gives HTTP 400 `AE_INVALID_PARAM` with `param: "answer"`. Unknown keys are removed. Other types stay "stored as sent, scores 0 when malformed": a strict check could block autosave for a client with an older shape. **Not included:** the type is read live from `questions.type`, not frozen per attempt (open task N21; the candidate view and scoring read it the same way). Tests: `answer-shape-save.test.ts` (no database) and one case in `attempt-engine.test.ts`.

## Question type `structured_case` (SP7, 2026-10-03)

- **Save check.** `checkAnswerForSave(type, answer, frozenContent?)` in `src/types.ts` now also validates `structured_case`: the answer is `{ steps: { [stepId]: number[] } }` (`StructuredCaseAnswerPayloadSchema`), every step id exists in the FROZEN content, every index is unique and inside that step's options. `saveAnswer` reads the type, then loads the content with `findFrozenContent(client, questionId, aq.question_version)` (`repository.ts`; server-internal, contains the key). A failure gives the same 400 `AE_INVALID_PARAM` (`param: answer`) as the scenario check; the message names the type. The key is the question TYPE, never the answer shape.
- **Candidate view.** `sanitizeContentForCandidate` keeps `title`, `context`, `log_excerpt` and per step only `id`, `prompt`, `select`, `options`. `correct`, `scoring`, `explanation` never leave the server.
- **No option shuffle.** Steps are served in authored order, and the stored indexes are original indexes. Upgrade path: one `option_order` per step id (ponytail note in `option-shuffle.ts`).
- **Why.** The type is deterministic, so the save seam can reject malformed picks early.
- **Not included.** A check that a `select: one` step has one pick (scoring treats a wrong count as wrong). `result.ts` non-mcq predicate now excludes the type.

## Business webhook events (FU-B6, 2026-10-03)

`submitAttempt` emits `attempt.submitted` after commit via `emitAttemptEventAfterCommit` (13). The timer sweep does not emit. Details: modules/13-notifications/SKILL.md.

## Timer sweep finds due tenants with one query (RW-39, 2026-10-11)

`listTenantsWithExpiredAttempts(now)` (`src/service.ts`, repository query in `src/repository.ts`) runs under `withSystemRole` and returns the active tenants with an `in_progress` attempt past `ends_at`. The timer sweep then calls `sweepStaleTimersForTenant` under `withTenant` for those tenants only. Why: no empty transaction per idle tenant. Rejected: a per-tenant fallback loop, and a cross-tenant mutation (it must stay RLS-scoped and audited). Not included: new indexes (`attempts_timer_sweep_idx`, 0030, serves the query). Details: `docs/11-observability.md` section 13.2.

## RW-68: per-type behaviour from the registry (2026-10-11)

Commits `b68523c`, `8353109`. The candidate content allowlist, the answer save check and the option shuffle moved into `packages/question-types`.
- Call `candidateViewFor(type, content)` (was `sanitizeContentForCandidate`) and `checkAnswerFor(type, answer, frozenContent)` (was `checkAnswerForSave`).
- The shuffle reads `shuffleField` (`options`, `items` or `null`) from the definition.
- The save path loads frozen content whenever the type has a `checkAnswer` hook (not by function arity).
- SQL type lists use `= ANY` / `<> ALL` with the registry arrays. Exported names and the 304 tests are unchanged.

## S14 (2026-10-16): frozen negative marks, logo fields, result summary

### Frozen `negative_marks` (EX-1, migration 0185)

- **What.** The attempt start copies a penalty into `attempt_questions.negative_marks` for every question: `COALESCE(questions.negative_marks, assessment default, 0)`. The code is in `src/repository.ts` (the insert) and `src/service.ts` (the assessment default is `settings.scoring.negative_marks_default`; anything that is not a finite number of 0 or more counts as 0). This is the same freeze pattern as `points` (migration `0128`).
- **Why.** A later edit of a question or of the assessment default must not change a score that a candidate already earned.
- **No trigger.** `DEFAULT 0` means "no penalty", so an old row needs no backfill.
- **Not included.** Validation of `settings.scoring` on write (route in module 05). This module sanitises the value on read.

### Result payload: `negative_marking` (EX-1)

- `GET /api/me/attempts/:id/result` and each item of `GET /api/me/results` carry `negative_marking: { enabled, penalty_total }` (`src/result.ts`, `loadNegativeMarking`). `enabled` is true when any frozen `negative_marks` of the attempt is above 0. `penalty_total` is the sum of the negative `score_earned` values of the effective gradings, as a positive number.
- `total_earned` is already net of the penalty and may be negative. `percent` may be negative. The client clamps the ring at 0.
- An attempt with no penalty returns `{ enabled: false, penalty_total: 0 }`.
- Field detail: [docs/03-api-contract.md](../../docs/03-api-contract.md) § "Negative marking (EX-1)".

### Logo fields in candidate payloads (Logo L3)

- `POST /api/take/start` (preview and start) returns `assessment.company_logo_url` (`string | null`).
- `GET /api/me/attempts/:id` returns top-level `company_name` and `company_logo_url`.
- `GET /api/me/attempts/:id/result` (200 and 202) returns `company_logo_url`. The released payload also returns `tenant_name`.
- The URL comes from `tenantLogoUrl` in module 02 (`/api/public/tenant-logo/<id>?v=<sha12>`). A missing logo gives `null`, and the page shows the organisation name.
- Not included: the logo bytes in any payload.

### `structured_case` candidate view

Each step also carries `points` and `negative_marks` when the author set them. They are not secret. `correct`, `scoring` and `explanation` stay on the server.

## S15 note (2026-10-17) — candidate progress (RW-84)

- `GET /api/me/progress` (`routes.candidate.ts`, `candidateOnly`) calls `getCandidateProgress(tenantId, userId)` in `src/progress.ts`, under `withTenant`.
- Released attempts only. `score_pct` uses `resultPercent` (same as `/api/me/results`). Subject strengths use the newest `gradings` row for each attempt and question, skip `review_needed`, and resolve the taxonomy node to its `subject` ancestor ("Other" when none).
- Tests: `src/__tests__/candidate-progress.test.ts`. Contract: `docs/03-api-contract.md` § "GET /api/me/progress (RW-84)".

## S15 note (2026-10-17) - per-question feedback (RW-80)

- `GET /api/me/attempts/:id/feedback` (`routes.candidate.ts`, `candidateOnly`) calls `getCandidateFeedback` in `src/feedback.ts`, under `withTenant`. 404 `ATTEMPT_NOT_FOUND` for another user's attempt. 409 `RESULT_NOT_READY` unless the attempt is `released` and has an `attempt_scores` row. Level `none` returns `items: []` before any question read.
- Newest `gradings` row per question (`graded_at DESC`). `review_needed` and `AIG_*` rows are dropped. `expected_answer` only for registry `scoring: 'deterministic'` types at level 2 or higher. `explanation` (`plainWords`) only for `scoring: 'ai'` types at level 3. Never send `stage_inputs`, `anchor_hits`, rubric text or raw AI text.
- `GET /api/me/results` now returns `feedback_level` (same transaction, `src/result.ts`).
- Tests: `src/__tests__/candidate-feedback.test.ts`. Contract: `docs/03-api-contract.md` § S15 additions. Rules: `docs/05-ai-pipeline.md` § "Candidate feedback levels (RW-80, S15)".

## Z-39 retake policy (2026-10-18)

- **What.** `attempts.attempt_number` (migration `0203_attempts_attempt_number.sql`, default 1). The unique key is now `(assessment_id, user_id, attempt_number)`. `findAttemptByAssessmentAndUser` returns the LATEST attempt (highest number). `startAttempt` keeps its old contract unless the caller passes `newAttempt: true`: an unfinished attempt (`draft`, `in_progress`) is always resumed; a finished latest attempt is returned as before; with `newAttempt` a new attempt is created only while `latest.attempt_number < attemptsAllowed(assessment.max_attempts, invitation.extra_attempts)`, else `409 AE_ATTEMPTS_EXHAUSTED`. The check runs under the invitation row lock (non-embed). Two parallel starts compute the same next number; the loser hits the unique key (SAVEPOINT, `23505`) and returns the winner, so the limit cannot be exceeded (this is also the only guard on the embed path, which has no invitation). `markInvitationStarted` also flips `submitted` to `started` for a retake; `markInvitationSubmitted` flips it back.
- **Callers.** `POST /take/start` passes `newAttempt: pv.existing === null`; `getTakePreview` hides a finished attempt when attempts are left and returns `attemptNumber` and `attemptsAllowed` ("Attempt n of m"). `POST /api/me/assessments/:id/start` takes `{ new_attempt: true }` (Try again button). The embed route does not pass the flag.
- **Result.** `GET /api/me/attempts/:id/result` (released) adds `retake { assessment_id, attempt_number, attempts_allowed, can_retake }`. The result page (`ResultSummary`) shows the real rule: "You can try again. This was attempt n of m." with a Try again button, or "You used all m attempts. Ask {org} if you need another."
- **Why.** Owner decision 2026-10-17 (Z-39). A start that must not exceed a limit needs a database key, not only an application check.
- **Considered and rejected.** Counting rows with `SELECT count(*)` and trusting it (two parallel starts both pass). Making `startAttempt` create a new attempt on every call after a submit (a reload would burn an attempt). A cancelled attempt does not give its attempt back: it counts as used (an admin can grant an extra attempt).
- **Not included.** Different question draws per retake (each attempt uses the same frozen pool rules as the first), cooling-off timers.
- **Reading rule for other modules.** Any query that joins `attempts` on `(assessment_id, user_id)` now sees several rows for a retaking candidate. Pick the attempt (latest, or best by `settings.score_counts`). The invitations list in module 05 does this; analytics queries in module 15 still list every attempt.
- **Tests.** `src/__tests__/retake.test.ts`: first, second, third refused, extra-attempt grant, re-open, best vs latest, two parallel starts (invitation and embed), tenant isolation, validation.

## Z-42 whole-test timer and section marks (2026-10-18)

- **What.** `readWholeTestMinutes` (`src/sections.ts`). In `startAttempt`: `duration_seconds` and `ends_at` = `whole_test_minutes * 60` from the server clock when set; for sections with `marks_per_question`, `insertAttemptQuestions` takes `pointsOverride` and `negativeOverride` and writes them as the frozen `points` and `negative_marks`. In `sectionStateFor`: whole-test mode returns `null`, so `assertSectionOpen` never throws `AE_SECTION_LOCKED`, `getAttemptView` returns every question with no `sections` view, and `finishSection` answers `SECTION_NOT_FINISHABLE`. The existing `ends_at` check in `saveAnswer` / `toggleFlag` is the only deadline.
- **Why.** Real exams with one timer let the candidate go back to any section. The marks are frozen so the candidate cannot gain marks or time from a later settings or bank edit.
- **Considered and rejected.** A per-attempt mode column; reading minutes live on each request (stored `ends_at` is the source). Recomputing marks at scoring time (module 09 reads frozen columns only).
- **Not included.** Section tabs in the take page for whole-test mode; the page shows one list. A section's `calculator` flag has no effect in whole-test mode (no current-section view).
- **Section names.** `getAttemptView` adds `section_names` (section names by `section_index`) only in whole-test mode; the key is absent otherwise. The take page navigator groups by it.
- **Tests.** `src/__tests__/whole-test-timer.test.ts` (free movement, reload keeps `ends_at`, 1 ms past `ends_at` rejected for every section, frozen marks, section totals 4 and 1.5, regressions for per-section and no-section assessments), `src/__tests__/sections-timing.test.ts`.
- **Z-42 hardening.** `toggleFlag` rejects past `ends_at` (`AE_TIMER_EXPIRED`) like `saveAnswer`; `startAttempt` fails closed with `AE_SECTIONS_INVALID` when `settings.sections` is non-empty but unreadable (no unsectioned fallback).

## Passage draw and freeze (EXP-8, 2026-10-19)

- **Draw unit.** In all three draw paths (sections, blueprint, full pool) `startAttempt` works on units: a standalone question, or all pool members of one passage. `src/passages.ts` (`takeUnits`, `groupUnits`) is pure. Siblings come from the SAME eligible pool (live active questions, or the frozen pool), so a withdrawn or inactive child is simply not there.
- **Count decision.** A passage counts as its number of children. A passage that does not fit the remaining slots of a section, criterion or assessment is skipped whole; a later smaller unit may fill the gap. Never a partial passage. Greedy, so an unlucky shuffle can leave a section short; it then fails with `POOL_TOO_SMALL` (full pool, sections) or draws fewer with a warning (blueprint, as before). Upgrade path if it matters: try a few shuffles.
- **Order.** Children stay together in `passage_position`, then `created_at`, then `id`. The blueprint final shuffle regroups units, so it never splits a passage. With no passage in the pool the result is identical to the old `slice(0, N)`.
- **Freeze.** `attempt_questions.passage_id` (0213) is written by `insertAttemptQuestions`. `listFrozenQuestionsForAttempt` returns `passage { id, title, body }` from that id. Passages are immutable, so later edits never change an attempt.
- **Scoring.** Unchanged. Each child has its own `points` and `negative_marks` rows.

## Affected attempts after an answer-key correction (EXP-12, 2026-10-19)

- **What.** `listAttemptsOnOlderVersions(tenantId, questionId)` in `service.ts` and `GET /api/admin/questions/:id/affected-attempts` (adminOnly, in `registerAttemptAdminRoutes`). Lists finished attempts (`submitted`, `auto_submitted`, `pending_admin_grading`, `graded`, `released`) whose `attempt_questions.question_version` is below `questions.version`, newest first, max 200 items, `total` is the full count. Ids only: no answers, scores, names or emails.
- **Why.** An answer-key fix makes a new question version; attempts keep the frozen old one. The admin needs to see who was marked on the old key before deciding anything.
- **Tenancy.** The question is read first under the caller's tenant (RLS); a foreign or unknown id returns `404 QUESTION_NOT_FOUND`, not an empty list. The transaction is `READ ONLY`.
- **Imports.** Reads module 04 through `qbRepo.findQuestionById` (same relative import `startAttempt` already uses). No new table, FK or column.
- **Not included.** Rescoring, notifying candidates, per-version diff, paging beyond 200.
- **Tests.** `src/__tests__/affected-attempts.test.ts`.

## Test type, desktop-only rule and readiness check (Z-87, Z-89, Z-91, 2026-10-20)

- **What.** `startAttempt` reads `delivery_mode` from the invitation row (under the row lock) and writes it to `attempts.delivery_mode`. No request field can set or change it. `camera_enabled` stays false (Wave 2). `StartAttemptInput.readiness` is stored in `attempts.readiness` in the same transaction. The retake limit counts only attempts of the same mode (`countAttemptsByMode`). `getTakePreview` returns `deliveryMode`.
- **Device gate.** `src/device.ts` `isMobileOrTabletClient({ userAgent, secChUaMobile, reported })` is pure. True for `Sec-CH-UA-Mobile: ?1`, a phone/tablet user agent, or reported signals (coarse pointer only with touch points, or screen width under 900). `POST /take/start` runs it for a REAL invitation before the session and the attempt: `403 DEVICE_NOT_ALLOWED`. The invitation stays unused. Mock is never blocked.
- **Readiness gate.** `src/readiness.ts` `evaluateReadiness(signals)` is pure (screen at least 1024 by 600, a recent Chrome/Edge/Firefox/Safari, downlink at least 0.5 Mbps when reported). A new real attempt without a passing `readiness` body field gets `422 READINESS_FAILED` with plain messages. A mock is never refused and stores what it sends.
- **Why on the server.** The page shows the same checks early, but a hand-made request must not skip them. The numbers live in two places (server constants and `apps/web/src/pages/take/readiness.ts`); change both.
- **Rejected.** Trusting only the client check. A per-organisation opt-out (owner: none). A secure or lockdown browser. Reading the mode from the request.
- **Known limit.** "Request desktop site" can hide a phone user agent; the touch and screen signals and the readiness check narrow this but a determined user can still send false numbers. The camera (Wave 2) closes this for proctored exams.
- **Not included.** Camera, photos, video. Certificates for mocks (module 09 skips them). Report filters (module 15).
- **Result views.** `ReleasedResult` and `ResultListItem` add `delivery_mode` so the UI shows a Mock label.
- **Tests.** `src/__tests__/device-readiness.test.ts` (pure rules) and the Z-87/89/91 cases in `attempt-engine.test.ts` (403, mode copy, 422, per-mode allowance).

## Real-exam camera data layer (Batch A part 1, 2026-10-20)

Migration `0229_camera.sql`. Code in `src/camera/`, exported from the package index. No routes yet. No AI on images, no face matching.

- `constants.ts`: `CAMERA_NOTICE_VERSION`, keep and size limits, MIME types, upload caps.
- `policy.ts`: `resolveCameraPolicy({deliveryMode, isEmbed, tenantCamera, enforced})` returns `{required, photos, video, keepDays, reason}`. Mock, embed and `enforced=false` are never required. `cameraSetupBlocker(policy, tenantCamera)` returns `'NOT_CONFIRMED'` or `null`. `computeExpiresAt(kind, takenAt, policy)`.
- `storage.ts`: `buildRelativePath` (re-exported `buildCameraRelativePath`), `resolveSafe`, `writeFileAtomic(rel, buf)`, `deleteFile(rel)`, `getUsage()` (system role, call outside a tenant tx), `diskGuard({incomingBytes})`, pure `evaluateDiskGuard`. Path rules live in `@assessiq/core` `camera-storage.ts`, shared with erasure and tenant purge.
- `hash.ts`: `hashCameraIp(ip)` (keyed HMAC through tenancy `signupHmac`).
- `repository.ts`: every function takes the client of an open `withTenant` tx. Consents, files, reviews, appeals, reviewers, `listFlaggedAttempts`.
- `retention.ts`: `runCameraRetentionForTenant(tenantId, now)` and `runCameraRetentionAll(now)`. Function only; the worker wiring is later.
- Rejected: a FK from consents to invitations (cross-module). Not included: routes, `/take/start` gate, UI.

## Real-exam camera: routes, start gate and daily job (Batch A part 2, 2026-10-20)

Routes and bodies: `docs/03-api-contract.md` section "Real-exam camera routes". No AI on images, no face matching, no ambient AI.

- `camera/gate.ts`: `resolvePolicyInTx` (one tenant read, then the pure policy with `config.CAMERA_ENFORCED`), `isCameraRequired`, `recordCameraConsent` (insert plus audit in one tx, 409 `CAMERA_NOT_REQUIRED`).
- `service.ts` `startAttempt` step c4: next to the Z-87/Z-91 block, under the same `input.gate !== undefined` condition, for a new real attempt. A required camera needs the organisation notice confirmed (422 `CAMERA_SETUP_REQUIRED`) and the invitation's latest consent `agreed` for `CAMERA_NOTICE_VERSION` (422 `CAMERA_CONSENT_REQUIRED`). The consent is linked to the attempt right after the row exists, in the same tx.
- `routes.take.ts`: `POST /take/camera-consent` (own bucket `aiq:rl:camera-consent:<hash>` 10/min; `recordCameraConsent` is idempotent for the same unlinked decision and notice version; a retake needs a fresh agree because the gate wants an unlinked consent); the preview and start answers carry `camera_required` and `camera_notice_version`.
- `routes.camera.candidate.ts`: an encapsulated plugin with its own `image/jpeg` and `video/webm` raw parsers. Global parsers stay untouched. The default `text/plain` parser is removed in that scope, so any other type is a plain 415.
- `routes.camera.admin.ts`: reviewer guard `requireCameraReviewer` (super admin, or tenant admin named in `camera_reviewers`), file streaming with the audit row committed first, reviewer and settings routes, the super-admin school flag.
- Worker: `camera-retention-cron` at 03:00 UTC calls `runCameraRetentionAll`, then `diskGuard`.
- **Why.** The server decides everything: policy is re-resolved on every upload and the client sends no time or path. **Rejected.** A route-only gate; streaming inside the DB tx; a users-module dependency for names (a lookup is injected from `apps/api`). **Not included.** Embed uploads, candidate and staff screens, any AI on files. **Tests.** `src/__tests__/camera-routes.test.ts`.

## Assessment time limit (2026-10-21)

- **What.** The time of a new attempt is `effectiveDurationMinutes(assessment.duration_minutes, level.duration_minutes) * 60` in `startAttempt` (a section or whole-test blueprint time still wins, as before). The result is copied into `attempts.duration_seconds` and `ends_at` at start, so a later admin edit never changes a running attempt (test `time-limit.test.ts`). `/take/start` reads `resolved.level.effective_duration_minutes` for the preview of a new attempt (a resumed attempt shows its own `duration_seconds`). `GET /api/me/assessments` uses `COALESCE(a.duration_minutes, l.duration_minutes)`.
- **Why.** Owner decision 2026-10-21 (manual time per assessment).
- **Not included.** Automatic time, per-question time, extra time for one candidate, a time change for a running attempt.

## Change history

### 2026-10-20 — Camera for real exams (S39, rows Z-74 and Z-82)

Folded from `docs/archive/2026-10-20-camera-change-record.md`. Design (now as-built): `docs/design/2026-10-20-camera-consent-flow-draft.md`. Runbook: `docs/runbooks/camera-school-test.md`. Rows: Z-74 (photo retention, review), Z-82 (school mode).

**Commits.** Batch A `737ccb13` (data layer, storage, routes, `/take/start` consent gate, daily delete job, erasure; migrations 0229, 0230). Batches B and C `6dbabbd4`, `b1426b66` (candidate screens, staff screens, "Did not consent" label, 10 help entries in migration 0231, nav probe fix). Batch D (close-out docs commit): Caddy edge change, smoke spec `apps/web/e2e/camera-smoke.spec.ts`, runbook, edge reference copies. Follow-up commit `e1d4ed50` (2026-10-21).

**What changed (server).**
- `modules/06-attempt-engine/migrations/0229_camera.sql`: tables `camera_consents` (immutable; only `attempt_id` may go NULL to a value), `camera_files`, `camera_attempt_reviews`, `camera_reviewers`. RLS on all four.
- `modules/02-tenancy/migrations/0230_camera_tenancy.sql`: `tenants.is_school`; `tenant_settings.camera_enabled`, `camera_photos_enabled`, `camera_notice_confirmed_*`.
- `modules/02-tenancy/src/camera.ts`: `getCameraTenantSettings`, `setTenantIsSchool`, `updateCameraSettings`, `confirmCameraNotice` (each writes one audit row in the same transaction).
- `modules/06-attempt-engine/src/camera/`: `policy.ts` (pure rules), `gate.ts` (loads policy, records consent), `storage.ts` (disk write, disk guard), `retention.ts` (delete job), `repository.ts`, `constants.ts`, `hash.ts`.
- `modules/00-core/src/camera-storage.ts`: shared path helpers (traversal and symlink checks, unlink, tenant folder removal). It lives in core because erasure (20) and tenant purge (02) cannot import module 06.
- `routes.camera.candidate.ts`: status, photo upload, video upload. `routes.camera.admin.ts`: access probe, flagged list, file list, file content, reviewed, appeal, reviewers, settings, confirm notice, school flag (super admin only).
- `routes.take.ts`: `POST /take/camera-consent`; the preview carries `camera_required` and `camera_notice_version`.
- `service.ts` `startAttempt` step c4: the server refuses a new real attempt that needs a camera without a fresh, unlinked, current-version agreed consent. The consent is linked to the attempt in the same transaction.
- `modules/20-data-rights/src/erasure.ts`: deletes the user's camera files (disk first; a failure rethrows so the job retries), consents, reviews and reviewer row. `modules/02-tenancy/src/purge.ts` removes the tenant folder.
- `apps/api/src/worker.ts`: job `camera-retention-cron`, daily 03:00 UTC, 1 attempt. No AI call.
- `infra/docker-compose.yml`: one bind mount line on api and worker (host folder under the assessiq namespace).
- Module 05: the invitation list gets `camera_consent: 'declined' | null` through an injected enricher wired in `apps/api/src/server.ts` (module 05 cannot join a module 06 table).

**What changed (screens).**
- Candidate, `apps/web/src/pages/take/`: `ReadinessPanel.tsx` (camera row with live picture); `CameraConsent.tsx` (text from design section 5, two buttons); `useCameraCapture.ts` (photo every 60 s, rolling 5 s video segment uploaded only when the camera stops or is blocked); `CameraIndicator.tsx` ("Camera on" mark and the "Your camera stopped" overlay with Retry); wiring in `TokenLanding.tsx` and `Attempt.tsx`.
- Staff, module 10: School switch on the Platform page; Camera card and Camera reviewers card on the Data privacy tab of Settings; reviewer page `/admin/camera-review`; "Did not consent" chip on invitation rows; nav probe in `AdminShell.tsx`.
- Help: migration `0231_camera_help.sql`, 10 ids (4 candidate, 6 admin). Help count 575 to 585.

**Why.** Owner decision: the camera is mandatory for real exams of normal organisations, off by default for schools until the school admin turns it on, never used for mock tests, used only for exam purposes. No AI touches the images. The server must enforce consent; the screen alone is not trusted (design section 4). Files stay private: no public URL, one authenticated tenant-checked route, one audit row per view.

**Considered and rejected.**
- Files in the database: the bytes would bloat backups.
- Files served by Caddy static or a signed URL: a leaked URL would expose an image. The API route checks session and tenant on every view.
- Slicing one long MediaRecorder stream: a webm piece is not playable without its header. The recorder restarts every 5 seconds.
- A per-tenant byte quota: not built now. One global cap exists.
- Blocking reviewer self-grant: the organisation names its own reviewers and every grant writes an audit row. A single-admin school must be able to review.
- Probing the reviewer role with the flagged list: failed CI (see bugs). An always-200 access route replaced it.
- Embed starts take no camera (the host app asserts the candidate and owns consent). Accepted gap, like Z-87.

**Rules in force.**

| Rule | Value |
| --- | --- |
| Camera required | real exam, not embed, not mock; normal organisation always; school only when its camera switch is on |
| Photos | every 60 s when photos are on (school photo switch); kept 90 days (school 7 days) |
| Video | only when the camera stops or is blocked; kept 7 days |
| Flagged attempt | all its files held while not reviewed since the newest flag, or while the appeal is open; maximum 365 days (school 90) |
| Upload limits | photo 400 KB, video 3 MB, 12 uploads per minute per attempt, 400 photos and 40 videos per attempt, magic-byte check, only while the attempt is in progress |
| Disk guard | warning at 80 percent of the cap (default 5 GB); upload refused above it or when free disk is under 256 MB; the attempt is flagged for the organiser |
| Switch | `CAMERA_ENFORCED` (default false) turns the whole rule on |

**Not included.**
- Face matching, any AI on images, sound, live proctoring, ID card checks, screen recording, Hindi consent text.
- Super admin viewing another tenant's files (support access stays deferred, Z-100). A super admin sees only the platform tenant's own files today.
- A per-tenant storage quota. One tenant can fill the global cap and cause refusals for all (gate finding 2, accepted for now).
- A sweep of orphan files and leftover `.tmp` files on disk (gate finding 5). There is no attempt delete path today.
- A video for a camera that dies between two 5 second segments (no recorder is running to stop).

**Follow-up (2026-10-21), commit `e1d4ed50`.**
- `camera-routes.test.ts` has the retake case (refused without a new consent; agree again links only the new attempt) and tests for the consent limits.
- `/take/camera-consent` has its own bucket `aiq:rl:camera-consent:<token hash>` at 10 per minute. It replaces the shared take-token call for this route, so consent then start does not use two calls of the 30 per minute start budget. The same open decision is not written twice.
- Camera line in the invitation email and reminder (design step 1): the real-exam invitation shows one block: "This test uses your camera. Check your camera early on the readiness page: [take link]. You will be asked to agree before the test starts." Only a boolean `cameraRequired` triggers it. Module 05 computes it in `email.ts` with the same rule as the take flow (`isCameraRequired` from module 06, injected at boot through `setCameraRequiredResolver` in `apps/api/src/server.ts` and `worker.ts`). Mock invitations never show it (mode read from the invitation row). A missing resolver or a resolver error gives false and the email still goes out. Not included: a privacy notice link in the email; Hindi text. Tests: `email-camera-line.test.ts` (13), `invite-camera-flag.test.ts` (05).

**Migrations, flags, jobs.**
- Migrations 0229, 0230, 0231 applied on the server. Next free migration at that time: 0232.
- Flag `CAMERA_ENFORCED`: true in production since 2026-10-21 (owner decision). One line added to the server `.env` after a name-only listing (31 variables, no CAMERA line), backup `env.pre-camera-enforced-2026-10-21` (mode 600). `assessiq-api` recreated only (healthy, container reads true), sweep 21 PASS and 0 FAIL, `/api/health` and `/api/ready` 200, error log unchanged. `assessiq-worker` was not recreated (only the reminder email camera line differs). Effect: a normal organisation must confirm the camera notice (Settings, Data privacy, Camera card) before any candidate can start a real exam, else 422 CAMERA_SETUP_REQUIRED. Undo: set false and recreate `assessiq-api`.
- Env: `CAMERA_STORAGE_DIR` (default `/var/lib/assessiq/camera`), `CAMERA_STORAGE_MAX_BYTES` (default 5 GB).
- Job: `camera-retention-cron`, daily 03:00 UTC.
- Server folder `/var/lib/assessiq/camera` created (mode 0700, new, assessiq namespace). Both containers see it.

**Caddy edge change (applied 2026-10-21 with the owner's go).** Shared Caddyfile, the AssessIQ site block only. Final lines:

```
+    @take_pages path /take /take/*
+    header @take_pages >Permissions-Policy "camera=(self), microphone=(), geolocation=()"
-    header Content-Security-Policy-Report-Only "...img-src 'self' data: blob: https:; connect-src ..."
+    header Content-Security-Policy-Report-Only "...img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src ..."
-    @api path /api/* /embed* /help/* /take/start /verify/*
+    @api path /api/* /embed* /help/* /take/start /take/camera-consent /verify/*
```

- The shared `security-headers` snippet stays `camera=()` for every other site. `connect-src 'self'` already covers the uploads.
- The header must be the deferred (`>`) form at site level. A plain header and a header inside the app handler both lost to the shared snippet. Caddy applies deferred writes from the outer handler last, and sorts the matcher form before the snippet's handler.
- Steps used: hash check of the live file, copy to the assessiq backups folder on the server, write in place (same inode), `caddy validate` (full output read), `caddy reload`, then `curl` checks. One false "invalid" from the orchestrator's own check restored the old file once; Caddy kept running the loaded config and no request failed.
- Checked after the final reload: `/take/abc` and `/take/attempt/abc` send `camera=(self)`; `/admin`, `/candidate/login` and `/` send `camera=()`; the health route returns 200; the neighbouring site returns 200; the legacy host still returns 301; `POST /take/camera-consent` returns JSON (404 for a fake token), not HTML.
- Not re-run: the direct-origin spoof check. The TLS client-certificate lines were not touched.
- Repo reference copies `infra/caddy/assessiq.caddy` and `infra/caddyfile/assessiq.snippet` carry the same lines. `apps/web/e2e/csp-policies.json` and the CSP enforce plan carry `media-src 'self' blob:`.

**How to verify.**
1. `pnpm verify`. Then `pnpm exec vitest run` in modules 06, 02-tenancy, 20-data-rights, 10-admin-dashboard, 05 and 16 (one at a time). Also `modules/20-data-rights/src/__tests__/erasure-coverage.test.ts` and `modules/16-help-system/src/__tests__/help-id-page-prefix.test.ts`.
2. Local smoke: `apps/web/e2e/camera-smoke.spec.ts` (fake camera, mocked network, 3 tests).
3. Follow `docs/runbooks/camera-school-test.md` on the school test organisation.
4. After a Caddy change: `curl -sI` on a take page shows `camera=(self)`; `/admin` still shows `camera=()`; `POST /take/camera-consent` returns JSON, not HTML.

**Bugs found (also in RCA_LOG).**
- The `modules/06-attempt-engine/src/camera/` folder was hidden by a local exclude rule; the first commit would have shipped without it. Fix: a named `git add -f` of 8 files. Prevention: run `git check-ignore -v` on new folders.
- A retake reused the consent linked to the first attempt, so every upload of the second attempt failed. Fix: the gate needs a consent with no attempt linked (`service.ts` step c4). Prevention: retake case test.
- The general consent checkbox was hidden for camera tests, so a candidate never saw the general statement. Fix: the checkbox stays and "Allow camera and start" waits for it.
- The nav probe called the reviewer-only list and logged a 403 console error on every admin page for every non-reviewer; all signed-in e2e smoke specs failed in CI. Fix: `GET /api/admin/camera/access` answers 200.
- Three admin help ids sat on the tenant settings page with a prefix that never matches. Renamed to `admin.tenant_settings.camera*`.

**Downstream.** 02-tenancy: new columns, `is_school` in the super admin tenant list, purge removes the camera folder. 20-data-rights: erasure scope grows by camera tables and files (erasure-coverage test updated). 14-audit-log: 7 new action names. 05: the invitation list accepts an optional enricher. 11-candidate-ui: `takeCameraConsent`, camera fields on the preview type. 16-help-system: 10 entries. Docs updated: 02-data-model, 03-api-contract, 04-auth-flows, 06-deployment, SKILL.md of 02, 05, 06 and 20; the design doc moved from draft to as-built.

**Rollback.**
- Fast: set `CAMERA_ENFORCED=false` and recreate api and worker. No camera step is asked and no upload is accepted as required.
- Code: revert `b1426b66`, `6dbabbd4`, `737ccb13`. Migrations only add things and stay.
- Caddy: restore the saved copy of the Caddyfile, validate, reload.
- Files: the daily job and erasure delete them; or remove the camera folder after the tables are empty.

**Capacity (read-only facts, 2026-10-21, after the switch went live and api and worker were recreated; single host).**
- Root disk 96 GB total, 51 GB used (53%), 46 GB free. Camera data folder 0 bytes, 0 files.
- Real photo size not measured (no photo existed yet). Hard limit is 400 KB; capture is a 640 by 480 JPEG, so a typical photo should be far smaller. Measure after the owner's first live test.
- AssessIQ app folder 127 MB; log folder 863 MB; other assessiq data folder 28 KB (backups of edited server files).
- Container images 10.8 GB (7.1 GB reclaimable), build cache 25.3 GB (17.2 GB reclaimable). Shared host: do not prune blindly.
- Camera cap `CAMERA_STORAGE_MAX_BYTES`, default 5 GB; warning at 80%; uploads refused above the cap or when free disk is under 256 MB.
- Reading: free disk (46 GB) is about 9 times the cap, so disk is not the limit now. At 400 KB the cap holds about 12,800 photos; at 100 KB about 51,000. For the load test, measure one real photo, then compute photos per hour from the 60 second interval and the number of candidates.

**Review gates.**
- Batch A: one Sonnet-takeover gate (upload, file access, consent, delete job, tenant isolation, erasure). Verdict revise. Fixed: photo body limit 400 KB (finding 2), suspended tenants swept (finding 3), re-flag after review holds files again (finding 4). Accepted and recorded: reviewer self-grant (1), orphan files (5), consent rows unbounded (6). Trailer `Adversarial-Review: sonnet-takeover revise-addressed` on `737ccb13`. Staff and candidate screens were reviewed by the orchestrator; no second gate.
- Follow-up `e1d4ed50` (2026-10-21): one Sonnet-takeover gate, verdict revise. Fixed (medium): the bulk invite called the camera resolver inside the open invite transaction; the resolver opens its own tenant connection, so each invitee held one pooled connection and waited for a second (pool deadlock under load). `inviteUsers` in `modules/05-assessment-lifecycle/src/service/invitations.ts` now resolves the rule once per batch before the transaction; `email.ts` accepts a ready `cameraRequired`. Single resend and the reminder job send outside a transaction and were already safe. Two other test files that mock `../email.js` needed the new export. Accepted, low: no per-IP cap on `/take/camera-consent` (per-token cap is tighter, 10 against 30); a concurrent identical double submit can write two rows (the start gate reads the newest row, harmless); an unlinked agreed row never expires (not new). Checked, no issue: delivery mode and tenant come from the invitation row and the call, a resolver error gives false and the email still goes out, templates add no user-controlled variable.

## Z-42 S42 blueprint timer and marks (2026-10-22)

- **What.** `readBlueprintWholeMinutes` and `readBlueprintMarks` (`src/sections.ts`; whole numbers 1..600 and 1..1000, else null). In `startAttempt`, only when there are no sections: `duration_seconds` / `ends_at` = blueprint minutes x 60 (wins over `assessments.duration_minutes` and the level time), and every `attempt_questions` row gets `pointsOverride = marks_per_question`. The penalty is not overridden (question's own, else the assessment default).
- **Why.** Closes the "not applied" gap of Z-51. Both values are frozen at start (`ends_at`, `attempt_questions.points`); a settings edit never changes a running attempt, and settings are locked once an attempt exists (module 05).
- **Empty fields.** Identical to before: same timer, same bank points. Tests prove it.
- **Not included.** Free movement and section tabs are not involved (a blueprint test has no sections). No migration. No AI call.
- **Tests.** `src/__tests__/whole-test-timer.test.ts`, describe "S42 blueprint timer and marks".

- **Z-134 (planned time, one helper).** `plannedDurationSeconds(settings, duration_minutes, level_minutes)` in `src/sections.ts` is the only rule for the attempt length. `startAttempt`, `GET /api/me/assessments` (`duration_seconds`) and the take preview now call it, so all three show the same seconds. Precedence: sectioned `whole_test_minutes`, else section minutes; blueprint `whole_test_minutes`; else assessment time, then level time. Tests: `sections-timing.test.ts`, `attempt-engine.test.ts` (Z-134 case).

## S50 additions (2026-10-22)
- A section draws only from its own pack (`pack_id` or the assessment pack; frozen NULL = assessment pack). Node draws also match the frozen `node_ids` (FUT-8).
- Status writers: `submitAttempt` and the read-time auto-submit take `FOR UPDATE`; `updateAttemptStatus` only moves an `in_progress` attempt (GATE-8 A3-3). `/event` refuses server-only types (`SERVER_ONLY_EVENT_TYPES`). Candidate feedback hides `expected_answer` while a retake is left on a real exam. A tenant admin cannot add themselves as a camera reviewer (a super_admin can).

- Update 2026-10-22: `submitAttemptForRevokeInTx(client, tenantId, attemptId)` is the admin-ended submit (invitation revoke): same submit, MCQ scoring and finalise as a candidate submit, inside the caller's transaction; the invitation row is left as the caller set it.

## S51 additions (2026-10-23)
- Affected attempts: `listAttemptsOnOlderVersions(tenantId, questionId, {reviewed})` and `setAffectedAttemptReview` (table `affected_attempt_reviews`, marks only, no score change). Camera upload uses `tenantDiskGuard` (per-tenant cap `CAMERA_TENANT_STORAGE_MAX_BYTES`). `saveAnswer` refuses a text answer over `MAX_ANSWER_CHARS` (20,000).
