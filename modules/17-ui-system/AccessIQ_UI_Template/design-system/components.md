# Components

Every primitive AccessIQ uses. Build new screens by composing these — don't reinvent.

The CSS classes referenced live in `../styles.css`. The JSX components live in `../screens/atoms.jsx`.

---

## Logo

The wordmark + a small dot with hairline ring — the only "branded" mark.

```jsx
<div className="aiq-mark">
  <span className="dot"></span>
  <span>AccessIQ</span>
</div>
```

Sizes: 16px (compact header), 18px (default), 22px (login hero).

---

## Buttons

Pill-shaped. Three variants × three sizes.

| Class | Use |
| --- | --- |
| `.btn .btn-primary` | One per screen — the main CTA. Filled accent. |
| `.btn .btn-outline` | Secondary action. 1px border. |
| `.btn .btn-ghost` | Tertiary, navigation, "View all". No border, no fill. |
| `.btn-sm` | 6px×14px, 12px font. Use in cards and toolbars. |
| (default) | 10px×18px, 13px font. |
| `.btn-lg` | 14px×28px, 14px font. Use on auth screens. |

```html
<button class="btn btn-primary">
  Start <Icon name="arrow" size="14" />
</button>
<button class="btn btn-outline btn-sm">
  <Icon name="eye" size="14" /> Preview
</button>
<button class="btn btn-ghost">View all →</button>
```

Rule: **only one `btn-primary` per visible region**.

---

## Inputs

```html
<input class="input" placeholder="Email address" />
```

12px×16px padding, 10px radius, 1px `--border-strong`. On focus: accent border + 4px soft accent ring.

For inline search bars (library hero), use the pill-shaped composition:
```html
<div style="border:1px solid var(--border-strong);border-radius:999px;padding:8px 8px 8px 20px;
            display:flex;align-items:center;gap:10px;box-shadow:var(--shadow);">
  <Icon name="search" size="16" />
  <input style="flex:1;border:0;outline:0;background:transparent;font:inherit" />
  <button class="btn btn-primary btn-sm">Search</button>
</div>
```

---

## Cards

```html
<div class="card" style="padding:22px"> ... </div>
```

- Default: `--bg`, 1px `--border`, 16px radius.
- On hover: border darkens to `--border-strong`.
- Padding: 20–28px depending on weight.
- Use `background: var(--surface)` to recess (build-your-own card, side panels).
- Use dashed border for "create / build your own" cards.

---

## Chips

Mono uppercase metadata badges.

```html
<span class="chip">Popular</span>
<span class="chip chip-accent">In progress</span>
<span class="chip chip-success">
  <Icon name="check" size="10" stroke="2" /> Passed
</span>
```

Always 11px mono, uppercase, tracking 0.04em. Never use chips for body content — only state/category.

---

## Icons

All icons live in `screens/atoms.jsx` as a single `<Icon>` component. 24px viewBox, 1.5 stroke width default.

Available names: `search, arrow, arrowLeft, check, clock, home, grid, chart, user, settings, plus, close, play, pause, flag, book, code, drag, bell, eye, sparkle, google`.

```jsx
<Icon name="arrow" size={14} />
<Icon name="check" size={10} stroke={2} />
```

To add an icon, edit the `paths` map in `atoms.jsx`. Match the visual weight of existing icons (1.5 stroke, round caps/joins, no fills).

---

## Stat / number block

The editorial signature.

```html
<div>
  <div class="mono" style="font-size:10px;color:var(--text-faint);
                            text-transform:uppercase;letter-spacing:.08em">
    Overall score
  </div>
  <div class="row" style="align-items:baseline;gap:8px">
    <span class="num" style="font-size:40px">132</span>
    <span style="color:var(--text-muted);font-size:14px">/ 160</span>
  </div>
</div>
```

Recipe:
1. **Tiny mono uppercase label** above (10–11px, `--text-faint`, tracking 0.08em)
2. **Big serif `.num`** (24–88px depending on weight)
3. Optional muted denominator or delta in mono

Never use the sans family for big numbers.

---

## Navigation item (sidebar)

```jsx
<NavItem icon="home" label="Overview" active />
```

- Default: 13px, `--text-muted`, transparent bg
- Active: 13px weight 500, `--text`, `--surface` background, 10px radius
- Padding: 9px×14px
- Gap between icon and label: 12px

---

## Section header (mono uppercase eyebrow)

For grouping items in a sidebar or panel:

```html
<div class="mono" style="font-size:10px;color:var(--text-faint);
                          padding:8px 14px;text-transform:uppercase;
                          letter-spacing:.08em">
  Workspace
</div>
```

---

## Progress bar

Two heights:
- 4px (in cards) — default
- 2px (page-top progress) — for assessment bar
- 6px (results breakdown rows)

```html
<div style="height:4px;background:var(--surface-2);border-radius:2px;overflow:hidden">
  <div style="width:64%;height:100%;background:var(--accent)"></div>
</div>
```

Use `--accent` for in-progress, `--success` for complete, `--text` for neutral metric bars.

---

## Score ring

See `ResultsScreen` (`screens/results.jsx`). 4px stroke, `--surface-2` track + `--accent` arc, animates dash-offset over 1.6s. Big serif number centered.

---

## Sparkline

Simple inline mini-chart. See `Sparkline` in `screens/dashboard.jsx`. 1.2px stroke, `vector-effect: non-scaling-stroke`, polyline with 8% opacity fill underneath.

---

## Question option (assessment)

Selectable card with circular radio.

```jsx
<button style={{
  textAlign:"left", padding:"18px 20px",
  background: selected ? "var(--accent-soft)" : "var(--bg)",
  border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
  borderRadius: 12,
  display:"flex", alignItems:"center", gap:16,
  fontSize: 15
}}>
  <span /* radio dot */ />
  <span className="mono" style={{fontSize:11,color:"var(--text-faint)",width:14}}>A</span>
  <span style={{flex:1}}>Option text</span>
</button>
```

The mono letter (A/B/C/D) is essential — preserves keyboard-shortcut affordance.

---

## Question navigator grid

8-column grid of square cells. See `QuestionNav` in `screens/assessment.jsx`. States: current (filled accent), answered (`--surface` fill), flagged (warn border + dot), unseen (border only). 11px mono number inside.

---

## Placeholder image

```jsx
<Placeholder height={120} label="Title" radius={8} />
```

Striped diagonal pattern (`--surface` / `--surface-2`), mono uppercase caption. Use anywhere a real image will eventually go.

---

## Subtle grid background

```html
<div class="grid-bg" style="position:absolute;inset:0;opacity:0.4;
   mask-image:radial-gradient(ellipse at center, black, transparent 70%)"></div>
```

48px×48px hairline grid that fades via radial mask. Use sparingly — login hero, library hero. Never edge-to-edge solid.

---

## Divider

```html
<hr class="divider" />
```

1px `--border`, no margin (apply with style).

---

## Animated count-up

```jsx
const display = useCountUp(132, 1600, hasMounted);
```

Cubic ease-out over 1.6s. Use for the score ring and any reveal moment. Never on every page-load number.
