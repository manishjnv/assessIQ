# 06-attempt-engine — Taking the assessment

> **Status (2026-05-02):** Phase 1 G1.C Session 4a — **candidate-side core LIVE.** Migrations 0030-0033, repository, service, candidate routes, testcontainer integration tests all shipped. **Deferred to Session 4b:** BullMQ runtime for `sweepStaleTimersForTenant` (shipped later in the `assessiq-worker` container, entry point `apps/api/src/worker.ts`, commit `2675e2f`; there is no `apps/worker` folder); magic-link `/take/:token` flow; embed routes; Redis-backed rate cap (in-process bucket today, multi-replica scale-out goal). `codex:rescue` adversarial sign-off mandated for Session 4b — embed JWT + magic-link surfaces are security-adjacent.
>
> **UI note (2026-05-20):** AttemptPage chrome is mobile-tuned via CSS only (M2a phase of MOBILE_KIT_PORT). Under `[data-viewport="mobile"]` the right navigator aside is hidden and is reachable via a `<Drawer>` opened by a new `aiq-attempt-nav-toggle` button in the header. **Integrity-hook surface, timer math, autosave debounce, and submit semantics are byte-identical to desktop** — the reflow is presentation only. Per-question-type mobile sizing shipped in M2b (2026-05-20): all sans textareas + the log-analysis finding `<input>` read `--aiq-answer-input-size` (15px desktop / 16px mobile); the KQL textarea reads `--aiq-answer-mono-size` (13px mono desktop / 16px mono mobile). The 16px floor on mobile defeats iOS Safari's auto-zoom-on-focus for form inputs. KQL also shows a mobile-only `aiq-attempt-kql-mobile-tip` caveat ("KQL is easier on a desktop browser") with a same-PR `candidate.attempt.kql.mobile_tip` help entry. **Grading semantics, autosave debounce, blur flush, and integrity-hook surface all unchanged across viewports.** See `docs/plans/MOBILE_KIT_PORT.md` and `docs/10-branding-guideline.md § 15.3`.

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
- `candidate.attempt.scenario.steps` — linear stepping, can't skip back if dependency
- `candidate.attempt.submit.confirm` — what happens after submit (grading time, when results visible)
- `candidate.attempt.disconnect` — what to do if connection drops (autosaves on reconnect)

## Open questions / deferred work

- **BullMQ scheduler runtime** — `sweepStaleTimersForTenant` ships as pure idempotent logic. The BullMQ runtime now exists: the `assessiq-worker` container runs `apps/api/src/worker.ts` (commit `2675e2f`). The auto-submit ALSO fires opportunistically inside `getAttemptForCandidate` whenever a candidate hits the endpoint past their `ends_at` — that's the safety net.
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
