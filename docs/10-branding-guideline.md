# 10 — Branding & Visual Guideline

> **Source of truth for every page, layout, and component built going forward.** Distilled from the design-canvas template at `modules/17-ui-system/AccessIQ_UI_Template/`. Read this before opening Figma, before drafting a new screen, before adding a new component.
>
> The template folder name has a typo — the product is **AssessIQ**, not AccessIQ. In all production code, copy, and titles, use *AssessIQ*.

## 1. Visual identity in one paragraph

AssessIQ reads like an editorial publication that happens to grade you. **Newsreader** (serif) carries headlines, hero numbers, and quotes. **Geist** (sans) carries everything you click and read in passing. **JetBrains Mono** (mono) carries microcopy — labels, IDs, kbd hints, timestamps — letter-spaced and uppercase. Color is restrained: white-on-white surfaces, a confident accent in the indigo-violet 258 hue, status colors used sparingly. Density adjusts via a single `--u` spacing unit. Components are pill-shaped buttons, low-shadow cards with thin borders, and animated numbers (count-up, ring fill, sparklines) that reward completion. Nothing shouts.

## 2. Typography

### 2.1 Font stack

| Role | Family | Weights | Where it shows |
|---|---|---|---|
| Serif (`--aiq-font-serif`) | Newsreader, Source Serif Pro, Georgia, serif | 300 / **400** / 500 (opsz 6–72) | Page titles, hero numbers (score, percentile), section headings, blockquotes, "big numbers in cards" |
| Sans (`--aiq-font-sans`) | Geist, -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif | 300 / **400** / 500 / 600 | Body, buttons, inputs, sidebar items, every interactive label |
| Mono (`--aiq-font-mono`) | JetBrains Mono, "SF Mono", Menlo, monospace | 400 / 500 | Microcopy: chip text, attempt IDs (`#A-2841`), timestamps, kbd hints, numeric meta-labels |

### 2.2 Feature-settings (always on)

```css
.aiq-screen      { font-feature-settings: "ss01", "cv11"; }
.serif           { letter-spacing: -0.02em; font-weight: 400; }
.mono            { letter-spacing: -0.01em; font-feature-settings: "ss02"; }
.num             { font-family: var(--aiq-font-serif); font-variant-numeric: lining-nums tabular-nums; }
```

The `.num` class is load-bearing: every score, count, time, percent on a results/dashboard surface uses serif lining-tabular-nums. **Never use sans for big numbers** — it's the strongest brand signal we have.

### 2.3 Type scale

| Use | Size | Family | Weight | Letter-spacing |
|---|---|---|---|---|
| Hero (login, library, results) | 44–52px | serif | 400 | -0.025em |
| Page title (dashboard "Good afternoon, Alex.") | 36px | serif | 400 | -0.02em |
| Section heading | 22–28px | serif | 400 | -0.015em |
| Question text | 30px | serif | 400 | -0.015em |
| Body paragraph | 14–16px | sans | 400 | -0.005em |
| Body large (results lede) | 17px | sans | 400 | normal |
| UI label / button | 13–14px | sans | 500 | -0.005em |
| Microcopy (chips, meta) | 10–11px | mono | 400 | 0.04em–0.10em (uppercase) |
| Big number | 36–88px | serif | 400 | -0.03em to -0.04em |

### 2.4 Tone of language

The template's voice is understated and editorial. Adopt it.

- **Headlines as statements, ending with a period:** "The library.", "Sign in to continue.", "Build your own."
- **No exclamation marks** anywhere in product surfaces. The brand never raises its voice.
- **Microcopy uppercase + letter-spaced** for labels: `OVERALL SCORE`, `WORKSPACE`, `ACCOUNT`, `WEDNESDAY · APRIL 29`.
- **Mid-dot separator (`·`)** in meta lines instead of pipes/slashes: `30 min · 24 questions · Advanced`.
- **Numerals lead with serif** in any standalone display: `132/160`, `97th`, `47:12`. Avoid mono for hero numbers; mono is for IDs and kbd.

## 3. Color palette

Defined in OKLCH for perceptual uniformity and easy hue rotation per tenant.

### 3.1 Light mode (default)

```css
:root {
  /* Surfaces */
  --aiq-color-bg-base:       #ffffff;
  --aiq-color-bg-raised:     #fafafa;
  --aiq-color-bg-sunken:     #f5f5f5;

  /* Text */
  --aiq-color-fg-primary:    #1a1a1a;
  --aiq-color-fg-secondary:  #5f6368;
  --aiq-color-fg-muted:      #9aa0a6;

  /* Borders */
  --aiq-color-border:        #e8e8e8;
  --aiq-color-border-strong: #d4d4d4;

  /* Accent (indigo-violet, hue 258) — driven by tenants.branding.primary */
  --aiq-color-accent:        oklch(0.58 0.17 258);
  --aiq-color-accent-soft:   oklch(0.96 0.03 258);
  --aiq-color-accent-hover:  oklch(0.52 0.19 258);

  /* Status — used sparingly */
  --aiq-color-success:       oklch(0.65 0.15 150);
  --aiq-color-success-soft:  oklch(0.97 0.03 150);
  --aiq-color-warning:       oklch(0.72 0.15 70);
  --aiq-color-danger:        oklch(0.62 0.20 25);
}
```

### 3.2 Dark mode

```css
[data-theme="dark"] {
  --aiq-color-bg-base:       #0e0e10;
  --aiq-color-bg-raised:     #161618;
  --aiq-color-bg-sunken:     #1d1d20;
  --aiq-color-fg-primary:    #f5f5f7;
  --aiq-color-fg-secondary:  #a0a0a8;
  --aiq-color-fg-muted:      #6a6a72;
  --aiq-color-border:        #2a2a2e;
  --aiq-color-border-strong: #3a3a3f;
  --aiq-color-accent:        oklch(0.70 0.16 258);
  --aiq-color-accent-soft:   oklch(0.25 0.08 258);
  --aiq-color-accent-hover:  oklch(0.78 0.16 258);
  --aiq-color-success-soft:  oklch(0.30 0.05 150);
}
```

### 3.3 Color rules

1. **Status by color + icon, never color alone.** A "passed" pill is `chip-success` *with* a checkmark icon; "flagged" question is warn-border *with* a warn dot. WCAG and brand both demand this.
2. **Accent reserved for action and selection.** Filled-accent appears on: primary buttons, current question marker, selected option ring, current sparkline point, focused input ring, growth-area bullets. Don't tint backgrounds or borders accent unless they're interactive.
3. **Per-tenant override = accent only.** Tenants override `--aiq-color-accent` (and its soft/hover companions auto-derive). Surfaces, text, and status colors stay AssessIQ's. This keeps brand recognizability while allowing client white-label.
4. **Soft accent for selected backgrounds.** MCQ selected option fills `--aiq-color-accent-soft`; user avatar mark uses `--aiq-color-accent` solid. Don't invent intermediate shades.

## 4. Spacing & density

The template uses a single base unit `--u` that the density mode rescales.

```css
:root                       { --u: 4px; }
[data-density="compact"]    { --u: 3px; }
[data-density="cozy"]       { --u: 4px; }   /* default */
[data-density="comfortable"]{ --u: 5px; }
```

Token spacing scale (multiples of `--u`):

| Token | Multiplier | Cozy default |
|---|---|---|
| `--aiq-space-2xs` | 0.5× | 2px |
| `--aiq-space-xs`  | 1×   | 4px |
| `--aiq-space-sm`  | 2×   | 8px |
| `--aiq-space-md`  | 3×   | 12px |
| `--aiq-space-lg`  | 4×   | 16px |
| `--aiq-space-xl`  | 6×   | 24px |
| `--aiq-space-2xl` | 8×   | 32px |
| `--aiq-space-3xl` | 12×  | 48px |
| `--aiq-space-4xl` | 16×  | 64px |

**Density scope:** apply `data-density` at the surface level — `comfortable` for candidate-facing screens (assessment, results), `cozy` default for admin overview, `compact` for admin tables and dashboards where information density wins.

## 5. Radii, shadows, and surface rules

```css
--aiq-radius-sm:   6px;   /* chips, small buttons, inline pills */
--aiq-radius-md:  10px;   /* inputs, secondary cards */
--aiq-radius-lg:  16px;   /* primary cards, hero panels */
--aiq-radius-pill: 999px; /* every <button>, every chip */

--aiq-shadow-sm:  0 1px 2px rgba(0,0,0,0.04);
--aiq-shadow-md:  0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);
--aiq-shadow-lg:  0 8px 32px rgba(0,0,0,0.08);
```

**Surface rules:**
- Cards always have `border: 1px solid var(--aiq-color-border)` + `--aiq-radius-lg` and **no shadow** at rest. Shadow appears only on hover-elevated cards (`--aiq-shadow-md`) or floating overlays (`--aiq-shadow-lg`).
- Hero/marketing cards (login visual panel, score ring summary) earn `--aiq-shadow-lg`.
- Buttons are **always pill** (`--aiq-radius-pill`). No square buttons anywhere in the product.
- Inputs are `--aiq-radius-md`. Focus shows a 4px halo using `--aiq-color-accent-soft` via `box-shadow: 0 0 0 4px var(--aiq-color-accent-soft)`.

## 6. Iconography

Source: 24 inline SVG paths defined in the template's `screens/atoms.jsx` (`search`, `arrow`, `arrowLeft`, `check`, `clock`, `home`, `grid`, `chart`, `user`, `settings`, `plus`, `close`, `play`, `pause`, `flag`, `book`, `code`, `drag`, `bell`, `eye`, `sparkle`, `google`).

**Migration plan:** in production, wrap **lucide-react** (`docs/08-ui-system.md` § Iconography) and add the project-specific paths (`sparkle`, `aiq-mark dot+ring`) as custom icons. Match the template's drawing rules: `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `stroke-width: 1.5` default (use 2 for emphasis), `stroke-linecap: round`, `stroke-linejoin: round`.

**Icon sizes:** 10px (chip), 12px (button-sm), 14px (button-md), 16px (sidebar nav, big buttons), 20–24px (hero contexts). Never larger; the brand is restrained.

**Logo mark:** filled `--aiq-color-accent` dot, 10×10, with a 1px-bordered halo at -4px inset, accent at 0.3 opacity. Adjacent serif wordmark "AssessIQ" at 18px, weight 500, tracking -0.02em.

## 7. Motion

| Use | Duration | Easing |
|---|---|---|
| Hover, focus, color change | 0.15s | `ease` |
| Background swap, tab switch | 0.18s | `cubic-bezier(.2,.7,.3,1)` |
| Progress bar fill, width grow | 0.3–1.0s | `ease-out` |
| Celebratory: score count-up, ring fill | 1.4–1.6s | `cubic-bezier(.2,.8,.2,1)` |
| Reduced-motion override | instant | (use `prefers-reduced-motion`) |

Two animations are **brand signature** — preserve them in any score/result surface:

1. **Count-up on scores.** The `useCountUp(target, duration, start)` hook (template's `atoms.jsx`). Cubic-out easing over 1.4–1.6s, triggered on mount. Use on every standalone hero number (overall score, percentile, time saved, time spent).
2. **Ring-fill on score rings.** Animate `stroke-dashoffset` from full circumference to `c * (1 - pct)` over 1.6s. The ring rotates -90° so the start is at 12 o'clock.

## 8. Component idioms

These are the load-bearing visual patterns. Every new component should resemble one of these or compose them.

### 8.1 Button (always pill)

| Variant | Background | Border | Text | Use |
|---|---|---|---|---|
| `primary` | `--aiq-color-accent` (filled) | none | white | One per surface — the dominant action |
| `outline` | transparent | `--aiq-color-border-strong` | `--aiq-color-fg-primary` | Secondary actions, "Preview", "Save & exit" |
| `ghost` | transparent (hover: `--aiq-color-bg-raised`) | none | `--aiq-color-fg-primary` | Tertiary, "View all →", "Skip" |

Sizes: `sm` (6px 14px / 12px text), default (10px 18px / 13px text), `lg` (14px 28px / 14px text). **Always include focus ring** — 2px solid `--aiq-color-accent` outline at 2px offset, never `outline: none`.

### 8.2 Chip / Pill

11px mono-uppercase microcopy in a pill. Variants:
- Default — `--aiq-color-bg-raised` background, `--aiq-color-border` border, `--aiq-color-fg-secondary` text.
- `chip-accent` — accent-soft background, accent border, accent text. Use for "Popular", "AI · matched", "Auto-saved".
- `chip-success` — success-soft background, success text + check icon. Use for "Passed", "Completed".

### 8.3 Card

Bordered surface, `--aiq-radius-lg`, no shadow at rest. Padding 18–28px depending on density. On hover (interactive cards only) the border darkens to `--aiq-color-border-strong`. Floating cards add `--aiq-shadow-lg`. The login screen's "floating second card" pattern (offset margin into the parent's whitespace) is a reusable composition for "callout next to hero."

### 8.4 Input

12px 16px padding, `--aiq-radius-md`, `--aiq-color-border-strong` border. Focus: border becomes accent, and a 4px `--aiq-color-accent-soft` box-shadow halo appears. Placeholder is `--aiq-color-fg-muted`. Labels are visible above the field, never inside as placeholder.

### 8.5 Score visualizations (override the template's defaults)

The template shows `132/160` and `97th percentile` for cognitive batteries. **Replace with AssessIQ's banded model** in any graded view:

- **Anchor list** — bullets / chips. Each anchor shows hit/miss + evidence quote (max 25 words) + weight. Hits use `--aiq-color-fg-primary` text; misses use `--aiq-color-fg-muted` and strikethrough-optional.
- **Reasoning band display** — five segments (0/25/50/75/100 mapping to bands 0–4). Filled to the band's segment in accent; remainder in `--aiq-color-bg-sunken`. Label the band with its descriptor from the rubric.
- **Error class chip** — single chip in the warn or accent-soft variant when band < 4.
- **AI justification block** — serif italic 15px, on `--aiq-color-bg-raised`, with skill-version footer in mono microcopy.
- **Stage 3 escalation diff** — when both Sonnet and Opus verdicts exist, show side-by-side cards with a "Reconcile" affordance (admin picks).

The score ring (`ScoreRing` from the template) is reusable — but its label changes from "Overall score" to "Anchor weight + Band weight" or to a per-attempt total against the rubric maximum.

### 8.6 Sparkline

SVG polyline, `vector-effect: non-scaling-stroke`, 1.2px stroke in accent or `--aiq-color-fg-primary`, with 8% opacity area fill below. Use for any trend over 7–30 points.

### 8.7 Question navigator

Square cells in a `repeat(8, 1fr)` grid, 6px gap. States:
- Current — accent fill, white text, accent border.
- Answered — `--aiq-color-bg-raised` fill, primary text, default border.
- Flagged — warn border + 6px warn dot at top-right.
- Unseen — transparent fill, faint text, default border.

Mono 11px numerals inside. This is the single best-fit component the template has for AssessIQ — port it directly to `06-attempt-engine`.

### 8.8 Grid background ("futurism touch")

```css
.grid-bg {
  background-image:
    linear-gradient(var(--aiq-color-border) 1px, transparent 1px),
    linear-gradient(90deg, var(--aiq-color-border) 1px, transparent 1px);
  background-size: 48px 48px;
}
```

Always pair with a radial mask:
```css
mask-image: radial-gradient(circle at 60% 40%, black, transparent 70%);
```

Use sparingly — login visual panel and library hero only. Two grid-bg panels on one screen is too much.

### 8.9 Sidebar

240px fixed width, 1px right border, `--aiq-color-bg-base`. Sections separated by 10px mono-uppercase labels (`WORKSPACE`, `ACCOUNT`). Each `NavItem` is a 9px 14px row with 16px icon and 13px label; active state uses `--aiq-color-bg-raised` background and weight-500 text. The user card sits at the bottom on `--aiq-color-bg-raised`.

## 9. Screen layout templates

Every new page should pick one of these four shells and stay inside it. Mixing layout shells across the product breaks the editorial rhythm.

### 9.1 Split hero — for any auth or single-purpose action

```
┌─────────────────────────────┬─────────────────────────────┐
│   1fr                       │   1fr                       │
│   48px / 64px padding       │   surface-raised, grid-bg   │
│                             │                             │
│   [chip — status]           │       [hero card,           │
│   <h1 serif 44px>           │        floating callout]    │
│   [body 15px muted]         │                             │
│   <form fields>             │                             │
│   [primary button, full w]  │                             │
│   [divider · or ·]          │                             │
│   [sso buttons]             │                             │
│                             │                             │
│   [mono footer]             │       [serif blockquote]    │
└─────────────────────────────┴─────────────────────────────┘
```

Use for: login, MFA enrollment, accept-invitation, embed-handshake confirmation.

### 9.2 Sidebar + main — for every authenticated workspace screen

```
┌──────┬──────────────────────────────────────────────────┐
│      │   header row: meta-mono · serif title  · search  │
│ 240  │                                          + CTA   │
│ side ├──────────────────────────────────────────────────┤
│ bar  │   stats grid (4-up StatCards, optional)          │
│      │   primary content grid (1fr 380px or full-width) │
│      │   recommended / list section                     │
└──────┴──────────────────────────────────────────────────┘
```

Use for: admin dashboard, library, candidates, reports, audit log, **admin grading queue (Phase 1)**, tenant settings.

### 9.3 Header + content + aside — for focused work surfaces

```
┌────────────────────────────────────────────────────────────┐
│ sticky header: logo | divider | meta | autosave | timer    │
├──────────────────────────────────────────┬─────────────────┤
│  question column                         │  side panel     │
│  (max 1fr, padding 48 56)                │  (320px aside,  │
│                                          │   surface-raised│
│  meta row · question text (serif 30px)   │   border-left)  │
│  diagram / placeholder                   │                 │
│  options / inputs                        │  navigator      │
│  footer nav (prev / skip / next)         │  legend         │
│                                          │  section progr. │
│                                          │  tip card       │
└──────────────────────────────────────────┴─────────────────┘
```

Use for: assessment-in-progress, **admin grading-proposal review (Phase 1)**, question authoring, rubric editor.

### 9.4 Editorial full-bleed — for reports and outcomes

```
┌────────────────────────────────────────────────────────────┐
│ header: logo | back · spacer · share · download · retake   │
├────────────────────────────────────────────────────────────┤
│   max-width 1080, centered, padding 48 40 80               │
│   chip row · meta                                          │
│   <h1 serif 52px>                                          │
│   <p 17px lede>                                            │
│                                                            │
│   hero card: ScoreRing | summary | sidebar                 │
│   section heading + breakdown card (rows of details)       │
│   2-up cards: AI strengths · AI growth areas               │
│   distribution / comparison chart                          │
└────────────────────────────────────────────────────────────┘
```

Use for: results, attempt report, audit-log detail, archetype profile.

## 10. Accessibility deltas vs. the raw template

The template ships with a11y gaps; production must close them. When porting any screen:

1. **Convert interactive `<div>`s to `<button>`** (or add `role="button"` + `tabIndex={0}` + key handlers) — sidebar nav items, MCQ option cards, library cards, "continue" cards.
2. **Add visible focus rings to all buttons** — 2px solid `--aiq-color-accent` outline at 2px offset, never removed.
3. **Provide screen-reader text for SVG visualizations** — score ring needs an `aria-label="Score 132 of 160, 97th percentile"`; sparkline needs the underlying data summarized.
4. **Mark decorative icons `aria-hidden`; semantic icons get `aria-label`.** Chip icons (check, sparkle) are usually decorative; standalone action icons (close, settings) are not.
5. **`aria-live` on the timer** when ≤ 5 minutes remaining; `aria-live="polite"` on the autosave indicator.
6. **Skip-link to main** on every authenticated screen.
7. **Color-independent state** — flagged questions need both border-warn + warn dot + `aria-label`; passed/failed chips need icon + text, never color alone.
8. **Verify contrast** on token combinations — `--aiq-color-fg-muted` (`#9aa0a6`) on `--aiq-color-bg-sunken` (`#f5f5f5`) is borderline; use it only for non-essential meta. WCAG AA target is 4.5:1 body / 3:1 large text and UI elements.

## 11. Multi-tenant theming hook

Per-tenant override sets the accent only:

```css
/* Server-rendered <style> from tenants.branding.primary */
:root {
  --aiq-color-accent: oklch(0.58 0.17 220);          /* tenant chose 220 hue */
  --aiq-color-accent-soft: oklch(0.96 0.03 220);
  --aiq-color-accent-hover: oklch(0.52 0.19 220);
}
```

Surfaces, text, and status colors stay AssessIQ's. Embed mode receives the same tokens via `postMessage`; the iframe applies only `--aiq-*` keys (origin-verified) to prevent host-page CSS bleed.

## 12. Recipe — building a new page in this style

Follow this checklist for every new screen request in coming sessions.

1. **Pick a shell** (§ 9). If none fits, default to sidebar+main and revisit.
2. **Pick a density** for the surface (`comfortable` for candidate, `cozy` admin default, `compact` for tables).
3. **Write the hero/title in serif** with a mono micro-label above it. End the title with a period.
4. **Compose with existing idioms** (§ 8). New visual ideas need explicit justification — the brand is built on consistency.
5. **Use `--aiq-*` tokens only.** Never inline a hex, OKLCH, or px value if a token expresses the same thing.
6. **Wire numbers as `<span class="num">`** (serif lining-tabular-nums) — this is the single strongest brand cue.
7. **Pick one primary action per screen.** Everything else is outline or ghost.
8. **Include a help affordance** — a `HelpTip` next to the hero title, plus contextual `HelpTip`s on non-obvious controls (rubric weight, escalation, archetype).
9. **Verify dark mode** — toggle `data-theme="dark"` and check that no chips, shadows, or hard-coded values break.
10. **Verify a11y** — keyboard tab through every interactive, screen-reader through every visualization, run axe.
11. **Add the screen to Storybook** — default state, loading, empty, error, dark, RTL.
12. **Update the help-content registry** in `16-help-system` for any new `help_id`s.

## 13. Where the source files live

```
modules/17-ui-system/AccessIQ_UI_Template/      # reference only — DO NOT IMPORT FROM APP CODE
├── styles.css                  # token + base classes (port to modules/17-ui-system/tokens/tokens.css)
├── screens/atoms.jsx           # Logo, Icon, Placeholder, useCountUp (port to components/primitives)
├── screens/login.jsx           # split-hero reference
├── screens/dashboard.jsx       # sidebar+main reference + StatCard, Sparkline, Sidebar, NavItem
├── screens/library.jsx         # sidebar+main reference with hero search
├── screens/assessment.jsx      # header+content+aside reference + QuestionNav
├── screens/results.jsx         # editorial full-bleed reference + ScoreRing
├── design-canvas.jsx           # designer-tool harness — exclude from build
├── tweaks-panel.jsx            # designer-tool harness — exclude from build
├── AccessIQ.html               # designer preview — exclude from build
└── .design-canvas.state.json   # designer state — exclude from build
```

The four "exclude from build" files are the omelette/Claude-design-canvas wrapper that produced this template. They are useful for visual reference (open `AccessIQ.html` in a browser to see all screens) but must never be imported by production code.

## 14. What this guideline does not cover

- **Domain copy.** Replace cognitive-assessment sample text (verbal/logical/spatial categories, "GMAT-style", percentile-vs-millions) with role-readiness language (SOC analyst scenarios, anchor concepts, archetype labels) on a per-page basis.
- **Score model.** The template's `132/160` + percentile + raw 0–100 bars are wrong for AssessIQ — see `docs/05-ai-pipeline.md` § Score computation for the banded model that replaces them.
- **Auth flow.** Template's email/password + signup is not the v1 product — see `docs/04-auth-flows.md` for Google SSO + TOTP MFA + admin-invite-only.
- **Components beyond what the template shipped.** New domain components (`RubricEditor`, `BandPicker`, `AnchorChip`, `GradingProposalCard`, `HelpTip`, `HelpDrawer`, `TotpEnrollment`) are listed in `docs/08-ui-system.md` and built per-module — they must conform to this guideline but are not pre-designed here.
