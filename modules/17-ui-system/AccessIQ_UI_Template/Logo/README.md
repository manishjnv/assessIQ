# AssessIQ — Brand Kit

The AssessIQ identity. Lives inside the UI template (`modules/17-ui-system/AccessIQ_UI_Template/Logo/`) so the design system and the brand identity share one source of truth. Use this folder when adding logos to the product, embedding favicons, designing decks, or producing social assets.

## What's here

```
AccessIQ_UI_Template/Logo/
  brand-guidelines.html      # Visual reference — open in a browser
  README.md                  # (this)
  logo/                      # Mark, wordmark, lockups
    assessiq-mark.svg                # primary mark, light
    assessiq-mark-dark.svg           # mark on dark
    assessiq-mark-mono.svg           # currentColor — for stamps/print
    assessiq-mark-512.png            # raster fallback
    assessiq-wordmark.svg            # type-only
    assessiq-horizontal.svg          # mark + wordmark, default lockup
    assessiq-horizontal-dark.svg     # same, dark backgrounds
    assessiq-horizontal.png          # 1280×256 raster
    assessiq-horizontal-dark.png
    assessiq-stacked.svg             # mark above wordmark + tagline
    assessiq-stacked.png
  favicon/                   # Web + app icons
    favicon.svg                      # SVG favicon (modern browsers)
    favicon-16.png  /-32.png /-48.png
    apple-touch-icon-180.png
    app-icon-192.png  /-512.png  /-1024.png
    app-icon-1024-dark.png
    app-icon-1024.svg  /-dark.svg
  social/                    # OG / Twitter card
    og-image.svg
    og-image.png             # 1200×630
```

## Concept

A solid dot inside a hairline ring — a single result plotted on a distribution. The mark is the existing `aiq-mark` element from the live UI, promoted into a real, scalable identity. Calm, precise, editorial.

## Wordmark

Set in **Newsreader** (serif, 400 weight, slight negative tracking). Never bold, never italic, never substitute for a sans family.

## Color

| Use | Light | Dark |
| --- | --- | --- |
| Mark | `#3177dc` | `#5b9eff` |
| Wordmark | `#1a1a1a` | `#f5f5f7` |
| Background | `#ffffff` | `#0e0e10` |

## Clear space & minimum size

- **Clear space:** 1× the height of the mark on every side.
- **Minimum size:** mark = 16px, horizontal lockup = 96px wide. Below that, use the favicon.

## Don'ts

- Don't recolor the mark outside the approved blue + mono variants.
- Don't outline or stroke the wordmark.
- Don't combine the mark with the wordmark in any custom layout — use the supplied lockups.
- Don't place the mark on busy photographs without a solid backdrop.
- Don't bold or italicize "AssessIQ".

## Embedding the favicon

```html
<link rel="icon" href="/brand/favicon/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/favicon/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/brand/favicon/apple-touch-icon-180.png">
<link rel="manifest" href="/brand/favicon/site.webmanifest">
```

See `brand-guidelines.html` for visual reference.
