# Copy & Voice

Tone: **calm, confident, editorial.** AccessIQ talks like a thoughtful editor, not a marketing app.

---

## Voice principles

- **Plain English.** Short sentences. No jargon, no marketing-speak.
- **Address the user directly.** "You scored higher than 97%". Not "Users in your cohort…"
- **Specific over vague.** "12 minutes left" not "Almost done". "4.2M takers" not "Millions of takers".
- **No emoji. No exclamation points** (rare exceptions for genuine celebration on results).
- **Sentence case for titles**, not Title Case. ("Continue where you left off" — not "Continue Where You Left Off")

---

## Headlines

- Use serif. Often end with a period — they read as statements.
- Keep under 8 words when possible.
- Examples: *"Sign in to continue."* · *"The library."* · *"Build your own."* · *"Good afternoon, Alex."*

---

## Microcopy patterns

| Element | Pattern | Example |
| --- | --- | --- |
| Mono eyebrow | UPPERCASE, tracking 0.08em | `COGNITIVE · ADAPTIVE` |
| Stat label | UPPERCASE mono, ≤ 3 words | `OVERALL SCORE`, `PERCENTILE`, `TIME` |
| Status chip | Title-case 1–2 words | `In progress`, `Auto-saved`, `Passed` |
| Empty CTA | Imperative, ≤ 4 words | `Start a blank assessment` |
| Button (primary) | Imperative verb | `Continue`, `Start`, `Retake` |
| Button (secondary) | Verb or noun | `Preview`, `Share`, `Download PDF` |
| Link | Sentence-case + arrow | `View all →` |

---

## Number formatting

- **Big numbers** use the `.num` class (serif). Always.
- **Inline numbers** (in body text, table cells) use mono with tabular numerals when alignment matters.
- Use thousand separators with commas (`12,400`) or compact form (`12.4k`) — pick one per surface and stick with it.
- Percentages: no space before `%` (`97%`).
- Percentile suffixes: small superscript-feel (`97<sup>th</sup>` rendered as smaller muted span — not actual `<sup>`).
- Time durations: `47:12` (mono, tabular). Or `12 min`, `1h 4m`. Never `12 minutes` in dense UI.

---

## Date / timestamp

- Long form: `Wednesday · April 29` (no year unless needed).
- Short form: `Apr 29, 2026 · 14:32` (mono, when used as metadata).
- Relative: `4s ago`, `2 min ago`, `Yesterday`, `Apr 12`. Switch to absolute after 6 days.

---

## IDs

- Always mono, prefix with `#` (e.g. `#A-2841`).
- Color: `--text-faint`. Right-aligned in tables and footers.

---

## Status labels

| State | Label | Chip variant |
| --- | --- | --- |
| Not started | (no chip) | — |
| In progress | `In progress` | `chip-accent` |
| Auto-saved | `Auto-saved` | `chip-accent` |
| Passed | `Passed` | `chip-success` |
| Completed | `Completed` | `chip-success` |
| Flagged | `Flagged` | (warn border) |
| Time-up / Failed | `Time exceeded` / `Did not pass` | (warn or danger) |

---

## Error / warning copy

- **Lead with what happened, then what to do.** "Connection lost. Your answers are saved locally." Not "Error: please try again later."
- Never blame the user. "We couldn't process this answer." Not "Invalid input."
- One short line preferred. Two if you need to instruct.

---

## AI / sparkle copy

When labelling AI-generated content (insights, recommendations):

- Eyebrow: `AI INSIGHTS` (mono uppercase) with `<Icon name="sparkle" size={14} stroke={2}/>`.
- Avoid the word "magic". Avoid hype words ("intelligently", "smart", "powerful").
- Always make AI output editable / dismissable / second-class to the user's own data.

---

## Examples — good vs bad

| ❌ Don't | ✅ Do |
| --- | --- |
| "Welcome Back to Your Dashboard! 🎉" | "Good afternoon, Alex." |
| "You absolutely crushed this assessment!" | "You scored higher than 97% of test-takers." |
| "Click here to start your test" | "Start" |
| "Test in progress... please wait." | "Auto-saved · 4s ago" |
| "Awesome insights powered by AI ✨" | "AI insights" eyebrow + factual bullets |
