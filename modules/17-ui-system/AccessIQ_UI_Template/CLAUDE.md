# CLAUDE.md — AccessIQ Design System

You are working in the **AccessIQ** project. AccessIQ is a minimal, Google-inspired assessment platform. When creating new pages or components, you MUST follow the design system defined in this folder.

## Read these first, in order

1. **`design-system/README.md`** — design philosophy, do/don't rules
2. **`design-system/tokens.md`** — exact colors, type, spacing, radii, shadows
3. **`design-system/components.md`** — buttons, inputs, cards, chips, icons, etc.
4. **`design-system/patterns.md`** — page layouts, sidebars, headers, empty states
5. **`design-system/copy-and-voice.md`** — tone, microcopy conventions

The reference HTML is **`AccessIQ.html`** (loads `styles.css` + the JSX screens in `screens/`). Open it to see the system in action across 5 screens: Login, Dashboard, Library, Assessment, Results.

The visual catalog is **`component-gallery.html`** — every primitive on one page.

## Non-negotiables

- **White / gray / black + ONE blue accent.** Never introduce new hues.
- **Two type families: a serif for display, a sans for body, mono for metadata.** Never use a third family.
- **Generous whitespace.** Pages should breathe. Multiply padding before you halve it.
- **Subtle motion only.** No bounce, no neon glow, no gradient hero blobs.
- **Numbers, IDs, timestamps, category labels → mono.** Body copy → sans. Display headlines → serif.
- **Pill buttons for primary actions** (border-radius: 999px). Cards: 10–16px radius.
- **Borders, not shadows, do most of the structural work.** Shadows are reserved for floating cards.

## When building a new page

1. Start from `patterns.md` — pick the closest existing layout.
2. Use only the tokens in `tokens.md` (CSS vars from `styles.css`).
3. Compose from primitives in `components.md`. Don't reinvent buttons.
4. Match the copy tone shown in `copy-and-voice.md`.
5. If a primitive doesn't exist, add it to `components.md` AND `component-gallery.html`.

## File / folder conventions

```
AccessIQ.html              # main canvas with all screens
styles.css                 # tokens + base atoms (source of truth for CSS)
screens/                   # one JSX per screen
  atoms.jsx                # Logo, Icon, Placeholder, useCountUp
  login.jsx
  dashboard.jsx
  library.jsx
  assessment.jsx
  results.jsx
design-system/             # docs you are reading
component-gallery.html     # visual reference for every primitive
Logo/                      # brand kit: mark, wordmark, lockups, favicon, OG
  README.md                # kit overview + embed snippet
  brand-guidelines.html    # visual reference — open in a browser
  logo/                    # SVG masters + PNG fallbacks (assessiq-*.{svg,png})
  favicon/                 # web + app icons + site.webmanifest
  social/                  # OG / Twitter card
```

New screens go in `screens/<name>.jsx` and export to `window` at the end of the file.
