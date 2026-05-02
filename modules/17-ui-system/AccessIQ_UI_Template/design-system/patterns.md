# Patterns

Composed layouts. Pick the closest match before building from scratch.

---

## Two-pane auth layout

**Used for:** login, signup, password reset.

Grid: `1fr 1fr`. Left pane = form, right pane = visual proof (testimonial + mock score card).

- Left: 48px×64px padding, logo top-left, form vertically centered, footer with version + compliance badges (mono, 11px, `--text-faint`).
- Right: `--surface` background with subtle radial-masked grid, floating mock card with hairline shadow, blockquote at bottom.

See `screens/login.jsx`.

---

## App shell with sidebar

**Used for:** dashboard, library, candidates, reports.

```
┌──────┬───────────────────────────────────┐
│      │   Page header                     │
│ Side │   ───────────────────────────     │
│ bar  │   Stats row (4 cards)             │
│ 240  │   Two-column content              │
│ px   │   Recommended grid                │
└──────┴───────────────────────────────────┘
```

- Sidebar: 240px wide, 1px right border, `--bg` background.
- Main: `padding: 32px 40px`, scrollable.
- Page header: mono date eyebrow, serif h1, `.spacer`, search button + primary CTA on right.

See `screens/dashboard.jsx`.

---

## Library / catalog layout

**Used for:** test library, course catalog, any browsable collection.

1. **Hero** (centered, max-width 720px): chip + serif h1 + muted lede + pill search bar + suggested chips. Subtle masked grid background.
2. **Sticky filter row**: btn-sm pill filters, `.spacer`, "N results" mono count. Border-bottom separates from grid.
3. **Card grid**: `repeat(3, 1fr)`, 16px gap. Last card is a dashed-border "build your own".

Card recipe (per item):
- Mono category·level eyebrow
- Serif title
- Sans muted description (2 lines)
- Stat strip (3 columns: Questions / Minutes / Takers — mono labels + serif numbers)
- Primary CTA + outline preview button

See `screens/library.jsx`.

---

## Assessment-in-progress layout

**Used for:** any timed test-taking screen.

```
┌─────────────────────────────────────────────┐
│ Logo │ Test name        Auto-saved · Timer  │  Sticky header
├─────────────────────────────────────────────┤
│ [progress bar 2px]                          │
├─────────────────────────────┬───────────────┤
│   Question column           │  Navigator    │
│   max-width: 680            │  panel        │
│   padding: 48 56 64         │  320px        │
│                             │  --surface    │
└─────────────────────────────┴───────────────┘
```

Header rules:
- Sticky, `--bg` with bottom border.
- Auto-save status: green dot + "Auto-saved · 4s ago" muted.
- Proctor: `chip` with eye icon.
- Timer: pill with clock icon + mono tabular numerals. Border turns `--danger` when < 5 min.
- Save & exit: outline btn-sm.

Below header: 2px progress bar (filled `--accent`).

Question column:
- Eyebrow row: mono "Question N / Total · Multiple choice" + flag-for-review ghost button right.
- Serif h2 (30px) for the question.
- Optional muted clarification line.
- Optional diagram in `--surface` card.
- Stack of option buttons.
- Footer nav: Previous outline, `.spacer`, Skip ghost, Next primary.

Side panel:
- Mono "Navigator" eyebrow + 8-col question grid.
- Legend (4 swatches: current / answered / flagged / unseen).
- Section progress (5 mini bars).
- Tip card with kbd shortcuts.

See `screens/assessment.jsx`.

---

## Results / report layout

**Used for:** assessment results, report exports.

Centered single column (`max-width: 1080px`).

1. **Top bar**: logo, divider, back link, `.spacer`, Share / Download / Retake.
2. **Hero**: chip-success + mono timestamp + ID, then large serif h1 + muted lede.
3. **Score block** card (3-column grid): score ring · overall summary · percentile + time.
4. **Competency breakdown** card with rows (`200px 1fr 80px 80px` grid: name · neutral bar · score/100 · percentile-th).
5. **AI insights**: two cards side-by-side (Strengths / Growth areas). Bullet rows with serif headings.
6. **Score distribution**: SVG bell curve with median + your-score guidelines.

See `screens/results.jsx`.

---

## Section header pattern

```html
<div class="row" style="margin-bottom:14px">
  <h3 class="serif" style="margin:0;font-size:22px;font-weight:400">
    Section title
  </h3>
  <span class="spacer"></span>
  <span class="chip">N items</span>
  <!-- or: <a style="color:var(--accent);font-size:12px">View all →</a> -->
</div>
```

Use for any "Recommended for you", "Continue where you left off", subsection start.

---

## Empty state

(Not yet built — when needed, follow this recipe)

- Centered in container, 64px+ vertical padding.
- Optional simple Icon at 32px, muted color.
- Serif h3 (22px) headline ("No assessments yet.")
- Sans muted body, 1–2 lines, max-width 360px.
- Primary CTA pill button.

No illustrations, no SVG hero art. Use whitespace as the visual.

---

## Loading state

Replace text with `.surface-2` shaped blocks at the same dimensions. 
- Heading skeleton: 28px tall × 60% width.
- Body line: 14px tall × 100% width, 8px gap, 3 lines.
- No spinners. No shimmer animation (subtle pulse 1.5s ease in/out at most).

---

## Modals / dialogs

(Not yet built — when needed)
- Centered, `max-width: 480px`, `--shadow-lg`.
- Same `card` styling: 16px radius, 1px border.
- 28–32px padding.
- Title is serif h2 (24px). Body sans 14px. Footer has 2 buttons (outline cancel + primary confirm) right-aligned.

---

## Page header recipe (universal)

```html
<div class="row">
  <div>
    <div class="mono" style="font-size:11px;color:var(--text-faint);
         text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">
      Wednesday · April 29
    </div>
    <h1 class="serif" style="font-size:36px;margin:0;font-weight:400;
         letter-spacing:-0.02em">
      Good afternoon, Alex.
    </h1>
  </div>
  <div class="spacer"></div>
  <button class="btn btn-outline">
    <Icon name="search" size="14"/>
    <span>Search</span>
    <span class="mono" style="font-size:10px;color:var(--text-faint)">⌘K</span>
  </button>
  <button class="btn btn-primary">
    <Icon name="plus" size="14" stroke="2"/> New assessment
  </button>
</div>
```

Mono eyebrow + serif h1 + right-aligned actions is the universal header.
