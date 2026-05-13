# AccessIQ Design System

A minimal, Google-inspired assessment platform.
White-canvas. One blue accent. Editorial serif headlines. Generous whitespace. Subtle, restrained futurism.

---

## Philosophy

**Minimal, but never sterile.** Whitespace is the primary design tool. The interface should feel like reading — calm, paced, easy to scan.

**Editorial, not "app-like".** Display headlines use a literary serif (Newsreader). Body copy is a clean modern sans (Geist). Metadata, numbers, IDs, timestamps wear monospace as a confident detail.

**Single accent, used sparingly.** A calm Google blue (`#1a73e8` / `oklch(0.58 0.17 258)`). Reserved for primary CTAs, links, current state, and small data emphasis. Everything else is grayscale.

**Borders, not shadows.** Structure is drawn with hairline borders (1px, low-contrast). Shadows are saved for floating cards or modal-like surfaces.

**Subtle futurism.** A grid-pattern background fading into white. Mono-spaced metadata. Lining-tabular numerics. Hairline ring around a logo dot. Never neon, never glassmorphism, never gradient mesh.

---

## Do / Don't

### Do
- Use `--accent` for **one** thing per screen (the primary CTA, or the active state, or the highlighted stat — pick one).
- Use serif for display (h1, large numbers, blockquotes).
- Use mono for: numbers in stat cards, IDs (`#A-2841`), timestamps, category tags, kbd shortcuts, category labels in uppercase tracking.
- Pad generously. A card padding of 22–28px is normal. Section spacing is 24–40px.
- Pair every numeric stat with a tiny uppercase mono label above it.
- Use chips with mono uppercase text for status/metadata.

### Don't
- Don't introduce new colors. Strictly black / white / gray + the accent.
- Don't use gradients except the subtle grid mask in hero areas.
- Don't use emoji as iconography. Use the `<Icon>` set in `screens/atoms.jsx`.
- Don't use shadow-heavy "elevation" stacks. One layer of shadow, max.
- Don't bold body copy for emphasis — use weight 500 on labels and headings, never on prose.
- Don't use border-radius greater than 16px on cards or 999px (pill) on buttons. Avoid in-between rounded shapes.
- Don't write more than 14px body copy or smaller than 11px metadata.
- Don't use the accent color on more than 2–3 elements in any one viewport.

---

## What's in this folder

| File | What |
| --- | --- |
| `README.md` | This. Philosophy + rules. |
| `tokens.md` | Exact color/type/spacing/radii/shadow values + dark mode + density + variant tokens. |
| `components.md` | Every primitive (buttons, inputs, cards, chips, icons, etc.) with HTML/JSX recipes. |
| `patterns.md` | Composed patterns: sidebar, page header, stat row, two-pane layouts, empty states. |
| `copy-and-voice.md` | Tone, microcopy, formatting (numbers, time, IDs). |

The visual reference is `../component-gallery.html`.

The canonical CSS lives in `../styles.css`.

The atoms (`Icon`, `Logo`, `Placeholder`, `useCountUp`) live in `../screens/atoms.jsx`.
