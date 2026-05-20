# 10 — Branding & Visual Guideline

> **Source of truth for every page, layout, and component built going forward.** Distilled from the design-canvas template at `modules/17-ui-system/AssessIQ_UI_Template/`. Read this before opening Figma, before drafting a new screen, before adding a new component.
>
> The kit's internal files (`CLAUDE.md`, `README.md`, `AccessIQ.html`, `brand/brand-guidelines.html`, and logo SVG filenames like `accessiq-horizontal.svg`) still spell the product name as **AccessIQ** — a vendor-side typo carried over when the kit was authored. The outer folder is correctly named `AssessIQ_UI_Template`. In all production code, copy, page titles, and OG/meta tags, use *AssessIQ*. Do not mass-rewrite kit internals on every refresh; the typo is design-time only and never reaches runtime (HTML links in `apps/web/index.html` reference `favicon/*` and `social/og-image.*` which match across kit revisions).

## 0. Working agreement — the design-system kit is the canonical reference

**Every UI change — new page, new layout, new composite, new variant of an existing component — starts at the design-system kit shipped in [`modules/17-ui-system/AssessIQ_UI_Template/`](../modules/17-ui-system/AssessIQ_UI_Template/).** That folder is the brand contract. Read it in this exact order before opening Figma, drafting a screen, or writing a component:

1. [`AssessIQ_UI_Template/CLAUDE.md`](../modules/17-ui-system/AssessIQ_UI_Template/CLAUDE.md) — folder-local entry point. Non-negotiables (single accent, two type families, generous whitespace, borders not shadows, pill primary buttons).
2. [`AssessIQ_UI_Template/design-system/README.md`](../modules/17-ui-system/AssessIQ_UI_Template/design-system/README.md) — design philosophy + Do/Don't.
3. [`AssessIQ_UI_Template/design-system/tokens.md`](../modules/17-ui-system/AssessIQ_UI_Template/design-system/tokens.md) — exact colors, type, spacing, radii, shadows.
4. [`AssessIQ_UI_Template/design-system/components.md`](../modules/17-ui-system/AssessIQ_UI_Template/design-system/components.md) — primitive recipes (buttons, inputs, cards, chips, icons).
5. [`AssessIQ_UI_Template/design-system/patterns.md`](../modules/17-ui-system/AssessIQ_UI_Template/design-system/patterns.md) — page layouts (sidebar, hero, results, empty states).
6. [`AssessIQ_UI_Template/design-system/copy-and-voice.md`](../modules/17-ui-system/AssessIQ_UI_Template/design-system/copy-and-voice.md) — tone, microcopy, number formatting.
7. [`AssessIQ_UI_Template/screens/`](../modules/17-ui-system/AssessIQ_UI_Template/screens/) — reference JSX implementations. Today: `login`, `dashboard`, `activity` (v1.1 — heatmap + leaderboard + stat-card breakdowns), `library`, `assessment`, `results`, plus `atoms.jsx` for primitives. Open [`AccessIQ.html`](../modules/17-ui-system/AssessIQ_UI_Template/AccessIQ.html) in a browser to see them; open [`component-gallery.html`](../modules/17-ui-system/AssessIQ_UI_Template/component-gallery.html) for every primitive on one page.
>
> **Kit version: v1.1 (May 2026).** Differences from v1.0: type tokens darkened (`--text` is now near-black `#0a0a0b`, serif headings weight 500); new `activity.jsx` screen with GitHub-style heatmap, stacked-bar timeline, leaderboard rows, and stat cards with colored breakdowns; brand assets moved from `Logo/` to `brand/` (downstream consumer `apps/web/scripts/copy-brand-assets.mjs` updated accordingly).
>
> **Port status: v1.1 fully shipped (2026-05-14).** All 14 phases of `docs/plans/UI_KIT_V1_1_PORT.md` are complete. Every admin and candidate page now uses count `Chip` + serif h1 (weight 400, −0.02em tracking) + lede paragraph, `Spinner` for all loading states, and the `--aiq-color-bg-raised` surface token. Phase 14 adds `@axe-core/playwright` a11y gate (unauthenticated pages). Visual regression + Lighthouse sweep deferred to Phase 15.

This guideline (`docs/10-branding-guideline.md`) is the **production-translation companion** to that kit — it explains how the kit's un-prefixed tokens (`--accent`, `--bg`, `.btn`) become the production `--aiq-*` namespace and `aiq-*` classes, and adds AssessIQ-specific deltas (the banded score model, accessibility deltas, multi-tenant accent override, light-mode-only lock). **The kit wins on visual conflicts; this doc updates next; [docs/08-ui-system.md](./08-ui-system.md) tracks the system implications last.**

The rules:

1. **Consult the kit first, in the order above.** If a screen exists in `screens/` for what you're building, port its structure, spacing, type ramp, and composition into the live page. The recipes in `design-system/components.md` are the canonical specs; the JSX in `screens/` shows them in context.

2. **Never lift-and-shift template code.** Files under `AssessIQ_UI_Template/` are reference, not production — [`modules/17-ui-system/SKILL.md:47`](../modules/17-ui-system/SKILL.md) is explicit: *"The designer-tool harness must never be imported by app code; port the screen JSX and atoms into typed components under `components/` on demand as features land."* Importing `screens/login.jsx` directly into `apps/web/...` is a Phase 3 bounce condition. ESLint `no-restricted-imports` blocks `**/AssessIQ_UI_Template/**` globally.

3. **If no screen or pattern exists for what you're building, STOP and surface the gap.** Either request the user add a `screens/<name>.jsx` + a `design-system/components.md` recipe entry first, or get explicit approval to compose from existing atoms. Do NOT silently invent a layout from primitives — that's how admin-side pages drift apart visually (the `apps/web/src/pages/admin/users.tsx` gap, surfaced 2026-05-01: no `users.jsx` template existed, so the page was assembled ad-hoc from atoms with no canonical reference to anchor future admin-list pages).

4. **Phase 3 critique of any UI diff includes a "does this match the kit?" gate.** Subagents (Sonnet, Haiku) proposing UI code without citing the screen, recipe, or pattern they referenced get bounced back. The diff review reads the relevant `screens/<name>.jsx` + `design-system/<topic>.md` alongside the diff.

5. **Translation pattern (the five steps for porting a screen):**
   1. Read `CLAUDE.md` + `design-system/README.md` for the rules; `design-system/patterns.md` for the layout shell; `design-system/components.md` for the primitives in play.
   2. Read the relevant `screens/<name>.jsx` and `screens/atoms.jsx` for the in-context JSX.
   3. Identify which `@assessiq/ui-system` typed components already cover those primitives; build any missing ones in `modules/17-ui-system/src/components/` first (Storybook story + a11y test + dark-mode story per the module's component contract).
   4. **Translate the kit's un-prefixed tokens to production names** when authoring the live page: `--accent` → `--aiq-color-accent`, `--bg` → `--aiq-color-bg-base`, `--surface` → `--aiq-color-bg-raised`, `--surface-2` → `--aiq-color-bg-sunken`, `--text` → `--aiq-color-fg-primary`, `--text-muted` → `--aiq-color-fg-secondary`, `--text-faint` → `--aiq-color-fg-muted`, `--border` / `--border-strong` keep their semantic but with the `--aiq-color-` prefix. The `.btn`, `.card`, `.chip`, `.input` global classes become `aiq-btn`, `aiq-card`, `aiq-chip`, `aiq-input`. The full token namespace lives in [`modules/17-ui-system/src/styles/tokens.css`](../modules/17-ui-system/src/styles/tokens.css).
   5. Match the kit's visual hierarchy, spacing, and prose voice exactly. Document any deliberate divergence (accessibility, route-specific behavior, addendum decision) in the page's header comment as `// Diverges from screens/<name>.jsx because: <reason>`.

This rule is encoded in memory at `branding-guideline-from-template.md` and `feedback-ui-template-canonical.md` so future sessions honour it at warm-start.

## 1. Visual identity in one paragraph

AssessIQ reads like an editorial publication that happens to grade you. **Newsreader** (serif) carries headlines, hero numbers, and quotes. **Geist** (sans) carries everything you click and read in passing. **JetBrains Mono** (mono) carries microcopy — labels, IDs, kbd hints, timestamps — letter-spaced and uppercase. Color is restrained: white-on-white surfaces, a confident accent in the indigo-violet 258 hue, status colors used sparingly. Density adjusts via a single `--u` spacing unit. Components are pill-shaped buttons, low-shadow cards with thin borders, and animated numbers (count-up, ring fill, sparklines) that reward completion. Nothing shouts.

### 1.1 Light mode is canonical; dark mode is opt-in

`AssessIQ_UI_Template/screens/*.jsx` ship **light-mode tokens only**. The visual identity in the paragraph above is *the* identity — white-on-white, restrained colour, low contrast, editorial calm. The dark-mode block in `modules/17-ui-system/src/styles/tokens.css` exists as **infrastructure** for a future opt-in (per `modules/17-ui-system/SKILL.md` Help/tooltip surface: `admin.profile.theme` — light/dark/system explanation), but is NOT the brand and must NOT render by default.

**Hard rule**: `apps/web` mounts `<ThemeProvider theme="light">` — never `"system"`. `"system"` resolves to dark on any OS in dark mode (Windows 11 default, macOS evening, etc.) and applies `data-theme="dark"` to the wrapping div, which overrides `--aiq-color-bg-base` to `#0e0e10` and gives the SPA a black background that diverges from every template screen. Dark mode adoption is gated on:

1. The template ships dark-mode variants of every screen in `AssessIQ_UI_Template/screens/`, demonstrating the brand survives the inversion.
2. An explicit user-toggle UI lands at `admin.profile.theme` (Phase 1+).
3. Both `light` and `dark` variants pass the same accessibility audit (axe, contrast ≥ 4.5:1).

Until all three land, the SPA is locked to light. This decision is encoded in the page-mount comment at [apps/web/src/App.tsx](../apps/web/src/App.tsx) so future sessions don't silently flip back to `"system"`.

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
  --aiq-color-bg-sunken:     #f3f3f4;

  /* Text */
  --aiq-color-fg-primary:    #0a0a0b;
  --aiq-color-fg-secondary:  #3f3f46;
  --aiq-color-fg-muted:      #71717a;

  /* Borders */
  --aiq-color-border:        #e4e4e7;
  --aiq-color-border-strong: #cdcdd1;

  /* Accent (indigo-violet, hue 258) — driven by tenants.branding.primary */
  --aiq-color-accent:        oklch(0.58 0.17 258);
  --aiq-color-accent-soft:   oklch(0.96 0.03 258);
  --aiq-color-accent-hover:  oklch(0.52 0.19 258);

  /* Status — used sparingly */
  --aiq-color-success:       oklch(0.65 0.15 150);
  --aiq-color-success-soft:  oklch(0.97 0.03 150);
  --aiq-color-warning:       oklch(0.72 0.15 70);
  --aiq-color-warning-soft:  oklch(0.97 0.04 70);
  --aiq-color-danger:        oklch(0.62 0.20 25);
  --aiq-color-info:          oklch(0.62 0.18 230);

  /* Chart palette — data visualizations (StatCard breakdown, StackedBarChart, LeaderboardList avatars).
     Eight slots; consumers iterate by index. Google-brand-anchored, NOT Tailwind. */
  --aiq-color-chart-1: #1a73e8;
  --aiq-color-chart-2: #10b981;
  --aiq-color-chart-3: #fbbc04;
  --aiq-color-chart-4: #ea4335;
  --aiq-color-chart-5: #9333ea;
  --aiq-color-chart-6: #06b6d4;
  --aiq-color-chart-7: #f97316;
  --aiq-color-chart-8: #64748b;

  /* Heatmap intensity ramp — five stops of hue 258 (matches --aiq-color-accent). Used by ActivityHeatmap.
     Level 0 is the empty-cell color (tracks dark mode via --aiq-color-bg-sunken); 1–4 climb in chroma. */
  --aiq-color-heatmap-0: var(--aiq-color-bg-sunken);
  --aiq-color-heatmap-1: oklch(0.92 0.06 258);
  --aiq-color-heatmap-2: oklch(0.82 0.12 258);
  --aiq-color-heatmap-3: oklch(0.68 0.16 258);
  --aiq-color-heatmap-4: oklch(0.55 0.18 258);
}
```

### 3.2 Dark mode

```css
[data-theme="dark"] {
  --aiq-color-bg-base:       #0e0e10;
  --aiq-color-bg-raised:     #161618;
  --aiq-color-bg-sunken:     #1d1d20;
  --aiq-color-fg-primary:    #f5f5f7;
  --aiq-color-fg-secondary:  #8a8a94;
  --aiq-color-fg-muted:      #88889a;
  --aiq-color-border:        #2a2a2e;
  --aiq-color-border-strong: #3a3a3f;
  --aiq-color-accent:        oklch(0.70 0.16 258);
  --aiq-color-accent-soft:   oklch(0.25 0.08 258);
  --aiq-color-accent-hover:  oklch(0.78 0.16 258);
  --aiq-color-success-soft:  oklch(0.30 0.05 150);
  --aiq-shadow-sm:  0 1px 2px rgba(0,0,0,0.4);
  --aiq-shadow-md:  0 1px 3px rgba(0,0,0,0.5), 0 4px 12px rgba(0,0,0,0.3);
  --aiq-shadow-lg:  0 8px 32px rgba(0,0,0,0.6);
}
```

### 3.3 Color rules

1. **Status by color + icon, never color alone.** A "passed" pill is `chip-success` *with* a checkmark icon; "flagged" question is warn-border *with* a warn dot. WCAG and brand both demand this.
2. **Accent reserved for action and selection.** Filled-accent appears on: primary buttons, current question marker, selected option ring, current sparkline point, focused input ring, growth-area bullets. Don't tint backgrounds or borders accent unless they're interactive.
3. **Per-tenant override = accent only.** Tenants override `--aiq-color-accent` (and its soft/hover companions auto-derive). Surfaces, text, and status colors stay AssessIQ's. This keeps brand recognizability while allowing client white-label.
4. **Soft accent for selected backgrounds.** MCQ selected option fills `--aiq-color-accent-soft`; user avatar mark uses `--aiq-color-accent` solid. Don't invent intermediate shades.

> **Updated 2026-05-14 to v1.1 token values (commit `2e1af79`).** Six light-mode hex values (`--aiq-color-bg-sunken`, `--aiq-color-fg-primary`, `--aiq-color-fg-secondary`, `--aiq-color-fg-muted`, `--aiq-color-border`, `--aiq-color-border-strong`) and two dark-mode hex values (`--aiq-color-fg-secondary`, `--aiq-color-fg-muted`) were reconciled to match `modules/17-ui-system/src/styles/tokens.css`. See `docs/design/2026-05-14-phase-14-reduced-motion-audit.md` for the original drift report.

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
modules/17-ui-system/AssessIQ_UI_Template/      # reference only — DO NOT IMPORT FROM APP CODE
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

### 13.b — Brand kit (logo, favicon, OG card, web manifest)

The brand identity assets live **inside** the UI template at [`modules/17-ui-system/AssessIQ_UI_Template/Logo/`](../modules/17-ui-system/AssessIQ_UI_Template/Logo/) so the design system and brand identity share one source of truth. Open [`Logo/brand-guidelines.html`](../modules/17-ui-system/AssessIQ_UI_Template/Logo/brand-guidelines.html) in a browser for the visual reference.

```
modules/17-ui-system/AssessIQ_UI_Template/Logo/
├── README.md                          # kit overview + embed snippet
├── brand-guidelines.html              # visual reference
├── logo/                              # mark, wordmark, lockups (assessiq-*.{svg,png})
├── favicon/                           # web + app icons + site.webmanifest
└── social/                            # OG / Twitter card (1200×630)
```

**Wordmark, color, file naming:**

- The wordmark text in every SVG is **AssessIQ** (not "AccessIQ" — the parent folder name carries the typo, the assets do not). Per § 0 of this guideline.
- The mark color in every light-variant SVG is `#3177dc` — the canonical accent derived from `oklch(0.58 0.17 258)` in [`modules/17-ui-system/src/styles/tokens.css`](../modules/17-ui-system/src/styles/tokens.css). Dark variants use `#5b9eff` (`oklch(0.70 0.16 258)`); the accent-hover companion is `#0462d3` (`oklch(0.52 0.19 258)`). Tenant accent overrides flow through `--aiq-color-accent` for in-product surfaces; baked SVGs (favicon, OG, app icons) keep the AssessIQ accent.
- File names follow `assessiq-{mark,wordmark,horizontal,stacked,horizontal-dark,mark-dark,mark-mono,...}.{svg,png}`. The unprefixed favicons (`favicon-16.png`, `apple-touch-icon-180.png`, `app-icon-192.png`, etc.) keep their standard names.

**Two regeneration / mirror workflows:**

1. **PNGs from SVGs** — [`modules/17-ui-system/tools/regenerate-brand-pngs.ts`](../modules/17-ui-system/tools/regenerate-brand-pngs.ts) rasterizes every PNG under `Logo/` from its SVG master at the canonical size. Run after editing any SVG in the kit:

   ```bash
   pnpm --filter @assessiq/ui-system brand:regen
   ```

   Uses `@resvg/resvg-js` (pure-WASM, no native binary, no Chromium overhead). The job manifest in the script is the source of truth for "which SVG → which PNG → at what size"; add an entry there to ship a new lockup raster.

2. **Kit → SPA mirror** — [`apps/web/scripts/copy-brand-assets.mjs`](../apps/web/scripts/copy-brand-assets.mjs) copies the `Logo/{favicon,logo,social}/` subfolders into `apps/web/public/brand/` so Vite serves them at `/brand/*`. Wired into `apps/web/package.json` as `predev` and `prebuild` hooks, so any `pnpm dev` or `pnpm build` re-mirrors automatically. The destination folder is **gitignored** — never edit `apps/web/public/brand/` directly. Source-of-truth is always the kit.

**Production wiring (`apps/web/index.html`):**

- Favicon set: `favicon.svg` (modern browsers), `favicon-{16,32}.png` (legacy), `apple-touch-icon-180.png` (iOS).
- PWA manifest: `<link rel="manifest" href="/brand/favicon/site.webmanifest" />` — nginx serves it as `application/manifest+json` via an explicit MIME location in [`infra/docker/assessiq-frontend/nginx.conf`](../infra/docker/assessiq-frontend/nginx.conf) (the default mime.types doesn't include `.webmanifest`).
- Theme color: `<meta name="theme-color" content="#3177dc" />`.
- OG / Twitter share card: `og:title`, `og:description`, `og:image`, `og:type`, `twitter:card=summary_large_image`, `twitter:image`.

**In-product Logo component — Path 1 decision (2026-05-03):**

[`modules/17-ui-system/src/components/Logo.tsx`](../modules/17-ui-system/src/components/Logo.tsx) stays the existing CSS-driven `aiq-mark` (a 10×10 dot + 1px halo at -4px inset, per § 6). It does NOT inline the kit's SVG. The kit's mark is intentionally *richer* (dot + two hairline rings r=18 and r=26 at varying opacity) — it's the brand on a deck or share card, not a calmer in-context detail. The two variants are a feature, not a bug.

If a future surface needs the richer kit mark (e.g. an admin "branding settings" preview), import the SVG from `apps/web/public/brand/logo/assessiq-mark.svg` directly — don't duplicate it into `Logo.tsx`.

**Tagline — RESOLVED 2026-05-19.** The site-wide brand line is **`Graded on evidence.`**, recorded as canonical in [`copy-and-voice.md` § Tagline](../modules/17-ui-system/AssessIQ_UI_Template/design-system/copy-and-voice.md). It replaces the earlier placeholder *"A calmer way to measure ability."* The runtime `meta description` + `og:description` in [`apps/web/index.html`](../apps/web/index.html) are updated. **Remaining divergence:** the baked OG social card raster and the stacked lockup subtagline still render the *old* placeholder text — they are images, not markup, so the new line only reaches them by editing the kit source and running `pnpm --filter @assessiq/ui-system brand:regen` (§13.b workflow 1). Deferred deliberately (no official social push yet); regenerate before any social launch so shares match the site.

**Pending decisions (still open as of 2026-05-03):**

- OG card eyebrow / footer copy (`ASSESSMENT · MEASURED`, `EST · 2026`) is from the original kit; not in any approved doc. Live now because skipping the OG card on every social share is worse than shipping the placeholder. Revisit before any official social push (alongside the tagline raster regen above).
- OG card domain shows `assessiq.io` — placeholder. Real production domain is `assessiq.automateedge.cloud`. Not changed automatically because `assessiq.io` may be a planned acquisition.
- Stacked lockup carries `ASSESSMENT · 2026` subtagline — not in any approved doc; same defer-to-decision.

## 14. What this guideline does not cover

- **Domain copy.** Replace cognitive-assessment sample text (verbal/logical/spatial categories, "GMAT-style", percentile-vs-millions) with role-readiness language (SOC analyst scenarios, anchor concepts, archetype labels) on a per-page basis.
- **Score model.** The template's `132/160` + percentile + raw 0–100 bars are wrong for AssessIQ — see `docs/05-ai-pipeline.md` § Score computation for the banded model that replaces them.
- **Auth flow.** Template's email/password + signup is not the v1 product — see `docs/04-auth-flows.md` for Google SSO + TOTP MFA + admin-invite-only.
- **Components beyond what the template shipped.** New domain components (`RubricEditor`, `BandPicker`, `AnchorChip`, `GradingProposalCard`, `HelpTip`, `HelpDrawer`, `TotpEnrollment`) are listed in `docs/08-ui-system.md` and built per-module — they must conform to this guideline but are not pre-designed here.

## 15. Mobile

The mobile UI kit lives at [`modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/`](../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/). It is a **palette of idioms** (tokens, atoms, layout patterns) for tuning existing pages on small viewports — *not* a product spec. Per [docs/plans/MOBILE_KIT_PORT.md](./plans/MOBILE_KIT_PORT.md), the port adopts kit visuals only for routes that already exist in the product. Adding a new page, route, or user flow because the kit ships a screen for it is out of scope.

### 15.1 Viewport mechanism

The SPA distinguishes two viewports: `mobile` and `desktop`. The current viewport is published as `data-viewport="mobile" | "desktop"` on `<html>`, driven by `window.matchMedia('(max-width: 719px), ((pointer: coarse) and (max-width: 1024px))')`. The initial value is set by an inline script in [`apps/web/index.html`](../apps/web/index.html) before the React bundle loads (avoids first-paint flicker); the React side keeps it in sync via `useViewportSync()` in [`modules/17-ui-system/src/hooks/useViewportSync.ts`](../modules/17-ui-system/src/hooks/useViewportSync.ts), wired into the existing `ThemeProvider`. Components that need to branch on viewport import `useViewport()` from `@assessiq/ui-system`.

### 15.2 Token deltas

The following CSS custom properties are overridden under `[data-viewport="mobile"]` in [`modules/17-ui-system/src/styles/tokens.css`](../modules/17-ui-system/src/styles/tokens.css):

| Token | Desktop | Mobile | Source |
| --- | --- | --- | --- |
| `--aiq-page-padding-x` | `40px` | `22px` | kit README (page padding 20–24px) |
| `--aiq-page-padding-y` | `32px` | `20px` | kit README |
| `--aiq-card-padding` | `24px` | `18px` | kit README (card padding 16–20px) |
| `--aiq-h1-size` | `36px` (`--aiq-text-3xl`) | `30px` | kit README (H1 28–34px) |

Pages reference the tokens directly (e.g., `padding: var(--aiq-page-padding-y) var(--aiq-page-padding-x)`) so the override applies automatically when the viewport changes.

### 15.3 Pattern reflows (catalog — populated incrementally by later phases)

Each later phase of the mobile port adds its reflow rule here.

#### Two-pane magic-link landing → single column (M1 — 2026-05-20)

Pages: [`apps/web/src/pages/candidate/CandidateLogin.tsx`](../apps/web/src/pages/candidate/CandidateLogin.tsx), [`apps/web/src/pages/take/TokenLanding.tsx`](../apps/web/src/pages/take/TokenLanding.tsx), [`apps/web/src/pages/take/Expired.tsx`](../apps/web/src/pages/take/Expired.tsx), [`apps/web/src/pages/take/ErrorPage.tsx`](../apps/web/src/pages/take/ErrorPage.tsx).

| Element | Desktop | Mobile |
| --- | --- | --- |
| Grid | `1fr 1fr` (form + visual aside) | `1fr` (form only) |
| Right aside | rendered | `display: none` (DOM kept; CSS-hidden) |
| `<main>` padding | `48px 64px` | `24px 22px` |
| Hero serif `<h1>` | `44px / 1.05` (TokenLanding · Expired · ErrorPage) or `36px / 1.1` (CandidateLogin) | `30px / 1.1` |
| Primary button | inline | full-width (unchanged across viewports) |

Mechanism: outer container carries `.aiq-take-twopane` (or `.aiq-candidate-login` for the portal login) + `<main>` carries `.aiq-take-main` (or `.aiq-candidate-login-main`). All overrides live in [`tokens.css`](../modules/17-ui-system/src/styles/tokens.css) under `[data-viewport="mobile"]` (the M0 mechanism — *not* a page-local `@media` rule). For the hero H1, `.aiq-take-twopane` scopes two CSS vars (`--aiq-take-h1-size`, `--aiq-take-h1-lh`) that the inline `SERIF_H1` style object reads; the desktop value defaults to `44px` via `var()` fallback.

**Anti-pattern guards** (apply when adding more pages to this reflow):
- DOM tree must be identical between viewports. Mobile must NOT swap the component tree — only CSS layout deltas. Divergent behavior across viewports is a bounce (`docs/plans/MOBILE_KIT_PORT.md` § Anti-pattern guards #5).
- Anti-enumeration copy and 200 ms timing floor remain unchanged.
- Same backend payloads on both viewports; same rate-limit error surfaces.
- `CandidateLoginVerify` (centered spinner intermediary) needs no reflow — it is viewport-agnostic by construction (`placeItems: 'center'`).

#### AttemptPage chrome → mobile reflow (M2a — 2026-05-20)

Page: [`apps/web/src/pages/take/Attempt.tsx`](../apps/web/src/pages/take/Attempt.tsx). The take-flow runner. Mobile-only CSS overrides; same DOM both viewports.

| Element | Desktop | Mobile |
| --- | --- | --- |
| Header padding | `0 var(--aiq-space-2xl)` (40px) | `0 var(--aiq-space-md)` (12px) |
| Header gap | `var(--aiq-space-md)` (12px) | `var(--aiq-space-sm)` (8px) |
| Navigator-toggle button (new) | `display: none` | `display: inline-flex` (grid icon, opens Drawer) |
| Middle row grid | `1fr 320px` (main + navigator aside) | `1fr` (main fills, aside hidden) |
| Middle row padding | `var(--aiq-space-lg) var(--aiq-space-2xl)` | `var(--aiq-space-md)` |
| Question serif `<p>` | `var(--aiq-text-2xl)` (30px) | `22px` |
| Footer | flex-row, `[Flag] — spacer — [Prev][Next][Submit]` | flex-wrap row; Submit takes `flex: 1 0 100%` (new row); `[Flag][Prev][Next]` share the row above; spacer hidden |

Mechanism: outer attempt wrapper carries `.aiq-attempt-shell`, which scopes a `--aiq-attempt-q-size` CSS var used by `.aiq-attempt-q-text` (the question paragraph). The aside hides via `display: none` under `[data-viewport="mobile"]`; in its place the existing `<Drawer>` from `@assessiq/ui-system` mounts lazily (only when the navigator toggle is tapped) with `title="Navigator"` and the same `QuestionNavigator` + legend body that the desktop aside renders. Footer restack uses `flex-wrap` + per-button `order` + `flex: 1 0 100%` on Submit — no DOM restructure.

**Anti-pattern guards (M2a-specific):**
- Integrity-hook surface (blur / visibility / beacon) unchanged. Reflow ≠ behavior change.
- Timer math (`AttemptTimer.endsAt`, `handleExpire`), autosave debounce (`useAutosave.queueSave/flushSave`), submit semantics (`window.confirm` + `submitAttempt`) all byte-identical to pre-M2a.
- Drawer renders the SAME `<QuestionNavigator items={items} onSelect={fn} />` — same props, same backend semantics, same per-cell states (`current` / `answered` / `flagged` / `unanswered`).
- A new `data-help-id="candidate.attempt.navigator.toggle"` exists for the new control with a same-PR entry in `modules/16-help-system/content/en/candidate.yml` (PROJECT_BRAIN § 9 same-PR rule).
- Per-question-type tunings (KQL editor, subjective, log/scenario) are explicitly out of M2a — they belong in M2b and may need a "desktop-required" interstitial decision before any rendering changes.

#### AttemptPage answer-area mobile sizing + KQL caveat tip (M2b — 2026-05-20)

Per-question-type mobile tuning of the same `Attempt.tsx`. CSS-var indirection on `.aiq-attempt-shell`; no DOM restructure for any question type.

| Element | Desktop | Mobile | Why |
| --- | --- | --- | --- |
| Subjective `<textarea>` | 15px sans | 16px sans | iOS Safari auto-zooms form inputs whose computed `font-size` is below 16px on focus; pushing to ≥ 16px defeats the auto-zoom and preserves layout. |
| KQL `<textarea>` (Phase 1: plain textarea, Monaco deferred) | 13px mono | 16px mono | Same auto-zoom defense; mono font retained for syntax readability. |
| Log-analysis finding `<input>` | 14px sans | 16px sans | Same. |
| Log-analysis explanation `<textarea>` | 15px sans | 16px sans | Same. |
| Scenario step `<textarea>` | 15px sans | 16px sans | Same. |
| KQL caveat tip (new) | hidden (`display: none`) | shown (`display: block`) above the tables/textarea | Sets candidate expectation that KQL is meaningfully easier on a laptop without blocking the mobile answer. |
| MCQ option `<label>` text | 15px sans | 15px sans (unchanged) | Tap target already ≥ 44 px; option text is a `<div>` inside a `<label>` with an `opacity: 0` radio — no form-input focus zoom risk. |

Mechanism: `.aiq-attempt-shell` scopes two new CSS vars — `--aiq-answer-input-size` (15→16) and `--aiq-answer-mono-size` (13→16). Each affected textarea / input reads via `fontSize: 'var(--aiq-answer-input-size)'` (or `--aiq-answer-mono-size` for KQL). The KQL tip is a new `<p class="aiq-attempt-kql-mobile-tip">` element with `display: none` desktop, `display: block` mobile; carries `data-help-id="candidate.attempt.kql.mobile_tip"` and a same-PR entry in `modules/16-help-system/content/en/candidate.yml`.

**Anti-pattern guards (M2b-specific):**
- No DOM restructure inside any answer area. The tip is the only new element, and it renders in both viewports (CSS-only visibility toggle).
- KQL grading semantics, autosave debounce, blur flush, and integrity-hook surface unchanged. Mobile font-size change is presentation only.
- "Desktop-required interstitial" rec from the original plan was rejected for Phase 1 because today's KqlAnswerArea is a plain textarea, not Monaco — the textarea works on mobile, just less ergonomically. When Monaco lands as part of Phase 2 KQL editor work, M2b' will revisit with the interstitial option as a follow-up.
- No change to MCQ option `<label>` — it is not a focusable form input, so iOS does not auto-zoom on tap.

#### Submitted page mobile reflow (M3 — 2026-05-20)

Page: [`apps/web/src/pages/take/Submitted.tsx`](../apps/web/src/pages/take/Submitted.tsx). Terminal post-submit screen. Already single-column (no right aside to hide), so M3 only retunes chrome padding + hero h1 size.

| Element | Desktop | Mobile |
| --- | --- | --- |
| `<header>` padding | `32px 48px` | `24px 22px` |
| `<main>` padding | `48px` | `24px 22px` |
| Hero serif `<h1>` | `52px / 1.05` | `32px / 1.1` |
| `<Card>` (Grading pending) | unchanged | unchanged (Spinner size="sm" already mobile-friendly) |
| Attempt ID mono footer | unchanged | unchanged |

Mechanism: outer `<header>` carries `.aiq-submitted-header`; `<main>` carries `.aiq-submitted-main`; h1 carries `.aiq-submitted-h1` alongside the existing `.aiq-serif`. The three desktop rules + three `[data-viewport="mobile"]` overrides live in [`tokens.css`](../modules/17-ui-system/src/styles/tokens.css). All other inline styles preserved (flex layout, alignment, margin, fontWeight, letterSpacing).

**Anti-pattern guards (M3-specific):**
- Polling cadence (`setInterval` 30 s), terminal `Navigate` redirects, `getResult` invocation, spinner primitive, and the "grading pending" / pollError state machine are byte-identical to pre-M3.
- The Phase 1 grading flow always returns `status: 'grading_pending'` — the "graded state" of the plan (score-ring + cert links) does not exist yet in this codepath. When Phase 2 result rendering lands, M3' will re-cover the graded-state mobile layout as a follow-up.
- No new help_id added — the existing `candidate.submit.confirm` on the status `<Card>` stays wired.

#### CandidateShell + CandidateActivity mobile reflow (M4 — 2026-05-20)

Files: [`modules/11-candidate-ui/src/components/CandidateShell.tsx`](../modules/11-candidate-ui/src/components/CandidateShell.tsx), [`modules/11-candidate-ui/src/components/CandidateActivity.tsx`](../modules/11-candidate-ui/src/components/CandidateActivity.tsx), [`modules/11-candidate-ui/src/components/MyCertificates.tsx`](../modules/11-candidate-ui/src/components/MyCertificates.tsx).

**Scope clarification:** the original M4 plan assumed `CandidateShell` had a sidebar to reshape — it does not (the shell is already a thin top bar with no nav between pages). M4 therefore (a) **adds** inline NavLinks for the two existing candidate routes (Certificates, Activity) to the shell on both viewports, and (b) on mobile collapses them — plus the Sign out action — into an overflow menu. Net-new affordance, justified by the existing route inventory (no new routes added).

| Element | Desktop | Mobile |
| --- | --- | --- |
| Top-bar padding | `0 24px` | `0 16px` |
| Inline NavLinks (Certificates / Activity) | visible (flex row) | hidden (`display: none`) |
| Signed-in text + Sign out (top-bar right) | visible | hidden (Sign out moved into menu) |
| Overflow-menu button (`Icon name="drag"` pill) | hidden | visible (32×32 pill, `aria-haspopup="menu"`) |
| Overflow-menu dropdown | n/a | absolute-positioned `<ul role="menu">` below the button; items: Certificates, Activity, separator, Sign out |
| Activity stats grid | `repeat(3, 1fr)` | `1fr` (cards stack vertically) |
| Activity heatmap | rendered directly | wrapped in `<div style={{overflowX:'auto'}}>` so the 52×7 grid scrolls horizontally inside the card |
| Activity leaderboard | `LeaderboardList columns={2}` | `columns={1}` (prop driven by `useViewport()` from `@assessiq/ui-system`) |
| MyCertificates `<h1>` | `var(--aiq-h1-size)` = 36px (M0 token) | 30px (M0 token) |

Mechanism:
- Shell: same DOM both viewports. Six CSS rules in [`tokens.css`](../modules/17-ui-system/src/styles/tokens.css) toggle `.aiq-candidate-nav-desktop` / `.aiq-candidate-shell-userinfo` (visible desktop, hidden mobile) vs `.aiq-candidate-nav-mobile` (hidden desktop, inline-flex mobile). The mobile overflow menu uses controlled `useState` for open/closed, with a `useEffect` listening for outside-click (`mousedown` on document, `menuRef.contains` test) and Escape. NavLink `onClick` closes the menu before navigating; Sign out closes then fires `handleSignOut`. New `data-help-id="candidate.shell.nav.mobile_menu"` on the toggle, with same-PR entry in `modules/16-help-system/content/en/candidate.yml`.
- Activity stats: inline `gridTemplateColumns` moves to `.aiq-candidate-activity-stats` class so the mobile override (`grid-template-columns: 1fr`) can take effect via CSS cascade.
- Activity heatmap: wrapped in a `.aiq-candidate-activity-heatmap-scroll` div with `overflow-x: auto`. Desktop is wider than the 290px min-content heatmap so the wrapper is a no-op there.
- Activity leaderboard: imports `useViewport` from `@assessiq/ui-system`, computes `columns={viewport === 'mobile' ? 1 : 2}` — same prop, just viewport-aware.
- MyCertificates h1: a one-line swap from `var(--aiq-text-3xl)` to `var(--aiq-h1-size)` — desktop value preserved (both equal 36px); mobile auto-shrinks to 30px via the M0 mobile-token override.

**Anti-pattern guards (M4-specific):**
- DOM tree identical between viewports. The Sign out button exists in both the desktop right-side block AND the mobile overflow menu; only one is visible per viewport, both call the same `handleSignOut`.
- No new routes, no new flows. The NavLinks point at existing routes that were previously reachable only by direct URL.
- Mobile menu opens via controlled state, not `<details>` — so outside-click and Escape close it (the `<details>` element has no outside-click semantic).
- Heatmap overflow-scroll does not change the underlying `ActivityHeatmap` props or the 15-analytics API contract.
- Leaderboard `columns` prop is the only viewport-aware JS branch in M4 — all other deltas are CSS-only. This is acceptable per anti-pattern #5 because `columns` is a layout hint that doesn't change backend payloads or surfaced errors.

### 15.4 Email-webview testing

Magic-link candidates click email links from Gmail / Outlook / Apple Mail in-app browsers, not Safari/Chrome. Any page touched by the mobile port (especially M1 candidate-auth pages) must be smoke-tested in at least one in-app webview before claiming the phase done. Common gotchas: minimum 16px font-size on inputs (otherwise iOS auto-zooms), missing `gap` polyfills in older WebViews, and aggressive paragraph-truncation.
