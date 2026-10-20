# 08 — UI System

*Type: reference* — This page describes the design tokens, components and theming rules of the UI system.

This page is the reference for the AssessIQ UI system. It lists the design tokens, the component library, the theming pipeline and the mobile rules.
It then lists the shared admin patterns and the behaviour of each admin page. Dated notes sit with the page or pattern they change.

## Contents
- [0. Working agreement — the design-system kit is the canonical reference](#0-working-agreement--the-design-system-kit-is-the-canonical-reference)
- [Architecture goals](#architecture-goals)
- [Token layer](#token-layer)
  - [Naming convention](#naming-convention)
  - [Token catalog](#token-catalog)
- [Component library (atomic → composite)](#component-library-atomic--composite)
- [Theming pipeline](#theming-pipeline)
- [Template integration status](#template-integration-status)
- [Storybook](#storybook)
- [Accessibility](#accessibility)
- [Density modes](#density-modes)
- [Iconography](#iconography)
- [What lives where](#what-lives-where)
- [Mobile (Mobile Kit Port M0–M6 SHIPPED — 2026-05-20)](#mobile-mobile-kit-port-m0m6-shipped--2026-05-20)
  - [Viewport hooks (`@assessiq/ui-system`)](#viewport-hooks-assessiqui-system)
  - [First-paint hint](#first-paint-hint)
  - [Mobile token block](#mobile-token-block)
  - [ViewportLock (M5 — removed 2026-05-21)](#viewportlock-m5--removed-2026-05-21)
  - [ESLint guard](#eslint-guard)
  - [Where mobile-mode components live](#where-mobile-mode-components-live)
  - [Help-system entries added by the port](#help-system-entries-added-by-the-port)
- [Shared patterns and primitives](#shared-patterns-and-primitives)
  - [Shared admin primitives (RW-32, 2026-10-10)](#shared-admin-primitives-rw-32-2026-10-10)
  - [RW-33 and RW-34 (S7): shared overlays, tables and one HTTP client](#rw-33-and-rw-34-s7-shared-overlays-tables-and-one-http-client)
  - [Admin list-page kit alignment + Table grid fix (2026-05-21)](#admin-list-page-kit-alignment--table-grid-fix-2026-05-21)
  - [Labels, dates and shared copy (S3, 2026-10-09)](#labels-dates-and-shared-copy-s3-2026-10-09)
  - [Brand consumer copies, static file routing and theme fixture key (2026-10-02)](#brand-consumer-copies-static-file-routing-and-theme-fixture-key-2026-10-02)
  - [Completion modal on new certificates (FR13, 2026-10-03)](#completion-modal-on-new-certificates-fr13-2026-10-03)
  - [404 page main landmark (N25, 2026-10-03)](#404-page-main-landmark-n25-2026-10-03)
  - [Page splits for file size (RW-53, S10, 2026-10-16)](#page-splits-for-file-size-rw-53-s10-2026-10-16)
- [Admin pages](#admin-pages)
  - [Super-admin Platform page (2026-05-17)](#super-admin-platform-page-2026-05-17)
  - [Admin dashboard UI changes (2026-05-24)](#admin-dashboard-ui-changes-2026-05-24)
  - [Add-candidate drawer + invite-picker filter (2026-05-26)](#add-candidate-drawer--invite-picker-filter-2026-05-26)
  - [Attempt detail pages](#attempt-detail-pages)
  - [Generation admin UI — wizard resume + scorecard help (2026-05-24)](#generation-admin-ui--wizard-resume--scorecard-help-2026-05-24)
  - [Generate wizard: difficulty warnings (RW-96, S11)](#generate-wizard-difficulty-warnings-rw-96-s11)
  - [Account security page and Reset two-factor (RW-45, S10, 2026-10-15)](#account-security-page-and-reset-two-factor-rw-45-s10-2026-10-15)
  - [Users page: Reset two-factor (RW-91, S10, 2026-10-16)](#users-page-reset-two-factor-rw-91-s10-2026-10-16)

> Design tokens + component library + theming, all in one module. **You said that you will share a UI template.** When you add it, the integration plan in this doc shows how to connect it to the token system. The rest of the platform stays unchanged.

## 0. Working agreement — the design-system kit is the canonical reference

**Every UI change starts at the design-system kit shipped in [`modules/17-ui-system/AccessIQ_UI_Template/`](../modules/17-ui-system/AccessIQ_UI_Template/) — *consult the kit, do not lift-and-shift it*.** The kit is now a complete brand contract, not only a visual reference. Before any UI work, read it in this order:

1. [`AccessIQ_UI_Template/CLAUDE.md`](../modules/17-ui-system/AccessIQ_UI_Template/CLAUDE.md) — folder-local entry point + non-negotiables.
2. [`design-system/README.md`](../modules/17-ui-system/AccessIQ_UI_Template/design-system/README.md), [`tokens.md`](../modules/17-ui-system/AccessIQ_UI_Template/design-system/tokens.md), [`components.md`](../modules/17-ui-system/AccessIQ_UI_Template/design-system/components.md), [`patterns.md`](../modules/17-ui-system/AccessIQ_UI_Template/design-system/patterns.md), [`copy-and-voice.md`](../modules/17-ui-system/AccessIQ_UI_Template/design-system/copy-and-voice.md) — philosophy, exact values, recipes, layouts, voice.
3. [`screens/`](../modules/17-ui-system/AccessIQ_UI_Template/screens/) — reference JSX implementations (`login`, `dashboard`, `library`, `assessment`, `results`, `atoms`). Live preview: open [`AccessIQ.html`](../modules/17-ui-system/AccessIQ_UI_Template/AccessIQ.html) or [`component-gallery.html`](../modules/17-ui-system/AccessIQ_UI_Template/component-gallery.html).

This rule binds in three places:

1. **The kit is reference-only.** Per [`modules/17-ui-system/SKILL.md`](../modules/17-ui-system/SKILL.md): *"The designer-tool harness must never be imported by app code; port the screen JSX and atoms into typed components under `components/` on demand as features land."* Do not use `import` from `AccessIQ_UI_Template/`. Do not use `cp` to copy its `.jsx` files into `apps/web/`. ESLint `no-restricted-imports` blocks `**/AccessIQ_UI_Template/**` globally. A violation is a Phase 3 bounce condition.

2. **The translation pattern is one-way: kit → typed components → live page.** If a screen exists in `screens/` for what you build, first port its structure into typed `modules/17-ui-system/src/components/` primitives. Then write the live page in `apps/web/src/pages/...`. Use only those typed imports + the production `--aiq-*` tokens. The un-prefixed `--accent` / `--bg` / `--text` of the kit map to `--aiq-color-accent` / `--aiq-color-bg-base` / `--aiq-color-fg-primary` and so on. See [docs/10-branding-guideline.md § 0 step 4](./10-branding-guideline.md#0-working-agreement--the-design-system-kit-is-the-canonical-reference) for the full translation table. Visual fidelity to the kit is the contract. The API of the typed components stays stable across visual updates.

3. **If no screen, recipe, or pattern exists for what you build, STOP.** Report the gap before you compose from primitives. Do not invent a layout silently. The `apps/web/src/pages/admin/users.tsx` gap of 2026-05-01 is an example: the template had no `users.jsx`, so the team built the page ad hoc. This is a Phase 3 bounce condition, because it causes drift across admin-side surfaces. Request a new `screens/<name>.jsx` + a `design-system/components.md` recipe entry. Or get explicit approval to compose from existing atoms, with the diff reviewed against the kit.

The visual translation companion lives at [`docs/10-branding-guideline.md`](./10-branding-guideline.md) § 0 — it codifies the same rule with the five-step translation pattern. This doc covers the *system architecture* (token namespace, theming pipeline, embed posture, component library structure). `10-branding-guideline.md` covers the *visual translation* (kit → `--aiq-*` mapping, AssessIQ-specific deltas such as the banded score model and light-mode lock). The kit itself is the *source of truth*. **When the three disagree, the kit wins, the branding guideline updates next, and this doc tracks the system-level implications last.**

This rule is encoded in memory at `branding-guideline-from-template.md` and `feedback-ui-template-canonical.md` so it survives across sessions.

## Architecture goals

1. **Token-driven** — colors, spacing, type, shadows, motion all defined as CSS custom properties. Components reference tokens, never hard-coded values.
2. **Per-tenant theming** — `tenants.branding` in DB → CSS vars at runtime → instant white-label.
3. **Two surfaces, shared primitives** — admin UI and candidate UI share atomic components (Button, Input, Card) but compose them into different layouts. No duplicate Button implementations.
4. **Embed-friendly** — when `?embed=true`, host can override tokens via `postMessage`. Component code does not change; tokens do.
5. **Accessible by default** — WCAG 2.1 AA target. Focus rings visible, color contrast ≥ 4.5:1, every interactive element keyboard-reachable.

## Token layer

### Naming convention

```
--aiq-<category>-<role>-<variant>
```

Examples: `--aiq-color-bg-base`, `--aiq-color-fg-primary`, `--aiq-space-md`, `--aiq-radius-sm`, `--aiq-shadow-elevation-1`, `--aiq-font-mono`, `--aiq-motion-duration-fast`.

### Token catalog

> Defined here at the namespace + structure level. **Visual values, the editorial type system, and component idioms live in `docs/10-branding-guideline.md`** — that is the canonical source for any color/spacing/typography decision. This section keeps the two in sync but the guideline doc wins on conflicts.

```css
:root {
  /* color — light defaults; dark mode via [data-theme="dark"] override.
     OKLCH-based palette adopted from the AccessIQ_UI_Template; see
     docs/10-branding-guideline.md § 3 for rationale. */
  --aiq-color-bg-base:       #ffffff;
  --aiq-color-bg-raised:     #fafafa;
  --aiq-color-bg-sunken:     #f3f3f4;
  --aiq-color-fg-primary:    #0a0a0b;
  --aiq-color-fg-secondary:  #3f3f46;
  --aiq-color-fg-muted:      #71717a;
  --aiq-color-border:        #e4e4e7;
  --aiq-color-border-strong: #cdcdd1;

  --aiq-color-accent:        oklch(0.58 0.17 258);
  --aiq-color-accent-soft:   oklch(0.96 0.03 258);
  --aiq-color-accent-hover:  oklch(0.52 0.19 258);

  --aiq-color-success:       oklch(0.65 0.15 150);
  --aiq-color-success-soft:  oklch(0.97 0.03 150);
  --aiq-color-warning:       oklch(0.72 0.15 70);
  --aiq-color-danger:        oklch(0.62 0.20 25);
  --aiq-color-info:          oklch(0.62 0.18 230);

  /* spacing — driven by --u so density modes rescale uniformly */
  --u: 4px;
  --aiq-space-2xs: calc(var(--u) * 0.5);
  --aiq-space-xs:  calc(var(--u) * 1);
  --aiq-space-sm:  calc(var(--u) * 2);
  --aiq-space-md:  calc(var(--u) * 3);
  --aiq-space-lg:  calc(var(--u) * 4);
  --aiq-space-xl:  calc(var(--u) * 6);
  --aiq-space-2xl: calc(var(--u) * 8);
  --aiq-space-3xl: calc(var(--u) * 12);
  --aiq-space-4xl: calc(var(--u) * 16);

  /* typography — editorial trio (serif headlines + sans body + mono microcopy) */
  --aiq-font-serif: "Newsreader", "Source Serif Pro", Georgia, serif;
  --aiq-font-sans:  "Geist", -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
  --aiq-font-mono:  "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  --aiq-text-xs:   11px;   /* mono microcopy */
  --aiq-text-sm:   13px;   /* UI label, button */
  --aiq-text-md:   14px;   /* body */
  --aiq-text-lg:   16px;   /* body large, card title */
  --aiq-text-xl:   22px;   /* section heading */
  --aiq-text-2xl:  30px;   /* question text, page title small */
  --aiq-text-3xl:  36px;   /* page title (dashboard) */
  --aiq-text-hero: 52px;   /* hero (login, library, results) */

  /* radius */
  --aiq-radius-sm:   6px;
  --aiq-radius-md:  10px;
  --aiq-radius-lg:  16px;
  --aiq-radius-pill: 999px;

  /* shadow */
  --aiq-shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
  --aiq-shadow-md: 0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);
  --aiq-shadow-lg: 0 8px 32px rgba(0,0,0,0.08);

  /* motion */
  --aiq-motion-duration-fast:    150ms;
  --aiq-motion-duration-base:    180ms;
  --aiq-motion-duration-slow:    300ms;
  --aiq-motion-duration-celebrate: 1500ms;
  --aiq-motion-easing-out:       cubic-bezier(0.2, 0.8, 0.2, 1);
  --aiq-motion-easing-spring:    cubic-bezier(0.34, 1.56, 0.64, 1);

  /* z layers */
  --aiq-z-popover:  100;
  --aiq-z-modal:    200;
  --aiq-z-toast:    300;
}

/* Density rescale */
[data-density="compact"]     { --u: 3px; }
[data-density="cozy"]        { --u: 4px; }   /* default */
[data-density="comfortable"] { --u: 5px; }

[data-theme="dark"] {
  --aiq-color-bg-base:       #0e0e10;
  --aiq-color-bg-raised:     #161618;
  --aiq-color-bg-sunken:     #1d1d20;
  --aiq-color-fg-primary:    #f5f5f7;
  --aiq-color-fg-secondary:  #8a8a94;
  --aiq-color-fg-muted:      #88889a;
  --aiq-color-border:        #2a2a2e;
  --aiq-color-border-strong: #3a3a3f;
  --aiq-color-accent:        oklch(0.70 0.16 258);
  --aiq-color-accent-soft:   oklch(0.25 0.08 258);
  --aiq-color-accent-hover:  oklch(0.78 0.16 258);
  --aiq-color-success-soft:  oklch(0.30 0.05 150);
  --aiq-shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
  --aiq-shadow-md: 0 1px 3px rgba(0,0,0,0.5), 0 4px 12px rgba(0,0,0,0.3);
  --aiq-shadow-lg: 0 8px 32px rgba(0,0,0,0.6);
}
```

## Component library (atomic → composite)

```
modules/17-ui-system/components/
├── primitives/
│   ├── Button.tsx
│   ├── Input.tsx
│   ├── Textarea.tsx
│   ├── Select.tsx
│   ├── Checkbox.tsx
│   ├── Radio.tsx
│   ├── Switch.tsx
│   ├── Badge.tsx
│   ├── Pill.tsx
│   ├── Tooltip.tsx        (re-exported as base for HelpTip)
│   ├── Avatar.tsx
│   ├── Spinner.tsx
│   └── Icon.tsx           (lucide-react wrapper)
├── layout/
│   ├── Card.tsx
│   ├── Drawer.tsx
│   ├── Modal.tsx
│   ├── Tabs.tsx
│   ├── Accordion.tsx
│   ├── Splitter.tsx
│   └── Stack.tsx          (vertical/horizontal flex with gap from tokens)
├── data/
│   ├── Table.tsx          (header, sort, sticky, pagination)
│   ├── Pagination.tsx
│   ├── EmptyState.tsx
│   ├── StatCard.tsx
│   ├── ScoreBar.tsx
│   ├── Sparkline.tsx
│   └── DiffViewer.tsx     (for help-content version diffs, AI verdict vs override)
├── feedback/
│   ├── Toast.tsx
│   ├── Banner.tsx
│   ├── Alert.tsx
│   └── ConfirmDialog.tsx
├── forms/
│   ├── Form.tsx           (controlled context with validation)
│   ├── Field.tsx          (label + input + error wiring)
│   ├── ValidationSummary.tsx
│   └── SubmitBar.tsx
├── domain/                 (assessment-specific composites)
│   ├── QuestionCard.tsx
│   ├── McqOption.tsx
│   ├── KqlEditor.tsx
│   ├── SubjectiveEditor.tsx
│   ├── QuestionNav.tsx
│   ├── Timer.tsx
│   ├── ScoreBreakdown.tsx
│   ├── RubricView.tsx
│   ├── AnchorChip.tsx
│   └── BandPicker.tsx     (admin override UI)
└── index.ts                (named exports; tree-shakeable)
```

Every primitive accepts:
- `className` for tenant-specific extension
- `data-test-id` for E2E tests (Playwright)
- ARIA attributes mapped from semantic props (`<Button intent="danger">` → `role="button"` + appropriate label expectations)

## Theming pipeline

```
tenants.branding (DB)
   │  { primary, fg, bg, logo_url, product_name_override }
   ▼
Theme resolver (server, on login)
   │  expands to full token set, applying brand overrides on top of defaults
   ▼
Inline <style> block in HTML response
   │  :root { --aiq-color-accent: <tenant.primary>; ... }
   ▼
Components render using var(--aiq-color-accent)
```

For embed mode, host can override at runtime:
```js
// host parent
iframeRef.contentWindow.postMessage(
  { type: "aiq.theme", tokens: { "--aiq-color-accent": "#1a73e8" } },
  "https://assessiq.automateedge.cloud"
);
```

AssessIQ injects the override into the iframe's `:root`. Origin is verified against `tenant.embed_origins`.

Dark mode toggle:
- Stored in `users.metadata.theme = 'system' | 'light' | 'dark'`
- Applied via `<html data-theme="dark">` attribute
- Respects `prefers-color-scheme: dark` when set to `system`

## Template integration status

The UI template arrived on 2026-04-30 and has been adopted as the brand base. It lives at `modules/17-ui-system/AccessIQ_UI_Template/` (the folder name is a typo; the product is *AssessIQ*). `docs/10-branding-guideline.md` holds the canonical visual contract: typography, palette, component idioms, screen-layout templates, motion and voice. **Read that guideline before designing or coding any new page.**

What is live (Phase 0 G0.B Session 3 — 2026-05-01):

1. **Token namespace ported.** `styles.css` → `modules/17-ui-system/src/styles/tokens.css` with all `--*` custom properties renamed to `--aiq-*`. All utility classes have the prefix `aiq-` (`.aiq-screen`, `.aiq-serif`, `.aiq-mono`, `.aiq-num`, `.aiq-btn{,-primary,-outline,-ghost,-sm,-lg}`, `.aiq-input`, `.aiq-card`, `.aiq-chip{,-accent,-success}`, `.aiq-mark` + `.aiq-mark-dot`, `.aiq-grid-bg`, `.aiq-divider`). Light + dark mode + density variants (`compact` / `cozy` / `comfortable`). `prefers-reduced-motion` override included.
2. **Phase-0 component library** at `modules/17-ui-system/src/components/`: `Button` (pill; `primary`/`outline`/`ghost` × `sm`/`md`/`lg` + `leftIcon`/`rightIcon`/`loading`), `Card` (no shadow at rest; `interactive` and `floating` flags), `Field` plus `Input`/`Label`/`FieldHelp` (label-above, focus halo, `aria-invalid`/`aria-describedby` wiring), `Chip` (`default`/`accent`/`success` with `success` defaulting to a `check` icon), `Icon` (22-name typed SVG sprite with aria-label/aria-hidden conditional), `Logo` (mark + halo + serif "AssessIQ" wordmark — case-sensitive; the template's "AccessIQ" typo is intentionally not propagated), `Num` + `useCountUp` (cubic-out RAF loop, reduced-motion respected). All exported from the package barrel `@assessiq/ui-system`.
3. **`ThemeProvider`** at `modules/17-ui-system/src/theme/ThemeProvider.tsx`. Reads a static fixture (`fixtures/tenants.ts`) for Phase 0; injects `--aiq-color-accent{,-soft,-hover}` overrides on a wrapper `<div>` and toggles `data-theme`/`data-density`. SSR-safe `matchMedia` for `system` theme. Live tenant wiring to `tenants.branding` JSONB lands in Phase 1 alongside `02-tenancy`.
4. **Vite 8 + React 19 + TypeScript SPA** at `apps/web/`. Token css imported via `@assessiq/ui-system/styles/tokens.css`. Tailwind installed for layout utilities only — editorial styling stays on the `aiq-*` classes; Tailwind theme reads `--aiq-font-*` and `--aiq-radius-*` from the same vars. `tsc -b && vite build` green.
5. **Storybook 8** at `apps/storybook/` with `@storybook/react-vite`. One story per component covering the main variants. `withThemeByDataAttribute` decorators for `data-theme` and `data-density` toolbars. Stories live next to components (`<Component>.stories.tsx`).

What is live (UI v1.1 port — 2026-05-13):

1. **Phase 1 — Token migration** (`b95df19`). 7 light-mode token values now match kit v1.1 (`--aiq-color-fg-primary` `#1a1a1a` → `#0a0a0b`, and others). Also `.aiq-serif` font-weight 400 → 500, and the dark-mode hierarchy stays intact.
2. **Phase 2 — Atom refresh** (`57ddf12`). 5 component updates, all additive: `Chip` `warn` variant; `Sparkline` `<polyline vector-effect="non-scaling-stroke">` at 1.2px; `ScoreRing` 1600ms stroke-dashoffset transition; `StatCard.breakdown` prop renders stacked-bar + colored legend (uses `--aiq-color-chart-{1..8}` palette); `Sidebar` 240px width + `footer?` slot + `SidebarSection` sub-component.
3. **Phase 3a — Easy primitives** (this commit). Three new primitives + first axe a11y wiring in the module:

   | Component | Props | CSS classes | Tests |
   | --- | --- | --- | --- |
   | `Spinner` | `size?: "sm" \| "md" \| "lg"`, `aria-label?: string` (default `"Loading"`) | `.aiq-spinner{,-sm,-lg}` + `@keyframes aiq-spin` (`prefers-reduced-motion` slows to 1.5s) | 5 |
   | `ProgressBar` | `value: number`, `max?: number` (default 100), `height?: 2 \| 4 \| 6` (default 4), `variant?: "accent" \| "success" \| "fg"`, `label?: string` | `.aiq-progress-bar` + `.aiq-progress-bar-fill` with `[data-height]` / `[data-variant]` selectors | 6 |
   | `Placeholder` | `width?: number \| string`, `height?: number \| string`, `radius?: number \| string`, `caption?: string` (default `"image"`) | `.aiq-placeholder` (striped diagonal `repeating-linear-gradient`) | 6 |

   ARIA: `Spinner` is `role="status" aria-live="polite"`; `ProgressBar` is `role="progressbar"` with `aria-valuenow/min/max`; `Placeholder` is `role="img"` with `aria-label` from caption. `ProgressBar` clamps `value` to `[0, max]`. `Placeholder` honors consumer `style` overrides via spread ordering.

   **Test infra:** `vitest` + `vitest-axe` + `@testing-library/react` + `jsdom` added as devDeps. `vitest.config.ts` (jsdom env), `vitest.setup.ts` (axe matchers + cleanup), `src/test-setup.d.ts` (vitest-axe@0.1.0 `Vi` namespace → vitest v2 `declare module "vitest"` patch). One axe assertion per primitive — precedent for the rest of the v1.1 port (17/17 tests green).

What is live (UI v1.1 Phase 3b — 2026-05-13):

Activity-screen primitives. All three sourced from [`AssessIQ_UI_Template/screens/activity.jsx`](../modules/17-ui-system/AssessIQ_UI_Template/screens/activity.jsx); none import from the kit (translated manually, ESLint blocks kit imports). All use the production `--aiq-color-chart-{1..8}` palette (NOT the kit's hardcoded `ACT_COLORS` hex array — the two palettes intentionally differ; production is Google-brand-anchored, kit is Tailwind). Each ships with one `axe(container)` assertion in its `.test.tsx` per the Phase 3a precedent.

| Component | Props | CSS / tokens | Tests |
| --- | --- | --- | --- |
| `ActivityHeatmap` | `data: number[]` (0–4 column-major), `weeks?: number` (default 52), `monthLabels?: string[]`, `dayLabels?: string[]` (default `["M","W","F"]`), `streakSummary?: string`, `legendLessLabel?` / `legendMoreLabel?`, `aria-label?`, `data-test-id?`, `className?` | Five new tokens added to `tokens.css`: `--aiq-color-heatmap-{0..4}`. Level 0 is mapped to `--aiq-color-bg-sunken` (auto-tracks dark mode); 1–4 are explicit `oklch()` stops on hue 258 (matches `--aiq-color-accent`). Pure CSS grid; no chart lib. Out-of-range data values clamped to `[0, 4]`; `data.length < weeks*7` zero-pads, longer truncates. | 7 (incl. axe) |
| `StackedBarChart` | `bars: StackedBarChartBar[]`, `colors?: string[]` (defaults `--aiq-color-chart-{1..8}`), `seriesLabels?: string[]`, `yAxisLabels?: string[]`, `xAxisStartLabel?` / `xAxisEndLabel?`, `height?: number` (default 200), `gap?: number` (default 4), `aria-label?`, `data-test-id?`, `className?` | Pure div/flex; no chart lib (anti-pattern guard). Per-bar height = `sum(segments) / max(totals)`; per-segment share = `segment / sum`. Empty bars (total = 0) render at 0 height — no NaN. Y-axis labels positioned absolutely at `top: i/(n-1)*100%`; chart reserves `paddingLeft: 36` when `yAxisLabels` present. Segments at `opacity: 0.85` (matches kit). | 6 (incl. axe) |
| `LeaderboardList` | `items: LeaderboardListItem[]`, `columns?: 1\|2` (default 2), `colors?: string[]` (defaults `--aiq-color-chart-{1..8}`), `onShowMore?: () => void`, `showMoreLabel?: string`, `data-test-id?`, `className?` | Renders as semantic `<ol>` with `listStyle: none` (rank order conveyed both visually and via DOM order). Rank avatar = 32×32 outer ring at `opacity: 0.18` + 12×12 inner solid dot. **Avatar opacity fix vs kit**: the kit nests the inner dot inside the 0.18-opacity outer div, which cascades opacity and makes the dot semi-transparent too. Production splits them: outer is `position: absolute; inset: 0` with the opacity; inner is `position: relative` at full opacity. Show More uses the existing `Button` with `variant="ghost" size="sm"`. | 6 (incl. axe) |

ARIA: `ActivityHeatmap` and `StackedBarChart` are `role="img"` with `aria-label`; their decorative day-labels / month-labels / y-axis labels are `aria-hidden`. `LeaderboardList` is a native `<ol>` so screen readers convey ranked order; avatars are `aria-hidden` (decorative).

The new components are exported from `@assessiq/ui-system` and ready for Phases 11 (admin `/activity`) + 12 (candidate `/activity`) page consumers.


What is live (UI v1.1 Phase 5 — 2026-05-14):

Admin dashboard + AdminShell sidebar refresh. Commit `3b7e2d9`. Source: [`AssessIQ_UI_Template/screens/dashboard.jsx`](../modules/17-ui-system/AssessIQ_UI_Template/screens/dashboard.jsx).

**What was composed:**

| File | Change | Kit source |
| --- | --- | --- |
| `modules/10-admin-dashboard/src/pages/dashboard.tsx` | Page header: mono date meta line + serif h1 greeting (dynamic time-of-day phrase + display name from session email) + CTA buttons (Refresh, New assessment). Stat row: 3 `StatCard` tiles in `repeat(3, 1fr)` grid derived from queue status counts ("In queue", "Submitted", "Awaiting review"). Grading queue table preserved as primary work surface. | `screens/dashboard.jsx` header region + stat row |
| `modules/10-admin-dashboard/src/components/AdminShell.tsx` | Imported `SidebarSection` (Phase 2e, already in package). Split flat nav into "Workspace" group (Dashboard → Users) and "Account" group (Help guide + Settings) with `<SidebarSection>` eyebrow headers. Added user card `footer` slot to `<Sidebar>` — avatar initial (accent-bg circle), display name, role label. | `screens/dashboard.jsx` sidebar sections + footer slot |

**Kit elements dropped (no admin-side data from queue endpoint):**

| Kit section | Why dropped |
| --- | --- |
| "Continue where you left off" | Candidate-context in-progress assessments — no equivalent admin data from `/admin/dashboard/queue` |
| "Performance" sparkline card | Requires time-series data — queue endpoint returns status snapshot only, no historical points |
| "Recommended for you" grid | AI-recommendation context for candidates; no admin equivalent planned |
| `StatCard.breakdown` prop | Would need categorical breakdown data (for example, by domain); queue items have only status |
| 4th stat card | Kit's "Time saved via auto-grading" derives from AI grading stats; no endpoint for it yet |

**Token decisions:** All tokens already present from Phases 1–3. No new tokens added. `fontSize: 10` (bare numeric, not `"10px"`) used for role label — smallest mono size, no `--aiq-text-xxs` token exists; matches the existing `SidebarSection` pattern.

**Verification:** `pnpm -C modules/10-admin-dashboard typecheck` ✓, `pnpm -C apps/web typecheck` ✓, `pnpm -C modules/17-ui-system typecheck` ✓. Zero hex colors in diff. Zero `px`/`rem` string literals in diff. Zero secrets. `assessiq-frontend` healthy on VPS; `/admin/dashboard` → HTTP 200.

What still needs to happen, on demand as later v1.1 phases land:

1. **Phase 6b — Attempt page** against `kit/screens/assessment.jsx` — timer header, question navigator, integrity banner.
2. **Phase 7–8 — List pages + results/reports** against kit screens.
3. **Phase 10/12 — Candidate Activity backend + wire.**

The reference template files (`design-canvas.jsx`, `tweaks-panel.jsx`, `AccessIQ.html`, `.design-canvas.state.json`) are the omelette/Claude design-canvas wrapper that produced the template. They are useful for visual reference (open the HTML to see all screens). **Production code must not import them.** Enforcement: ESLint flat config has `no-restricted-imports` blocking `**/AccessIQ_UI_Template/**` globally; CI's no-template grep verifies.

What is live (UI v1.1 Phase 6a — 2026-05-14):

Candidate take-flow page refresh. Commit `7e89875`. Source: [`AssessIQ_UI_Template/screens/login.jsx`](../modules/17-ui-system/AssessIQ_UI_Template/screens/login.jsx) (two-column layout idiom) + Phase 3a Spinner primitive.

**What changed:**

| File | Change |
| --- | --- |
| `apps/web/src/pages/take/TakeRightPane.tsx` | **New file.** Extracts the 55-line duplicated right-pane `<aside>` that was copy-pasted across `TokenLanding`, `Expired`, and `ErrorPage`. Single source of truth: accent chip "Phase 1", serif tagline, blockquote with footer. |
| `apps/web/src/pages/take/TokenLanding.tsx` | Replaced inline spinner ring (`div + Loading… text`) in loading state with `<Spinner aria-label="Verifying invitation" />` (Phase 3a). Replaced local `RightPane` function with `<TakeRightPane />`. |
| `apps/web/src/pages/take/Submitted.tsx` | Removed `injectStyles()`, `STYLE_ID` constant, `@keyframes aiq-submitted-spin` injection, and the `useEffect(() => { injectStyles(); }, [])` call. Replaced "Loading…" loading state with `<Spinner aria-label="Loading submission status" />`. Replaced inline spinner ring in grading-pending card with `<Spinner size="sm" aria-label="Grading pending" style={{ flexShrink: 0 }} />`. |
| `apps/web/src/pages/take/Expired.tsx` | Replaced copy-pasted 58-line `<aside>` block with `<TakeRightPane />`. |
| `apps/web/src/pages/take/ErrorPage.tsx` | Same as Expired. |

**Why:** Phase 3a shipped `Spinner` but Submitted.tsx kept a hand-rolled `@keyframes` injection ("no Spinner primitive yet" comment was stale). The right-pane aside was duplicated verbatim across 3 files — DRY violation discovered during this audit.

**What was NOT changed:** Left-pane content (headings, body copy, buttons, chips) in all four pages matched the kit login-screen idiom already. No token substitutions needed — pages were already using `--aiq-color-*` tokens throughout.

**Verification:** `pnpm -C apps/web typecheck` ✓. Zero inline hex. Zero residual `animation:` styles. `/take/expired` → HTTP 200, `/take/error` → HTTP 200.


What is live (UI v1.1 Phase 7a — 2026-05-14):

Admin list-page template established + Users + Attempts refreshed. Commit `f528fc6`. Source: [`AssessIQ_UI_Template/screens/library.jsx`](../modules/17-ui-system/AssessIQ_UI_Template/screens/library.jsx) (count chip + serif h1 + lede + filter strip pattern).

**List-page composition recipe (no shared component — pages vary too much):**

```
Chip leftIcon="grid"  — count meta above the h1
h1 aiq-serif text-3xl fontWeight=400 letterSpacing="-0.02em"
p color=fg-secondary fontSize=14 margin="8px 0 0"  — lede
[action button aligned flex-end]
---border---
filter strip: search Field (flex 1 1 320px) + tab buttons or Chip filters
---border--- (optional, on paddingBottom)
Table or card grid
empty state: dashed border, bg-raised, serif h2 + secondary p + CTA
pager: ghost prev/next + mono "X / Y" label
```

**What changed:**

| File | Change |
| --- | --- |
| `modules/10-admin-dashboard/src/pages/users.tsx` | **New file** (migrated from `apps/web/src/pages/admin/users.tsx`). Replaced custom top-bar with `AdminShell breadcrumbs=["Users"]`. Uses `adminApi`/`AdminApiError`. Spinner for loading. Fixed `--aiq-color-bg-elevated` → `--aiq-color-bg-raised` (3 occurrences). Kit header pattern: count Chip + serif h1 + lede + "Invite user" button. |
| `apps/web/src/pages/admin/users.tsx` | Deleted — replaced by module page above. |
| `modules/10-admin-dashboard/src/pages/attempts.tsx` | Added count Chip + lede paragraph above the filter tabs. |
| `modules/10-admin-dashboard/src/index.ts` | Added `AdminUsers` export. |
| `apps/web/src/App.tsx` | Import `AdminUsers` from `@assessiq/admin-dashboard`; remove external `<AdminShell>` wrapper from `/admin/users` route (component manages its own shell now, consistent with all other admin pages). |

**Why the move to the module:** All other admin pages live in `modules/10-admin-dashboard/` and self-wrap `AdminShell`. `users.tsx` in `apps/web` was the only exception, with its own top-bar — a pattern inconsistency introduced before AdminShell existed.

**Verification:** `modules/10-admin-dashboard` typecheck ✓, `apps/web` typecheck ✓. Zero `--aiq-color-bg-elevated`. `/admin/users` → 200, `/admin/attempts` → 200.


What is live (UI v1.1 Phase 7b — 2026-05-14):

Applied the list-page recipe (count Chip + serif h1 + lede) from Phase 7a to all 5 remaining Phase 7 targets. Commit `01b351b`.

**What changed:**

| File | Change |
| --- | --- |
| `modules/10-admin-dashboard/src/pages/assessments.tsx` | Added `Chip` import. Chip `{N} assessment(s)` above h1. Lede "Assessment cycles — set dates, invite candidates, track completion." Action button repositioned inside right side of flex row. |
| `modules/10-admin-dashboard/src/pages/question-bank.tsx` | Same treatment. Chip `{N} pack(s)`. Lede "Question packs organised by domain and difficulty level." |
| `modules/10-admin-dashboard/src/pages/pack-detail.tsx` | Added `Chip` import. Chip `{N} level(s)` above existing serif h1 + meta lede (domain · version · created date already present). |
| `modules/10-admin-dashboard/src/pages/assessment-detail.tsx` | Added `Chip` to existing ui-system import. Chip `{N} invitation(s)` above serif h1 + dates lede already present. |
| `modules/11-candidate-ui/src/components/MyCertificates.tsx` | Added `Chip, Spinner` import. Replaced non-serif `headingStyle` with kit serif pattern (`aiq-font-serif`, weight 400, −0.02em tracking). Replaced "Loading your certificates…" `<p>` with `<Spinner>`. Added count Chip + lede above h1. Period appended to title per kit convention. |

**Detail-page header treatment:** detail pages already had serif h1 + inline status pill + meta lede. Phase 7b adds only the count Chip above the header block (level/invitation count) — no structural change to the h1 row itself.

**Verification:** `modules/10-admin-dashboard` typecheck ✓, `modules/11-candidate-ui` typecheck ✓. Zero inline hex introduced. Zero `--aiq-color-bg-elevated`. `/admin/assessments` → 200, `/admin/question-bank` → 200.


What is live (UI v1.1 Phase 8a — 2026-05-14):

Applied Spinner loading state + count Chip + serif h1 + lede to the two results/reports detail pages. Commit `86f7de3`.

| File | Change |
| --- | --- |
| `modules/10-admin-dashboard/src/pages/cohort-report.tsx` | Added `Chip, Spinner` imports. Replaced "Loading…" div with centered `<Spinner>`. Replaced mono meta line (cohort name) with count Chip `{N} candidate(s)` + h1 "Cohort Report." + lede "Score distribution and archetype breakdown across all scored attempts." |
| `modules/10-admin-dashboard/src/pages/attempt-detail.tsx` | Added `Chip, Spinner` imports. Spinner loading state. Status Chip (attempt.status) above h1 displaying `{attempt.assessment_name}.` Mono meta row below: `candidate_email · level_label · submitted_at`. |


What is live (UI v1.1 Phase 8b — 2026-05-14):

Applied Spinner + count Chip + serif h1 + lede to individual report and reports landing. Commit `378c93d`.

| File | Change |
| --- | --- |
| `modules/10-admin-dashboard/src/pages/individual-report.tsx` | Added `Chip, Spinner` to existing Sparkline/StatCard import. Spinner loading state. Count Chip `{N} attempt(s)` + h1 `{report.email}.` + lede "Attempt history and progression for this candidate." |
| `modules/10-admin-dashboard/src/pages/reports.tsx` | Added `Spinner` import. Replaced "Loading…" in `ReportSection` with `<Spinner size="sm">`. Added lede below existing h1: "Cohort summaries and per-candidate progression across all assessments." |


What is live (UI v1.1 Phase 12 — 2026-05-14):

Spinner loading states for all 4 async sections in CandidateActivity. Commit `b0a512d`.

| File | Change |
| --- | --- |
| `modules/11-candidate-ui/src/components/CandidateActivity.tsx` | Added `Spinner` to existing ui-system import (StatCard, ActivityHeatmap, StackedBarChart, LeaderboardList). Replaced 4 "Loading…" inline divs — statsLoading, heatmapLoading, timelineLoading, leaderboardLoading — with `<Spinner size="sm" aria-label="Loading [section]" />`. |


What is live (UI v1.1 Phase 13 — 2026-05-14):

Kit treatment for settings + low-traffic admin pages. Commit `e624184`.

| File | Change |
| --- | --- |
| `modules/10-admin-dashboard/src/pages/generation-attempts.tsx` | Added `Chip, Spinner` imports. Count Chip + h1 text-3xl "AI generation history." (period added). Spinner in table td loading cell. |
| `modules/10-admin-dashboard/src/pages/certificates.tsx` | Added `Chip, Spinner` imports. Count Chip + h1 text-3xl "Certificates." Spinner in table td loading cell. |
| `modules/10-admin-dashboard/src/pages/help-content.tsx` | Added `Spinner` to existing Modal import. Spinner replaces "Loading…" div. h1 already correct (text-3xl, "Help content.", period present). |
| `modules/10-admin-dashboard/src/pages/question-editor.tsx` | Added `Spinner` import. Full-page loading state → centered `<Spinner>`. Two h1s upgraded: text-2xl → text-3xl, period appended — "New question." and "Edit rubric." |

**Not changed (Phase 13):** `guide.tsx` does not exist as a separate page file. App.tsx wraps `<AdminGuide>` externally with `<AdminShell>`, so there is no file to modify.

## Storybook

FU-D11 (2026-10-06): there is no root `pnpm storybook` script today. Run `pnpm --filter @assessiq/storybook dev` (or `cd apps/storybook && pnpm dev`). Every primitive and composite has stories covering:
- Default state
- All size variants
- All intent/variant variants
- Disabled, loading, error states
- RTL (right-to-left) — for future Hindi/Arabic support
- Dark mode
- Keyboard focus

FU-D14 (2026-10-16, S12): the last seven components without a story got one (Drawer, Modal, ScoreRing, Sidebar, Sparkline, StatCard, Table). Every file in `modules/17-ui-system/src/components/` now has a `.stories.tsx` (27 of 27). Stateful demos (open/close, sortable table) live in small named components inside the story file because eslint rejects hooks inside `render`. The E13 visual-baseline merge is not included. Gate: `pnpm --filter @assessiq/storybook build`.

Storybook ships as part of the dev environment, not deployed. We may host a public version later for component documentation if AssessIQ becomes a multi-tenant product with partner devs.

## Accessibility

- Colour contrast: ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI elements (verified per token combination)
- Focus indication: 2px ring using `--aiq-color-accent` with 2px offset; never removed
- Keyboard: every interactive element reachable via Tab; logical order; skip-link to main on every page
- Screen reader: ARIA labels on icon-only buttons; live regions for toast and timer; `aria-busy` during async ops
- Motion: respect `prefers-reduced-motion`; transitions removed under that preference
- Forms: labels always visible (no placeholder-as-label); error messages programmatically associated with inputs
- Color independence: status never conveyed by color alone — pair with icon or text

## Density modes

Two density tokens:
```
[data-density="comfortable"]  /* default */
[data-density="compact"]
```

Compact reduces vertical padding ~25% on Button, Input, Table rows. Useful for admin dashboards where information density matters; comfortable for candidate-facing screens where reading load matters. Stored in `users.metadata.density`.

## Iconography

Use **lucide-react**. Centralize via `<Icon name="alert-triangle" size="md" />` so we can swap icon sets later without find-replacing across the codebase.

## What lives where

```
modules/17-ui-system/
├── SKILL.md
├── package.json                       # @assessiq/ui-system (workspace)
├── tsconfig.json                      # excludes *.stories.tsx (typechecked by storybook app)
├── AccessIQ_UI_Template/              # reference only — never imported
└── src/
    ├── index.ts                       # barrel — public surface
    ├── styles/
    │   └── tokens.css                 # :root + [data-theme="dark"] + density variants + base classes
    ├── components/
    │   ├── Button.tsx + .stories.tsx
    │   ├── Card.tsx + .stories.tsx
    │   ├── Chip.tsx + .stories.tsx
    │   ├── Field.tsx + .stories.tsx   # exports Field, Input, Label, FieldHelp
    │   ├── Icon.tsx + .stories.tsx
    │   ├── Logo.tsx + .stories.tsx
    │   └── Num.tsx + .stories.tsx
    ├── hooks/
    │   └── useCountUp.ts              # RAF cubic-out; respects prefers-reduced-motion
    ├── theme/
    │   └── ThemeProvider.tsx + .stories.tsx
    └── fixtures/
        └── tenants.ts                 # Phase-0 static fixture; replaced by live tenant API in Phase 1

apps/web/                              # Vite 8 + React 19 + TS SPA host (not yet routed)
├── index.html                         # Google Fonts link for Newsreader / Geist / JetBrains Mono
├── tsconfig.{json,app.json,node.json} # references-style; bundler module resolution
├── vite.config.ts
├── tailwind.config.ts                 # reads --aiq-font-*, --aiq-radius-*
├── postcss.config.js
└── src/
    ├── main.tsx                       # imports tokens.css + globals.css; mounts <App />
    ├── App.tsx                        # Phase-0 smoke page exercising every component
    └── styles/globals.css             # Tailwind base/components/utilities

apps/storybook/                        # Storybook 8 + @storybook/react-vite host
├── package.json                       # @assessiq/storybook
├── tsconfig.json                      # picks up modules/17-ui-system/src/**/*.stories.tsx
└── .storybook/
    ├── main.ts                        # framework: @storybook/react-vite; addons: essentials, themes
    └── preview.tsx                    # tokens.css import + theme/density data-attribute decorators
```

Server-side theme resolver (`theme-resolver.ts`) lands in Phase 1 alongside `02-tenancy`, when the `tenants.branding` JSONB query becomes available; the Phase-0 `ThemeProvider` reads `fixtures/tenants.ts` instead. A future `tokens.ts` (TS export of token names for typesafe usage) is deferred until a consumer actually needs it.

## Mobile (Mobile Kit Port M0–M6 SHIPPED — 2026-05-20)

See [docs/10-branding-guideline.md § 15. Mobile](./10-branding-guideline.md#15-mobile) for the canonical visual contract and the full per-pattern reflow catalog (M1 magic-link landing, M2a AttemptPage chrome, M2b per-question-type sizing, M3 Submitted, M4 CandidateShell nav + Activity, M5 admin graceful-degrade). This section lists the API surface in `@assessiq/ui-system` and `apps/web/src/lib/`.

### Viewport hooks (`@assessiq/ui-system`)

- `useViewport(): 'mobile' | 'desktop'` — SSR-safe (returns `'desktop'` when `window` is undefined). Subscribes to `matchMedia` change events so live resize / orientation changes update the value. Source: [`modules/17-ui-system/src/hooks/useViewport.ts`](../modules/17-ui-system/src/hooks/useViewport.ts).
- `useViewportSync(): void` — side-effect hook that writes `data-viewport` on `<html>` and keeps it in sync. Called once inside `ThemeProvider`; consumers never call it directly. Source: [`modules/17-ui-system/src/hooks/useViewportSync.ts`](../modules/17-ui-system/src/hooks/useViewportSync.ts).
- Predicate constant: `VIEWPORT_QUERY` = `(max-width: 719px), ((pointer: coarse) and (max-width: 1024px))`. The combined OR covers small phones AND iPads in portrait. Single source-of-truth — never duplicate this predicate elsewhere.

### First-paint hint

[`apps/web/index.html`](../apps/web/index.html) carries a tiny inline IIFE in `<head>` that sets `data-viewport` on `<html>` BEFORE the React bundle loads. Without this, the page paints in desktop layout for one frame then re-flows to mobile. The IIFE has a try/catch with `'desktop'` fallback so any `matchMedia` weirdness cannot blank the page.

### Mobile token block

Lives in [`modules/17-ui-system/src/styles/tokens.css`](../modules/17-ui-system/src/styles/tokens.css) as the `[data-viewport="mobile"]` block + per-page class-scoped overrides. Final set of M0-introduced viewport-aware tokens:

| Token | Desktop | Mobile |
| --- | --- | --- |
| `--aiq-page-padding-x` | `40px` | `22px` |
| `--aiq-page-padding-y` | `32px` | `20px` |
| `--aiq-card-padding` | `24px` | `18px` |
| `--aiq-h1-size` | `var(--aiq-text-3xl)` = 36px | `30px` |

Later phases added scoped CSS vars on container classes (not in the global token registry):

| Scope | Var | Desktop | Mobile | Phase |
| --- | --- | --- | --- | --- |
| `.aiq-take-twopane` | `--aiq-take-h1-size` / `--aiq-take-h1-lh` | `44px` / `1.05` | `30px` / `1.1` | M1 |
| `.aiq-attempt-shell` | `--aiq-attempt-q-size` | `var(--aiq-text-2xl)` = 30px | `22px` | M2a |
| `.aiq-attempt-shell` | `--aiq-answer-input-size` | `15px` | `16px` | M2b (defeats iOS auto-zoom on form inputs < 16px) |
| `.aiq-attempt-shell` | `--aiq-answer-mono-size` | `13px` | `16px` | M2b (same defeat, mono-font preserved) |

Never remove or rename existing keys.

### ViewportLock (M5 — removed 2026-05-21)

> **Removed.** Commit `c8349df` (Admin Mobile Port A6) deleted `apps/web/src/lib/ViewportLock.tsx` and unwrapped it from `App.tsx`. Admin pages are now mobile-responsive, so no interstitial shows. See `docs/plans/archive/ADMIN_MOBILE_PORT.md`. The text below is history.

[`apps/web/src/lib/ViewportLock.tsx`](../apps/web/src/lib/ViewportLock.tsx) wraps `<Routes>` in [`apps/web/src/App.tsx`](../apps/web/src/App.tsx) and renders the "Admin tools work best on desktop" interstitial when ALL of these hold: the viewport is `mobile`; the path starts with `/admin/`; the path is not one of `{login, login/email, select-identity, mfa}`; no `sessionStorage.aiq_admin_mobile_override='1'` is set; and the page is not in embed mode (`?embed=true`). Otherwise it passes through. Candidate, take-flow, embed and 404 routes are not affected, because their pathnames do not match `/admin/`. Override storage is `sessionStorage` (per-tab, clears on tab close). The "per-session" + `localStorage` wording of the plan was contradictory; M5 follows the per-session intent. Security gates (rate-limit errors, locked-account, MFA prompts) render exactly as on desktop when the override is on — the override only relaxes layout.

### ESLint guard

[`eslint.config.js`](../eslint.config.js) blocks runtime imports from `**/AssessIQ-Mobile-Kit/**` (in addition to the existing `**/AssessIQ_UI_Template/**` block). Hand-port idioms into `modules/17-ui-system/src/components/` per the desktop-kit pattern. The Mobile Kit is REFERENCE-ONLY — never imported from production code.

### Where mobile-mode components live

- Foundation: `modules/17-ui-system/src/hooks/{useViewport,useViewportSync}.ts`, `modules/17-ui-system/src/styles/tokens.css` (`[data-viewport="mobile"]` block + per-page scoped overrides).
- Magic-link auth (M1): `apps/web/src/pages/candidate/CandidateLogin.tsx`, `apps/web/src/pages/take/{TokenLanding,Expired,ErrorPage}.tsx` (CSS-only reflow on the M1 shared `.aiq-take-twopane` class).
- Take-flow chrome (M2a): `apps/web/src/pages/take/Attempt.tsx` (header padding shrink, navigator-aside hidden + lazy `<Drawer>` mount via the new `aiq-attempt-nav-toggle` button, footer flex-wrap restack).
- Take-flow answer areas (M2b): same file — textareas + the log-analysis finding `<input>` read `--aiq-answer-input-size`. The KQL textarea reads `--aiq-answer-mono-size` and renders a mobile-only `.aiq-attempt-kql-mobile-tip` caveat above the editor.
- Submitted page (M3): `apps/web/src/pages/take/Submitted.tsx` (class-managed header/main padding + hero h1 size).
- Candidate portal (M4): `modules/11-candidate-ui/src/components/CandidateShell.tsx` (new shell-level nav + mobile overflow menu through controlled state + outside-click + Escape). `CandidateActivity.tsx` (stats grid 3→1 col, heatmap horizontal-scroll wrapper, leaderboard `columns={viewport === 'mobile' ? 1 : 2}` through `useViewport()`). `MyCertificates.tsx` (1-line h1 size swap to `var(--aiq-h1-size)`).
- Admin graceful-degrade (M5): `ViewportLock.tsx` — removed in A6 (see above); admin pages are responsive instead.

### Help-system entries added by the port

- `candidate.attempt.navigator.toggle` (M2a — bottom-sheet navigator toggle).
- `candidate.attempt.kql.mobile_tip` (M2b — KQL caveat tip).
- `candidate.shell.nav.mobile_menu` (M4 — candidate-shell overflow menu).
- `admin.shell.mobile_continue_anyway` (M5 — admin interstitial override).

All four wired via `data-help-id` on the actual control and seeded into 0011 by `pnpm help:seed:regen`.

## Shared patterns and primitives

### Shared admin primitives (RW-32, 2026-10-10)

Five components in `@assessiq/ui-system`. Each is one file in `modules/17-ui-system/src/components/`, with a story and tests in `src/__tests__/rw32-primitives.test.tsx`.

**Why.** Admin pages each built their own status chips, headers, empty states, confirm modals and pager. One shared set keeps the look the same.

**Not included.** No data-table recipe exists in the kit (kit gap). The existing `Table` is unchanged. The admin `PageHeader` in `modules/10-admin-dashboard` is unchanged and has an eyebrow prop that the new one lacks. Migrating pages to the new components is a later task.

#### StatusPill
- Props: `status: string`, `labels?: Record<string,string>`, `tone?: ChipVariant` (default `default`), `label?: string`.
- Text is `label ?? labels?.[status] ?? status`. It renders a `Chip`.
- Use for any status or enum value. Pass the glossary label map from `lib/labels.ts`.
- Kit gap: no StatusPill recipe; built on Chip (`design-system/components.md` "Chips").

#### PageHeader
- Props: `title`, `count?: number`, `lede?: ReactNode`, `actions?: ReactNode`.
- Renders `<header>` with `h1.aiq-serif`, a `Chip` only when `count` is given (0 is shown), a muted lede, and actions on the right.
- Follows the kit "Page header recipe (universal)" without the mono eyebrow.

#### EmptyState
- Props: `title`, `body?`, `action?`, `icon?`.
- Centered, 64px vertical padding, serif `h2`, muted body (max 360px), action below. No illustrations. Follows kit "Empty state".

#### ConfirmDialog
- Props: `open`, `title`, `body`, `confirmLabel`, `cancelLabel='Cancel'`, `danger?`, `busy?`, `onConfirm`, `onCancel`, `mfaGuard?`.
- Built on `Modal`. Escape and backdrop call `onCancel`. `busy` disables both buttons.
- `danger` sets the confirm button to `--aiq-color-danger` (the kit has no danger button class). `mfaGuard` is a slot above the buttons and has no logic.
- Use for destructive or irreversible actions.

#### Pagination
- Props: `page` (1-based), `pageSize`, `total`, `onPageChange`.
- `<nav aria-label="Pagination">` with Previous, "Page X of Y", Next. Y = `max(1, ceil(total/pageSize))`. `page` is clamped into 1..Y.
- Kit gap: no Pagination recipe; uses the outline small button.

### RW-33 and RW-34 (S7): shared overlays, tables and one HTTP client

**What.**
1. **One HTTP client (RW-34).** `packages/http-client` (`@assessiq/http-client`) holds the only browser fetch layer. `createApiClient`, `createApiRequest` and `createApiRawRequest` keep the behaviour of the three old copies: `credentials: 'include'`, a `Content-Type` header only when a body exists, the `{ error }` envelope with the `HTTP_<status>` fallback, and 204 returns undefined. `apps/web/src/lib/api.ts`, `modules/10-admin-dashboard/src/api.ts` (`adminApi`, `getReadiness`) and `modules/11-candidate-ui/src/api.ts` (`call`) build on it. `AdminApiError` and `CandidateApiError` remain subclasses of `ApiCallError`.
2. **`useApi` hook (RW-34).** `modules/17-ui-system/src/hooks/useApi.ts` (also re-exported in `apps/web/src/lib/useApi.ts`) loads on mount and when the path changes. It aborts the in-flight request on unmount, on path change and on refetch, and never surfaces an AbortError. Data is cleared when the path or base changes; a plain refetch keeps it. This came from a Codex review (revise, addressed).
3. **Confirm dialogs (RW-33).** `window.confirm` is gone from modules 10 and 11. Destructive confirms use `ConfirmDialog` (danger, with a pending-action state). Hand-rolled fixed dialogs use `Modal`.
4. **Tables (RW-33).** Raw `<table>` in modules 10 and 11 is now `Table`, except the main attempts table in `generation-attempts.tsx`, which has row expansion (see Not included).
5. **Overlay lint (RW-33).** `tools/lint-no-fixed-overlay.ts` runs in WARN mode. It flags `position: 'fixed'` and raw `<table` in modules 10 and 11 unless the line or the line above has `lint-fixed-allow: <drawer|menu|toast|gate|panel|table>` with a reason.

**Why.** Three near-identical fetch clients drifted apart. Dialogs and tables were hand-rolled per page. One client and one dialog and table primitive remove the drift. The lint keeps it from returning.

**Considered and rejected.**
- Put the base client in `apps/web/src/lib` and import it from modules 10 and 11. Rejected: modules cannot import from `apps/web` (Rule B).
- Make `ConfirmDialog` hold MFA and reason inputs. Rejected: `ConfirmDialog` always renders its own buttons. The MFA steps in the archive and lifecycle dialogs use `Modal` with the same body.
- Add row expansion to `Table` now. Deferred: it is a behaviour change for the attempts table.

**Not included.**
- Playwright e2e and axe runs. They run in CI on push, not locally.
- A tooltip or popover conversion. Those are not in scope.
- `Table` renders `div`s with ARIA roles, not a real `<table>`. Converted tables get CSS-grid semantics and truncated cells. An axe check on the changed pages is open.
- The `generation-attempts.tsx` main table stays a raw `<table>` (allow comment `table`).

**Downstream impact.**
- Modules 10, 11, 17 and `apps/web` depend on `@assessiq/http-client` (workspace). `pnpm-lock.yaml` is updated.
- Visible: confirm dialogs now use the kit style; Escape and backdrop close these dialogs; a close button with `aria-label="Close modal"`; converted tables use the grid style.
- Lint: `lint:repo` does not run the new script yet (warn mode; run it with `npx tsx tools/lint-no-fixed-overlay.ts`).

### Admin list-page kit alignment + Table grid fix (2026-05-21)

A design review of `/admin/attempts` and `/admin/question-bank` against [`docs/10-branding-guideline.md`](./10-branding-guideline.md) found a load-bearing render bug in the shared `Table` primitive and several drift points from the kit. Shipped in commit `8558750`.

#### `Table` width contract — **numbers are pixels, strings pass through**

Source: [`modules/17-ui-system/src/components/Table.tsx`](../modules/17-ui-system/src/components/Table.tsx).

**Root cause that motivated the fix:** the previous `String(c.width)` stringified a numeric column hint (for example, `width: 80`) into a unitless CSS grid track length (`"80"`). Browsers reject that as invalid `grid-template-columns` and discard the declaration. The body grid then collapses to a single implicit column, and every header + cell stacks vertically. The bug silently affected every page using the primitive (attempts, question-bank, assessments, dashboard, assessment-detail).

**Contract now:**

| `ColumnDef.width` value | Output track |
| --- | --- |
| `number` (for example, `80`) | `"80px"` — bare numbers are pixel lengths |
| `string` (for example, `"1fr"`, `"minmax(120px, 1fr)"`, `"auto"`) | passed through verbatim |
| `undefined` / `null` / `""` / `0` | `"1fr"` (default; share remaining space equally) |

Callers should keep using `width: 80` for pixel hints — no migration needed. The fix is in the primitive.

#### Click-to-sort columns (2026-05-21)

The shared `Table` already supports sorting through the `sortable` (per-column), `sortBy`, `sortDir` and `onSort` props. But it only **emits** the sort event in `onSort`. It does not reorder `data` itself. Admin list pages full-fetch their rows (`pageSize 100`), so they sort **client-side** over the loaded page rather than re-fetching. The shipped pattern (commit `ef9d2d8`) is identical across pages:

- A module-level `sortRows<T>(rows, key, dir)` helper: keys ending in `_at` compare as dates, numeric columns numerically, everything else case-insensitive string. Keep it page-local (a duplicated ~15-line helper) and do not import it from a shared lib. A prior shared-lib extraction on this module caused a parallel-agent file race.
- `sortBy` defaults to `""` (no active column) so first paint matches the server's fetch order; `const sortedRows = useMemo(() => sortBy ? sortRows(items, sortBy, sortDir) : items, …)`.
- Wire `data={sortedRows}` `sortDir={sortDir}` `onSort={(k,d)=>{setSortBy(k);setSortDir(d);}}`, and pass `sortBy` via the spread `{...(sortBy ? { sortBy } : {})}` — passing `sortBy={undefined}` is a type error under `exactOptionalPropertyTypes`.
- Mark `sortable: true` on every data column **except** action/empty-label columns and columns whose value is a composite object that the generic comparator cannot order (for example, the "Invited" `{ total, … }` column of assessments).

Live on: Question Bank, Attempts, Assessments, Dashboard grading queue, and Assessment-detail invitations.

**Server-paginated tables sort server-side instead.** `certificates.tsx` and `generation-attempts.tsx` use native `<table>` markup with `limit`/`offset` + "Load more", so client-side sort would only reorder the loaded page. They send `sort`/`dir` query params to the API. The API maps the key through a fixed `ORDER BY` allowlist, because `ORDER BY` cannot be parameterized. On a header click, they **refetch from `offset 0`**. Clickable `<th>`s carry the same `▲`/`▼` affordance. See `docs/03-api-contract.md` for the per-endpoint sort allowlists. Rule of thumb: full-fetch list → client-side `sortRows`; paginated list → server-side allowlisted sort.

> Update 2026-10-10 (RW-33): `generation-attempts.tsx` now uses the shared `Table` (see next section). Its `onSort` sets `sortBy`/`sortDir` and the existing fetch effect refetches from offset 0. `certificates.tsx` is unchanged.

#### `Table` row expansion and ARIA table semantics (RW-33, 2026-10-10)

**What changed.** `Table` gained four optional props. Every existing caller is unchanged; none needed an edit.

| Prop | Type | Purpose |
| --- | --- | --- |
| `rowKey` | `(row: T) => string` | Stable row key. Defaults to the row index. Needed for `expandedId` to match a row. |
| `expandedId` | `string \| null` | Key of the row whose detail row is open. The caller owns this state and the toggle button. |
| `renderExpanded` | `(row: T) => ReactNode` | Content of a full-width detail row rendered directly under the expanded row, inside the same table. |
| `rowStyle` | `(row: T) => CSSProperties` | Extra per-row style (for example a sunken background for child rows, or `borderBottom: "none"` on an open row). The hover reset restores this background. |

**ARIA tree.** The root is `role="table"`. The header is `rowgroup > row > columnheader` (`aria-sort` when sorted). A header with an empty `label` renders as `role="cell"` because axe `empty-table-header` rejects an empty header. Sortable headers take keyboard focus and sort on Enter or Space. Body rows are `role="row"` with `role="cell"`. The empty message, the loading indicator and the expanded detail are each a `role="row"` with one `role="cell"` that carries `aria-colspan`. Put `aria-expanded` on the caller's toggle button. axe rejects `aria-expanded` on a row outside a `treegrid`. Test: `modules/17-ui-system/src/__tests__/table.test.tsx` (axe with an open detail row, toggle, loading row, empty row).

**Loading.** The `loading` row now shows the shared `Spinner` (`role="status"`) instead of the text "Loading…". This is the one visible change for existing callers.

**Generation attempts page.** The raw `<table>` and its `lint-fixed-allow: table` comment are gone. Batch grouping happens in the page: it flattens attempts into `AttemptRow` items (`single` / `group` / `child`). An open group adds its `child` rows to `data`. The summary row is a normal data row. The per-attempt `AttemptDetails` panel is `renderExpanded`. Visible differences against the old table: header cells use the `Table` mono header style. Columns have fixed grid widths. Rows have the `Table` hover background. Child rows use the standard cell padding (the old table used a smaller one). The spinner shows only while the first page loads, as before.

**Considered and rejected.** (1) `groupBy` / `renderGroupHeader` props: the group header of the page is an ordinary row with summed values. The page already owns the open-group state, so flattening in the caller is smaller. (2) An internal `onToggleExpand` callback: the own button of the caller already toggles the state, so `Table` would never call it. (3) `aria-expanded` on the row: invalid outside `treegrid`.

**Not included.** No `treegrid` keyboard navigation, no virtualization, no sticky header, no per-header style override. `certificates.tsx` keeps its own markup for now.

#### Shared admin formatters (`modules/10-admin-dashboard/src/lib/`)

Two small helpers consolidate display logic that was previously duplicated inline on each list page. New pages MUST use these instead of re-inventing per-page status switches or `toLocaleString()` calls.

| Helper | Source | Purpose |
| --- | --- | --- |
| `attemptStatusDisplay(status)` | [`lib/status.ts`](../modules/10-admin-dashboard/src/lib/status.ts) | Maps attempt enum (`submitted`/`auto_submitted`/`pending_admin_grading`/`graded`/`released`) → `{ label, ChipVariant }`. Operators see "Pending grading", not `PENDING_ADMIN_GRADING`. |
| `packStatusDisplay(status)` | [`lib/status.ts`](../modules/10-admin-dashboard/src/lib/status.ts) | Same shape for pack enum (`draft`/`published`/`archived`). |
| `formatTimestamp(iso)` | [`lib/format.ts`](../modules/10-admin-dashboard/src/lib/format.ts) | `"21 May 2026 · 23:17"` — mid-dot separator, en-GB month, 24h (`hourCycle: "h23"`) so display is locale-stable across operators. Per branding §2.4. |
| `formatDate(iso)` | [`lib/format.ts`](../modules/10-admin-dashboard/src/lib/format.ts) | `"21 May 2026"` — date-only variant for created-at columns. |

Status rendering composes with the `Chip` primitive: `const s = attemptStatusDisplay(row.status); return <Chip variant={s.variant}>{s.label}</Chip>;`.

**Question Bank list — Status column (added 2026-05-25).** The `/admin/question-bank` pack list previously had **no status column**, so an admin could not tell draft / published / archived packs apart in the list (only the per-pack detail page showed a status pill). A sortable **Status** column now sits between Domain and Questions, rendered with the canonical `packStatusDisplay(row.status)` → `<Chip variant={s.variant}>` pattern above, not a hand-rolled colour map. This pairs with the archive fix of the same session (`docs/RCA_LOG.md` 2026-05-24): archiving a draft pack now works *and* is visible in the list. The detail page still uses its own inline `packStatusColor` span (pre-existing drift). This is harmless, but a future consolidation could route it through `packStatusDisplay` too.

**Pack detail — "Activate all" → "Activate drafts", conditional (2026-05-25).** Publishing a pack now auto-activates its `draft` questions (see `docs/03-api-contract.md` publish row), so the per-level activate button is no longer the primary path. The button is now named **"Activate drafts"**. It renders only when that level has `draft` questions (`levelQs.some(q => q.status === "draft")`). Before, it showed on every published pack, so it looked like a dead button on a fully-active pack. The reported confusion: "Published" + "Activate all" looked contradictory. The two axes are still distinct: pack status (draft/published/archived) and question status (ai_draft/draft/active/archived). But the common case (publish → everything usable) no longer needs a second click.

**Inline button help — Wave 1 (2026-05-25).** Action buttons now carry `<HelpTip helpId>`. It shows a hover tooltip from `short_text` and a (?) icon that opens the help drawer with `long_md`. Wave 1 covers the two Question Bank pages: the **list** (`admin.question_bank.list.new_pack`, `…list.add_to_workspace`) and **pack detail** (`admin.question_bank.pack.{generate,publish,archive,activate_drafts}`). Content lives in `content/en/admin.yml`. It ships to prod through forward migration `0093_seed_question_bank_button_help.sql`. The team regenerated the `0011` canonical seed for source-sync. New rows reach prod through the forward migration, the same pattern as 0089/0092. **Reminder (the `HelpProvider` prefix rule):** the `helpId` of a button MUST sit under the `helpPage` prefix of its page. Otherwise `listHelpForPage` (`key LIKE '<page>.%'`) does not fetch it and `HelpTip` silently renders nothing. The list page is `admin.question_bank.list`. Pack detail is `admin.question_bank.pack`. The remaining admin pages are follow-up waves: Assessments, Attempts, Grading, Reports, Certificates, Users, Platform, Billing and Dashboard. For Assessments, the create-form keys are under `admin.assessments.create.*` while the page prefix is `admin.assessments.list`. Reconcile this mismatch.

**Inline button help — Wave 2 (2026-05-25).** This wave covered the assessment-lifecycle + certificates action buttons: assessments → **Create assessment**; assessment-detail → **Publish**, **+ Invite candidates**; certificates → **Revoke**, **Reissue**. Key insight applied: `data-help-id` attributes are **inert markers**, and only `<HelpTip>` renders visible help. Most of these buttons already had content keys (`admin.assessments.publish`, `.invite.bulk`, `admin.certificates.revoke`, `.reissue`). These keys did not load, because the `helpPage` of the page was a deeper prefix than the key. So Wave 2 **broadened the `helpPage` prefix** (`admin.assessments.detail`/`.list` → `admin.assessments`; `admin.certificates.list` → `admin.certificates`) so the existing content is fetched, then wrapped the buttons in `HelpTip`. Only ONE new key was authored (`admin.assessments.create.submit`, migration `0094`). **Lesson for future waves: broaden `helpPage` to reuse existing content, and do not author duplicate keys. Remember that `data-help-id` alone shows nothing.** The remaining pages (Attempts, Grading, Reports, Users, Platform, Billing, Dashboard, Activity) are later waves. Several already have `data-help-id` content that needs only a `helpPage` broaden + `HelpTip` wrap.

**Question Bank list — three follow-ups (2026-05-25).** (1) **Row `⋯` menu rendered via portal.** `RowOverflowMenu` previously used `position:absolute`, and the `overflow:hidden` (rounded corners) of the packs table clipped it. The Archive menu silently never appeared. It now mirrors `platform.tsx`'s `ManageMenu`: `createPortal` to `document.body`, anchored via `getBoundingClientRect` with `position:fixed`, `zIndex:1000`, closing on outside-click / Esc / scroll / resize. **Recurrence class:** any row-level popover inside a table with `overflow:hidden` MUST portal out — see the same note on ManageMenu (§ Super-admin Platform page). (2) **Levels column** between Status and Questions, sourced from a new `level_count` on `GET /admin/packs` (0 rendered muted — flags a pack with no levels yet). (3) **Default filter is now Published**, not All. A one-time, ref-guarded mount effect sets `?status=published` when no `status` param is present, so the list opens on live content. The page still respects a click on **All** (which clears the param) and never sets the filter back.

#### Question & answer content renderers (never raw JSON)

Any admin surface that displays a frozen question or a candidate's submitted answer MUST render a typed, human-readable layout. **Never** use `JSON.stringify` to put the stored payload into a `<pre>`/text node. Two renderers own this:

| Renderer | Source | Renders |
| --- | --- | --- |
| `QuestionContentView` | [`components/QuestionContentView.tsx`](../modules/10-admin-dashboard/src/components/QuestionContentView.tsx) | A frozen question's `content`, switched by type (`mcq`/`subjective`/`kql`/`scenario`/`log_analysis`). Strips JSON-escape + markdown noise via `cleanText()`; for MCQ highlights the correct option (✓) and shows the rationale. Genuinely malformed/unknown content degrades to a styled JSON fallback (debug aid, not the normal path). |
| `AttemptAnswerView` | [`pages/attempt-detail.tsx`](../modules/10-admin-dashboard/src/pages/attempt-detail.tsx) | A candidate's submitted answer, switched by question type (mcq → selected letter + option text + ✓/✗ vs the key; subjective → response prose; kql → query in a mono block; log_analysis → findings list + explanation; scenario → per-step responses). Empty answers show "No answer submitted."; unrecognised shapes show a readable message, never braces. |

**History (2026-05-22):** until this date the attempt-detail page used a local `QuestionContent`/`AnswerContent` pair that did `typeof x === "string" ? x : JSON.stringify(x, null, 2)`. Question `content` and every answer shape are objects, so the JSON branch always fired. Every question and answer rendered as a raw `{ "correct": 0, "options": [...] }` blob (the reported bug). The page now delegates the question to the shared `QuestionContentView` and the answer to `AttemptAnswerView`. The candidate take-flow was never affected (it renders field-by-field) and answer-key fields are stripped server-side before reaching candidates (`sanitizeContentForCandidate`, see `docs/RCA_LOG.md` 2026-05-16). The correct-option/rationale display in `QuestionContentView` is therefore **admin-only and intentional** — do not reuse it on a candidate-facing surface without re-gating those fields.

#### Row-overflow menu pattern (currently page-local)

Question-Bank's destructive `Archive` action moved into a `⋯` row-level menu (`useRef` + click-outside listener + `Esc` to close). Destructive verbs then do not crowd a list row. Implementation lives inline at [`modules/10-admin-dashboard/src/pages/question-bank.tsx`](../modules/10-admin-dashboard/src/pages/question-bank.tsx) as `RowOverflowMenu`. **Promote it to `@assessiq/ui-system` when a second admin list needs it.** This is likely soon, because assessments, users and certificates all have row-level destructive actions today.

#### Admin list-page chrome contract

For every admin list page going forward, the chrome composes like this (matches the kit's library pattern in [`screens/library.jsx`](../modules/17-ui-system/AssessIQ_UI_Template/screens/library.jsx)):

```text
┌─────────────────────────────────────────────────────────┐
│  [count chip]                                           │
│  Page title.                            [primary CTA]   │
│  Lede paragraph, sans 14px muted.                       │
├─────────────────────────────────────────────────────────┤
│ [tab] [tab] [tab]   [search…]              N RESULTS   │  ← .aiq-admin-filter-strip
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐    │
│  │  data-density="compact"                          │   │  ← .aiq-card
│  │  ┌ .aiq-admin-table-scroll ──────────────────┐  │   │
│  │  │ HEADER  HEADER  HEADER  HEADER  HEADER    │  │   │
│  │  │ cell    cell    cell    cell    [⋯][View →]│  │   │
│  │  └────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

Specifics:

- **Filter tabs** are ghost buttons (`aiq-btn aiq-btn-ghost aiq-btn-sm`), inactive `transparent + fg-secondary`, active `accent-soft bg + accent fg + weight 500`. Never use `aiq-btn-primary` blue fills on tabs — that is reserved for the single primary action per surface.
- **Filter strip** carries the `.aiq-admin-filter-strip` class so the parallel mobile-port (A2) reflow rules can target it. New list pages MUST include this class on the filter row.
- **Results counter** is right-aligned, mono uppercase tracked, fg-muted: `{N} {result|results}`. Hidden during loading / error.
- **Table card** wraps in `<div className="aiq-card" data-density="compact">` so row padding tightens per branding §4. The inner `<div className="aiq-admin-table-scroll">` is from the mobile-port A2 wave and must stay (mobile horizontal-scroll behavior).
- **Empty state** is editorial — serif H3 + sans muted lede + max-width 360px, filter-aware copy ("No attempts in this state." vs "No attempts yet."). It replaces the inline "No data." fallback of the Table primitive when the items array is empty and the page is not loading.
- **Row action** is ghost `View →` (per kit §8.1 tertiary affordance). Outline `Open` is the previous pattern and should not be reintroduced.

#### Migrating other admin list pages

`assessments.tsx`, `dashboard.tsx`, `assessment-detail.tsx`, `users.tsx`, `certificates.tsx`, `generation-attempts.tsx` still use the older pre-2026-05-21 chrome (primary/outline filter tabs, inline `toLocaleString()` timestamps, inline status pill spans, `Open` outline buttons). They render correctly now that the Table width bug is fixed, but they do not yet match the chrome contract above. Treat the migration as ad-hoc polish. Change a page when you already edit it for another reason. The team plans no big sweep PR.

### Labels, dates and shared copy (S3, 2026-10-09)

**What.** Commit `505031a` (hardening S3, rows RW-12 to RW-15). Four shared pieces now give pages their visible words.

1. **Enum labels.** `modules/10-admin-dashboard/src/lib/labels.ts` holds every label map: attempt, evaluation, pack, assessment and organisation status; question type; plan tier; certificate tier; audience; role; job status; generation status; cognitive level; grant scope; difficulty. `lib/status.ts` is now a one-line re-export of `labels.ts` (Rule A: no deletes). `difficultyLabel` returns an unknown value unchanged, so authored level names such as "SOC Analyst L1" stay as written.
2. **Dates.** `modules/17-ui-system/src/format.ts` exports `formatDate` ("Apr 29, 2026"), `formatDateTime` ("Apr 29, 2026 · 14:32"), `formatRelative` ("4s ago", "2 min ago", "3 h ago", "Yesterday", "5 days ago", then a date after 6 days), `formatMonthYear` and `formatDayLine`. They come from `@assessiq/ui-system`. The old en-GB helpers in `modules/10-admin-dashboard/src/lib/format.ts` re-export them; `formatTimestamp` is an alias of `formatDateTime`. About 45 page-level `toLocale*` and `Intl` date calls in modules 10, 11 and `apps/web` are replaced. Two number counters keep `toLocaleString` with the comment `// lint-ui-labels: number`.
3. **After-submit sentence.** `AFTER_SUBMIT_TEXT` in `modules/11-candidate-ui/src/copy.ts`: "Your answers are saved. You will see your result on this page or by email once it is final." The code uses it in `take/PreTest.tsx` (consent, after "Written answers are graded with AI assistance and checked by your organisation."), `take/Submitted.tsx`, `CandidateHelp.tsx` and the help key `candidate.submit.confirm`. This extends R4.
4. **Lint.** `tools/lint-ui-labels.ts` has four rules: `raw-enum`, `id-slice`, `http-status`, `date`. It runs in WARN mode (exit 0). Use `--strict` to fail on a hit and `--self-test` to test the rules. Root scripts: `lint:ui-labels`, `lint:ui-labels:self-test`, and `lint:repo`. `lint:repo` runs ui-labels, rls, mv-tenant-filter, doc-anchors, vitest-coverage, skill-mount, public-collisions, ui-api-contract, ambient-ai, edge-routing and deploy-procedure. It leaves out cross-module-deps (more than 4 minutes, and it fails on `.claude/worktrees`).

**Rule.** Pages never render raw enums, ID slices, SHAs, model names or HTTP codes. Pages never call `toLocale*` or `Intl` for dates. Add a label to `labels.ts` and use a date helper instead. Visible words follow `docs/10-branding-guideline.md` section 2.5. The text "HTTP <n>" in errors is now "Something went wrong. Please try again." (`take/Attempt.tsx` twice, `TokenLanding.tsx`).

**Why.** The review found 8 date formats, raw enum values and UUID slices in JSX, and three different after-submit texts. One source for each removes the drift.

**Considered and rejected.**
- Put the date helpers in `apps/web/src/lib` (the task row said so). Modules 10 and 11 cannot import from `apps/web` (Rule B), so the helpers live in `ui-system`.
- Put `AFTER_SUBMIT_TEXT` in `apps/web`. Same import reason; it lives in candidate-ui.
- Delete `status.ts` and the old `format.ts`. Rule A forbids it; both re-export.
- Start the lint in strict mode. Six hits remain, so it starts in WARN mode.

**Not included.**
- Six lint warnings remain: `id-slice` at `certificates.tsx:725`, `BillingDrawer.tsx:396`, `tenant-settings.tsx:1215`, `users.tsx:1497`, `users.tsx:1594` (no name exists to show); `raw-enum` at `11-candidate-ui` `QuestionNavigator.tsx:121` (aria-label).
- The lint is not strict in CI.
- The PDF template in `modules/18-certification` keeps its date format.
- Nav section headers "Work" and "Content" are placeholders until RW-16 regroups the nav.
- API error messages from the backend still use the old words.

**Downstream impact.** The date format changes from "21 May 2026" to "May 21, 2026" on all pages. Difficulty chips (FU-C13) show Beginner, Intermediate and Advanced. A new page must use `labels.ts` and the date helpers, or the lint warns. Help text follows the same glossary (`docs/07-help-system.md`).

### Brand consumer copies, static file routing and theme fixture key (2026-10-02)

- **Consumer copies.** The kit manifest and preview image carry the old name "AccessIQ" and a wrong domain. The kit stays untouched (project rule). The app uses its own copies under `apps/web/public/brand/`: `favicon/app.webmanifest`, `social/app-og.png` and `social/app-og.svg`. `apps/web/index.html` links them. The PNG is rendered from the SVG with the installed `@resvg/resvg-js`.
- **Force-added files.** `apps/web/public/brand/` is gitignored because the prebuild script mirrors the kit there. The three files are added with `git add -f`, like `try-og.png`. Their names differ from the kit names, so the mirror script (`copy-brand-assets`) cannot overwrite them. The kit copies (`site.webmanifest`, `og-image.png`) are still served; nothing links them.
- **Routing rule.** The shared Caddy `@app` matcher sends only `/admin*`, `/candidate*`, `/take*`, `/try*`, `/assets/*` and `/brand/*` to the app. Put a new static file of the app under `/brand/` or `/assets/`. A file in the `public/` root goes to the marketing site and returns 404.
- **Theme fixture.** The key `wipro-soc` in `modules/17-ui-system/src/fixtures/tenants.ts` is now `default` (`apps/web/src/App.tsx` and two stories follow). The fixture is a static theme for all tenants until live tenant theming lands.
- **Not included.** No lint yet compares `public/` names with the Caddy matcher (plan item RV71).

### Completion modal on new certificates (FR13, 2026-10-03)

**What.** `CompletionModal` (module 11) is rebuilt on the kit `Modal` (commit `6638494`). `NewCertificateModal` on `apps/web/src/pages/take/Submitted.tsx` shows when the released result has a certificate. It shows once for each browser and each `credential_id`. The seen list is in `localStorage` key `aiq:certs-seen` (try/catch; the page works without it). `MyCertificates` has a "View" button that opens the same modal. The prop `course_title` is now `assessment_title`.

**Why.** The old component was unused (review FR13, row FU-C12) and used its own overlay instead of the kit Modal.

**Considered and rejected.** A new certificate payload with `tier` and `pdf_url` (needs a server change). Showing the modal at each visit (annoying).

**Not included.** Server changes: data comes from the existing `GET /api/certificates`.

### 404 page main landmark (N25, 2026-10-03)

The `NotFound` page root is now `<main>` (commit `00a951e`). This fixes the axe rules `landmark-one-main` and `region`. The e2e a11y spec covers it. No visual change.

### Page splits for file size (RW-53, S10, 2026-10-16)

*Type: reference.* These moves are mechanical: no behaviour changed. Barrels keep the old import paths. `tools/lint-file-size.ts` (script `lint:file-size`) warns about files over 800 lines. It does not fail the build. 27 files were over the limit on this date. RW-99 (S11, 2026-10-16) then brought the four pages below under 800 lines.

| File | Lines now | Where code moved |
| --- | --- | --- |
| `modules/10-admin-dashboard/src/pages/pack-detail.tsx` | 751 (was 1300) | `pack-detail/shared.tsx` holds types, `packStatusColor`, `questionPrompt` and `GenerationAttemptLine`. RW-99 added `pack-detail/LevelPanel.tsx` |
| `modules/10-admin-dashboard/src/pages/assessment-detail.tsx` | 697 (was 1111) | `assessment-detail/shared.tsx` (types and helpers) and `assessment-detail/invitation-columns.tsx` (invitation table columns). RW-99 added `assessment-detail/InvitationsSection.tsx` and `ReleaseResendBlock.tsx` |
| `modules/10-admin-dashboard/src/pages/assessments.tsx` | 657 (was 826) | `assessments/BlueprintBuilder.tsx`, `FromSetPicker.tsx`, `PreviewAdequacy.tsx`, `shared.tsx`. RW-99 added `assessments/columns.tsx` (`buildAssessmentColumns`) |
| `apps/web/src/pages/take/Attempt.tsx` | 785 (was 941) | `take/attempt-parts/AnswerArea.tsx` (the answer dispatcher) and `attempt-parts/shared.tsx`. RW-99 added `attempt-parts/AttemptTopBar.tsx`, `FinishSectionModal.tsx`, `SubmitConfirmModal.tsx` and `NavigatorBody.tsx` |

- **Backend splits in the same change.** Module 05 `service.ts` went from 2423 to 43 lines and is now a barrel over `src/service/`. Module 04 `clone.ts` went from 1299 to 38 lines, a barrel over `src/clone/`. See the SKILL.md files of both modules.
- **Rejected.** A rewrite of the pages: it needs a behaviour review. Raising the limit: the warning is the point.
- **RW-99 (S11, 2026-10-16).** The same method finished the four pages: pure moves of JSX blocks and helpers into sibling files, props passed explicitly. No behaviour change. Help ids (`data-help-id`) and test ids are unchanged, so the help system and the tests need no edit.
- **Why RW-99 stopped at these sizes.** Each page is now under 800 lines. A further split would cut state that the blocks share and would need a behaviour review.
- **Not included.** Any other file over 800 lines. The warning stays for them.

## Admin pages

### Super-admin Platform page (2026-05-17)

#### `/admin/platform` — company provisioning

Route: `apps/web/src/App.tsx` → `<Route path="/admin/platform" element={<RequireSession role="super_admin"><AdminPlatform /></RequireSession>} />`

Component: `modules/10-admin-dashboard/src/pages/platform.tsx` → `export function AdminPlatform()`

**`RequireSession role="super_admin"` exact-match semantics:** when `role="super_admin"` is passed, only a session with `session.user.role === "super_admin"` is admitted. A plain `admin` is redirected to `/admin/login`. This is asymmetric with all other role gates (`admin`, `reviewer`), where `super_admin` satisfies the gate. The reason: `super_admin` is a platform-level role above the tenant hierarchy, not a peer of admin. The asymmetry is documented with a code comment in `apps/web/src/lib/RequireSession.tsx`. The backend enforces the real gate. This is FE defense-in-depth.

**Nav entry:** `AdminShell` renders a "Platform" nav entry with `superAdminOnly: true`. Tenant admins (`role === "admin"`) do not see this entry.

**Admin nav (S4, 2026-10-09):** Platform section now separate from Account. Super-admin items (Grading queue, Platform, Help content) render under Platform. Order: Work → Content → Admin → Account → Platform.

**Page pattern:** it mirrors `users.tsx` exactly. The parts are `AdminShell breadcrumbs={["Platform"]}`, serif h1 `Companies.`, count Chip, `listTenantsApi()` on mount, and `Spinner` / error Chip / empty-state card / read-only zebra table (columns: slug mono, name, status Chip, created en-GB date).

**Create-company modal:** fixed-position Card with backdrop, required fields (name, slug, admin email), collapsible Advanced section (domain, admin display name). Slug auto-derived from name; client-side `[a-z0-9-]+` validation. MFA step-up sub-state on `401 AUTHN_FAILED` + message `/fresh totp/i` — preserves all entered form values, calls `verifyTotpApi`, refreshes session via `fetchAdminWhoami(true)`, auto-retries `createCompanyApi`. No secrets stored beyond the transient 6-digit TOTP code (cleared on success/close).

**Tenant lifecycle (Manage menu + confirmation modal):** each tenant row carries a `Manage ▾` dropdown (`ManageMenu`, rendered through `createPortal` to `document.body` so it escapes the `overflow:hidden` of the table; it closes on outside-click / scroll / resize). It offers Open billing, Manage users, and **status-aware** lifecycle actions: Suspend + Archive (when `active`), Resume + Archive (when `suspended`), Unarchive (when `archived`), and a non-actionable "Provisioning in progress" note (when `provisioning`). Selecting a lifecycle action opens `LifecycleConfirmModal` with action-specific copy, an optional **Reason** textarea (≤500 chars, recorded in the audit log) and a confirm button; on success, a toast shows the idempotent-no-op state or the `sessionsRevoked` count. The server gates the four lifecycle endpoints with **fresh MFA** (TOTP within 15 min — `superAdminFreshMfa` on `apps/api/src/routes/admin-super.ts`). So as of **2026-05-24** the modal carries the same **MFA step-up sub-state** as Create-company. A stale-MFA `401` + `/fresh totp/i` switches the modal in place to `MfaStepUp` (lifecycle-specific `prompt` + a `Verify & {action}` `confirmLabel`). Then on `onVerified` the modal retries the original action automatically and keeps the typed reason. The page-level `handleLifecycleConfirm` re-throws **only** that fresh-MFA 401 (narrow `status===401 && /fresh totp/i` match), so the modal owns recovery. Every other error (including `INVALID_LIFECYCLE_TRANSITION`) shows as a page-level Chip and closes the modal. Create-company, Edit-admin and the lifecycle modal share `MfaStepUp`. Its `confirmLabel` defaults to `"Verify & create"`, so the first two are unchanged.

**Help page key:** `admin.platform` (wired via `AdminShell helpPage="admin.platform"`). Field-level keys: `admin.platform.slug`, `admin.platform.admin_email`, `admin.platform.domain`, `admin.platform.admin_name`, `admin.platform.mfa_code`.

#### Platform page: Curriculum frameworks (RW-57 part 2, S10, 2026-10-16)

*Type: reference.*

**What.** `modules/10-admin-dashboard/src/pages/platform/PlatformFrameworksSection.tsx` is a section of the Platform page. `platform.tsx` renders it only when the session role is `super_admin`. A header chip shows how many curricula are available.

- **Table.** Columns: Curriculum, Board, Release, Entries, Loaded. "Loaded" shows "Not loaded" or the loaded version.
- **Actions.** A "Load" button for a curriculum that is not loaded, a "Reload" button for one that is. Both open a confirm dialog first. After success a toast shows the counts: added, updated, unchanged.
- **Helpers.** `modules/10-admin-dashboard/src/api/frameworks.ts` (`listFrameworkSeedsApi`, `loadFrameworkSeedApi`). Routes: [03-api-contract.md](03-api-contract.md) § "Framework seeds".
- **Help.** Key `admin.platform.frameworks` (migration 0173).

**Content shipped with it.** The files `cbse.json`, `icse.json` and `ib.json` in `modules/04-question-bank/src/frameworks/` hold 335, 340 and 89 nodes. CBSE covers grades 6 to 12 with the core NCERT subjects. ICSE and ISC are by stage. IB has PYP, MYP (criteria A to D for each group) and DP. Chapter titles were written from memory. Subjects that are not verified carry the description "partial: verify".

**Owner step.** Check one board against the official syllabus before real use.

**Why.** Part 1 added the load routes but a super admin had no screen and no board content.

**Not included.** Edit of a node in the UI. Removal of a loaded curriculum. A diff view for a reload.

### Admin dashboard UI changes (2026-05-24)

Three admin-facing UI changes shipped as part of the domain-slug normalization + Question Bank import work.

#### Question Bank — Domain field changed from free-text to dropdown

**What:** The "Domain" field on the New Pack form (`modules/10-admin-dashboard/src/pages/question-bank.tsx`, New Pack modal) is now a `<Select>` filled from `GET /api/admin/domains` (the canonical domain list of the tenant). Before, it was a free-text `<Input>`. That allowed mixed-case entries such as `'SOC'`, which silently failed entitlement resolution at publish time. The license resolver matches `question_packs.domain` by exact lowercase slug.

**Why:** Free-text entry was the root cause of the casing-drift bug fixed by migration `0090_normalize_domain_slugs.sql` (see `docs/02-data-model.md`). Sourcing from the `domains` table guarantees the stored value is always a canonical lowercase slug. The dropdown renders the human-readable `label` but submits the lowercase `slug`.

**Not included:** retroactive UI changes to the Pack Edit form (PATCH). The current admin surface does not let you edit the domain field after creation. If a later change adds this, it must also use the dropdown.

**Downstream:** `createPack`/`updatePack` service methods also lowercase `domain` at the write path as defense-in-depth. The UI change removes the primary entry point for drift, not the only guard.


#### Question Bank — "Licensed sets" section (2026-05-24)

**What:** A new read-only **Licensed sets** section in the Question Bank page (`modules/10-admin-dashboard/src/pages/question-bank.tsx`) lists the PLATFORM-library question sets that the calling tenant has a license for. The data comes from `GET /api/billing/available-sets`.

**Layout:** The section appears below the tenant's own pack list and is hidden entirely when `sets` is empty (no licensed sets). Each row shows:

| Column | Content |
|---|---|
| Name | `source.name` |
| Domain | lowercase slug chip |
| Questions | `question_count` |
| Status badge | "In your workspace" (`success` Chip, when `cloned: true` and not `update_available`) — "Update available" (`warning` Chip, when `cloned: true` and `update_available: true`) — no badge when not yet cloned |
| Action | "Add to workspace" button (`ghost` variant, visible only when `cloned: false`) — calls `POST /api/admin/sets/:source_pack_id/import` and refreshes the section on success |

**"In your workspace" / "Update available" logic:** the `cloned` and `update_available` flags from the `GET /api/billing/available-sets` response drive it. "Update available" means that a newer `source_version` exists than the cloned one. The update path (re-clone) is deferred, so the badge is informational only for now, with no button.

**"Add to workspace" button:** calls `POST /api/admin/sets/:source_pack_id/import` (see `docs/03-api-contract.md` § `POST /api/admin/sets/:sourcePackId/import`). On `201` success, the button switches to the "In your workspace" badge. The own pack list of the tenant refreshes, so the new clone appears immediately. On `403 NOT_LICENSED`, an inline error Chip is shown ("Not licensed"); on other errors, a toast.

**Not included:** a re-clone/update flow for `update_available: true` sets (deferred); pagination of the licensed sets list (the platform library should stay small for Phase 1); candidate-facing visibility of licensed sets.


#### Assessments — Blueprint mode button hidden for non-super-admins (2026-05-24)

**What:** On the New Assessment form (`modules/10-admin-dashboard/src/pages/assessments.tsx`), the "Blueprint" mode toggle button is rendered only when `session.user.role === 'super_admin'`. Tenant admins (`role === 'admin'`) do not see the button; the form defaults to the standard mode silently.

**Why:** Blueprint mode sets `settings.blueprint` on the assessment, which is a `super_admin`-only capability. Both `POST /admin/assessments` and `PATCH /admin/assessments/:id` enforce it server-side (see `docs/03-api-contract.md` § Blueprint authoring restriction). The FE hide is defense-in-depth. The backend 403 is the authoritative gate.

**Implementation:** The session role is already available via `useSession()` (or the equivalent `AdminWhoami` hook) used throughout the admin dashboard. The conditional is a single `{isSuperAdmin && <BlueprintModeButton … />}` guard, consistent with the existing `{isSuperAdmin && …}` pattern used on the Platform nav entry and the AI-generate-mode select.

**Not included:** any change to the assessment edit form for existing draft assessments. If a super-admin created a blueprint assessment and a tenant admin opens it in edit mode, the form does not render `settings.blueprint` (read-only exclusion). The tenant admin cannot clear or modify it.

#### Question import page (RW-58, S10, 2026-10-16)

*Type: reference.*

**What.** Page `/admin/question-import` (`modules/10-admin-dashboard/src/pages/question-import.tsx`). Only a super admin can open it (`RequireSession role="super_admin"` in `apps/web/src/App.tsx`). The question bank page has an "Import questions" button that links to it. Helpers: `src/api/question-imports.ts`. Routes: [03-api-contract.md](03-api-contract.md) § "Question import".

**Flow, in three steps on one page.**
1. "Get a template." The admin chooses a question type and a format (CSV or XLSX) and downloads the file.
2. "Upload your file." The admin chooses a subject (domain), an optional question set name and the file (CSV or XLSX, up to 4 MB), then selects "Check file". Nothing is saved to a question set yet.
3. "Check the report." Chips show the counts: rows, ready, need a fix, duplicate, skipped. A table lists each row with its result and errors. The admin can fix the values of a row or skip it. "Commit (skip errors)" and "Discard" each open a confirm dialog. After a commit, the page links to the new draft pack at `/admin/question-bank/<packId>`.

**Help.** Keys `admin.question_import.page`, `.template`, `.upload`, `.report` and `.commit` (migration 0175).

**Why.** The platform owner had no way to load many questions. A staged report lets the admin fix a row before any question exists.

**Upload as FormData (RW-97, S11, 2026-10-16).** Step 2 now sends `FormData` to the same route. The text fields (`format`, `domain`, `pack_name`, optional `file_name`) go first and the file goes last, under the name `file`. The server reads the fields in order, so the order is a rule. A file over 4 MB shows the `413 FILE_TOO_LARGE` message. The old JSON base64 body still works but the page no longer uses it. Contract: [03-api-contract.md](03-api-contract.md) § "Question import".

**Draft rubrics step (RW-97, S11).** After a commit, the page lists the imported `subjective` and `scenario` questions that have no rubric. It reads them with `GET /api/admin/questions?pack_id=<packId>&pageSize=500` (500 is the server maximum). The button "Draft rubrics" then calls `generate-rubric` and `save-rubric` for each question, one at a time. Each call is one admin click and one AI call under the single-flight lease. If the AI is busy, the server answers `409 AIG_GRADING_IN_PROGRESS` and the page shows "The AI is busy. Try again in a moment." Help key: `admin.question_import.draft_rubrics` (migration 0178). Rubric text is a draft: the admin can edit it in the pack editor.

**Rejected (RW-97).** Drafting rubrics inside the commit route: it would put AI calls in a request that no admin clicked for that purpose. This would break the no-ambient-AI rule. A parallel run of the drafts: it breaks single-flight.

**Not included.** Drag and drop. A rubric step for question types other than `subjective` and `scenario` (the other types are scored by rule). More than 500 imported questions in one pack on this step (the list stops at 500).

### Add-candidate drawer + invite-picker filter (2026-05-26)

**What:** The admin Users page (`modules/10-admin-dashboard/src/pages/users.tsx`) `InviteForm` drawer is now role-aware. The role picker gained a third option, **candidate**. When you select `candidate`, the drawer shows **Name** (required) + **Designation** (optional, for example, "SOC Analyst L1") fields. It changes the title to "Add candidate" and the subtitle to "Candidates are added directly — no email is sent now…". It posts to `POST /admin/users` (not `/admin/invitations`). It confirms with a "Candidate added." chip. Admin/reviewer behaviour is byte-for-byte unchanged (still invite-email flow). On `assessment-detail.tsx` the invite picker now filters to `role==='candidate' && status==='active'` (was: all users), so only assignable candidates appear.

**Why:** There was no UI to create a candidate (the invite form only offered admin/reviewer, and `inviteUser` hard-blocks candidates at `CANDIDATE_INVITATION_PHASE_1`). Candidates authenticate only via per-assessment magic links, so they need no invite/accept email — direct active creation is the simple, correct model. The picker previously listed admins/reviewers too, which the server silently rejected — confusing UX.

**Implementation:** A form-local `type InviteRole = "admin" | "reviewer" | "candidate"` (the file-level `UserRole` is used by filter chips/manage menus and was left untouched). Error display switched from the email `Field`'s `error` prop to a shared `role="alert"` danger-coloured div below the fields (covers both email + name validation). Help: `data-help-id="admin.users.candidate.fields"` → content in `modules/16-help-system/content/en/admin.yml` + seed migration `0099_seed_candidate_fields_help.sql`.

**Not included:** No bulk CSV add (still the `/admin/users/import` 501 stub). No reverse "assign assessment from the user row" flow — assignment stays on the assessment-detail page (single source of truth). No new component in the kit — composed from existing `Field`/`Button`/`Card`/`Chip` atoms. [Update 2026-10-03: bulk CSV import is live since 2026-10-01.]

### Attempt detail pages

#### Attempt-detail — grading summary + Accept-all (2026-05-28, commit `defb9f9`)

The attempt-detail page now shows grading progress at the top, between the header and the per-question cards. It shows it whenever there is at least one fresh proposal OR at least one accepted gradings row. The panel is tied directly to the backend completion-gate (see `docs/05-ai-pipeline.md` § Accept-all + completion-gate, and `docs/03-api-contract.md` `/admin/attempts/:id/accept`).

| Element | Purpose |
| --- | --- |
| `Graded` line | `{acceptedDistinct} of {N} ({M} AI-gradeable)` — N = frozen question count; M = subset whose `type ∈ {subjective, scenario, log_analysis}`. acceptedDistinct counts non-overridden rows. Drives the admin's mental model of "why is not this attempt finishing." |
| `Score` line | Sum of `score_earned / score_max` across non-overridden gradings. Hidden when no gradings exist yet. |
| Per-question status chips | One chip per frozen question, labelled `Q{idx} graded` / `Q{idx} needs review` / `Q{idx} ready` / `Q{idx} pending`. `needs review` is set when a fresh proposal has `isAiFailure()` true (model=`"none"` / `prompt_version_sha="error:no-sha"` / `band.error_class` starting `AIG_` — incl. new `AIG_STAGE1_DEGRADED`). Tokens use existing `aiq-color-{success,warning,danger,fg-muted}` pairs. |

**Header buttons.** `Grade all` is unchanged. A new `Accept all (N)` button renders next to it whenever there is at least one proposal `p` with `!isAiFailure(p)`. `N` shows the count that will actually post. The button posts every acceptable proposal in a single `{proposals: […]}` body to `/admin/attempts/:id/accept`. AI-failures stay in their per-question cards for manual Re-run / Override. The user-locked decision (2026-05-26) is that the system NEVER auto-commits a score-0 / `AIG_*` row.

**Help IDs.** New `admin.attempts.accept_all` (button) and `admin.attempts.grading_summary` (panel) — wire content via `modules/16-help-system` when copy is finalised. Existing `admin.attempts.grading_dispatch` (Grade all) is unchanged.

**History.** Pre-2026-05-28 the page had only a single per-question Accept button that posted `{question_id}` — the backend required `{proposals: […]}`. Every Accept therefore failed silently with 422, and no attempt ever reached `graded` status. See `docs/RCA_LOG.md` 2026-05-28 entries (Bug A + Bug B) for the full incident.

#### Attempt-detail — navigate-away robustness (2026-05-29, commit `96b71a6`)

Operator-observed after the Bug-A fix deployed: even when the admin stayed on the attempt page after Grade-all, the proposals never appeared. Root cause was a Cloudflare ~100s edge timeout that cut the 4-minute synchronous POST `/grade` response in the middle of the call (`docs/RCA_LOG.md` 2026-05-29). The fix stores proposals server-side as a review cache. It adds two new UI affordances. The admin can leave the page during a batch and find the proposals again on return.

| Element | Purpose |
| --- | --- |
| **"Grading in progress" banner** (`admin.attempts.grading_in_progress`) | Blue info banner, rendered between the header and the grading-summary panel when `detail.grading_started_at != null`. Shows a Spinner + "Started Ns ago · polling every 15s · safe to navigate away" + a **Check now** button (manual `load()` trigger). Disappears the moment the marker is nulled by the backend's batch-completion write. |
| **"Previous grading stalled" banner** (`admin.attempts.grading_stalled`) | Yellow warning banner, replaces the in-progress banner once the elapsed time exceeds `STALE_MARKER_SEC = 600` (10 min). Indicates likely API container SIGKILL mid-batch — the `handleAdminGrade` catch-block marker-clear did not run. Coaches the admin to click **Re-grade**, which is enabled in this state because the server's in-process single-flight is fresh after a restart. |
| **Grade-all button — three states** | (a) Disabled "Grading…" while a local `handleGrade()` call is in flight OR while `gradingActive` is server-reported. (b) Enabled "Re-grade (previous stalled)" when `gradingStalled`. (c) Enabled "Grade all" otherwise. Title attribute carries hover-hint per state. |
| **Auto-poll** | A `useEffect` polls `load()` every 15s while `detail.grading_started_at != null`. Hard cap at `POLL_CAP_SEC = 720` (12 min) — beyond that the FE stops polling and shows the stalled banner. Adjusts to `gradingElapsedSec` so even a stalled marker that was set, say, 11 minutes before page load still polls for ~60s before giving up. |

**Hydration on mount.** `load()` reads `detail.ai_proposals` (a `GradingProposal[] \| null` from the new GET endpoint contract) and seeds the local `proposals` state. Explicit reset to `{}` when null so a stale proposal from a previous attempt does not bleed into a freshly-navigated-to one. The same `load()` call powers the auto-poll, so when proposals land in the cache the FE picks them up within at most 15 seconds.

**Timeout-resilient `handleGrade()`.** The synchronous POST `/grade` still fires on click, but a thrown 504/524/408 (proxy timeout) is now non-fatal. The FE shows "Grading is taking longer than the connection timeout — it continues on the server. This page will refresh automatically when proposals arrive." and calls `load()` to start the poll. Real errors (for example, 422 contract violation, 503 mode mismatch) still bubble through the existing error banner.

**Compliance frame UNCHANGED.** The cache is review-state only. `Accept all` still runs the Phase-1 completion gate. Billing still fires same-tx with the gate flip. The admin still clicks Accept on visible proposals before any `gradings` row is written. See `docs/05-ai-pipeline.md` § "Proposals cache + navigate-away robustness" for the full compliance argument.

#### Attempt-detail — pre-Release review UX bundle (2026-05-29, commit `d5ad835`)

It replaces the prior `window.confirm()` Release flow with a richer evaluation-review surface. The admin can verify **what was evaluated and why this score** before publishing results to the candidate. Release is the publish step: a best-effort result-released email, plus a cert if eligible. The candidate sees results immediately on the next reload.

| Affordance | Lives in | Renders |
| --- | --- | --- |
| **`ReleaseConfirmModal`** | [components/ReleaseConfirmModal.tsx](../modules/10-admin-dashboard/src/components/ReleaseConfirmModal.tsx) | Centered modal triggered by clicking **Release to candidate** (replaces `window.confirm`). Header: candidate email + assessment name + level label. Three stat cards: **Total score** (`scoreEarned/scoreMax` + percentage in serif lining-nums), **Questions graded** (`graded/total`), **Average band** (rounded avg → 0/25/50/75/100). **AI-failure callout** (only when count > 0): yellow `aiq-banner-warning` explaining flagged-for-review questions are excluded. **Per-question table**: Q-position chip + type + topic (40-char trunc) + band/score + status chip (`graded` green, `needs review` yellow, `ungraded` muted). Footer: **Release** (disabled + "Releasing…" while POST in flight) + **Cancel**. ESC and click-outside both cancel. Help id `admin.attempts.release_confirm`. |
| **`AnchorChip` enrichment** | [components/AnchorChip.tsx](../modules/10-admin-dashboard/src/components/AnchorChip.tsx) | New optional `anchorDef?: { concept, weight, synonyms? }` prop. When provided, chip text becomes `✓ concept · Npts` (40-char trunc); tooltip carries three blocks: full concept (medium weight), `Weight: Npts · Confidence: NN%` (confidence shown only if `finding.confidence` set), `as the model cited: "<evidence>"`. When omitted, falls back to existing `label ?? anchor_id` chip + evidence-only tooltip. |
| **`ConceptCoverageView`** | [components/ConceptCoverageView.tsx](../modules/10-admin-dashboard/src/components/ConceptCoverageView.tsx) | Collapsible card under each question's candidate answer (left column). Header: `{hitCount}/{anchors.length} concepts found · {hitWeight}/{totalWeight} weight` + chevron toggle. Expanded body highlights HIT-anchor concepts and their explicit synonyms inline in the answer text using **case-insensitive whole-word match** (no stemming — admins author synonyms deliberately per Sonnet V2 adversarial revision). Each match is a green ✓ pill with the concept as `title=` tooltip. Below the answer: **Missed concepts** block — muted ✗ pills for any anchor `hit=false`. **Truncation** with "Show all" when `answerText.length > maxChars` (default 800). Only renders for narrative answer types: `subjective`, `scenario`, `log_analysis` — `mcq` / `kql` / unknown suppress the view via empty `serializeAnswerForCoverage()`. |
| **Print review** | header button + inline `@media print` `<style>` block in [pages/attempt-detail.tsx](../modules/10-admin-dashboard/src/pages/attempt-detail.tsx) | New **Print review** button (header, `aiq-no-print` class) — rendered when `gradings.length > 0`, calls `window.print()`. Print stylesheet hides `.aiq-no-print, .aiq-banner:not(.aiq-error-banner), .aiq-shell-nav, .aiq-shell-sidebar, nav`, the grading-in-progress + grading-stalled banners; flattens the 2-col `.aiq-admin-detail-two-col` grid; removes card shadows; whitewashes background. **Error banner** carries a new `aiq-error-banner` class and is INTENTIONALLY exempted from the hide (Sonnet V5 adversarial revision — operational errors are part of audit context if the admin chose to print mid-error). |

**Backend dependency.** Both `AnchorChip` enrichment and `ConceptCoverageView` require the question's rubric to be present in the GET `/admin/attempts/:id` response. Commit `d5ad835` extended the 07-ai-grading `loadFrozenQuestions` SELECT to include `qv.rubric`. The prior comment "rubric column intentionally excluded — this read is for display" was too cautious. The loader IS the display read for the admin grading review surface, and the route is `adminOnly`-gated. Candidates never reach it. See `docs/03-api-contract.md` for the response shape.

**Data plumbing in `attempt-detail.tsx`.**
- `FrozenQuestion` interface gained `topic?`, `position?`, `rubric?: RubricForReview | null`.
- `serializeAnswerForCoverage(type, answer)` produces a plain-text serialisation per type for the coverage matcher (returns `""` for non-narrative types → coverage view suppressed).
- `<ScoreDetail>` receives `rubricAnchors={q.rubric.anchors}` (when present) and looks up each `anchor_hit.anchor_id` to build a chip `anchorDef`.
- `<ConceptCoverageView>` receives the paired `{rubric anchors × anchor_hits}` array so it knows which rubric concepts were hit vs missed.
- `handleRelease` is now sync (`function`, not `async`) — it opens the modal. The actual POST runs in `handleReleaseConfirm()` after the admin clicks Release inside the modal.

**Adversarial review** (Sonnet takeover, REVISE → addressed):
- V1 rubric-PII-leak: ACCEPT (same admin authors rubric + views attempt; admin-only route).
- V2 stemming false positives → fixed (literal whole-word match only — no `s` / `ing` suffix-strip).
- V3 malformed `log_analysis.findings`: ACCEPT (`filter(typeof === "string")` catches it).
- V4 250KB rubric payload at 50-question packs: ACCEPT-noted.
- V5 print over-hides error banner → fixed (`.aiq-error-banner` class + `:not()` selector).
- V6 modal live-prop updates during 15s poll: ACCEPT (fresher data preferred).
- V7 `handleRelease` sync-not-async: ACCEPT (call site is sync dispatch).

**Compliance frame UNCHANGED.** ReleaseConfirmModal does NOT bypass any backend check — the POST `/release` route still validates `attempts.status === 'graded'`. No new `gradings` write path. No `dangerouslySetInnerHTML` anywhere (rubric content is admin-authored, but still rendered through React text nodes).

#### Attempt-audit four-zone demarcation (2026-05-29)

**What:** The per-question card on the admin attempt-detail page (`/admin/attempts/:id`, `modules/10-admin-dashboard/src/pages/attempt-detail.tsx`) changed from a 2-column *question+answer | grading-panel* split to a single full-width card. The card has **four clearly-labelled, colour-accented audit zones**, stacked top-to-bottom:

1. **❓ Question** (neutral/muted accent) — the candidate-facing stimulus *only*. Rendered by the new `QuestionPromptView`, which strips every answer-key field (mcq `correct`/`rationale`, kql `expected_keywords`, scenario per-step `expected`, log_analysis `expected_findings`/`sample_solution`). This is exactly what the candidate saw.
2. **✦ Expected answer / rubric** (info-blue accent) — the answer key + grading ground-truth. The new `ExpectedAnswerView` renders it: mcq → correct option + rationale; kql → expected keywords; scenario → per-step expected; log_analysis → expected findings + sample solution; **subjective → the rubric anchors (concept + weight). Subjective has no authored model answer, so the rubric IS the expected answer**. Rubric-graded types also show a "Rubric (grading basis)" anchor list. When neither answer-key nor rubric exists, the zone shows a "graded holistically on the reasoning band" note.
3. **✎ Candidate answer** (secondary-grey accent) — the submitted answer, shown with the existing `AttemptAnswerView` (typed per-shape renderers, never raw JSON) + the existing `ConceptCoverageView` highlight (hit concepts highlighted inline, missed concepts listed below). The zone shows "No answer submitted." when no answer exists.
4. **🤖 AI evaluation** (accent) — band/%/score + grader chip + the existing anchor chips. **It now has an always-visible per-anchor evidence list** (`✓/✗ concept — "the quote the model cited"`) through the new `ScoreDetail` opt-in `showAnchorEvidence` prop. It also shows the AI justification, the Override form/button, fresh-proposal card, and Stage-2-vs-3 escalation diff. A "Not yet graded" placeholder shows when no grading/proposal exists. The card header now has a `Q{n} · {type} · {pts}` label + a per-question status pill (graded / ready to accept / needs review / not graded).

**Why:** An admin asked "for a graded attempt, how do I see what the candidate submitted, what was expected, and how the AI evaluated it — with clear demarcation to audit?" The prior layout failed this on three counts. (a) `QuestionContentView` rendered the prompt *and* answer key together, so the correct option / rationale / expected findings mixed into the question. (b) The "expected answer" was scattered and unlabelled, and **completely absent for subjective questions** (their rubric showed only implicitly as hit/miss chips). (c) The *cited evidence* of the AI was hidden in chip hover tooltips, invisible in a print/audit context. The four-zone split makes each audit question answerable at a glance. It also works in the existing `@media print` review export.

**Considered & rejected:** Three-column (Expected | Candidate | AI) side-by-side layout. Rejected: it is too tight on narrow screens and worse for print. Stacked sections read top-to-bottom cleanly at any width. The user picked stacked over three-column and over a minimal "add an Expected card to the current 2-col" option. Adding a new authored `model_answer` column for subjective: deferred. Rubric concepts + weights answer the need now with **no schema change**. An authored model answer would need a migration, a question-editor field and a later session.

**Implementation notes:** New shared `question-format.tsx` util holds the text-normalisation helpers (`cleanText`/`unescapeJsonString`/`stripMarkdown`) + small primitives (`JsonFallback`/`Chip`/`SUBLABEL_STYLE`). **`QuestionContentView` is intentionally unchanged.** The question-editor preview (`question-editor.tsx`) still uses it, and it keeps its own private helper copies. The new audit zones use the shared util instead. All four components reuse the production `--aiq-*` tokens (cards, borders, mono uppercase sublabels), like the established admin surface. So the work needed no new kit screen/recipe. It is a re-composition of existing idioms, not an invented layout.

**Not included / downstream:** No backend, schema, API, auth, tenancy, RLS, or grading-logic change. `modules/10-admin-dashboard` is non-load-bearing. This `adminOnly` route *already* returned the rubric (added by the 2026-05-29 review-UX bundle). So there is no new data exposure and no candidate-facing path. No `help_id` added for the zone labels (they are presentational, not interactive controls). The `aiq-admin-detail-two-col` print class became `aiq-admin-detail-question` (the card is now single-column; the grid override was dropped, page-break-avoid kept). `ScoreDetail`'s other usages are unaffected (`showAnchorEvidence` defaults off). This work does not change the 3 pre-existing `attempt-detail-error.test.tsx` failures (mock-exhaustion in the Grade-error path of the test). They are identical on HEAD with the diff stashed.

### Generation admin UI — wizard resume + scorecard help (2026-05-24)

Two super-admin-only generation surfaces in `modules/10-admin-dashboard`. Both
are presentational/help only — no auth, tenancy, or grading-pipeline logic.

#### Generation gating is already complete (no code this round)

Question generation is **super_admin-only** on every surface; this was confirmed,
not changed, this session. The four gates (FE defence-in-depth; the backend
`super_admin`-only generate route is the real boundary):

- **Nav** — `AdminShell.tsx` Library section: "Generate Questions" and
  "Generation history" are `superAdminOnly: true`.
- **Routes** — `apps/web/src/App.tsx`: `/admin/generate-wizard` and
  `/admin/generation-attempts` are `RequireSession role="super_admin"`.
- **Mode toggle** — `billing.tsx` AI-generate-mode `<select>` renders only inside
  `{isSuperAdmin && …}`.
- **Pack-detail link** — the "✦ Generate questions →" button is `{isSuperAdmin && …}`.

#### Resume a running generation (`generate-wizard.tsx`)

**What:** the wizard's per-category progress lives only in React state
(`genResults`), so navigating away during a run and returning dropped the user on
an empty config form even though the server was still generating. Now, on mount
the wizard queries `listGenerationAttempts({ status: "running", limit: 1 })`; if a
run is in flight it shows a **"Generation in progress…"** panel (replacing the
step UI) and polls every 4s until the tracked attempt leaves the running set, then
loads the resulting drafts and lands on **Review** — matching what Generation
History shows live.

**Why:** generation is sync-on-click + single-flight, so at most one attempt is
`running` platform-wide; a returning super-admin should see that, not a fresh form.

**Not included:** no cancel control, no per-category live progress on resume (the
in-flight category's React progress is gone once you navigate away — by design,
same as before). The poll reuses the existing `GET /api/admin/generation-attempts`
endpoint (new typed helper `listGenerationAttempts` in `api.ts`); no backend change.

#### Scorecard inline help (`generation-attempts.tsx`)

Four `HelpTip`s on the per-attempt scorecard, keyed `admin.gen_score.*`:

| Element | help_id |
|---|---|
| "Score this attempt" button | `admin.gen_score.score_button` |
| "Overall verdict:" label | `admin.gen_score.verdict` |
| "Structural quality" heading | `admin.gen_score.structural` |
| "Runtime metrics" heading | `admin.gen_score.runtime` (per-metric one-liners in its drawer `long_md`) |

**Page-prefix fix (required):** help resolves via `key LIKE page||'.%'`
(`listHelpForPage`), and `help_id` segments are `[a-z0-9_]` only — **no hyphens**.
The page's old `helpPage="admin.generation-attempts.history"` (hyphenated) could
never match any valid key, so the provider was inert and the `<h1 data-help-id>`
was a no-op (there is no global `[data-help-id]` binder — help renders only via
`<HelpTip>`/`useHelp`). The page prop is now `helpPage="admin.gen_score"`, which
the four keys match. The pre-existing `admin.generation_attempts.history` YAML key
stays (a kept-test asserts its presence) but remains unrendered — converting the
`<h1>` to a real `HelpTip` was left out of scope.

**Seeding:** keys live in `modules/16-help-system/content/en/admin.yml`; `0011`
was regenerated (`pnpm tsx tools/generate-help-seed.ts`) and a forward migration
`modules/16-help-system/migrations/0089_seed_gen_score_help.sql` carries the four
rows to prod (0011 is already-applied, so it never re-runs). Numbered 0089 to
avoid the analytics `0088_attempt_summary_mv_owner.sql` added in parallel. `short_text` ≤120
chars and non-empty `long_md` per the help-key test.

#### Generate wizard: Topic focus (RW-46, S10, 2026-10-15)

*Type: reference.*

**What.** The config step has an optional text field, `TopicFocusField` (`modules/10-admin-dashboard/src/components/TopicFocusField.tsx`). The maximum is 200 characters, the same limit as the API's `topic_focus`. Over the limit, the field shows an error and the Generate button is disabled. A non-empty trimmed value is sent as `topic_focus` in every per-category `POST /admin/generate` call of the run. An empty value sends no key. A resumed batch uses the focus typed in the current session, because the saved batch plan does not store it.

**Help.** Key `admin.generate_wizard.topic_focus` (migration 0172).

**Why.** The API accepted `topic_focus` (RW-46 backend) but the wizard had no input for it.

**Not included.** A prompt change. The generation skills live on the VPS; if they must read `topic_focus` explicitly, the owner copies the skill and re-baselines the eval harness (docs/05-ai-pipeline.md).

#### Generate wizard: polling (RW-93, S10, 2026-10-15)

*Type: reference.*

**What.** `runBatch` in `modules/10-admin-dashboard/src/pages/generate-wizard.tsx` calls `startGenerateForDomainApi` (`POST /api/admin/generate/start`). Then it reads `getGenerationAttemptApi` every 3 s, for at most 10 min. The category row shows the elapsed time as `m:ss`. A `failed` attempt shows its error and the wizard continues with the next category. A `success` or `partial` attempt goes on with `count_inserted`. After 10 min the wizard shows a time-out error. The run continues on the server if the admin leaves the page.

**Why.** The edge cut a single long request at about 100 to 125 s. The wizard then started the next category into a held lock (RCA 2026-10-15).

**Considered and rejected.** SSE or websockets (edge buffering). Keeping the single long request.

**Not included.** Cancel; resume after an API restart (the row can stay `running`, ROADMAP RW-94).

### Generate wizard: difficulty warnings (RW-96, S11)

*Type: reference.*

- **What.** The Review step of the Generate wizard (`modules/10-admin-dashboard/src/pages/generate-wizard.tsx`) shows a warning chip, "N warnings", on each draft that has warnings. A native `title` tooltip lists each warning as `code: message`. The chip has `data-help-id="admin.generate_wizard.review_warnings"`. The step header shows a count, "W drafts with warnings".
- **Data.** The chip reads `difficulty_params.warnings`, a list of `{ code, message }`. RW-88 stores the list when the draft is inserted (`modules/07-ai-grading/src/handlers/admin-generate.ts`). `GET /api/admin/questions` already returned `difficulty_params` (`modules/04-question-bank/src/repository.ts`, `QUESTION_COLUMNS`). The UI type `QuestionListItem` in `src/api.ts` gains `difficulty_params`. Module 04 was not changed.
- **Help.** Keys `admin.generate_wizard.review_warnings` and `admin.question_import.draft_rubrics` in migration `0178_rw96_wizard_warnings_and_import_rubric_help.sql`. The seeded help count goes from 387 to 389.
- **Why.** RW-88 stored the warnings but no screen showed them. The admin approved drafts without seeing a weak difficulty tag.
- **Rejected.** Blocking Approve on a warning: the heuristics are advisory (RW-50). A custom tooltip component: the native `title` is enough for this step.
- **Not included.** A filter by warning. A warning count on the pack page. Any change to the heuristics or to the stored shape.

### Account security page and Reset two-factor (RW-45, S10, 2026-10-15)

**Account security page.** `modules/10-admin-dashboard/src/pages/account-security.tsx`, route `/admin/account-security`, reached from the Account menu in the admin shell.
- It shows the TOTP status of the signed-in admin.
- "Regenerate recovery codes" opens a dialog that asks for a current 6-digit code. After success the dialog shows the 10 codes once, with "Copy all" and "I saved them". Closing the dialog before that loses the codes, so the server never shows them again.
- A user with no TOTP enrolment sees a link to `/admin/mfa` and no regenerate button.

**Reset two-factor dialog.** On the super-admin Users page, "Reset two-factor" sits in the Manage menu. It appears only when the row has `totp_enrolled` true, and never on the signed-in user's own row. It opens `modules/10-admin-dashboard/src/components/ResetTotpDialog.tsx`, a `ConfirmDialog` with a required reason field (up to 500 characters).

**Help.** Keys `admin.account.security.*` (8) and `admin.users.list.reset_totp`, in `modules/16-help-system/content/en/admin.yml`. Migration 0171 carries the 9 rows to production.

**Why.** The backends existed but had no screen. An admin who lost recovery codes, or a user who lost the authenticator, had no way to recover without database access.

**Not included.** A notice to the target user after reset, and a tenant-admin reset. (Both shipped in RW-91, see "Users page: Reset two-factor" below.) Backend contract: [03-api-contract.md](03-api-contract.md). Flow and audit: [04-auth-flows.md](04-auth-flows.md).

### Users page: Reset two-factor (RW-91, S10, 2026-10-16)

*Type: reference.*

**What.** The tenant-admin Users page (`modules/10-admin-dashboard/src/pages/users.tsx`) now offers "Reset two-factor" in the row menu. The same `ResetTotpDialog` (`components/ResetTotpDialog.tsx`) opens, with a required reason of up to 500 characters. The dialog calls `POST /api/admin/users/:userId/totp/reset`.

**When the item shows.** All of these must hold. The signed-in user is a tenant `admin`. The row has `totp_enrolled` true. The row is not the signed-in user. The role is not `candidate` or `super_admin`. The status is `active`, and the row is not deleted.

**Step-up.** The route returns 401 `FRESH_TOTP_REQUIRED` when the last TOTP check is older than 15 minutes. The dialog uses `useMfaGuard`, shows an inline code prompt and retries the call.

**Why.** The route existed only for a super admin. A tenant admin whose user lost an authenticator had to ask the platform owner.

**Not included.** A reset for candidates (they have no TOTP). A bulk reset. Backend: [03-api-contract.md](03-api-contract.md). Flow: [04-auth-flows.md](04-auth-flows.md) § "Self-service MFA".

## Session S13 UI changes (2026-10-16)

*Type: reference.* These blocks cover the admin and candidate screens that S13 changed. API facts are in [03-api-contract.md](03-api-contract.md) § "S13 additions (2026-10-16)".

**Help id rule (reminder).** A page `helpPage` value and every `data-help-id` must pass `isValidHelpKey`. The check rejects hyphens. Use dots and underscores only. The audit, embed and webhooks pages used hyphenated ids (RCA 2026-10-03 class), so the help drawer never loaded. S13 renamed them in the same commit as migration `0182`, so no old help rows exist.

### Framework tree picker (RW-61, S13)

**What.** `modules/10-admin-dashboard/src/components/FrameworkTreePicker.tsx`. One component for all pages that pick curriculum framework nodes.

| Prop | Meaning |
| --- | --- |
| `frameworkId?` | A fixed framework. When absent, the picker shows a framework select. |
| `value` | Selected node ids. |
| `onChange(ids, nodes, lookup)` | Called on each change. `lookup` holds every node loaded so far, so a caller can read parent labels. |
| `multiple?` | Many nodes. The default is one node, and a second click on it clears it. |
| `readOnly?` | The tree shows but cannot change. Tenant admins get this on the question editor. |
| `kinds?` | Only these node kinds can be selected. Other nodes stay visible for navigation. |
| `helpId` | Required. Becomes `data-help-id` on the wrapper. It must pass `isValidHelpKey`. |

**Behaviour.**
- The picker loads all nodes of the framework in one call (`GET /api/admin/frameworks/:id/nodes`) and builds the tree in the browser. The child list of a node renders only after you expand the node.
- Search matches the label or the code. It keeps matching nodes and all their ancestors, and it expands the ancestors.
- Accessibility: roles `tree`, `group` and `treeitem`, with `aria-level`, `aria-expanded` and `aria-selected`. The search field and the framework select have `aria-label`. Errors use `role="alert"`.
- Keyboard: each item takes focus with Tab. Enter or Space expands a node that has children, or selects a leaf. There are no arrow-key moves yet. This is a gap against the full WAI-ARIA tree pattern.
- Data helpers are in `modules/10-admin-dashboard/src/api/frameworks.ts`: `listFrameworksApi`, `listFrameworkNodesApi`, `getQuestionTaxonomyApi`, `putQuestionTaxonomyApi`, `getPackTaxonomyApi`.

**Use on each page.**
- Question editor (`question-editor.tsx`): card "Framework nodes" with the picker in multiple mode. A tick saves at once (`PUT`). A super admin edits. A tenant admin sees it read-only. A "Bloom" chip shows the cognitive level.
- Question set detail (`pack-detail.tsx`): a single-node filter above the levels. The page keeps only questions under that node. A load error shows an empty list.
- Generate wizard (`generate-wizard.tsx`): an optional picker that fills the Topic focus text. For a unit or an outcome, the text is "Parent: node". The text is cut to the Topic focus limit. The wizard sends no new parameter.
- Blueprint builder (`assessments/BlueprintBuilder.tsx`): a picker for the kind `subject`. It selects the question domain with the same `domains.node_id`. When no domain matches, a note says "No question set uses this node yet."

**Help.** Four keys, one for each page prefix (migration `0182`): `admin.question.editor.framework_nodes`, `admin.question_bank.pack.framework_filter`, `admin.generate_wizard.framework_pick`, `admin.assessments.blueprint.framework_pick`.

**Why.** Admins could not see or edit framework links. A shared component keeps one look and one set of keyboard rules.

**Considered and rejected.** Server-side tree loading per node (many calls for a small tree). A picker for each page (four copies to keep equal). A free-text node code field (no check, no labels).

**Not included.** Pickers per level. New generation parameters. Node authoring by tenants. Arrow-key moves.

**Downstream impact.** Any new page that links nodes reuses this component and adds a help key in the same commit.

### Audit log page tails (S13)

**What.** `modules/10-admin-dashboard/src/pages/audit-log.tsx`.
- Buttons in the card header: "Export CSV", "Export JSONL" and "Archive range". Archive range is off until both dates are set.
- "Archive range" opens a `ConfirmDialog` ("Archive this range?"). The confirm button reads "Archive and download". On success the page shows "N rows marked as archived" (`role="status"`) and starts the download of `export_url`.
- A note (`role="note"`) appears when the range is over the cap: "The export covers the first 100,000 rows. Narrow the date range and export again." The page decides from the total count or from the archive result.
- `helpPage` is `admin.audit`. Ids were `admin.audit-log.*` and are now `admin.audit.*`, with underscores (for example `admin.audit.date_from`).

**Why.** The API caps and audits exports (FR1). The page must show the cap and offer the archive.

**Rejected.** Block the export when over the cap (a partial file is more useful). Delete rows after archive (the owner parked deletion).

**Not included.** A list of past archives. A delete step. A date picker for time of day.

**Downstream impact.** Each export and each archive click adds audit rows (see [03-api-contract.md](03-api-contract.md)). The audit list shows them.

### Embed page tails (S13)

**What.** `modules/10-admin-dashboard/src/pages/embed-config.tsx`.
- The page now manages embed secrets: list (`GET /api/admin/embed-secrets`), create (`POST`), rotate (`POST /:id/rotate`) and revoke (`DELETE /:id`).
- A new secret shows once. The page never shows it again.
- The old card wired the webhook secret under the label "API Secret". It stays, under the label "Webhook secret".
- A new card shows an integration snippet for the host page (the `/embed/sdk.js` script and `mount`).
- `helpPage` is `admin.embed`. Ids are `admin.embed.*` (were `admin.embed-config.*`).

**Why.** Tenants could not manage embed secrets from the UI. The wrong label also led admins to the wrong secret.

**Not included.** A test-token button (no production mint route). A check of the tenant allowed origins from the page. The Caddy and frontend CSP work (see [03-api-contract.md](03-api-contract.md) open items).

**Downstream impact.** Embed hosts need the SDK `onBlocked` option to show a message when a frame is refused.

### Webhooks page tails (S13)

**What.** `modules/10-admin-dashboard/src/pages/webhooks.tsx`. No API change.
- A Replay button on each failed delivery calls `POST /api/admin/webhooks/deliveries/:id/replay`.
- A status filter: All, Failed, Delivered, Pending. It filters in the browser.
- A notice shows the new secret once, with a Dismiss button.
- Three event checkboxes: `attempt.submitted`, `attempt.graded` and `result.released`. The default is `attempt.graded`.
- `helpPage` is `admin.webhooks`. The id `admin.webhooks.delivery-log` is now `admin.webhooks.deliveries`.

**Why.** The replay route had no button. The page offered no way to choose events.

**Not included.** A server-side status filter. A replay for delivered rows.

### Candidate new-result banner (Z-3, S13)

**What.**
- `modules/11-candidate-ui/src/components/CandidateShell.tsx` shows a banner (`role="status"`, `data-help-id="candidate.shell.new_results_notice"`). The text is "1 new result is published." or "N new results are published.", with a link "View results".
- The shell calls `GET /api/me/notifications?unread=1&limit=50` once after the sign-in check. There is no polling. A failed call hides the banner.
- `MyResults.tsx` calls `POST /api/me/notifications/mark-read` with `{ kind: 'result.released' }` after the list loads. Then it sends the window event `aiq:notifications-read`. The shell listens and hides the banner.

**Why.** The candidate learned of a published result only by email.

**Rejected.** Polling. A toast (it disappears before a slow reader sees it).

**Not included.** A notice bell. Notices for other events. A count on the menu item.

**Downstream impact.** Help key `candidate.shell.new_results_notice` (migration `0182`). Tests: `CandidateShell.test.tsx` and `MyResults.test.tsx`.

## Session S14 UI changes (2026-10-16)

*Type: reference.* These blocks cover the screens that S14 changed. API facts are in [03-api-contract.md](03-api-contract.md). Help rows for the new ids are in migration `0187`.

### TenantLogo component (Logo-L2, S14)

**What.** `modules/17-ui-system/src/components/TenantLogo.tsx`. The component shows the logo of an organisation. It never replaces the AssessIQ mark (see [10-branding-guideline.md](10-branding-guideline.md) section 11).

| Prop | Meaning |
| --- | --- |
| `src` | The logo URL. When it is absent, the component shows the organisation name. |
| `name` | The organisation name. It is the `alt` text and the fallback text. |
| `height` | The logo height in pixels. The width is automatic, with a maximum of four times the height. The image uses `contain`. |
| `viaAssessIQ` | When true, a muted "via AssessIQ" caption shows next to the logo. The caption uses tokens. |

**Placements.**

| Screen | Height | Help id |
| --- | --- | --- |
| Admin top bar | 28 px | `admin.shell.tenant_logo` |
| Candidate shell (`CandidateShell.tsx`) | 28 px | `candidate.shell.logo` |
| Candidate token landing (`TokenLanding.tsx`) | 40 px | `candidate.take.landing.logo` |
| Attempt top bar (`AttemptTopBar.tsx`) | 28 px | `candidate.take.attempt.logo` |
| Submitted page (`Submitted.tsx`) | 40 px | `candidate.take.submitted.logo` |
| Tenant settings preview | 120 px | `admin.tenant_settings.logo` |

**Tenant settings: "Organisation logo" section.** The section has a preview (120 px at most), a PNG or JPEG file input, client checks, and an Upload button. Upload sends JSON with `content_base64`. A Remove button asks for confirmation. Both actions need a fresh MFA step-up, like release mode. Help ids: `admin.tenant_settings.logo` and `admin.tenant_settings.logo.remove`. The page help `admin.tenant_settings.page` is now version 2 (a logo bullet).

**Why.** Organisations asked to see their own brand on the pages that their candidates see. One component keeps the sizes, the fallback and the co-brand caption the same on every screen.

**Not included.** SVG, GIF and WebP logos (the API refuses them). A logo crop tool.

### Question editor: negative marks and passage sets (EX-1, EX-3, S14)

- **Negative marks input.** The question editor has a "Negative marks" input in the create form and in the edit card. Blank means "use the assessment default". AI-graded types ignore the value. Help id: `admin.question_editor.negative_marks`.
- **`NegativeMarksCard`.** The assessment page shows this card under Advanced settings. It sets `settings.scoring.negative_marks_default` (0 to 1000). It is editable in draft only. Help id: `admin.assessments.settings.negative_marks_default`.
- **Structured case editor.** Each step has "Marks" and "Negative marks" inputs (help id `admin.question.editor.structured_case.step_marks`). A "Passage set" preset adds five single-choice steps (help id `admin.question.editor.structured_case.passage_preset`).
- **Grading panel.** The panel adds `· −N` to the score line when the question has a penalty.

### Candidate screens: passage sets and negative marking (EX-1, EX-3, S14)

- **`StructuredCaseAnswerArea`.** The component shows the shared stem block, the label "Question k of N", and a chip "+w · −n" for each step that has marks. Help id: `candidate.take.structured_case.child_marks`.
- **`ResultSummary`.** The total can be negative and shows its sign. The score ring never goes below 0. When the penalty is more than 0, a line reads "Negative marking: −N deducted for wrong answers". Help id: `candidate.result.negative_marking`.

**Why.** The result must explain a lower total. A candidate must see the weight of each step before the answer.

### Billing page: Plan limits (PT1, PT-4, S14)

- The billing page has a "Plan limits" block. It shows four values: licensed packs, candidates per drive, overage cap, and AI answers used against included ("Unlimited" or "no cap" when a limit is null).
- When `PLAN_TIERS_ENFORCED` is false, the block adds the note "Plan limits are shown for information and are not enforced yet."
- Help ids: `admin.settings.billing.limits` and `admin.settings.billing.limits.enforced`.

### Grading panel and Platform drawer (P4, S14)

- **`AttemptGradingPanel`.** A "Graded by" line reads "answer key N · reuse N · rule N · AI N · human N". The line omits tiers with a count of zero. Help id: `admin.attempts.grading.tiers`.
- **`AiGradingScopeCard`.** The Platform billing drawer has this card for super admins. It sets the AI grading scope of an organisation: "written" or "none". Help id: `admin.platform.tenant.ai_grading_scope`.

### Organisation question upload page (EXP-17, 2026-10-19)

- **What.** Page `/admin/org-question-upload` (`modules/10-admin-dashboard/src/pages/org-question-upload.tsx`) for a tenant admin. Steps: file (CSV or XLSX, up to 4 MB), subject, optional set name, optional source reference, rights (original, based on a source, licensed), the rights confirmation tick-box, then **Check file**. The check is the dry run: it stages the file and shows valid, with problems, duplicates and skipped counts in an `aria-live` region, plus a table of the rows that are not valid. Nothing becomes a question yet. **Add N questions** is the second, explicit click. After it the page shows the result and a link to the draft set. The list **Your uploads** shows each upload with its state, rights and question count, and a Withdraw action behind a confirm dialog.
- **Warranty text.** One exported constant, `ORG_UPLOAD_WARRANTY_TEXT`: "I confirm that I own this content or hold the right to use and upload it, and that it does not break anyone's copyright." Check file stays disabled until the box is ticked. The server also refuses the upload without `content_warranty: true`.
- **Locked state.** A `403` with code `TIER_NOT_INCLUDED` from the list call replaces the form with a "Contact us" panel. The panel names the AssessIQ administrator (the app has no shared contact link; the billing page uses the same wording). No flag is changed.
- **Help ids.** `admin.org_upload.page`, `.file`, `.domain`, `.source_ref`, `.rights`, `.warranty`, `.preview`, `.commit`, `.withdraw` (9 keys, seed only, no migration).
- **Why.** Owner row EXP-17: a tenant adds its own questions with a rights statement, and can take them back. **Considered and rejected:** a separate staging table for the preview (the stage step already is the dry run); gift, aiken and qti for organisations (the database CHECK on `question_imports.format` allows csv and xlsx only).
- **Not included.** Per-row fix in the browser (fix the file and upload again), AI checks, quotas, a Playwright spec (needs App.tsx wiring, done by the orchestrator).
- **Wiring (orchestrator).** Route in `App.tsx` inside `RequireSession role="admin"`, nav item "Upload questions" in `admin-nav.ts`.
- **Downstream.** API: `docs/03-api-contract.md` § "Organisation upload". Gate: `modules/19-billing/src/service.ts` (`question_upload`, tier `pro`).

### Question import page (RW-59, S14)

- The page lists the accepted formats: CSV, XLSX, GIFT, Aiken and QTI (zip or one `.xml` item). Help id: `admin.question_import.formats`.
- A `.txt` file makes the page ask you to choose GIFT or Aiken. Help id: `admin.question_import.text_format`.
- Templates stay CSV and XLSX only.

### Help ids added in S14

| Help id | Page or component |
| --- | --- |
| `admin.tenant_settings.logo` | Tenant settings, logo section |
| `admin.tenant_settings.logo.remove` | Tenant settings, Remove button |
| `admin.shell.tenant_logo` | Admin top bar |
| `candidate.take.landing.logo` | Token landing |
| `candidate.take.attempt.logo` | Attempt top bar |
| `candidate.take.submitted.logo` | Submitted page |
| `candidate.shell.logo` | Candidate shell |
| `admin.question_editor.negative_marks` | Question editor |
| `admin.assessments.settings.negative_marks_default` | Assessment page, `NegativeMarksCard` |
| `candidate.result.negative_marking` | Candidate result summary |
| `admin.question.editor.structured_case.step_marks` | Structured case editor |
| `admin.question.editor.structured_case.passage_preset` | Structured case editor |
| `candidate.take.structured_case.child_marks` | Candidate structured case answer area |
| `admin.settings.billing.limits` | Billing page |
| `admin.settings.billing.limits.enforced` | Billing page |
| `admin.platform.tenant.ai_grading_scope` | Platform billing drawer |
| `admin.attempts.grading.tiers` | Attempt grading panel |
| `admin.question_import.formats` | Question import page |
| `admin.question_import.text_format` | Question import page |

`admin.tenant_settings.page` is bumped to version 2. The migration `0187` holds all rows (20 rows with the page bump).

## Session S15 UI changes (2026-10-17)

### Candidate progress page (RW-84, S15)

**What changed.** A new page `MyProgress` (`modules/11-candidate-ui/src/components/MyProgress.tsx`) shows the history and strengths of a candidate.

- Route: `/candidate/progress` in `apps/web/src/App.tsx`, inside `RequireSession` and `CandidateShell`.
- Nav: a "Progress" link after "Results" in `CandidateShell`, on desktop and on mobile.
- Data: `GET /api/me/progress`. See [03-api-contract.md](03-api-contract.md) § "GET /api/me/progress (RW-84)".
- Sections: `PageHeader` with a count chip; a `StatCard` row (tests taken, average score, best score); a `Sparkline` when there are 2 or more points, else a one-line note; a "Your tests" `Table` (assessment, date, score, `StatusPill` passed or failed, certificate link); "Strengths by subject" rows with `ProgressBar` and a `Chip`.
- Chip rule: Strong at 75 % or more, Developing at 50 to 74 %, Focus below 50 %.
- States: loading (`Spinner`), error (message and a Retry `Button`), empty ("No released results yet").
- Help ids: `candidate.progress`, `candidate.progress.history`, `candidate.progress.trend`, `candidate.progress.subjects` in `modules/16-help-system/content/en/candidate.yml`.
- Kit pattern: `patterns.md` "Results / report layout" (the competency breakdown in `screens/results.jsx`).
- Tests: `modules/11-candidate-ui/src/__tests__/MyProgress.test.tsx` (spinner, empty, rows with certificate link and chips and sparkline, single-point note, error and Retry).

**Why.** Candidates had results and certificates but no view across tests.

**Rejected.** A `/me/*` web route family (the portal is `/candidate/*`).

**Not included.** Per-framework split, unit-level strengths, filters.

**Impact.** New nav item in `CandidateShell`. No change to existing pages.

### Take pages as lazy chunks (RW-79, S15)

**What changed.**
- `apps/web/src/App.tsx` imports `Expired`, `ErrorPage` and `TakeRoot` from their own files. The three lazy wrappers import `./pages/take/Attempt`, `Submitted` and `TokenLanding` directly.
- Before, the barrel file made these pages part of the main chunk, and the build printed `INEFFECTIVE_DYNAMIC_IMPORT`. The warning is gone.
- `apps/web/src/pages/take/TokenLanding.tsx` prefetches `import('./Attempt')` after `takePreview` resolves, so the attempt chunk loads while the candidate reads the landing.
- `apps/web/vite.config.ts` also proxies `^/take/start$` when `E2E_API_PROXY` is set. The bare `POST /take/start` did not reach the API through `vite preview`.

| Chunk | Before | After |
| --- | --- | --- |
| Main | 290.14 kB (gzip 77.29 kB) | 156.13 kB (gzip 45.87 kB) |
| `Attempt` | in main | 33.55 kB |
| `TokenLanding` | in main | 13.50 kB |
| `Submitted` | in main | 4.85 kB |

**Rule.** For lazy routes, import take pages from their own files, not from the barrel. A barrel import pulls the page into the main chunk.

**Why.** RW-79 asks for under 20 s from the invitation link to the first question on a phone. See [12-test-coverage.md](12-test-coverage.md) § "Phone first-question timing (RW-79, S15)" for the numbers.

**Not included.** The result-released email links to `/candidate/login?tenant=<slug>` (magic-link sign-in with an email round trip). The magic-link decision stays as it is (owner decision Z-15 a).

**Known tail (not fixed).** An anonymous `GET /api/help?page=candidate.attempt` returns 401 on the token landing. `HelpProvider` at `/take` is not fetched again after Begin. Help tips can stay empty on the attempt page after the token path. This existed before RW-79.

### Start a test screen (RW-83, S15)

*Type: reference.*

**What changed.** A new page `AdminStartTest` (`modules/10-admin-dashboard/src/pages/start-test.tsx`) at `/admin/start-test`.

- Route: `apps/web/src/App.tsx`, inside `RequireSession role="admin"`.
- Entry points: nav item "Start a test" after "Assessments" in `AdminShell.tsx` (`adminOnly`), and a link beside "+ New Assessment" on `pages/assessments.tsx`.
- Card "Question set": radio list from `GET /api/billing/available-sets`, each with a chip "Licensed" or "Not yet imported". A difficulty select (Beginner, Intermediate, Advanced by `level_position`, limited to the levels of the set). A question count (default: the smaller of 10 and the set size; maximum 200). A name (default "<set> — <today>").
- Card "Candidates": a search box and the active candidates from `GET /api/admin/users?role=candidate&pageSize=100&search=`, a selected-count chip, and a paste box (one email for each line or separated by commas, optional ", Name"). Invalid lines are listed.
- Card "Window": opens now (rounded up to 5 minutes), closes now plus 7 days.
- One primary button "Send invitations". The call sequence is in [03-api-contract.md](03-api-contract.md) § "Start a test (RW-83): no new routes".
- Result card "Assessment created": link to `/admin/assessments/:id`, chips for invited, new candidates and skipped (with reasons from `lib/labels.ts`). If a step fails, the card names the step and links to the assessment.
- Helpers in `modules/10-admin-dashboard/src/api.ts`: `publishAssessmentApi`, `inviteAssessmentUsers`, `importCandidates`, `listCandidates`. The pasted CSV cells use `csvCell` from `@assessiq/core`.
- Help ids: `admin.start_test`, `.set`, `.candidates`, `.emails`, `.window`, `.send`, `.result` in `modules/16-help-system/content/en/admin.yml` (the database rows follow in this session's help migration).
- Test: `modules/10-admin-dashboard/src/__tests__/start-test.test.tsx` (5 cases).

**Why.** RW-83 asks for one screen for the common case: pick a set, pick people, send.

**Rejected.** A new combined API route (see the API page). A wizard with steps (the goal is one screen).

**Not included.** Duration edits (the set level sets the duration). A retry button after a partial failure. The six-screen path is unchanged.

**Impact.** New nav item for admins. Owner gate (flow confirmation): the default window, whether pasted unknown emails create candidates, a warning for "Not yet imported" sets, and a retry after a partial failure.

### Item statistics card on the question editor (RW-60, S15)

*Type: reference.*

**What changed.** A new component `QuestionStatsCard` (`modules/10-admin-dashboard/src/components/QuestionStatsCard.tsx`) shows on the super-admin question editor (`pages/question-editor.tsx`), after the framework nodes card. Data: `getSuperQuestionStats(id)` in `api.ts`, which calls `GET /api/admin/super/questions/:id/stats`.

- No volume: the text "No graded attempts on this question yet. Statistics appear after the nightly refresh." and no chart.
- With volume: `StatCard`s for attempts, correct rate, discrimination (a "Noise" chip under 0.2), exposure and last used. A gradient table by level with the level of the question marked. A chip "Miscalibrated" or "Calibrated" with the reason.
- Under 30 attempts: the line "Phase C needs 30+ attempts".
- Roll-up scope: the line "Across N copies of this platform question in customer organisations."
- Help ids: `admin.question.editor.stats`, `.stats.discrimination`, `.stats.gradient`, `.stats.miscalibrated`.
- Test: `modules/10-admin-dashboard/src/__tests__/question-stats-card.test.tsx` (2 cases).

**Also fixed.** The editor help ids `admin.question_editor.negative_marks` (two elements, shipped in S14 with EX-1) did not match the page prefix `admin.question.editor`, so the help text could never load. They are now `admin.question.editor.negative_marks`. The YAML key is renamed. This session's help migration renames the seeded row.

**Why.** Authors need measured difficulty next to authored difficulty. See [05-ai-pipeline.md](05-ai-pipeline.md) § "Phase C report".

**Rejected.** A separate statistics page (the editor is where the author acts).

**Not included.** Tenant-admin view. A review queue of flagged items.

**Impact.** Only the super admin sees the card. No change to the editor save flow.

### Contrast tokens darkened for WCAG AA (RW-82, S15)

*Type: reference.*

**What changed.** The axe scan of logged-in pages (RW-82) found serious colour-contrast failures. The light-mode tokens in `modules/17-ui-system/src/styles/tokens.css` changed:

| Token | Before | After |
| --- | --- | --- |
| `--aiq-color-accent` | `oklch(0.58 0.17 258)` | `oklch(0.52 0.18 258)` |
| `--aiq-color-accent-hover` | `oklch(0.52 0.19 258)` | `oklch(0.46 0.19 258)` |
| `--aiq-color-info` | `oklch(0.62 0.18 230)` | `oklch(0.42 0.13 235)` |
| `--aiq-color-success` | `oklch(0.65 0.15 150)` | `oklch(0.50 0.14 150)` (dark mode keeps the old value) |
| `.aiq-chip-warn` text | `var(--aiq-color-warning)` | `color-mix(in oklch, var(--aiq-color-warning) 40%, black)` |

- `modules/17-ui-system/src/fixtures/tenants.ts`: the default tenant `branding.primary` now matches the new accent. The `ThemeProvider` branding overrode the token before this change.
- `modules/10-admin-dashboard/src/components/AdminShell.tsx`: `<main tabIndex={0}>`. This fixes the axe rule `scrollable-region-focusable`.

**Why.** The CI gate needs zero serious or critical axe findings (see [12-test-coverage.md](12-test-coverage.md) § "Logged-in Lighthouse and axe (RW-82, S15)").

**Rejected.** Per-component colour overrides (the token is the single source).

**Not included.** Two moderate findings stay open: `region` (the `AdminShell` topbar and breadcrumbs are outside landmarks) and `page-has-heading-one` on `/take/attempt/:id`. The dark-mode value of `--aiq-color-info` was not set in this change. Check it when dark mode is audited.

**Impact.** The brand accent is darker (the hue is the same). This is visible to the owner. The visual-regression baselines run only on Linux or Docker and none are committed. Regenerate them inside the Playwright image before the next visual run.

### Review your answers on the candidate results page (RW-80, S15)

*Type: reference.*

**What changed.** `modules/11-candidate-ui/src/components/AttemptFeedback.tsx` is new. `MyResults.tsx` renders it under each released result, and only when `feedback_level` from `GET /api/me/results` is not `none`.

- A collapsed button "Review your answers" (it reads "Hide your answers" when open; `aria-expanded` and `aria-controls` are set). The fetch of `GET /api/me/attempts/:id/feedback` runs on the first expand, never on list load.
- States: loading (spinner), error ("We could not load your answers. Try again." with a Retry button) and empty ("No questions to show.").
- Each row: `Q<position>` and an outcome chip (Correct, Partly correct, Not correct); the prompt cut at 120 characters with the full text in `title`; "Your answer" ("No answer" when null); an "Expected answer" line only when the API sent one; an explanation block; a "What to study" line (unit and subject, else topic).
- The explanation block is serif italic 15 px on `--aiq-color-bg-raised`. This is `docs/10-branding-guideline.md` § 8.5 "AI justification block".
- Help ids: `candidate.results.feedback`, `.expected`, `.explanation`, `.study`.

**Why.** Candidates asked which answers were wrong. The section follows the release rules, because the route answers only for released results.

**Considered and rejected.** Feedback on the post-submit page `apps/web/src/pages/take/Submitted.tsx` (its rule P1: no per-question data there). Loading feedback with the list (extra load for every visit).

**NOT included.** A print view. Per-question links to practice. Pending questions (the API omits them).

**Downstream impact.** `MyResults` needs the new `feedback_level` field. Types: `modules/11-candidate-ui/src/types.ts`. API call: `getAttemptFeedback` in `modules/11-candidate-ui/src/api.ts`. Contract: [03-api-contract.md](03-api-contract.md) § S15 additions.

### Tenant settings: per-question feedback (RW-80, S15)

*Type: reference.*

**What changed.** `modules/10-admin-dashboard/src/pages/tenant-settings.tsx` has a second radio-card group, "Per-question feedback", after the release-mode group. The options are none, right_wrong, with_expected_answer and with_ai_justification. A save sends `PATCH /api/admin/tenant-settings/result-feedback-level` with the same `MfaStepUp` flow as the release mode. The page reads `result_feedback_level` from `GET /api/admin/tenant-settings`. An older server without the field leaves the group unselected.

- Help ids: `admin.tenant_settings.result_feedback_level` on the section, and one id for each option (`.none`, `.right_wrong`, `.with_expected_answer`, `.with_ai_justification`).
- Help rows: YAML in `modules/16-help-system/content/en/` and migration `0191_s15_batch4_help.sql`.

**Why.** The tenant admin decides what candidates see. The default stays `none`, and the owner picks the production default later (owner gate).

**Considered and rejected.** A per-assessment control. A plain select (the release-mode group already uses radio cards, so the page stays consistent).

**NOT included.** A preview of what the candidate sees. Any change to the release-mode group.

**Downstream impact.** The group has its own MFA and save state, separate from the release mode. Contract: [03-api-contract.md](03-api-contract.md) § S15 additions.

### Design pass on live-data pages (RW-81, S15)

**What changed.** Every routed page was reviewed with real data at 1440x900 and 390x844. The fixes below went in commit `80eab3e`. The rule: fix the primitive, not the page.

**Procedure.**

1. Seed real data with the e2e factories (packs, questions, assessments, attempts, certificates).
2. Run `apps/web/e2e/design-pass-screenshots.mjs` against a production preview. It logs in as admin, super admin and candidate.
3. Write numbered, measurable gaps in `docs/testing/screenshots/S15/CRITIQUE.md`.
4. Fix, shoot again, compare. See [12-test-coverage.md](12-test-coverage.md) § "Design-pass screenshot script (RW-81, S15)".

**Primitive fixes (one fix, many pages).**

- `modules/17-ui-system/src/components/Table.tsx`: cells get `min-width: 0` and plain text sits in an ellipsis span with a `title` attribute. Cell text is 13 px. This closed hard-clipped text on about 10 list pages.
- `modules/17-ui-system/src/styles/tokens.css`: on mobile, `.aiq-attempt-top` wraps and has `min-height: 64px`. The take page header was 564 px wide at 390 px (the only horizontal overflow). After the fix there is none.
- Both `PageHeader` components (module 10 and module 17) and about 20 admin pages use the existing `--aiq-h1-size` token (36 px desktop, 30 px mobile). Assessment detail was 7 lines at 390 px with its buttons off-screen.
- `flexWrap` on the header row of assessment-detail, assessments, pack-detail, question-bank and question-editor.
- About 70 ad-hoc 10 px labels use `--aiq-text-xs`. Values of 15, 17, 20, 22, 28 and 32 px use `--aiq-text-lg`, `--aiq-text-xl` or `--aiq-text-2xl` (about 50 files, about 17 under `apps/web/src/pages`).

**Page fixes.**

- `pages/assessments.tsx`: "Start a test" is an outline button. The hand-rolled empty state is the kit `EmptyState`.
- `attempts.tsx` and `question-bank.tsx` use `EmptyState`.
- `certificates.tsx` uses `EmptyState`, a doubled gutter is gone, and raw `#fee2e2` and the Distinction pill colours are tokens.
- `modules/11-candidate-ui` `MyCertificates.tsx`: Distinction colours are tokens (its snapshot changed, colour only).
- `apps/web/src/pages/try/TryCertificate.tsx`: raw colours and fonts are tokens.
- `apps/web/src/App.tsx:285`: `#3177dc` is now `var(--aiq-color-accent)`.

**Why.** The first full look with real data (long pack names, many rows, a phone width) showed clipping and overflow that the empty-state tests never showed. A token or primitive fix keeps the pages consistent and stops the same bug from returning.

**Considered and rejected.** Per-page fixes of each clipped cell (about 10 copies of one patch). A new shared PageHeader (see owner item 3). Changing button and input sizes in this pass (owner decision, item 1).

**NOT included (for the owner, numbered).**

1. Button height is 41 px and input height is 47 px against the 36 px target. The kit sets 10x18 and 12x16 padding. This is an owner decision.
2. The MyResults empty state is hand-rolled and left-aligned. The file was excluded because RW-80 edited it.
3. Admin pages still use inline h1 blocks instead of `PageHeader`. Modules 10 and 17 each have their own `PageHeader`.
4. Composite `Table` cells (candidate name plus erased chip) still clip without an ellipsis.
5. `/admin/mfa` redirects to login for a minted session.
6. Several files keep `--aiq-radius-full` and `var(--x, #hex)` fallbacks.
7. Empty rows on webhooks, audit log and reports are still one muted line.
8. `visual.spec.ts` baselines must be regenerated inside the Playwright image (a line is in `apps/web/e2e/README.md`).
9. The shared API dropped connections a few times during the run. The script retries.

Note: the pass agent saw an error on `/candidate/progress` for the seeded candidate. The cause was a local API process that started before the route existed. A restart returns 200. This is not a defect.

**Downstream impact.** Screenshots are local only: `docs/` is gitignored, so `docs/testing/screenshots/S15/` (`before/` 102 PNGs, `after/` 103, `CRITIQUE.md`, `overflow.json`, `state.json`) is not in the repository. The owner reviews them. `visual.spec.ts` baselines are stale until item 8 is done. Font-size rule: see [10-branding-guideline.md](10-branding-guideline.md) § 2.3.

## AdminShell help drawer and account card (Z-21, Z-6, Z-22, RW-82; S16, 2026-10-17)

**What changed.**
- **Help drawer.** `modules/10-admin-dashboard/src/components/AdminHelp.tsx` adds a top-bar trigger (`HelpDrawerTrigger`) and the shortcut Ctrl/Cmd+/. The drawer has two tabs: "This page" (entries under `<helpPage>.`) and "Guide". `openAdminGuide()` (line 19) opens it on the Guide tab through a window event, so pages need no props. It uses the ui-system `Drawer`. Known limit: `Drawer` closes on Escape but does not trap Tab.
- **Provider.** `AdminShell.tsx` (line 667) always wraps in `HelpProvider`; the fallback page is `admin.shell`.
- **Footer.** `MyAccountCard.tsx` replaces the plain user card. It shows a 2FA chip, "Regenerate recovery codes" (shared `RegenerateCodesModal.tsx`), enrol, and sign out. "Help guide" and "Account security" left `accountEntries`. Their routes stay.
- **Landmarks.** `<header>` (line 449), the breadcrumb `<nav>` (line 577) and the MFA notice as `<section aria-label="Security notice">` (line 567).
- **Print (Z-6).** `@media print` in `AdminShell.tsx` (line 365) releases height and overflow on html, body, shell, main column and main. It hides the sidebar, top bar, MFA nudge, breadcrumbs and drawer backdrop.
- **Z-22 links.** Dashboard "New assessment" goes to `/admin/assessments?new=1`. The Activity tab "Recent activity" links to `/admin/audit-log`. The attempts page filters by `?assessmentId=` with a clearable chip. Reports has a candidate search over `GET /admin/users?search=`.

**Why.** Admins had no in-page help and the guide hid under the account menu. The account area mixed navigation and account actions. Print review cut off after one page because the shell is a fixed-height scroll container.

**Considered and rejected.** The help-system `HelpDrawer` (one entry). A focus trap in `Drawer` (shared component; separate change). Moving the print rules to a global stylesheet (they depend on shell class names).

**Not included.** Tab trapping. A new endpoint for the reports search (reuses the Users param). Visual baselines: none are committed, so none were regenerated; this needs the Playwright image.

**Downstream impact.** Every admin page can open help. Test `apps/web/e2e/admin-help-print.spec.ts` asserts `page.pdf()` has more than one page; it is written and not run yet. Content source: `docs/07-help-system.md` section "Admin guide as help rows, S16".

## Candidate: question navigator filters, New chip, take landmarks (Z-8, Z-12, RW-82; S16, 2026-10-17)

**What changed.**
- **Navigator (Z-8).** `QuestionNavigator.tsx` has filters All, Flagged and Unanswered with counts, and Next/Previous flagged buttons that wrap around (line 123). The current square always stays visible (line 121). Limit: a flagged question that is also current shows as current, so the Flagged count leaves it out.
- **New chip (Z-12).** A result card shows "New" until it is at least 50% visible (IntersectionObserver). Then the page calls `POST /api/me/attempts/:id/seen`. The shell banner counts `is_new` results. The page no longer calls notification mark-read.
- **Landmarks (RW-82 tail).** Take pages have `<header>`, a breadcrumb `<nav>` and a notice `<section>`. Candidate notices sit inside `<main>`. Each take state has one visually hidden `<h1>` (`Attempt.tsx` lines 298, 322, 530).
- **Test gate.** `apps/web/e2e/a11y-authed.spec.ts` keeps `region` and `page-has-heading-one` as advisory until a run on the real stack shows zero.

**Why.** Long tests needed a way to find flagged and open questions. Mark-read on page load cleared "New" from every result at once.

**Considered and rejected.** Hide the current square under a filter (the candidate loses their place). Clear "New" on page load (the bug).

**Not included.** Visual baselines (none committed; needs the Playwright image). Counting a current flagged question as flagged.

**Downstream impact.** API and data: `docs/03-api-contract.md` (rows already present), `docs/02-data-model.md` (`attempts.seen_at`, migration 0193 with backfill of already released rows).

## Candidate: certificate rule line and phone sign-in alignment (Z-11 (c), Z-15 (b), (d); S17, 2026-10-17)

**What changed.**
- `CERTIFICATE_RULE_TEXT` (`modules/11-candidate-ui/src/copy.ts`) shows on the empty Certificates page. It also shows on `ResultSummary` when `certificate === null` and the percent is below 70. Commit `f9c569f`.
- `CandidateLogin.tsx` has a mobile-only rule, class `aiq-candidate-login-body`, so the sign-in form starts near the top on a phone. Commit `dd3b779`. Authentication is untouched.

**Why.** A candidate who scored 60% saw an empty page with no reason. On a phone the sign-in form sat low and needed a scroll before the keyboard opened.

**Considered and rejected.** Hide the Certificates page for candidates below 70% (the page is where they look). Put the rule only in an email (not seen on the page). Read the 70 from the server (the service floor may change in Z-16; a constant is simpler for now).

**Not included.** LinkedIn share (Z-11 a), admin row shortcut (Z-11 b), result-email link target (Z-15 a), result copy (Z-9). Tests: candidate-ui 137, web 88.

**Downstream impact.** The sentence hard-codes 70. If Z-16 changes the certificate rule, change the string in the same commit. See also `docs/10-branding-guideline.md` section 15.5.

## Question set page: search and facet filters (EXP-5, 2026-10-17)

**What changed.**
- `modules/10-admin-dashboard/src/pages/pack-detail/QuestionFilterBar.tsx` adds a filter bar above the levels on the question set page (`helpPage` `admin.question_bank.pack`). It has a search box (300 ms pause) and these controls: exam stage, subject, topic, subtopic, difficulty range, origin, rights, review, language, solution.
- Each option shows its count from `GET /api/admin/questions/facets`. A control ignores its own filter, so options do not disappear. A "Clear filters" button and a live total sit at the end of the bar.
- `pack-detail.tsx` re-loads the questions with the filters as query parameters (`GET /admin/questions?pack_id=...&q=...`). While no filter is used, only the first load runs.
- Help ids (all under `admin.question_bank.pack.`): `filter_search`, `filter_stage`, `filter_subject`, `filter_unit`, `filter_outcome`, `filter_difficulty`, `filter_origin`, `filter_rights`, `filter_review`, `filter_language`, `filter_solution`. Content in `modules/16-help-system/content/en/admin.yml`; production rows in migration `0197_exp5_facets_help.sql` (apply by hand, per docs/06).

**Why.** The super admin must review thousands of exam items by subtopic, difficulty, origin and review state, and find a question by its words (plan 2026-10-17, section 6). The server does the filtering so a page of 500 rows is not filtered in the browser.

**Considered and rejected.**
- Client-side filtering of the 500 loaded rows (it would hide the real totals and could not search the normalised text).
- A side panel with check boxes and a count for every node (a tree of hundreds of nodes does not fit; selects are enough for the first slice).
- Filter controls on the pack list page `question-bank.tsx` (it lists question sets, not questions; its search stays on name and slug).
- The existing framework tree filter stays as it is (RW-61); the new node selects list only nodes that have questions in this set.

**Not included.** Saved filters, a URL for the filter state, filters on the candidate side, multi-select values (the API accepts comma lists; the UI picks one value).

**Downstream impact.** Admin API clients that call `/admin/questions` keep working. No change to `LevelPanel`. Help ids are new, so the help seed has 11 more rows.

## AdminShell seven groups and tab strips (Z-23 session 1, 2026-10-18)

**What changed.** The tenant-admin sidebar has seven entries: Home, Assessments, Question bank, Reports, People, Integrations, Settings. The model lives in `modules/10-admin-dashboard/src/lib/admin-nav.ts` (`NAV_GROUPS`, `resolveActiveNav(pathname, search)`). A group is active when the URL is under any of its tabs (segment-aware prefix match). Each entry links to the first tab of its group. `components/TabStrip.tsx` draws a `nav` landmark with links; the current tab has `aria-current="page"`; the strip scrolls sideways on phones. `AdminShell` renders the strip above the page for groups with `strip: true`: **Assessments** (Assessments, Start a test, Attempts, Grading status, Certificates) and **Settings** (Organisation, Results, Data privacy, Plan and usage). Reports, People and Integrations got their strips in session 2 (below).

**Why.** Owner approved the 7 names and order on 2026-10-18 (`docs/plans/ADMIN_NAV_REVIEW_2026-10-17.md` section 3). Tabs keep every page and help id; only the sidebar and a strip change.

**Settings.** All four tabs share `/admin/settings`; the tab is `?tab=organisation|results|privacy|plan` (default organisation). `billing.tsx` shows Plan and usage for `plan` and `<TenantSettings embedded tab=...>` otherwise; both panels stay mounted so unsaved form state survives a tab switch. `TenantSettings` hides its own button row when it gets a `tab` prop (standalone `/admin/tenant-settings` keeps it). The inner "Company" label is now "Organisation". `/admin/settings/billing` redirects to `/admin/settings?tab=plan`.

**Routes and gates.** No route moved or was removed. All seven groups are admin-or-higher, the same as every `RequireSession role="admin"` guard in `apps/web/src/App.tsx`; nothing changed there. Generate questions and Generation history (super admin) sit under a "Content" label, Platform items unchanged. Help guide, Account security and Help content are outside the groups (no active entry).

**Rejected.** Collapsible groups (2026-05-20 decision). Per-tab routes for Settings (would need new URLs and redirects). `role="tablist"` buttons: each tab is a real URL, so links are the correct semantics.

**Not included.** Start a test as Home primary button (Z-24), Home checklist (Z-24), Z-46, (session 2 added the other strips and moved the Webhook secret card). Help ids unchanged in session 1.

**Verify.** `modules/10-admin-dashboard/src/__tests__/admin-nav.test.tsx`; `apps/web/e2e/signed-in-smoke.spec.ts` opens 21 old admin URLs; `a11y-authed.spec.ts` axe clean on `/admin` and `/admin/assessments`. **Rollback:** revert the commit; no data or route change.

## Reports, People and Integrations tab strips; Webhook secret move (Z-23 session 2, 2026-10-18)

**What changed.** `admin-nav.ts` sets `strip: true` on Reports (Reports, Activity), People (Users, Audit log) and Integrations (Webhooks, Embed). A test enforces "strip if and only if the group has more than one tab". The Webhook secret card (Regenerate, show or hide, copy, ConfirmDialog; `POST /admin/webhook-secrets/rotate`, secret shown once) moved from `embed-config.tsx` to `webhooks.tsx`, between the endpoint list and the delivery log. The Embed lede points to the Webhooks tab. The Activity inner tab was already renamed "Recent activity" with a link to the full audit log in Z-22; no further change.

**Why.** The webhook HMAC secret signs webhook deliveries, so it belongs with the endpoints, not with the embed signing secrets. Both pages had a "secret" card and admins confused the two keys (plan section 3).

**Help ids.** New keys in `modules/16-help-system/content/en/admin.yml`, all under the page's `helpPage` `admin.webhooks`: `admin.webhooks.secret` (card), `admin.webhooks.secret_value`, `admin.webhooks.secret_regenerate`. Migration `0204_z23_webhook_secret_help.sql` inserts them; the seed was regenerated; seeded count 510 to 513. The old row `admin.embed.webhook_secret` stays in the database (no page uses it now; rows are never deleted).

**Routes and gates.** No route moved. Every group stays admin-or-higher, matching `RequireSession role="admin"` in `apps/web/src/App.tsx` (unchanged).

**Two axe fixes found by the new a11y checks.** (1) `reports.tsx` list rows were `role="button"` containers that held a real "View report" button (nested-interactive). The rows are plain clickable divs now; the button is the keyboard target. (2) The Regenerate button no longer uses the red text colour (contrast 4.0 on white, needs 4.5); the red ConfirmDialog carries the warning.

**Rejected.** Keeping a copy of the card on Embed (two cards with one meaning). A link redirect (no URL changed).

**Not included.** Z-24 Home checklist, Z-46, Home primary button.

**Verify.** `admin-nav.test.tsx`; `signed-in-smoke.spec.ts` (all old URLs, strip marks the right tab, secret card only on Webhooks); `a11y-authed.spec.ts` axe on `/admin/reports` and `/admin/integrations/webhooks`. **Rollback:** revert the commit; migration 0204 only inserts rows and is harmless to leave.

## Question review page (EXP-18 part 2, 2026-10-18)

- **What.** New page `/admin/question-bank/:id/review` (`AdminQuestionReview`, `modules/10-admin-dashboard/src/pages/question-review.tsx`). A button "Review questions" on the question set page opens it. The page has the help page key `admin.question_bank.review`.
- **Layout.** Heading "Review questions." in the serif style, a mono meta line with the counts, a row of filter buttons ("Needs review" is the default, then In review, Needs fix, Disputed, Verified, Not set, All; each shows its count), then one card for each question. A card shows: topic, type and points; the review state and the rights status as pills; the question; the answer key (options with the correct ones marked, or the stored key fields, the rubric and the full content in disclosure blocks); the rationale; the source reference with a link when the URL starts with `https://`. Actions: Verify (primary), Needs fix (outline), Withdraw (ghost, danger colour).
- **Dialogs.** Needs fix opens a modal with a required note (max 1000 characters). Withdraw uses the confirm dialog (danger). "Verify all in this question set (N)" in the header uses the confirm dialog with the count; the request carries `expected_count`, so a changed count stops the action and the page shows the server message.
- **Who sees it.** Any admin. The server decides: the super admin reviews platform questions, an organisation admin reviews that organisation's questions. A refused call shows the server message in an alert line.
- **Words.** "Question set" for a pack (glossary, `docs/10-branding-guideline.md` § 2.5). No exclamation marks.
- **Help ids (6).** `admin.question_bank.pack.review`, `admin.question_bank.review.filter`, `.verify`, `.needs_fix`, `.withdraw`, `.verify_all`. They come from `modules/16-help-system/content/en/admin.yml` and the regenerated seed (no migration).
- **Considered and rejected.** Putting the actions into the existing pack page (the page is already long and the review task is its own flow). Inline editing of a question in the review card (the question editor exists). A diff view of a flagged question.
- **Not included.** Showing the saved Needs fix note on the card or in the question editor, keyboard shortcuts, a review queue across all question sets.
- **Downstream.** `apps/web/src/App.tsx` route (before `/admin/question-bank/:id`). API in `docs/03-api-contract.md` § "Question review routes".

## Exam blueprints page and passage filter (EXP-6 tail, EXP-5 tail, 2026-10-19)

**What changed.**
- New page `modules/10-admin-dashboard/src/pages/exam-blueprints.tsx` at `/admin/exam-blueprints` (super admin only; the App.tsx route is added by the owner). It lists every exam blueprint with a verified or unverified chip, the totals, and a table of its sections: questions, marks per question, negative marks, minutes and qualifying (with the cut-off mark). It has no edit controls.
- "Start full mock" on a blueprint opens a small form: question set (platform packs), level (from the pack) and opens at (local time). Submit calls `POST /api/admin/blueprints/:id/mock`. The draft id and warnings show in a status region; a server error shows in an alert region. Focus moves to the first field when the form opens. The toggle sets `aria-expanded` and `aria-controls`.
- API client `modules/10-admin-dashboard/src/api/exam-blueprints.ts` (list with sections, start mock). The older helpers in `src/api.ts` stay for the start-test page.
- Help ids (all under `admin.blueprints.`): `page`, `verification`, `sections`, `mock_form`, `start_mock`. Plus `admin.question_bank.pack.filter_passage` on the question set page (see below).
- Question set page: a "Passage" select (All, With passage, Without passage) in `QuestionFilterBar.tsx`, sent as `has_passage`. It has no counts, so it stays a plain select.

**Why.** Super admins check exam structure against the official notice before they run a mock, and they need to see the sections and the marks in one place. The passage filter lets an admin find questions that use a shared text (EXP-8).

**Considered and rejected.**
- Editing blueprints on this page (Z-51 admin fields are a separate row with an owner decision).
- A passage facet with counts (the filter is enough for now, and the facet endpoint would grow).
- A stage name in the card. The list returns only the stage id, so the card shows no stage label.

**Not included.** Blueprint edit or delete, the Z-51 fields (whole-test minutes, marks per section), the draw by outcome node (Z-43), other exams, and a link from the created draft to its assessment page.

**Downstream impact.** Help seed gets 6 new keys (seed only, as with EXP-18; production needs the help rows applied by hand, see docs/06). The help-system test count changes and must be updated by the owner in the same change. The API gains one optional query parameter, `has_passage` (docs/03).

## Review queue page and review controls (EXP-18, 2026-10-19)

**What changed.**
- New page `modules/10-admin-dashboard/src/pages/review-queue.tsx` (`ReviewQueue`) at `/admin/review-queue`. It lists the questions of all question sets in one table, with a tab for each review state and its count. A row shows the question set, topic, type, state, the latest note (first 140 characters) and the update time. "Open review" goes to the pack review page of that question set.
- Paging: 25 questions for each page, Previous and Next buttons, and a status line ("Showing 1 to 25 of 60 questions.").
- Pack review page (`pages/question-review.tsx`): a "Mark disputed" button on each card opens the same dialog as Needs fix. The note is required. The dialog title and button name change to match the action.
- Each card shows the latest review note under the question. A "Note history" button shows every note, newest first. An "Attempts on an older version" button loads the attempts that used an older version. It shows the total, the first five attempt ids and this sentence: "Marks are not changed. A correction creates a new version; attempts keep the version they used."
- API client `modules/10-admin-dashboard/src/api/review.ts`: queue, review notes, review action (verify, needs_fix, dispute, withdraw), affected attempts. The types are defined in this file. The module does not import types from the backend modules.

**Why.** Admins need one place to see every question that still waits for a check. The pack page needs the reason for the last change and the attempts that a correction does not change.

**Words and states.**
- "Question set" is the name of a pack. "Needs review" groups In review, Disputed and Needs fix. "Not set" means the question was made before the review step.
- Errors show the server message when the server sends one. Otherwise the page shows a plain sentence.

**Accessibility.**
- The state tabs are buttons with `role="tab"` and `aria-selected`. They work with the keyboard.
- The result line and the attempts panel use `role="status"` and `aria-live="polite"`. Errors use `role="alert"`.
- The note history and the attempts buttons set `aria-expanded` and `aria-controls`.

**Loading.** The queue loads when the page opens and when the state or the page changes. Each question card loads its notes once when it mounts and again after each action. The attempts load only when the panel opens.

**Help ids (9 new, seed only, no migration).** `admin.review_queue.page`, `.filter`, `.state`, `.latest_note`, `.open`, `.paging`, and `admin.question_bank.review.disputed`, `.note_history`, `.attempts`. Content is in `modules/16-help-system/content/en/admin.yml`. The seed is regenerated with `pnpm help:seed:regen`.

**Considered and rejected.**
- Loading the latest note for every question in one list call. The pack review contract does not return it, so the card loads its own notes. The server could add `latest_note` to the pack review items to remove these calls.
- Adding the queue as a tab in the question set page. The queue covers all sets, so it needs its own page.

**Not included.** Bulk actions in the queue, a filter by question set or topic, and a view of the answer key in the queue.

**Downstream impact.**
- Routes: `App.tsx` needs the `/admin/review-queue` route (role admin, as for the pack review route). `admin-nav.ts` needs a tab in the Question bank group. Both are added by the owner.
- The help-system test counts (`help-system.test.ts`) rise by 9 on a fresh DB, from 551 to 560.
- The API routes are in `docs/03-api-contract.md`. That file is changed by another session.
## Mock results page (Z-90, 2026-10-20)

`/admin/mock-results`, tab "Mock results" in the Reports group (between Reports and Activity). Component `modules/10-admin-dashboard/src/pages/mock-results.tsx`, `helpPage="admin.mock_results"`.

- Header carries a "Mock" label and an assessment filter (All mock assessments, or one).
- Four tiles: mock attempts, students, average score, completed.
- Sections, each with a help id: Weak and strong topics (`admin.mock_results.topics`, two ranked bar lists), Students (`.students`, table sortable by average), Trend (`.trend`, plain SVG line of average % per day, no chart library), Not taken (`.not_taken`, needs one assessment selected). The page id is `admin.mock_results.page`.
- Empty state: "No mock tests have been taken yet. Invite candidates to a Mock test to see results here."
- Read only: no export, no edit. Not included: per-question drilldown, practice tracks.

## Evaluation status: expected grading line (SP11, 2026-10-20)

- The Evaluation status page (`/admin/grading-jobs`) shows one muted line under the header: "Expect grading {turnaround}. Results appear after AssessIQ finishes the evaluation. If your organisation releases results by hand, you release them next." It uses the `evaluationTurnaroundText` field from `GET /api/admin/dashboard/queue` and the `admin.grading.jobs.eta_notice` help id (see `docs/03-api-contract.md`, SP11 note). Style: the page's existing `MUTED_SM` text, no new component.
