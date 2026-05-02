# Tokens

All tokens are defined as CSS custom properties in `../styles.css`. **Always reference the variable, never the literal value** — this keeps dark mode + density + accent-tweak working.

---

## Colors

### Light (default)

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#ffffff` | Page background |
| `--surface` | `#fafafa` | Slightly recessed surfaces (sidebars, hero band, side panels) |
| `--surface-2` | `#f5f5f5` | Track for progress bars, chart backdrops |
| `--border` | `#e8e8e8` | Default 1px border |
| `--border-strong` | `#d4d4d4` | Inputs, button outlines, hover states |
| `--text` | `#1a1a1a` | Primary text |
| `--text-muted` | `#5f6368` | Secondary text, descriptions |
| `--text-faint` | `#9aa0a6` | Metadata, tertiary text, mono labels |
| `--accent` | `oklch(0.58 0.17 258)` (~`#1a73e8`) | Primary CTAs, links, active state |
| `--accent-soft` | `oklch(0.96 0.03 258)` | Accent backgrounds (chip-accent, selected option) |
| `--accent-hover` | `oklch(0.52 0.19 258)` | Primary button hover |
| `--success` | `oklch(0.65 0.15 150)` | Pass / completed |
| `--warn` | `oklch(0.72 0.15 70)` | Flagged for review |
| `--danger` | `oklch(0.62 0.20 25)` | Timer < 5min, errors |

### Dark mode (`[data-theme="dark"]`)

Set `document.documentElement.dataset.theme = "dark"` and the same token names switch:

| Token | Value |
| --- | --- |
| `--bg` | `#0e0e10` |
| `--surface` | `#161618` |
| `--surface-2` | `#1d1d20` |
| `--border` | `#2a2a2e` |
| `--border-strong` | `#3a3a3f` |
| `--text` | `#f5f5f7` |
| `--text-muted` | `#a0a0a8` |
| `--text-faint` | `#6a6a72` |
| `--accent` | `oklch(0.7 0.16 258)` (lighter for legibility) |

### Accent rules
- The accent is the ONLY non-grayscale color you may use.
- Don't tint surfaces with the accent. The only "filled" accent surface is `--accent-soft`, used for selected radio options and chip-accent.
- For new accent variants, use `color-mix(in oklch, var(--accent) 12%, white)` (soft) or `color-mix(in oklch, var(--accent) 80%, black)` (hover).

---

## Typography

```css
--font-serif: "Newsreader", "Source Serif Pro", Georgia, serif;
--font-sans:  "Geist", -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
--font-mono:  "JetBrains Mono", "SF Mono", Menlo, monospace;
```

### Scale

| Use | Family | Size | Weight | Letter-spacing | Line-height |
| --- | --- | --- | --- | --- | --- |
| Display H1 (hero) | serif | 44–52px | 400 | -0.025em | 1.05 |
| Page H1 | serif | 36px | 400 | -0.02em | 1.1 |
| Section H2 | serif | 28px | 400 | -0.015em | 1.2 |
| Card H3 | serif | 22px | 400 | -0.01em | 1.3 |
| Body | sans | 14px | 400 | -0.005em | 1.5 |
| Body-large | sans | 15–17px | 400 | -0.005em | 1.5 |
| Label / button | sans | 12–13px | 500 | -0.005em | 1.4 |
| Metadata (mono) | mono | 10–11px | 400 | 0.08em (uppercase) | 1.4 |
| Number-stat | serif (`.num`) | 24–88px | 400 | -0.03em | 1 |
| Number-inline (mono) | mono | 12–22px | 400 | tabular-nums | 1 |

### Big-number rule
Stat numbers (32px+) use the `.num` class — serif with `font-feature-settings: "lnum","tnum"`. This is the editorial signature of AccessIQ and should be used for every prominent quantitative value.

### Font pair alternates (Tweaks-only)
The Tweaks panel can swap font pairs. **Default is always Newsreader + Geist.** Other pairs (Fraunces+Inter, Playfair+Helvetica, IBM Plex) are user preferences, not design defaults.

---

## Spacing

Base unit: `--u: 4px` (cozy, default). Density modes:
- `[data-density="compact"]` → `--u: 3px`
- `[data-density="cozy"]` → `--u: 4px`
- `[data-density="comfortable"]` → `--u: 5px`

### Common values
- Inline gap (icons + text): `8px` (`gap: 8px`)
- Tight stack (label → value): `4–6px`
- Card inner padding: `20–28px`
- Section vertical rhythm: `24–40px`
- Page padding (desktop): `32–48px`
- Hero padding: `48–64px` top, generous

### Rule
Whitespace is the most important design tool. When unsure, **add more**.

---

## Radii

```css
--radius-sm:   6px;   /* tiny chips, inputs in tables */
--radius:     10px;   /* default — buttons (non-pill), inputs */
--radius-lg:  16px;   /* cards, large surfaces */
--radius-pill: 999px; /* primary buttons, status chips */
```

Don't use values between these. The system has 4 radii, period.

---

## Shadows

```css
--shadow-sm: 0 1px 2px rgba(0,0,0,0.04);                              /* hairline lift */
--shadow:    0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04); /* card hover, search bar */
--shadow-lg: 0 8px 32px rgba(0,0,0,0.08);                             /* floating modal, hero card */
```

Default cards use **borders, not shadow**. Reserve shadow for hover, search field, and floating elements.

---

## Borders

- Default: `1px solid var(--border)`
- Hover/focus: `1px solid var(--border-strong)`
- Selected: `1px solid var(--accent)`
- Dashed (placeholder/build-your-own): `1px dashed var(--border)`

Never thicker than 1px outside of focus rings.

### Focus ring
```css
border-color: var(--accent);
box-shadow: 0 0 0 4px var(--accent-soft);
```

---

## Layout primitives

```css
.row    { display: flex; align-items: center; }
.col    { display: flex; flex-direction: column; }
.spacer { flex: 1; }
.serif  { font-family: var(--font-serif); letter-spacing: -0.02em; font-weight: 400; }
.mono   { font-family: var(--font-mono); letter-spacing: -0.01em; }
.num    { font-family: var(--font-serif); font-variant-numeric: lining-nums tabular-nums; }
.divider{ height: 1px; background: var(--border); border: 0; }
```

---

## Tweakable variables (runtime)

The Tweaks panel writes to these CSS vars at runtime:
- `--accent`, `--accent-soft`, `--accent-hover` (color picker)
- `--font-serif`, `--font-sans` (font pair selector)
- `data-density` on `<html>` (compact/cozy/comfortable)
- `data-theme` on `<html>` (light/dark)
- `data-layout` on `<html>` (spacious/bento/rows — for layout variant CSS)

When writing new screens, always read tokens — don't hardcode.
