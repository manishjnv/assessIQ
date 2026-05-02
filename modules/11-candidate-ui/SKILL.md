# 11-candidate-ui — Assessment-taking UI

> **Status (2026-05-02):** Phase 1 G1.D — **shipped live.** `@assessiq/candidate-ui`
> workspace package + `apps/web/src/pages/take/*` route tree both deployed in
> commits `da62760` (code) + `93a9e50` (infra Docker fix). Magic-link landing,
> attempt runner, post-submit page, and 4 presentation primitives are all live.
> **Deferred to Session 4b:** the magic-link **backend** (`POST /api/take/start`)
> that mints the candidate session — the SPA calls this endpoint and surfaces a
> branded "Connection error · Session 4b deliverable" panel until it ships.
> See `docs/SESSION_STATE.md` headline + agent-utilization footer.

## Purpose
The candidate's experience. Calm, focused, distraction-minimal. Same engine in standalone or embed mode.

## Scope
- **In:** landing (assessment intro + integrity rules), pre-flight (mic/cam not used in v1; only browser checks), question runner (one question per screen with overview panel), timer, flag toggle, navigation, review screen, submit confirmation, results page (when released).
- **Out:** anything admin.

## Dependencies
- `17-ui-system`
- `16-help-system`
- `06-attempt-engine` API
- `01-auth` (session for standalone, embed JWT for iframe mode)

## Page tree
```
/take
├── /:invitationToken       Landing (invitation magic-link entry)
├── /a/:attemptId/intro     Assessment overview, integrity rules, "Begin"
├── /a/:attemptId/q/:qid    Question runner
├── /a/:attemptId/review    Review flagged + unanswered
├── /a/:attemptId/submit    Submit confirmation modal flow
├── /a/:attemptId/done      "Submitted, results in N minutes" pending
└── /a/:attemptId/result    Score, breakdown, AI justifications (when released)
```

In embed mode (`?embed=true`):
- Strip `<TopNav>` and `<Footer>`
- Apply theme from postMessage if provided
- On submit, postMessage to parent instead of full-page transition; show inline confirmation

## Question runner layout
```
┌─────────────────────────────────────────┐
│ [Topic chip]   Question 4 of 12   [Timer ⏱ 18:42]  [?]│
├─────────────────────────────────────────┤
│                                          │
│  Question text                           │
│                                          │
│  [Answer area — type-specific]           │
│                                          │
├─────────────────────────────────────────┤
│ [⚐ Flag]                  [← Prev] [Next →]│
└─────────────────────────────────────────┘
```

Side panel (collapsible on mobile): question grid (12 squares), each colored by status (unanswered / answered / flagged / current).

## Type-specific answer components
- MCQ: `<McqOption>` radio cards with hover, focus, selected states
- Subjective: `<SubjectiveEditor>` — autosaving textarea with word count, no rich text in v1
- KQL: `<KqlEditor>` — Monaco-based with KQL keywords syntax highlighting, no execution; tab key indents, escape exits to next focus
- Scenario: stepper UI; each step is one of the above; "Step 2 of 4" indicator

## Integrity hooks (passive)
Recorded but never blocking — friction here costs more than it gains:
- Tab visibility transitions
- Copy/paste events on answer fields
- Window resize / fullscreen exit
- Keystroke pauses > 30s on a question

Surfaced in admin attempt detail under "Integrity signals". Never auto-flag or auto-fail; informational only.

## Connectivity resilience
- Autosave debounced 5s; immediate on blur
- On save failure: visible "Reconnecting..." pill in header; queue answer locally; retry with exponential backoff
- On hard-stale connection (>2 min): banner offers reload (preserves answer via localStorage backup)

## Help/tooltip surface
- `candidate.intro.integrity` — what's monitored, what's not
- `candidate.attempt.timer`, `candidate.attempt.flag`, `candidate.attempt.kql.editor`, etc. (see 07-help-system)
- `candidate.submit.confirm` — finality
- `candidate.result.bands` — explanation of band-based scoring

## What shipped (Phase 1 G1.D — 2026-05-02)

### `@assessiq/candidate-ui` workspace package

| File | Purpose |
|---|---|
| `src/types.ts` | Wire types for `/api/me/*` and `/take/start` — ISO strings on the JSON boundary, distinct from `06-attempt-engine`'s service-layer Date types. `CandidateEventInput` mirrors EVENTS.md catalog. |
| `src/api.ts` | Typed fetch client. `CandidateApiError` envelope; `takeStart`, `listInvitedAssessments`, `startAttempt`, `getAttempt`, `saveAnswer` (reads `X-Client-Revision` header), `toggleFlag`, `recordEvent`, `submitAttempt`, `getResult`. Cookie-trust via `credentials: 'include'`; never persists tokens to storage. |
| `src/components/AttemptTimer.tsx` | Server-deadline-anchored countdown pill. Re-derives `remaining = endsAt - Date.now()` every 1 s tick (no accumulation). `onExpire` fires exactly once via `useRef` guard. Color states: green > 5 min, warning ≤ 5 min, danger ≤ 1 min. |
| `src/components/AutosaveIndicator.tsx` | 5-state pill (`idle` / `saving` / `saved` / `error` / `offline`). 8-px CSS dot + relative-time label refreshing every 30 s on `saved`. Pulse keyframe injected once per page-load with idempotency guard. |
| `src/components/IntegrityBanner.tsx` | 4 variants — `multi_tab`, `reconnecting`, `tab_was_blurred`, `stale_connection`. Single-source-of-truth `VARIANT_CONFIG` record drives copy + icon + ARIA role/live. `stale_connection` uses `role="alert" aria-live="assertive"`; rest are polite status. |
| `src/components/QuestionNavigator.tsx` | CSS-grid status squares (`auto-fill, minmax(36px, 1fr)`). Status → border + background per `STATUS_STYLES`; `current` uses 2 px accent border with `box-sizing: border-box` (no layout shift). Hover lift + focus-visible accent ring via singleton `<style>` tag injection. |
| `src/hooks/useAutosave.ts` | Per-question debounce (5 s default) + retry queue with exponential backoff (1 → 30 s, max 5 attempts). 4xx terminal, 5xx/network retried. Online recovery clears retry timer. Lock guard rejects writes once timer expired. |
| `src/hooks/useIntegrityHooks.ts` | `visibilitychange` / `copy` / `paste` / `question_view` emit. **Token bucket: 8/sec budget** (server cap is 10/sec — leaves 2/sec headroom per decision #23). 5 000-event-per-attempt cap. Clipboard payload: `{ length }` only — never the text. Errors swallowed (fire-and-forget). |
| `src/hooks/useMultiTabWarning.ts` | `BroadcastChannel(`aiq-attempt-${attemptId}`)` heartbeat (3 s) + 5 s expiry. SSR-safe; jsdom-shimmed via `__tests__/setup.ts`. |
| `src/resilience/localStorage-backup.ts` | Decision #8 schema — `aiq:attempt:<id>:answers` key, `{ answers, savedAt, clientRevision }` value. `writeBackup` merges per-question; `clearBackup` on submit. |
| `src/__tests__/components.test.tsx` | 24 vitest cases (jsdom + @testing-library/react) — primitives + resilience layer. |
| `RESILIENCE.md` | Full resilience contract — what can go wrong, layered defenses, **known cosmetic limitations** (retry-revision audit semantic + AttemptTimer drift-check unwired — Phase 2 follow-ups). |

### `apps/web/src/pages/take/*` route tree

- `TakeRoot.tsx` — `<Outlet>` wrapped in `<HelpProvider page="candidate.attempt" audience="candidate" locale="en">`. Mounted via React Router under `/take`.
- `TokenLanding.tsx` (`/take/:token`) — calls `POST /api/take/start`. 5-state machine: `loading` / `success` / `error404` (Session 4b backend not wired — heading "Connection error.") / `invalid` (401/403 — heading "Invalid magic link.") / `error` (5xx — heading "Something went wrong.").
- `Attempt.tsx` (`/take/attempt/:id`) — the runner. Wires all 4 primitives + 3 hooks + HelpDrawer (which reads from TakeRoot's HelpProvider). Type-switched answer area for `mcq` (radio cards), `subjective` (autosaving textarea + word counter), `kql` (mono textarea — Monaco deferred per decision #11), `scenario` / `log_analysis` (stub messages — Phase 2). Submit uses `window.confirm` (Modal primitive deferred — see `docs/SESSION_STATE.md` open questions).
- `Submitted.tsx` (`/take/attempt/:id/submitted`) — terminal page. Polls `GET /api/me/attempts/:id/result` every 30 s; shows `grading_pending` panel for entire Phase 1 lifetime. 401/403/404 → `/take/error`. 5xx / network → still shows submitted panel with "Result polling temporarily unavailable" sub-text.
- `Expired.tsx` (`/take/expired`) + `ErrorPage.tsx` (`/take/error`) — static fallback states. Two-column branded layout matching `apps/web/src/pages/admin/login.tsx` idiom.

### Help system integration

`HelpProvider` is wired at `<TakeRoot>` with `page="candidate.attempt"` and `audience="candidate"`. Phase 1 G1.A Session 2 already seeded 10 candidate-side `help_id`s (`candidate.attempt.timer`, `candidate.attempt.flag`, `candidate.attempt.kql.editor`, `candidate.attempt.subjective.length`, `candidate.attempt.scenario.steps`, `candidate.attempt.submit.confirm`, `candidate.attempt.disconnect`, `candidate.intro.integrity`, `candidate.result.bands`, `candidate.submit.confirm`). The HelpDrawer is rendered in `Attempt.tsx`; the HelpDrawerTrigger is in the top bar. No new help_ids added in this session — copy refinement deferred to a UX pass.

### E2E tests (`apps/web/e2e/`)

- `take-error-pages.spec.ts` — 3 tests run today against the deployed SPA (`/take/INVALID_TOKEN`, `/take/expired`, `/take/error`). Validates branded heading + no raw error spillage.
- `take-happy-path.spec.ts` — full magic-link → submit flow; **`test.skip`'d pending Session 4b** backend mint.
- `take-timer-expiry.spec.ts` — auto-submit edge case; **`test.skip`'d pending Session 4b** + a 60 s test fixture.

Run locally: `pnpm --filter @assessiq/web e2e` (after `pnpm --filter @assessiq/web exec playwright install chromium`). Run against prod: `PLAYWRIGHT_BASE_URL=https://assessiq.automateedge.cloud pnpm --filter @assessiq/web e2e -- take-error-pages`.

### Phase 1 deferred (Phase 1+ / Phase 2 follow-ups)

- **Monaco-based `<KqlEditor>`** with KQL grammar + lazy import — decision #11; Phase 1 ships textarea fallback.
- **Scenario stepper + log_analysis renderer** — Phase 2 (need rubric-engine context).
- **Modal primitive in `@assessiq/ui-system`** — Phase 1 uses `window.confirm` for submit confirmation; Phase 2 will replace with a proper Modal that shows a per-question summary + "are you sure" UX.
- **Spinner primitive in `@assessiq/ui-system`** — `Submitted.tsx` inlines a 14 px CSS ring for now.
- **AttemptTimer `onDriftCheck` wiring** — `apps/web/src/pages/take/Attempt.tsx` does not pass `onDriftCheck` to `<AttemptTimer>`. Phase 1 has no admin-extendable deadlines (decision #5), so this is harmless. Phase 2 will wire it when admin-side `extendAssessment` lands.
- **Autosave retry-revision audit cleanup** — `useAutosave` increments `client_revision` on retries (cosmetic; data is safe per server's GREATEST + 1 contract). Phase 2 will capture revision once per pending payload to clean up false `multi_tab_conflict` events.
- **Embed mode** (`?embed=true` strips top nav, postMessage protocol) — Phase 4.
- **Save-and-resume across days** — explicit non-goal v1; tenant setting in v2.
- **Accessibility for assistive tech** (KQL editor screen-reader navigation) — pending Monaco + manual testing.

## Open questions
- (none new — Phase 1 G1.D closed all open questions in the kickoff plan; Phase 2 follow-ups tracked above)
