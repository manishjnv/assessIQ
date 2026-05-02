# AccessIQ — Design System Kit

This is the design reference for AccessIQ. Upload this folder as a project asset for Claude Code (or any developer) to consume when building new pages.

## What's in this kit

```
CLAUDE.md                  # Entry point — read this first
README.md                  # (this file)
AccessIQ.html              # Live reference: 5 screens on a pannable canvas
component-gallery.html     # Every primitive on a single page
styles.css                 # Source of truth for tokens + atoms

design-system/
  README.md                # Philosophy + do/don't
  tokens.md                # Colors, type, spacing, radii, shadows
  components.md            # Buttons, inputs, cards, chips, icons…
  patterns.md              # Page layouts (sidebar, hero, results, etc.)
  copy-and-voice.md        # Tone, microcopy, number formatting

screens/                   # Reference React/JSX implementations
  atoms.jsx                # Logo, Icon, Placeholder, useCountUp
  login.jsx
  dashboard.jsx
  library.jsx
  assessment.jsx
  results.jsx
```

## How Claude Code should use this

1. **Read `CLAUDE.md` first.** It points to everything else.
2. **For tokens** (colors, type, spacing) — use the CSS variables defined in `styles.css`. Never hardcode.
3. **For components** — copy the markup recipes from `design-system/components.md`. Reference live implementations in `screens/*.jsx`.
4. **For new pages** — pick the closest layout in `design-system/patterns.md` and adapt.
5. **For copy** — match `design-system/copy-and-voice.md`.

## Quick start

To see the system in action, open `AccessIQ.html` in a browser. To browse every primitive on one page, open `component-gallery.html`.

## Stack notes

The reference is React + Babel inline (so it runs without a build). When porting to a real codebase:

- Move tokens from `styles.css` into your CSS / Tailwind config.
- Convert each `screens/*.jsx` into the component file format your project uses.
- Keep the atoms (`Icon`, `Logo`, `Placeholder`) — they're framework-agnostic patterns.

Fonts loaded: **Newsreader** (serif), **Geist** (sans), **JetBrains Mono** — all from Google Fonts.
