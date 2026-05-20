# AssessIQ — Mobile UI Kit

Mobile companion to the AssessIQ design system. Six iPhone screens built on the same tokens as the web app.

## Open

**Double-click `AssessIQ-Mobile.html`** — single self-contained file, no setup. Works offline.

`Mobile.html` is the source version that loads the separate JSX files; use that one only if you want to edit and re-bundle. Pan the canvas with mouse drag; click any artboard label to focus it fullscreen.

## Screens

| # | Screen | File |
| --- | --- | --- |
| 01 | Sign in | `mobile-screens/login.jsx` |
| 02 | Today (home) | `mobile-screens/home.jsx` |
| 03 | Library | `mobile-screens/library.jsx` |
| 04 | Assessment in progress | `mobile-screens/assessment.jsx` |
| 05 | Results | `mobile-screens/results.jsx` |
| 06 | Activity | `mobile-screens/activity.jsx` |

Plus two dark-mode variants (Today, Results) in a second section.

## What's bundled

```
Mobile.html              # the canvas — open this
styles.css               # design tokens (colors, type, spacing, radii)
ios-frame.jsx            # iPhone chrome (status bar, dynamic island, home indicator)
design-canvas.jsx        # pan/zoom Figma-ish wrapper
screens/atoms.jsx        # shared Icon, Logo, Placeholder, useCountUp
mobile-screens/          # the six screens + mobile-atoms.jsx (TabBar, header, chips)
brand/                   # logos, favicons, social, brand README
design-system/           # README, tokens, components, patterns, copy & voice
```

## System rules

White / gray / black + one blue accent. Serif (Newsreader) for display, sans (Geist) for body, mono (JetBrains Mono) for metadata. Pill buttons, hairline borders, generous whitespace. See `design-system/README.md` for the full philosophy.

## Mobile-specific adjustments

- Page H1: 28–34px (down from 36–52 on desktop)
- Page padding: 20–24px (down from 32–48)
- Card padding: 16–20px (down from 22–28)
- Bottom tab bar (Today / Library / Activity / Profile) replaces the desktop sidebar
- Filter rows are horizontally scrollable instead of wrapping
