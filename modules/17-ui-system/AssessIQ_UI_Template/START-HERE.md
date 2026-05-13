# AccessIQ UI Kit

Upload this entire folder into your project (or attach as project files in Claude Code).

## Where to start

1. **`CLAUDE.md`** — read this first. It tells any assistant how to use the kit.
2. **`AccessIQ.html`** — open in a browser (double-click) to see all 6 screens on a pannable canvas. Fully self-contained, works offline.
3. **`component-gallery.html`** — every primitive on one page.
4. **`brand/brand-guidelines.html`** — the identity system.

## Note on the JSX source files

`AccessIQ.html` is a **self-contained bundle** with all code inlined — open it directly to view the live UI.

The separate readable source files live in:
- `screens/*.jsx` — one file per screen
- `styles.css` — CSS tokens and atoms
- `design-canvas.jsx` / `tweaks-panel.jsx` — UI shell components

These exist so Claude Code (or any developer) can **read and learn from the patterns** when building new pages. The bundled HTML is what you open to view; the source files are what you reference.

See `README.md` for the full file map.
