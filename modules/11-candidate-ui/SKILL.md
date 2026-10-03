# 11-candidate-ui — Assessment-taking UI

> **Status (2026-05-02):** Phase 1 G1.D — **shipped live.** `@assessiq/candidate-ui`
> workspace package + `apps/web/src/pages/take/*` route tree both deployed in
> commits `da62760` (code) + `93a9e50` (infra Docker fix). Magic-link landing,
> attempt runner, post-submit page, and 4 presentation primitives are all live.
> **Session 4b shipped 2026-05-03 (`fae4b33`):** the magic-link **backend** (`POST /api/take/start`,
> `modules/06-attempt-engine/src/routes.take.ts`) mints the candidate session. The
> Playwright specs `take-happy-path` and `take-timer-expiry` are still `test.skip`'d (2026-10-02).
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

## Integrity v1 (2026-10-01)
`useIntegrityHooks` now takes `blockCopyPaste` / `fullscreenRequired` (from `CandidateAttemptView.integrity`) and returns state: tab-leave count + warning, copy-blocked notice, full-screen gate state. Behaviour: (1) always warns "You left the test window n time(s). This is recorded and shared with the organiser." on return (count in sessionStorage, best effort); (2) fullscreen required and `document.fullscreenEnabled`: `FullscreenGate` blocking dialog (focus trapped, Esc swallowed, timer not paused), emits `fullscreen_enter`/`fullscreen_exit`, exits full screen on submit/unmount; unsupported browsers (iPhone Safari) are never blocked; (3) block_copy_paste cancels copy/cut/paste/contextmenu, still emits copy/paste with `blocked: true`, throttled notice (5 s). Exits and clipboard use are recorded, not prevented: a determined candidate can bypass all of it.

## Integrity hooks (passive)
Recorded but never blocking unless the assessment opts in (above) — friction here costs more than it gains:
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
- `candidate.submit.confirm` — what happens after submit (instant result vs emailed result)
- `candidate.result.bands` — explains the released-result card: score, percent, Passed / Not passed, certificate. Key name kept (renaming breaks tenant overrides); no bands or AI justifications are shown to candidates (owner rule P1, 2026-10-01)
- `candidate.results.list` — the `/candidate/results` page
- `candidate.auth.org_code` — the "Organisation code" field on `/candidate/login` (shown only when `?tenant=` is absent)

## What shipped (Phase 1 G1.D — 2026-05-02)

### `@assessiq/candidate-ui` workspace package

| File | Purpose |
|---|---|
| `src/types.ts` | Wire types for `/api/me/*` and `/take/start` — ISO strings on the JSON boundary, distinct from `06-attempt-engine`'s service-layer Date types. `CandidateEventInput` mirrors EVENTS.md catalog. |
| `src/api.ts` | Typed fetch client. `CandidateApiError` envelope; `takePreview` (read-only landing data, no timer), `takeStart(token, { consent })` (the Begin click: creates the attempt and starts the clock), `listInvitedAssessments`, `startAttempt`, `getAttempt`, `saveAnswer` (reads `X-Client-Revision` header), `toggleFlag`, `recordEvent`, `submitAttempt` (returns `result_expectation` / `email_masked` / `turnaround_text`), `getResult` (200 `released` result or 202 `pending`; treat any status other than `released` as pending), `listMyResults` (`GET /me/results`). Cookie-trust via `credentials: 'include'`; never persists tokens to storage. |
| `src/components/ResultSummary.tsx` | The candidate-facing COMPLETE result (2026-10-01): `ScoreRing` (percent) beside `total / max (percent%)`, Passed / Not passed chip, optional "View certificate" link. Shared by `Submitted.tsx` and `MyResults.tsx`; `compact` = list-row size. No bands / breakdown / insights / percentile (P1). flex-wrap, so it reflows on phones without a viewport branch. |
| `src/components/MyResults.tsx` | `/candidate/results` — the candidate's released results, newest first (`GET /api/me/results`); loading / empty / error states. The emailed magic-link sign-in lands here. |
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
- `Submitted.tsx` (`/take/attempt/:id/submitted`) — terminal page, **rewritten 2026-10-01 (scoring + result release)**. A candidate only ever sees a COMPLETE result (owner rule P1) — never a partial score. `Attempt.tsx` hands the submit response (`result_expectation`, `email_masked`, `turnaround_text`) over as router state; without it (timer-expiry auto-submit, deep link) the first `GET /api/me/attempts/:id/result` decides. `'soon'` → "Scoring your answers… this takes under a minute." and a poll every 5 s for at most 60 s; a 200 `released` swaps in the result card (`ResultSummary`: score ring, `total / max (percent%)`, Passed / Not passed, certificate link, "A copy was emailed to {email_masked}."). `'email'`, or the 60 s window closing, → "Your result will be emailed to {email_masked} {turnaround_text}." (manual-release tenants, when the API sends `release_mode: 'manual'`: "…once {tenant_name} releases it."). 5xx / network / a mid-poll 401 never show an error page; 401/403/404 on the FIRST fetch with no router state → `/take/error`. The old `window.location.reload()` loop and 30 s poll are gone.
- `Expired.tsx` (`/take/expired`) + `ErrorPage.tsx` (`/take/error`) — static fallback states. Two-column branded layout matching `apps/web/src/pages/admin/login.tsx` idiom.

### Help system integration

`HelpProvider` is wired at `<TakeRoot>` with `page="candidate.attempt"` and `audience="candidate"`. Phase 1 G1.A Session 2 already seeded 10 candidate-side `help_id`s (`candidate.attempt.timer`, `candidate.attempt.flag`, `candidate.attempt.kql.editor`, `candidate.attempt.subjective.length`, `candidate.attempt.scenario.steps`, `candidate.attempt.submit.confirm`, `candidate.attempt.disconnect`, `candidate.intro.integrity`, `candidate.result.bands`, `candidate.submit.confirm`). The HelpDrawer is rendered in `Attempt.tsx`; the HelpDrawerTrigger is in the top bar. No new help_ids added in this session — copy refinement deferred to a UX pass.

### E2E tests (`apps/web/e2e/`)

- `take-error-pages.spec.ts` — 3 tests run today against the deployed SPA (`/take/INVALID_TOKEN`, `/take/expired`, `/take/error`). Validates branded heading + no raw error spillage.
- `take-happy-path.spec.ts` — full magic-link → submit flow; **still `test.skip`'d** (backend shipped in `fae4b33`; the unskip is open).
- `take-timer-expiry.spec.ts` — auto-submit edge case; **still `test.skip`'d** (needs a 60 s test fixture).

Run locally: `pnpm --filter @assessiq/web e2e` (after `pnpm --filter @assessiq/web exec playwright install chromium`). Run against prod: `PLAYWRIGHT_BASE_URL=https://assessiq.automateedge.cloud pnpm --filter @assessiq/web e2e -- take-error-pages`.

### Phase 1 deferred (Phase 1+ / Phase 2 follow-ups)

- **CandidateHelp content connected to 16-help-system store** — Phase 4+ TODO. The
  `CandidateHelp` component (2026-05-04) ships with hardcoded JSX copy for speed.
  Phase 4 will connect it to `@assessiq/help-system` for i18n + admin-overridable
  content, matching the same `help_id` pattern as admin-side tooltips.

- **Monaco-based `<KqlEditor>`** with KQL grammar + lazy import — decision #11; Phase 1 ships textarea fallback.
- **Scenario stepper + log_analysis renderer** — Phase 2 (need rubric-engine context).
- **Modal primitive in `@assessiq/ui-system`** — Phase 1 uses `window.confirm` for submit confirmation; Phase 2 will replace with a proper Modal that shows a per-question summary + "are you sure" UX.
- **Spinner primitive in `@assessiq/ui-system`** — `Submitted.tsx` inlines a 14 px CSS ring for now.
- **AttemptTimer `onDriftCheck` wiring** — `apps/web/src/pages/take/Attempt.tsx` does not pass `onDriftCheck` to `<AttemptTimer>`. Phase 1 has no admin-extendable deadlines (decision #5), so this is harmless. Phase 2 will wire it when admin-side `extendAssessment` lands.
- **Autosave retry-revision audit cleanup** — `useAutosave` increments `client_revision` on retries (cosmetic; data is safe per server's GREATEST + 1 contract). Phase 2 will capture revision once per pending payload to clean up false `multi_tab_conflict` events.
- **Embed mode** (`?embed=true` strips top nav, postMessage protocol) — Phase 4.
- **Save-and-resume across days** — explicit non-goal v1; tenant setting in v2.
- **Accessibility for assistive tech** (KQL editor screen-reader navigation) — pending Monaco + manual testing.

---

## Candidate certificate portal (Phase 5, 2026-05-13)

A separate surface from the assessment-taking flow. Candidates navigate to `/candidate/login` to authenticate via magic link and then view their certificates at `/candidate/certificates`. This surface uses a distinct shell (`CandidateShell`) rather than the `<TakeRoot>` wrapper, because it has a persistent header (session status + expiry warning) and does not need the attempt-scoped `HelpProvider` setup.

### Page tree

```
/candidate
├── /login              CandidateLogin — email input + submit; 204 → shows link-sent state
├── /login/verify       CandidateLoginVerify — intermediate route; GET ?token= triggers server-side redirect
├── /results            CandidateShell > MyResults — released results, newest first (the emailed sign-in link lands here)
└── /certificates       CandidateShell > MyCertificates (already exists in 11-candidate-ui)
```

`CandidateShell` nav (desktop inline + mobile overflow menu): **Results**, Certificates, Activity.

`/candidate/login` takes the organisation from `?tenant=<slug>` (the result email links to `/candidate/login?tenant=<slug>`); when the param is absent it shows an "Organisation code" field instead. The hard-coded `'wipro-soc'` tenant is gone. The page-local mobile rules use `!important` because the container and the aside carry inline `grid-template-columns` / `display` that otherwise beat the stylesheet (the two panes used to stay side by side on phones).

### CandidateShell

**File:** `apps/web/src/pages/candidate/CandidateShell.tsx`

Wrapper rendered on all `/candidate/*` routes that require an active session (`/certificates`). Provides:

- `<CandidateSessionBanner>` in the page header — shows "Signed in as {email} · Expires {date}" and a "Sign out" link
- `<Outlet>` for child pages
- Redirects to `/candidate/login` if no valid `aiq_sess` cookie is present (detected via `GET /api/auth/whoami` returning 401)

**Props:** none — reads session state from the `useWhoami()` hook (fetches `/api/auth/whoami`).

**When it renders:** on any `/candidate/*` route that requires authentication. `/candidate/login` and `/candidate/login/verify` are exempt (they render standalone without CandidateShell).

### CandidateSessionBanner

**File:** `apps/web/src/pages/candidate/CandidateSessionBanner.tsx`

Persistent header element inside `CandidateShell`. Two visual states:

| State | Trigger | Content |
|---|---|---|
| Normal | `session.expiresAt > now + 5 days` | "Signed in as {email} · Session expires {relative date}" |
| Expiring soon | `session.expiresAt <= now + 5 days` | Amber warning banner; "Your session expires in {N} days. [Request a new sign-in link]" |

The "expiring soon" threshold (5 days = day 25 of the 30-day session) is a UX constant in the component file. Help IDs wired:

- Normal state header element: `candidate.auth.session-status`
- Expiring-soon banner: `candidate.auth.expiring-soon`

**Props:**
```ts
interface CandidateSessionBannerProps {
  email: string;
  expiresAt: string;       // ISO 8601 UTC
  onRequestNewLink: () => void;  // navigates to /candidate/login
}
```

### CandidateLogin

**File:** `apps/web/src/pages/candidate/CandidateLogin.tsx`

Two internal states managed by a local state machine:

| State | What renders |
|---|---|
| `idle` | Email input field + "Send link" button. Help ID on the input: `candidate.auth.request-link` |
| `sent` | Success panel: "Check your email" copy. Help ID on the panel: `candidate.auth.link-sent` |

On submit, calls `POST /api/auth/candidate/request-link`. Transitions to `sent` on both 204 (success) and 404/500 that cannot leak enumeration — the server always returns 204, so the client always shows the `sent` state after a non-429 response. On 429, shows an inline "Too many attempts — try again in {retryAfterMs / 1000 / 60} minutes" message and stays in `idle`.

**Props:** none — standalone page component.

**Accessibility:** email input uses `<label htmlFor>`. "Send link" is `<button type="submit">`. The `sent` state panel uses `role="status"` so screen readers announce the state change.

### CandidateLoginVerify

**File:** `apps/web/src/pages/candidate/CandidateLoginVerify.tsx`

Thin intermediate route mounted at `/candidate/login/verify`. On mount, reads `?token=` from the URL and immediately navigates the browser to `GET /api/auth/candidate/verify-link?token=<t>` (the server handles the 302 redirect to `/candidate/certificates` or back to `/candidate/login?error=invalid_link`).

In practice this page is only visible for the brief moment between the candidate clicking the email link and the server's 302 completing. It renders a neutral "Signing you in…" loading state. If the server redirect does not fire within 5 seconds (network error), shows "Something went wrong — [try requesting a new link]".

**Props:** none — reads `useSearchParams()` from React Router.

**Help IDs:** none — the page is transient and does not warrant a drawer.

## Open questions
- (none new — Phase 1 G1.D closed all open questions in the kickoff plan; Phase 2 follow-ups tracked above)

## Accessibility conventions

All presentation primitives in this module target WCAG 2.1 AA. Future component authors must follow these conventions before merging. Each rule maps to the checklist item in the WCAG 2.1 audit applied on 2026-05-11.

- **Semantic HTML first.** Use `<button type="button">` for interactive controls, `<nav aria-label="…">` for navigation regions, `<header>` / `<main>` / `<footer>` as landmark elements. Never use `<div onClick>` or `<span onClick>` for actionable surfaces.
- **Every form control has an accessible name.** Use `<label htmlFor>`, `aria-label`, or `aria-labelledby`. No unlabelled `<input>`, `<textarea>`, or `<select>` — hidden visual labels still require `aria-label`.
- **Status regions use `role="status"` or `role="alert"`.** Polite, non-urgent updates (autosave, reconnect status) use `role="status" aria-live="polite"`; urgent interruptions that demand immediate attention use `role="alert" aria-live="assertive"`. Avoid adding `aria-live` to elements that update at sub-second frequency (flag for review instead).
- **Decorative icons carry `aria-hidden={true}` explicitly.** An icon inside a control that already has a visible text label or an `aria-label` on the parent must have `aria-hidden={true}` to suppress duplicate announcements — don't rely on the Icon component's default behaviour.
- **Dialogs return focus to their trigger on close.** Any component that opens a modal, drawer, or panel must hold a `ref` on the trigger element and call `triggerRef.current?.focus()` in its close handler (WCAG 2.4.3 Focus Order). The `CandidateHelp` component is the reference implementation.

## Public demo mode (2026-10-02)
`apps/web/src/pages/try/` (`/try`, `/try/certificate`) reuses `AttemptTimer`, `AutosaveIndicator` and `QuestionNavigator` from this package, plus the take/* MCQ, multi-select and numeric answer areas, as pure-props components with static content. No components in this package changed. Invariant: the demo makes zero network requests (asserted in `Try.test.tsx`), so never wire api.ts calls into those components' demo usage.
## Sections + calculator (2026-10-02)

- `finishSection(attemptId)` (POST `/me/attempts/:id/finish-section`) and `SectionsViewWire` on `CandidateAttemptViewWire.sections` (present only for sectioned tests; the questions/answers in the view are already the running section's). The runner (`apps/web/.../Attempt.tsx`) shows "Section N of M · name", a section timer keyed per section, "Finish section" with a confirm ("You can't come back to this section."), and a navigator numbered inside the section; the last section keeps Submit.
- `Calculator` (+ `calculator-eval.ts`): four-function calculator, no `eval()`/`Function` (tokenizer + two-pass precedence evaluator), 12-significant-digit formatting, keyboard only while focus is inside the panel (digits . + - * / x, Enter/=, Backspace, Esc/c). Plain buttons with no clipboard use, so integrity `block_copy_paste` (which cancels copy/cut/paste/contextmenu) does not affect it. Shown only when the running section has `calculator: true`.
- Not included: parentheses, memory, percent, a calculator history; no persistence of the calculator state across sections.
- Tests: `calculator.test.tsx`; runner behaviour in `apps/web/src/pages/take/AttemptSections.test.tsx`.

## Completion modal (FR13, 2026-10-03)

`CompletionModal` is rebuilt on the kit `Modal`. `NewCertificateModal` (exported from the module index) shows on the Submitted page for a released result, once for each browser and `credential_id` (`localStorage` `aiq:certs-seen`, in try/catch). `MyCertificates` has a "View" button. The prop is `assessment_title` (was `course_title`). Data comes from `GET /api/certificates`; no server change.
