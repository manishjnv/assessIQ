# Handoff: AssessIQ student exam engine

## Overview
The candidate-facing test-taking experience for AssessIQ. A student sees one question at a time, answers it in one of eight formats, flags items for review, watches a countdown, reviews everything on a finish summary, submits after confirming, and then sees a pass/fail result and an answer key with explanations.

It covers four views: **Question → Finish summary → Result → Answer key**.

## About the design files
Everything in `prototype/` is a **design reference built in HTML**: one self-contained file showing the intended look, motion and behaviour. It is **not production code to copy in**. Recreate it inside the existing AssessIQ application, using its framework (React / Next.js + Tailwind per the AssessIQ stack), component library, routing, data layer and auth. Reuse existing AssessIQ primitives (Button, Chip, Card, Input, Logo, Icon) wherever they exist; build new ones only where this README specifies something that doesn't exist yet.

Open `prototype/exam-engine.html` directly in a browser to interact with it. Its state persists to `localStorage` under the key `aiq-exam-engine-v2`. Use **Display settings → Reset demo answers** to start over.

## Fidelity
**High fidelity.** Colours, type, spacing, radii, states, motion and copy are final. Match them using the AssessIQ tokens (`reference/`). The only new tokens are the **mid-tone theme** and the semantic `warn-*` / `ok-*` / `danger-*` soft and ink pairs (see Design tokens).

---

## Global layout (all views)
Full-bleed, edge to edge, `height: 100dvh`. The page itself never scrolls; only inner regions scroll.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Top bar · 60px                                                       │
├──────────────────────────────────────────────────────────────────────┤
│ Progress row · ~38px  (question & review views only)                 │
├───────────────────────────────────────────────────────┬──────────────┤
│ Stage (scrolls)                                       │ Navigator    │
│                                                       │ 320px open   │
├───────────────────────────────────────────────────────┤  88px closed │
│ Footer action bar                                     │              │
└───────────────────────────────────────────────────────┴──────────────┘
```
Shell grid: `grid-template-rows: auto auto minmax(0,1fr)`. Body grid: `grid-template-columns: minmax(0,1fr) 320px` (collapsed: `88px`). It animates over `.45s cubic-bezier(.2,.7,.3,1)`.

### Top bar (60px, 1px bottom border, horizontal padding `clamp(14px,2vw,24px)`, gap 14px)
Left to right:
1. **AssessIQ logo**: 10px accent dot with a hairline ring (inset −4px, 1px accent at 30% opacity) next to "AssessIQ" in Newsreader 500 17px, −0.02em.
2. 1×24px vertical divider (`--border`).
3. **Organization** (who assigned the test). A 32×32 logo (8px radius, 1px `--border-strong`, `--bg` background). If there's no logo URL, it shows the initials (`ORG.short`) in Newsreader 600 12px. Next to it, an eyebrow "ASSIGNED BY" and the org name (Geist 500 14px, max-width 200px, ellipsis). A user setting controls it: `both | logo | name | off` (default `both`). When on, a divider follows it.
4. **Assessment**: eyebrow "ASSESSMENT · #EX-2841", then the title "AWS Machine Learning Associate" (Geist 500 14px, ellipsis).
5. Divider.
6. **Candidate**: a 32px circle avatar with initials "JA" (`--accent-soft` background, `--accent` text, JetBrains Mono 600 11.5px), eyebrow "CANDIDATE · STU-10482", and the name "Jordan Avery".
7. Flexible spacer.
8. **Save status**: a 6px `--ok` dot plus "Saved just now" / "Saved 12s ago" / "Saved 2 min ago" (12px `--muted`). The dot pulses on each save (0.9s ring).
9. **Timer** (`flex: none`, never shrinks):
   - pill, 42px tall; `--surface-2` background with a 1px `--border-strong` border
   - clock icon in `--accent`, a "TIME LEFT" eyebrow, then `HH:MM:SS` in JetBrains Mono 600 18px with tabular numerals
   - a 2px bar inset 14px at the bottom: track `--border`, fill `--accent`, width = secsLeft / duration
   - **Low time (< 300s):** `--danger-soft` background, `--danger` border and text, and a pulsing 6px halo every 2s
10. **Tools**: two 36px ghost icon buttons (10px radius):
    - **Display settings** (sliders icon) opens a popover
    - **Full screen** toggles `requestFullscreen()`; the icon swaps between expand and shrink
11. **Finish assessment**: a primary pill button, shown in the Question view only.

Results / Answer key views: the save status and timer are replaced by a chip "✓ SUBMITTED" (ok).

**Display settings popover:**
- **Placement:** 340px wide, 16px radius, `--shadow-lg`, 18px padding, anchored 10px below the button and right-aligned. It opens with an opacity fade and a −6px slide (.18s / .22s), and closes on an outside click or Esc.
- **Theme:** `Mid-tone | Light | Dark`.
- **Text size:** `S | M | L | XL`, which sets `--fs` to 0.92 / 1 / 1.12 / 1.25. It scales question, option, passage and input text.
- **Organization:** `Logo + name | Logo | Name | Off`.
- **Keyboard:** a reference list of the shortcuts.
- **"Reset demo answers":** a link (demo only; omit in production).

Each control is a segmented control: a `--surface-2` track with a 3px inset; the selected item gets `--bg`, a hairline ring and a small shadow.

### Progress row (question + review views)
A flex row with 9px vertical padding and a 1px bottom border.
- **Left:** "QUESTION **03** / 18" (Mono 500 11.5px `--muted`; the current number is Mono 600 14px `--text`). On the review view it reads "REVIEW".
- **Centre:** the segmented progress bar, one segment per question.
  - shape: `flex: 1`, 2px gaps, 6px tall, pill-rounded; grows to 10px on hover
  - colours: open `--surface-2`, answered = accent mixed 38% into `--surface-2`, flagged `--warn`, current `--accent`
  - each segment is clickable and jumps to its question (`tabindex=-1`; the navigator is the accessible path)
- **Right:** "17 answered · 94%" (hidden below 900px).

---

## View 1: Question

### Stage
- **Scroll area:** padding `clamp(28px,6vh,72px) clamp(20px,5vw,88px) 56px`.
- **Content width:** max 860px, centred.
- **Questions with a passage** (`q.passage`) switch to a two-column split on wide screens:
  - columns `minmax(0,1fr) minmax(0,1.05fr)`, gap `clamp(28px,4vw,80px)`, max width 1600px
  - the passage pane on the left is sticky
  - below 1240px the split stacks into one column
- **Passage box:** `--surface` background, 1px border, 16px radius, 22×24px padding, 15px × `--fs`, line-height 1.7, `pre-wrap`. Max height is `100dvh − 280px` and the box scrolls internally. Monospace variant (`q.pre`): JetBrains Mono 13.5px. Its eyebrow reads "PASSAGE" or "DIAGRAM · TABLE".
- **Question entry animation:** 0.38s, cubic-bezier(.2,.7,.3,1). Going forward it slides from translateY(14px) with opacity 0; going back, from −14px. The scroll position resets to the top.

**Question header row:**
- "QUESTION **03** / 18" (nowrap), then the type chip (accent chip, e.g. "TRUE OR FALSE").
- On the right, the **Flag** toggle:
  - pill, 36px tall, outline style; label "Flag for review", which becomes "Flagged" when pressed
  - pressed state: `--warn-soft` background, `--warn` border, `--warn-ink` text
  - `aria-pressed` reflects the state

**Stem:** Newsreader 500, `clamp(22px, 1.5vw+12px, 32px) × --fs`, line-height 1.3, −0.015em, `text-wrap: pretty`, margin 22px 0 8px.
**Sub-hint** (13px `--faint`, margin-bottom 26px). It varies by type:
- multi: "Select every answer that applies."
- grid: "Choose one option in each row."
- order: "Step 1 comes first. Use the arrows to reorder."
- essay: "Between {min} and {max} words. Marked by an examiner."
- cloze: "Type one word in each blank."
- ungraded: "Self-report. This item is not scored."

### Answer formats (all eight, see `types/exam.ts`)
| Type | UI |
| --- | --- |
| `single` | **Option card** (below). Mono letter badge A–D, text, radio on the right. |
| `single` + `layout:"scale"` | Equal-width tiles in an auto-fit grid (min 120px, 68px tall, 14px radius), 1–5 rating. |
| `multi` | Option cards with a 22px checkbox (6px radius) + letter badge. |
| `grid` | One bordered fieldset per row (14px radius, 16×18 padding). The legend is the statement (`float:left; width:100%`, so it sits inside the border). Below it, pill segment buttons for each column (min 88px wide, 40px tall). |
| `number` | Label + 48px input (mono, max-width 240px) + unit text. |
| `text` | Input + hint "Up to N words · x / N words". |
| `essay` | Textarea (min-height 280px, resize vertical, line-height 1.65) + live word count. Below the minimum: "Add N more words to meet the minimum of M." in `--warn-ink`. |
| `order` | Numbered list of 62px rows. Each row has up/down 40px icon buttons; the first and last buttons are disabled at the ends. |
| `cloze` | One labelled input per blank ("Blank 1", "Blank 2"…). |

**Option card:**
- **Size:** min-height 62px, padding 14×18px, 1px `--border`, 14px radius, gap 16px.
- **Hover:** `--border-strong` border, `--surface` background.
- **Checked:** `--accent` border and `--accent-soft` background. The badge fills with accent, and the radio dot scales in over 0.2s.
- **Focus:** a 2px accent outline, offset 2px.
- **Markup:** inputs are visually hidden and stay real `<input type=radio|checkbox>` inside a `<label>`.

### Footer action bar
- **Layout:** 1px top border; padding 12px `clamp(20px,5vw,88px)` plus the bottom safe-area inset.
- **Left:** "Clear response" (ghost button).
- **Filter pill** (only when a navigator filter is active): "FLAGGED ONLY · 3 ×". It is `--accent-soft` (`--warn-soft` for flagged); the × clears the filter.
- **Keyboard hints:** `← → navigate · A–D answer · F flag`, shown at ≥ 1240px only.
- **Right:** **Previous** (outline, chevron) and **Next** (primary).
  - With a filter active, Next reads "Next flagged" / "Next open" / "Next answered".
  - When there's no next question, it becomes **"Review & finish"** and opens the finish summary.

### Navigator: expanded (320px, `--surface` background, 1px left border)
- **Head (56px):** the serif title "Questions" and the mono count "17 / 18 answered".
- **Clickable stat cards** (3 columns): Answered · Flagged · Open, each a mono eyebrow over a Newsreader 500 26px number.
  - **Clicking a card filters** the grid, the collapsed rail, Previous/Next and the keyboard arrows to that subset.
  - Clicking the same card again (or "Show all") clears the filter.
  - Pressed state: accent border and `--accent-soft` (Flagged uses `--warn` / `--warn-soft`).
  - Helper text below the cards: "Select a count to show and navigate only those questions." While filtered it reads "Showing flagged only. Previous and Next skip the rest." with a "Show all" link.
  - If the current question isn't in the chosen subset, it jumps to the next match (wrapping to the first).
- **Question grid:**
  - 5 columns, 8px gap, square cells with a 10px radius, Mono 500 12px
  - open: 1px `--border-strong` on `--bg`
  - answered: `--accent-soft` fill, accent text
  - current: accent fill, white text
  - flagged: a 10px `--warn` dot at the top-right with a 2px surface ring
  - non-matching cells are hidden; an empty filter shows "Nothing here."
- **Legend:** Current · Answered · Flagged · Open.
- **"Next unanswered →"** (outline, full width, pinned to the bottom): jumps to the next open question, wrapping round.

### Navigator: collapsed rail (88px). **The key interaction.**
- A vertical strip of question cells: 42px squares, 10px radius, 12px gap.
- A fixed **lens** sits at the vertical centre: a 62px rounded square (18px radius) with a 1px accent border at 40% opacity.
- **The current question is always centred inside the lens.**
  - The list is absolutely positioned and translated by `translateY(viewHeight/2 − (cell.offsetTop + cell.offsetHeight/2))`.
  - It animates over `.55s cubic-bezier(.2,.7,.3,1)` on every question change. Recompute without animation on resize and after the panel's width transition ends.
- A 1px `--border` track line runs behind the cells.
- **Distance styling** (by position in the visible, filtered sequence):

  | Distance | 0 (current) | 1 | 2 | 3 | 4+ |
  | --- | --- | --- | --- | --- | --- |
  | Scale | 1.16, accent glow shadow | .94 | .88 | .82 | .78 |
  | Opacity | 1 | .92 | .62 | .38 | .2 |

  Transform and opacity transition over .5s.
- A top and bottom edge **mask fade** (`linear-gradient(transparent, #000 20%, #000 80%, transparent)`).
- **Chevron up / down buttons** above and below step to the previous / next question (filter-aware).
- **Footer:** the current number "03" (Newsreader 22px) with "of 18" beneath it, or "2 of 3 flagged" when filtered.
- The rail respects the active filter: non-matching cells are hidden, but the current question always stays visible.

### Collapse / expand handle
- A 34×68px pill straddling the navigator's left border, vertically centred (`left: -17px; top: 50%`).
- `--bg` background, 1px `--border-strong` border, a soft shadow and a chevron.
- Hover: accent border and icon, plus a 4px `--accent-soft` halo.
- The chevron flips when collapsed.
- `aria-expanded` and `aria-label` reflect the state ("Collapse / Expand question navigator").
- Shortcut: `\` or `[`. The state persists.
- Moving between states, the expanded content fades and slides 28px while the rail fades in with a 0.2s delay.

### Responsive
- **≥ 1240px:** everything shows.
- **< 1240px:**
  - top bar: the org name, the "Time left" label and the candidate eyebrow hide
  - question: the passage split stacks; the keyboard hints hide
- **< 1080px:** the save status and assessment eyebrow hide; the review table drops the "Your answer" column.
- **≤ 900px (mobile / tablet):**
  - **Navigator** becomes a **68px horizontal strip** pinned above the footer: the same rail logic on the X axis, the lens centred horizontally, and chevrons rotated −90°.
  - A grid button on the strip opens the full navigator as a **bottom sheet**: max 78dvh, 20px top radius, over a scrim, sliding up over .32s. Esc or tapping the scrim closes it, and so does choosing a question.
  - **Top bar:** the org and assessment meta hide; the candidate shows as avatar + name.
- **≤ 640px:** the candidate collapses to just the avatar; the timer is compact (15px digits, no icon); button labels shorten ("Finish", "Clear"); grid segments become 2-up; dialog buttons stack.
- **Touch targets** are at least 40px everywhere, and at least 44px for primary controls.

---

## View 2: Finish summary (review)
Two columns: `minmax(0,1fr) 380px` (320px below 1080px; stacked at ≤ 900px).

**Main column:**
- **Header:** the eyebrow "REVIEW BEFORE SUBMITTING", the H1 "Finish summary." (Newsreader 500, `clamp(30px,3vw,42px)`), and the lede "Check each answer before you submit. Select a row to jump back and change it."
- **Four stat cards:** Answered `17 / 18` · Flagged `3` · Open `1` · Time left `01:06:02` (mono).
- **Filter segmented control:** `All · 18 | Open · 1 | Flagged · 3`.
- **Table:** columns `52px | question (ellipsis) | your answer (ellipsis, muted) | status chip | "Edit ›"`. Each row is focusable, and Enter or click opens that question.
  - The status chip reads Flagged (warn), Answered (ok) or Open (neutral).
  - The head row is mono uppercase on `--surface`.

**Side panel** (`--surface`, left border):
- **Checklist** with 20px round status icons (ok / warn):
  - "N questions have no answer yet." or "All 18 questions have an answer."
  - "N questions are flagged for review." or "No questions are flagged."
  - "Answers saved automatically."
- **Notice:** "**Submitting ends the assessment.** You can't change answers afterwards."
- **Buttons** pinned to the bottom: **Submit assessment** (primary, large, full width) and **‹ Back to questions** (outline).

**Confirm dialog** (`role=alertdialog`, focus starts on "Submit now", Esc closes):
- **Container:** 480px max, 16px radius, 28px padding, `--shadow-lg`. The scrim is `rgba(10,10,11,.36)`. It enters by rising 10px and scaling from .98 over .28s.
- **Copy:** eyebrow "FINAL STEP"; H2 "Submit your assessment?"; body "1 question is still unanswered and 3 are flagged. You won't be able to change answers after you submit."
- **Buttons:** "Keep reviewing" (outline) and "Submit now" (primary).

## View 3: Result
A centred column (max 980px) over a 48px hairline grid that fades out with a radial mask from the top.
- **Header:**
  - chip "✓ PASSED" (ok) or "DID NOT PASS" (danger)
  - eyebrow "SUBMITTED · OCT 28, 2026 · #EX-2841"
  - H1 "You passed." / "Not this time." (Newsreader `clamp(42px,5vw,68px)`)
  - the lede
- **Score card** (16px radius, bordered, 32×36 padding; a 2-column grid that stacks on mobile):
  - **Ring:** 184px, r=76, 6px stroke, `--surface-2` track and `--accent` arc with round caps. The arc animates its dash offset to the score over 1.6s cubic-bezier(.2,.7,.3,1). The centre number counts up with the same cubic ease-out (Newsreader 60px), with a "% SCORE" eyebrow beneath it.
  - **Meter:** 8px tall; the fill animates to the score; a 2px `--text` tick marks the pass mark at 70%. Labels: `0 · PASS 70% · 100`.
  - **Four mini stats:** Correct `x / gradable` · Pending · Flagged · Time used.
- **Fine print:** "Scores use auto-marked questions only. Written answers and self-report items are excluded until an examiner reviews them."
- **CTA:** **Review answer key →**

## View 4: Answer key
Max width 1080px.
- **Header:** the H1 "Answer key." with the lede "Compare your answer with the correct one and read why.", plus a "‹ Back to result" outline button.
- **Filter:** `All · 18 | Correct | Incorrect | Not scored`.
- **One card per question:**
  - the eyebrow "QUESTION 03 · TRUE OR FALSE" and a grade chip (Correct ok · Incorrect danger · Not answered neutral · Pending review warn · Not scored neutral)
  - the stem in serif 18px
  - two cells: **Your answer** (tinted ok or danger by grade) and **Correct answer**
  - the explanation, prefixed with a bold "Why."

---

## Interactions & behaviour
**Keyboard** (ignored while typing in an input, textarea or select, or when a modifier key is held):
| Key | Action |
| --- | --- |
| ← / → | Previous / next (filter-aware). Skipped when the focus is on a radio, so native radio arrows still work. |
| A–D | Select an option (single), or toggle one (multi) |
| 1–5 | Choose on a rating scale |
| F | Toggle flag |
| \ or [ | Toggle the navigator (opens the sheet on mobile) |
| Esc | Close the popover, sheet or dialog |
| Enter | Open the focused review-table row |

**Grading** (`gradeQ` in the prototype; move it **server-side** in production):
- **single:** index equality.
- **multi:** every checkbox must match.
- **grid:** every row must match.
- **number:** numeric equality.
- **text / cloze:** the trimmed, lower-cased answer must appear in the `accept` list.
- **order:** the full sequence must be equal.
- **essay:** "manual" (pending review).
- **ungraded:** "na".
- **Score** = correct / (correct + incorrect + unanswered), excluding manual and na. **Pass** when ≥ `passMarkPct`.

**Answered rules:**
- single: index ≥ 0
- multi: any box checked
- grid: every row chosen
- cloze: every blank filled
- number / text: not empty
- essay: more than 0 words
- order: the user has moved at least once

**Timer:** ticks every 1s in the Question and Review views and pauses after submission. It turns to the low state under 5 minutes. At 0 it auto-submits and shows the Result view. **In production the deadline is server-authoritative**: compute the time left from `startedAt + duration`, don't trust the client count.

**Autosave:** debounced 250ms after any change. Typing in text fields updates state without re-rendering, so the caret stays put. The prototype saves to `localStorage`; in production send a PATCH to the attempt endpoint, show "Saving…" or a retry on failure, and keep a local copy so answers survive a dropped connection. Error copy: "Connection lost. Your answers are saved on this device."

**Motion:** honour `prefers-reduced-motion`; disable all animations and transitions.

## State
Shapes are in `types/exam.ts`.
- **AttemptState** (persisted, server): view, idx, answers[], flags[], secsLeft, savedAt.
- **UiPrefs** (persisted per user):
  - theme (default **mid**; `themeSet` is false until the user picks one explicitly, so the default can change later)
  - fontScale
  - nav open/closed
  - org display (default `both`)
- **Ephemeral:** navFilter (default `all`), popover open, sheet open, review filter, key filter.

**API suggestion:**
- `GET /attempts/:id` → `{ exam, state }`
- `PATCH /attempts/:id` with answers, flags and idx
- `POST /attempts/:id/submit` → `{ grades, score, passed }`
- the answer key is fetched only after submit and **never** shipped to the client beforehand

The prototype embeds `ans` / `accept` on each question for demo purposes; strip them from the candidate payload.

## Design tokens
These are the AssessIQ tokens (`reference/assessiq-css-variables.css`), with the additions below. The question view uses the **semantic aliases** `--text / --muted / --faint` (AssessIQ: `--text / --text-muted / --text-faint`).

| Token | Mid-tone (default) | Light | Dark |
| --- | --- | --- | --- |
| --bg | #efece5 | #ffffff | #0e0e10 |
| --surface | #e8e4db | #fafafa | #161618 |
| --surface-2 | #dedad0 | #f3f3f4 | #1d1d20 |
| --border | #d4cec1 | #e4e4e7 | #2a2a2e |
| --border-strong | #bab2a2 | #cdcdd1 | #3a3a3f |
| --text | #23211d | #0a0a0b | #f5f5f7 |
| --muted | #3e3a33 | #3f3f46 | #b8b8c0 |
| --faint | #55504a | #52525b | #a2a2ab |
| --accent | oklch(.5 .13 258) | oklch(.58 .17 258) | oklch(.7 .16 258) |
| --accent-hover | oklch(.45 .14 258) | oklch(.52 .19 258) | oklch(.78 .16 258) |
| --accent-soft | oklch(.91 .03 258) | oklch(.96 .03 258) | oklch(.27 .07 258) |
| --accent-ink | #fff | #fff | #0e0e10 |
| --ok / --ok-soft | oklch(.45 .11 150) / oklch(.92 .04 150) | oklch(.5 .13 150) / oklch(.96 .04 150) | oklch(.75 .15 150) / oklch(.25 .05 150) |
| --warn | oklch(.72 .15 70) | oklch(.72 .15 70) | oklch(.78 .14 75) |
| --warn-ink / --warn-soft | oklch(.43 .1 65) / oklch(.92 .05 80) | oklch(.47 .11 65) / oklch(.96 .045 80) | oklch(.82 .12 75) / oklch(.26 .05 75) |
| --danger / --danger-soft | oklch(.5 .17 25) / oklch(.92 .04 25) | oklch(.56 .2 25) / oklch(.96 .03 25) | oklch(.72 .17 25) / oklch(.26 .06 25) |

**Typography:**
- **Families:** Newsreader (display, stems, big numbers, 500), Geist (body and UI, 400/500), JetBrains Mono (eyebrows, IDs, counts, timer, badges).
- **Eyebrow:** Mono 500 11px, uppercase, +0.07em, `--faint`.
- **Body** 14px; option text 15.5px × `--fs`; stem 22–32px × `--fs`.
- **Radii:** 6 (checkbox), 8 (badge, logo), 10 (cells, icon buttons), 12 (inputs, notices), 14 (option cards, rows, tables), 16 (cards, dialogs, popover), 999 (buttons, chips, timer).
- **Shadows:** cards use borders, not shadows. `--shadow-lg: 0 8px 32px rgba(0,0,0,.08)` (dark: .6) is for the popover, dialog and sheet only.
- **Easing:** `cubic-bezier(.2,.7,.3,1)` everywhere.
- **Durations:**
  - .15s for hover
  - .38s for question entry
  - .45s for the panel
  - .55s for the rail
  - 1.6s for the score reveal

## Accessibility
- **Labels and roles:**
  - every control has an accessible name
  - question and rail cells announce "Question 3, answered, flagged, current"
  - the timer has `role="timer"`; the progress bar has `role="progressbar"`
  - the result has `aria-live="polite"`
- **Focus:**
  - focus stays on the same control after re-render (pattern `restoreFocus`)
  - after a reorder, focus follows the moved item
- **Contrast:** all text meets WCAG AA in all three themes, including the darkened `--faint`.

## Assets
- **Icons:** inline 24px outline SVGs, 1.6 stroke, round caps (chevrons, flag, clock, sliders, expand/shrink, check, alert, arrow, grid, panel, close). Use AssessIQ's `<Icon>` set and add any missing ones in the same style.
- **Organization logo:** `organization.logoUrl` (any image, shown with object-fit: contain in a 32px box). Falls back to the initials.
- **Fonts:** Google Fonts (Newsreader, Geist, JetBrains Mono); use whatever font loading AssessIQ already has.

## Files
| Path | What |
| --- | --- |
| `prototype/exam-engine.html` | **Source of truth.** Self-contained interactive prototype: all views, all eight question types, grading, themes. |
| `data/sample-exam.json` | 18 sample questions covering every type, plus exam, org and candidate metadata. |
| `types/exam.ts` | TypeScript contracts for exam, questions, answers, attempt state and UI prefs. |
| `reference/assessiq-css-variables.css`, `reference/assessiq-tokens.json` | AssessIQ base tokens. |
| `reference/design-system/*.md` | AssessIQ rules: philosophy, components, voice. Follow them for any new component. |
| `CLAUDE_CODE_PROMPT.md` | A ready-to-paste kickoff prompt. |

## Not in scope yet
Image hotspots, real charts, code editor and runner, audio/video items, proctoring capture, and examiner essay-marking UI.
