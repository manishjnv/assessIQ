# 17-ui-system — Design tokens, component library, theming

> Full architecture in `docs/08-ui-system.md`. This is the implementation orientation.

## Purpose
Provide every UI primitive used by 10-admin-dashboard, 11-candidate-ui, and 16-help-system. Token-driven, themable per tenant, accessible, embed-friendly.

## Scope
- **In:** CSS custom property token catalog, Storybook-documented component library (primitives, layout, data, feedback, forms, domain composites), per-tenant theme resolver, dark mode, density modes, icon wrapper, accessibility audits.
- **Out:** business components beyond reusable composites (e.g., the assessment-create wizard form lives in 10).

## Dependencies
- `00-core`
- `02-tenancy` (reads `tenants.branding`)

## Public surface
```ts
// tokens
import "modules/17-ui-system/tokens/tokens.css";   // injected globally
import { tokens } from "modules/17-ui-system/tokens/tokens";   // typed access

// components
import { Button, Input, Card, Drawer, Modal, Table, ... } from "modules/17-ui-system";

// theming
applyTenantTheme(branding: TenantBranding): void
applyEmbedTheme(tokens: Record<string,string>, originVerified: boolean): void
toggleTheme("light"|"dark"|"system"): void
toggleDensity("comfortable"|"compact"): void
```

## Component contract
Every primitive accepts:
- Standard HTML props (className, id, etc.)
- `data-test-id` for E2E
- `aria-*` props mapped from semantic ones (e.g., `<Button intent="danger">` sets appropriate ARIA)

Every primitive has:
- Storybook story with all variants
- Visual regression test
- a11y test (axe)
- Dark-mode story

## Branding base
The folder `AssessIQ_UI_Template/` is the **complete design-system kit** for AssessIQ — the canonical brand contract, not just a visual reference. Entry point is [`AssessIQ_UI_Template/CLAUDE.md`](./AssessIQ_UI_Template/CLAUDE.md); detail lives in [`AssessIQ_UI_Template/design-system/`](./AssessIQ_UI_Template/design-system/) (`README.md` for philosophy + Do/Do not, `tokens.md` for exact values, `components.md` for primitive recipes, `patterns.md` for page layouts, `copy-and-voice.md` for tone). Reference JSX implementations live in [`AssessIQ_UI_Template/screens/`](./AssessIQ_UI_Template/screens/); browse them via `AccessIQ.html` or `component-gallery.html`.

The production-translation companion lives at `docs/10-branding-guideline.md` — it explains how the kit's un-prefixed tokens (`--accent`, `--bg`, `.btn`) map to the production `--aiq-*` namespace and `aiq-*` classes, plus AssessIQ-specific deltas (banded score model, multi-tenant accent override, light-mode-only lock, accessibility deltas). The system architecture (token catalog, theming pipeline, embed posture) lives in `docs/08-ui-system.md`. **When the three disagree the kit wins, then the branding guideline, then 08.**

Files under `AssessIQ_UI_Template/` are reference, not production code. The designer-tool harness (`design-canvas.jsx`, `tweaks-panel.jsx`, `AccessIQ.html`, `component-gallery.html`, `.design-canvas.state.json`) must never be imported by app code; port the screen JSX and atoms into typed components under `components/` on demand as features land. ESLint `no-restricted-imports` blocks `**/AssessIQ_UI_Template/**` globally.

Component APIs in this module stay stable; visual fidelity to the kit is the contract.

## Help/tooltip surface
- `admin.settings.tenant.branding.preview` — live preview of brand changes
- `admin.profile.theme` — light/dark/system explanation
- `admin.profile.density` — comfortable vs compact

## Open questions
- Internal vs publishable component library — keep internal for v1; consider extraction if external partners build on AssessIQ
- Tailwind utilities + design tokens overlap — Phase 0 resolution: editorial styling lives on `aiq-*` global classes from `src/styles/tokens.css`; Tailwind is for layout/spacing utilities only and reads font + radius vars via the theme extension. `@apply` not needed.

## Status

- **2026-05-01 — Phase 0 G0.B Session 3 shipped.** Workspace package `@assessiq/ui-system` live. Token namespace ported (`--*` → `--aiq-*`; utility classes prefixed `aiq-`). Components ported: `Button` (pill; primary/outline/ghost × sm/md/lg + leftIcon/rightIcon/loading), `Card` (no shadow at rest; interactive/floating flags), `Field` + `Input` + `Label` + `FieldHelp` (label-above, focus halo, aria wiring), `Chip` (default/accent/success; success defaults to a `check` icon), `Icon` (22-name typed SVG sprite with aria-label/aria-hidden), `Logo` (mark + halo + serif "AssessIQ" wordmark — case-sensitive; template's "AccessIQ" typo is not propagated), `Num` + `useCountUp` (cubic-out RAF loop respecting `prefers-reduced-motion`), `ThemeProvider` (reads `fixtures/tenants.ts`; toggles `data-theme`/`data-density` and injects `--aiq-color-accent{,-soft,-hover}`; SSR-safe `matchMedia`).
- **Light + dark + density variants** all token-driven; verified via Storybook stories and the `apps/web` smoke page.
- **Storybook 8** scaffold at `apps/storybook/` with `@storybook/react-vite`. One story per component covering main variants; `withThemeByDataAttribute` decorators add `data-theme` and `data-density` toolbars.
- **Vite SPA** at `apps/web/` builds clean (`pnpm --filter @assessiq/web build` → 156 KB JS / 12 KB CSS gzipped to 50/3 KB). No public route until G0.C Session 5 ships `/admin/login`.
- **Deferred to Phase 1+ (state 2026-10-02):** `ScoreRing`, `Sparkline`, `Sidebar`/`NavItem`/`StatCard` now exist in `src/components/` and are exported from `src/index.ts`. `QuestionNavigator` lives in `modules/11-candidate-ui`; `AnchorChip`, `BandPicker` and `RubricEditor` live in `modules/10-admin-dashboard/src/components`. `QuestionCard` has no component. Still open: server-side theme resolver, visual-regression baseline, self-hosted fonts.
- **Enforcement:** ESLint `no-restricted-imports` blocks `**/AssessIQ_UI_Template/**` everywhere. The template folder is reference only — copy idioms, never import.
- **2026-05-13 — Phase 1 (token migration) shipped (`b95df19`).** 7 light-mode token values + serif weight 500 + dark-mode hierarchy adjustments align production to kit v1.1. Visible across every page on hard refresh.
- **2026-05-13 — Phase 2 (atom refresh) shipped.** 5 components updated, all changes additive (no breaking signatures):
  - `Chip`: new `"warn"` variant (auto-defaults `leftIcon: "flag"` for status-by-icon WCAG rule). Added `--aiq-color-warning-soft` token + `.aiq-chip-warn` class.
  - `Sparkline`: switched line from `<path>` to `<polyline vector-effect="non-scaling-stroke">` and default `strokeWidth` 1.5 → 1.2px. Width stays crisp in responsive containers.
  - `ScoreRing`: stroke-dashoffset transition extended 180ms → 1600ms to match kit v1.1 results.jsx single-timing animation.
  - `StatCard`: optional `breakdown?: StatCardBreakdownItem[]` prop renders a mini stacked-bar + colored legend in place of sparkline. Added 8-slot `--aiq-color-chart-{1..8}` palette tokens.
  - `Sidebar`: expanded width 220 → 240px (kit v1.1). New `footer?: ReactNode` slot. New exported `SidebarSection` sub-component for mono-uppercase eyebrow labels between nav groups.
- **Deferred to Phase 14:** Storybook story coverage gaps (ScoreRing/Sparkline/StatCard/Sidebar have no stories yet; Chip story needs warn variant added).
- **2026-05-13 — Phase 3a (easy primitives) shipped.** Three new primitives + first axe a11y wiring in the module:
  - `Spinner`: rotating ring loader, `size: "sm" | "md" | "lg"`, CSS-only animation (no SVG), `role="status"` + `aria-live="polite"` + default `aria-label="Loading"`. Honours `prefers-reduced-motion` via `.aiq-spinner` keyframe override in `tokens.css`.
  - `ProgressBar`: thin horizontal bar with `value`/`max`/`height: 2|4|6`/`variant: "accent"|"success"|"fg"`. Clamps `value` to `[0, max]`. `role="progressbar"` with `aria-valuenow/min/max`. `data-height` / `data-variant` only emitted for non-default values.
  - `Placeholder`: striped diagonal `repeating-linear-gradient` panel with mono-uppercase `caption` (default `"image"`). Consumer `style` overrides take precedence; supports numeric or string `width`/`height`/`radius`. `role="img"` with `aria-label` from caption.
  - **Test infra:** `vitest` + `vitest-axe` + `@testing-library/react` added as devDeps; `vitest.config.ts` (jsdom env) + `vitest.setup.ts` + `src/test-setup.d.ts` (vitest-axe@0.1.0 `Vi` namespace → vitest v2 `declare module "vitest"` patch). One axe assertion per primitive — precedent for the rest of the v1.1 port. 17/17 tests green.
  - **CSS classes:** `.aiq-spinner{,-sm,-lg}` + `@keyframes aiq-spin`, `.aiq-progress-bar{,-fill}` with `[data-height]` / `[data-variant]` selectors, `.aiq-placeholder` striped gradient. All in `src/styles/tokens.css`.
- **2026-05-13 — Phase 3b (activity primitives) shipped.** Three pure-CSS/div components ported from `AssessIQ_UI_Template/screens/activity.jsx`:
  - `ActivityHeatmap`: 52×7 (configurable via `weeks`) GitHub-style intensity grid. `data: number[]` is pre-binned 0–4 column-major; out-of-range values clamp to `[0, 4]`. Optional `monthLabels` strip + `dayLabels` (default `["M","W","F"]`) + `streakSummary` mono-microcopy. `role="img"` with `aria-label` (default `"Activity over N weeks"`).
  - `StackedBarChart`: multi-series stacked bars with auto-normalization (per-bar height = `sum(segments) / max(totals)`; per-segment share = `segment / sum`). Pure div composition — no chart library. Optional `yAxisLabels` positioned absolutely on the left; `xAxisStartLabel` / `xAxisEndLabel` meta below. Empty bars handled gracefully (no NaN).
  - `LeaderboardList`: semantic `<ol>` of rank rows (rank number + colored avatar dot + name/subline + metric/delta). 1- or 2-column flow. Avatar uses a `position: absolute` 0.18-opacity outer ring + `position: relative` inner solid dot so opacity does not cascade (kit-side bug fix). Optional `onShowMore` callback gates a ghost Button.
  - **Color tokens:** new heatmap ramp `--aiq-color-heatmap-{0..4}` in `tokens.css` (level 0 maps to `--aiq-color-bg-sunken` so it auto-tracks dark mode; 1–4 are explicit `oklch()` stops on hue 258 matching `--aiq-color-accent`). `StackedBarChart` + `LeaderboardList` default to the production `--aiq-color-chart-{1..8}` palette (NOT the kit's `ACT_COLORS` hex array — production is Google-brand-anchored, kit is Tailwind-anchored; the two intentionally differ).
  - Per the Phase 3a precedent, each component ships with one `axe(container)` assertion. 36/36 tests green across the v1.1 module (Spinner 5 + ProgressBar 6 + Placeholder 6 + ActivityHeatmap 7 + StackedBarChart 6 + LeaderboardList 6).

- **2026-05-14 — v1.1 port complete (Phases 4–14).** All 14 phases of `docs/plans/archive/UI_KIT_V1_1_PORT.md` shipped. Every admin and candidate page now uses count `Chip` + serif h1 + lede + `Spinner` loading states. `@axe-core/playwright` a11y gate added at `apps/web/e2e/a11y.spec.ts`. Visual regression + Lighthouse deferred to Phase 15. Reduced-motion: covered globally by `tokens.css` `prefers-reduced-motion` block; `useCountUp.ts` handles JS-driven count animations independently. Full port decisions in `docs/08-ui-system.md`.

- **2026-10-17 — S15 contrast tokens (RW-82).** Light-mode `--aiq-color-accent` is `oklch(0.52 0.18 258)`, accent-hover `oklch(0.46 0.19 258)`, `--aiq-color-info` `oklch(0.42 0.13 235)`, `--aiq-color-success` `oklch(0.50 0.14 150)` (dark mode keeps `oklch(0.65 0.15 150)`). `.aiq-chip-warn` text mixes the warning colour 40% with black. The default tenant `branding.primary` in `src/fixtures/tenants.ts` matches the accent. Reason: axe serious colour-contrast findings on logged-in pages. The accent is darker with the same hue. Visual baselines need regeneration in the Playwright image. See `docs/08-ui-system.md` § "Contrast tokens darkened for WCAG AA (RW-82, S15)".
- **2026-10-17 — S15 design pass (RW-81).** `Table` cells have `min-width: 0` and plain text sits in an ellipsis span with a `title` attribute (13 px cells); composite cells (name plus chip) still clip. Mobile `.aiq-attempt-top` wraps and has `min-height: 64px` (the take header overflowed at 390 px). Page titles use `--aiq-h1-size` (36 px desktop, 30 px mobile) in both `PageHeader` components. Pages use `--aiq-text-xs/sm/md/lg/xl/2xl/3xl` only, never raw px. See `docs/08-ui-system.md` § "Design pass on live-data pages (RW-81, S15)".

## Z-170 / Z-171 shared component changes (S69, S70, 2026-10-28)

- **`Drawer` `placement="bottom"` (Z-170).** Optional prop, default `"right"`. The bottom sheet is full width, max 78 dvh, 20 px top radius, with the `aiq-sheet-up` .32 s slide (off under reduced motion). The close button is at least 40 px. Used by the take page below 900 px.
- **`Modal` `role` and `data-autofocus` (Z-171).** Optional `role?: "dialog" | "alertdialog"` (default `"dialog"`) for final confirmations. On open the modal focuses the first element marked `data-autofocus`, else the first focusable element as before. The take page's submit confirm uses `alertdialog` with `data-autofocus` on "Submit now". Existing callers are unchanged.
- **Why.** Owner decision 2026-10-28 (exam engine handoff: confirm dialog is `role=alertdialog`, focus on "Submit now"). Rejected: a new dialog component (two optional props are enough).

