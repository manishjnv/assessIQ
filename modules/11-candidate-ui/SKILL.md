# 11-candidate-ui — Assessment-taking UI

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

## Open questions
- Save-and-resume — explicit non-goal v1; can be a tenant setting in v2
- Accessibility for assistive tech (e.g., screen reader navigation of KQL editor) — requires Monaco a11y mode + manual testing
