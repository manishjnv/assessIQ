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
The folder `AssessIQ_UI_Template/` is the **complete design-system kit** for AssessIQ — the canonical brand contract, not just a visual reference. Entry point is [`AssessIQ_UI_Template/CLAUDE.md`](./AssessIQ_UI_Template/CLAUDE.md); detail lives in [`AssessIQ_UI_Template/design-system/`](./AssessIQ_UI_Template/design-system/) (`README.md` for philosophy + Do/Don't, `tokens.md` for exact values, `components.md` for primitive recipes, `patterns.md` for page layouts, `copy-and-voice.md` for tone). Reference JSX implementations live in [`AssessIQ_UI_Template/screens/`](./AssessIQ_UI_Template/screens/); browse them via `AccessIQ.html` or `component-gallery.html`.

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
- **Deferred to Phase 1+:** `ScoreRing`, `Sparkline`, `QuestionNavigator`, domain composites (`AnchorChip`, `BandPicker`, `RubricEditor`, `QuestionCard`, etc.), `Sidebar`/`NavItem`/`StatCard`, server-side theme resolver, visual-regression baseline, self-hosted fonts.
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
