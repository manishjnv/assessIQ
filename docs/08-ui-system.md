# 08 — UI System

> Design tokens + component library + theming, all in one module. **You said you'll share a UI template** — when you drop it in, the integration plan in this doc tells us how to wire it into the token system without touching the rest of the platform.

## 0. Working agreement — the design-system kit is the canonical reference

**Every UI change starts at the design-system kit shipped in [`modules/17-ui-system/AccessIQ_UI_Template/`](../modules/17-ui-system/AccessIQ_UI_Template/) — *consult the kit, don't lift-and-shift it*.** The kit is now a complete brand contract, not just a visual reference. Read it in this order before any UI work:

1. [`AccessIQ_UI_Template/CLAUDE.md`](../modules/17-ui-system/AccessIQ_UI_Template/CLAUDE.md) — folder-local entry point + non-negotiables.
2. [`design-system/README.md`](../modules/17-ui-system/AccessIQ_UI_Template/design-system/README.md), [`tokens.md`](../modules/17-ui-system/AccessIQ_UI_Template/design-system/tokens.md), [`components.md`](../modules/17-ui-system/AccessIQ_UI_Template/design-system/components.md), [`patterns.md`](../modules/17-ui-system/AccessIQ_UI_Template/design-system/patterns.md), [`copy-and-voice.md`](../modules/17-ui-system/AccessIQ_UI_Template/design-system/copy-and-voice.md) — philosophy, exact values, recipes, layouts, voice.
3. [`screens/`](../modules/17-ui-system/AccessIQ_UI_Template/screens/) — reference JSX implementations (`login`, `dashboard`, `library`, `assessment`, `results`, `atoms`). Live preview: open [`AccessIQ.html`](../modules/17-ui-system/AccessIQ_UI_Template/AccessIQ.html) or [`component-gallery.html`](../modules/17-ui-system/AccessIQ_UI_Template/component-gallery.html).

This rule binds in three places:

1. **The kit is reference-only.** Per [`modules/17-ui-system/SKILL.md`](../modules/17-ui-system/SKILL.md): *"The designer-tool harness must never be imported by app code; port the screen JSX and atoms into typed components under `components/` on demand as features land."* No `import` from `AccessIQ_UI_Template/`, no `cp` of its `.jsx` files into `apps/web/`. ESLint `no-restricted-imports` blocks `**/AccessIQ_UI_Template/**` globally. Phase 3 bounce condition.

2. **The translation pattern is one-way: kit → typed components → live page.** When a screen exists in `screens/` for what you're building, port its structure into typed `modules/17-ui-system/src/components/` primitives first, then author the live page in `apps/web/src/pages/...` using only those typed imports + the production `--aiq-*` tokens (the kit's un-prefixed `--accent` / `--bg` / `--text` map to `--aiq-color-accent` / `--aiq-color-bg-base` / `--aiq-color-fg-primary` and so on — see [docs/10-branding-guideline.md § 0 step 4](./10-branding-guideline.md#0-working-agreement--the-design-system-kit-is-the-canonical-reference) for the full translation table). Visual fidelity to the kit is the contract; the API of the typed components stays stable across visual updates.

3. **If no screen, recipe, or pattern exists for what you're building, STOP.** Surface the gap before composing from primitives. Silently inventing a layout (the `apps/web/src/pages/admin/users.tsx` gap surfaced 2026-05-01 — no `users.jsx` in the template, page assembled ad-hoc) is a Phase 3 bounce condition because it produces drift across admin-side surfaces. Either request a new `screens/<name>.jsx` + a `design-system/components.md` recipe entry, or get explicit approval to compose from existing atoms with the diff reviewed against the kit.

The visual translation companion lives at [`docs/10-branding-guideline.md`](./10-branding-guideline.md) § 0 — it codifies the same rule with the five-step translation pattern. This doc covers the *system architecture* (token namespace, theming pipeline, embed posture, component library structure); `10-branding-guideline.md` covers the *visual translation* (kit → `--aiq-*` mapping, AssessIQ-specific deltas like the banded score model and light-mode lock); the kit itself is the *source of truth*. **When the three disagree, the kit wins, the branding guideline updates next, and this doc tracks the system-level implications last.**

This rule is encoded in memory at `branding-guideline-from-template.md` and `feedback-ui-template-canonical.md` so it survives across sessions.

## Architecture goals

1. **Token-driven** — colors, spacing, type, shadows, motion all defined as CSS custom properties. Components reference tokens, never hard-coded values.
2. **Per-tenant theming** — `tenants.branding` in DB → CSS vars at runtime → instant white-label.
3. **Two surfaces, shared primitives** — admin UI and candidate UI share atomic components (Button, Input, Card) but compose them into different layouts. No duplicate Button implementations.
4. **Embed-friendly** — when `?embed=true`, host can override tokens via `postMessage`. Component code doesn't change; tokens do.
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
  --aiq-color-bg-sunken:     #f5f5f5;
  --aiq-color-fg-primary:    #1a1a1a;
  --aiq-color-fg-secondary:  #5f6368;
  --aiq-color-fg-muted:      #9aa0a6;
  --aiq-color-border:        #e8e8e8;
  --aiq-color-border-strong: #d4d4d4;

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
  --aiq-color-fg-secondary:  #a0a0a8;
  --aiq-color-fg-muted:      #6a6a72;
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

The UI template arrived on 2026-04-30 and has been adopted as the brand base. It lives at `modules/17-ui-system/AccessIQ_UI_Template/` (folder name is a typo — product is *AssessIQ*) and the canonical visual contract — typography, palette, component idioms, screen-layout templates, motion, voice — is captured in `docs/10-branding-guideline.md`. **Read that guideline before designing or coding any new page.**

What's live (Phase 0 G0.B Session 3 — 2026-05-01):

1. **Token namespace ported.** `styles.css` → `modules/17-ui-system/src/styles/tokens.css` with all `--*` custom properties renamed to `--aiq-*` and all utility classes prefixed `aiq-` (`.aiq-screen`, `.aiq-serif`, `.aiq-mono`, `.aiq-num`, `.aiq-btn{,-primary,-outline,-ghost,-sm,-lg}`, `.aiq-input`, `.aiq-card`, `.aiq-chip{,-accent,-success}`, `.aiq-mark` + `.aiq-mark-dot`, `.aiq-grid-bg`, `.aiq-divider`). Light + dark mode + density variants (`compact` / `cozy` / `comfortable`). `prefers-reduced-motion` override included.
2. **Phase-0 component library** at `modules/17-ui-system/src/components/`: `Button` (pill; `primary`/`outline`/`ghost` × `sm`/`md`/`lg` + `leftIcon`/`rightIcon`/`loading`), `Card` (no shadow at rest; `interactive` and `floating` flags), `Field` plus `Input`/`Label`/`FieldHelp` (label-above, focus halo, `aria-invalid`/`aria-describedby` wiring), `Chip` (`default`/`accent`/`success` with `success` defaulting to a `check` icon), `Icon` (22-name typed SVG sprite with aria-label/aria-hidden conditional), `Logo` (mark + halo + serif "AssessIQ" wordmark — case-sensitive; the template's "AccessIQ" typo is intentionally not propagated), `Num` + `useCountUp` (cubic-out RAF loop, reduced-motion respected). All exported from the package barrel `@assessiq/ui-system`.
3. **`ThemeProvider`** at `modules/17-ui-system/src/theme/ThemeProvider.tsx`. Reads a static fixture (`fixtures/tenants.ts`) for Phase 0; injects `--aiq-color-accent{,-soft,-hover}` overrides on a wrapper `<div>` and toggles `data-theme`/`data-density`. SSR-safe `matchMedia` for `system` theme. Live tenant wiring to `tenants.branding` JSONB lands in Phase 1 alongside `02-tenancy`.
4. **Vite + React 18 + TypeScript SPA** at `apps/web/`. Token css imported via `@assessiq/ui-system/styles/tokens.css`. Tailwind installed for layout utilities only — editorial styling stays on the `aiq-*` classes; Tailwind theme reads `--aiq-font-*` and `--aiq-radius-*` from the same vars. `tsc -b && vite build` green.
5. **Storybook 8** at `apps/storybook/` with `@storybook/react-vite`. One story per component covering the main variants. `withThemeByDataAttribute` decorators for `data-theme` and `data-density` toolbars. Stories live next to components (`<Component>.stories.tsx`).

What's live (UI v1.1 port — 2026-05-13):

1. **Phase 1 — Token migration** (`b95df19`). 7 light-mode token values aligned to kit v1.1 (`--aiq-color-fg-primary` `#1a1a1a` → `#0a0a0b`, etc.) + `.aiq-serif` font-weight 400 → 500 + dark-mode hierarchy preservation.
2. **Phase 2 — Atom refresh** (`57ddf12`). 5 component updates, all additive: `Chip` `warn` variant; `Sparkline` `<polyline vector-effect="non-scaling-stroke">` at 1.2px; `ScoreRing` 1600ms stroke-dashoffset transition; `StatCard.breakdown` prop renders stacked-bar + colored legend (uses `--aiq-color-chart-{1..8}` palette); `Sidebar` 240px width + `footer?` slot + `SidebarSection` sub-component.
3. **Phase 3a — Easy primitives** (this commit). Three new primitives + first axe a11y wiring in the module:

   | Component | Props | CSS classes | Tests |
   | --- | --- | --- | --- |
   | `Spinner` | `size?: "sm" \| "md" \| "lg"`, `aria-label?: string` (default `"Loading"`) | `.aiq-spinner{,-sm,-lg}` + `@keyframes aiq-spin` (`prefers-reduced-motion` slows to 1.5s) | 5 |
   | `ProgressBar` | `value: number`, `max?: number` (default 100), `height?: 2 \| 4 \| 6` (default 4), `variant?: "accent" \| "success" \| "fg"`, `label?: string` | `.aiq-progress-bar` + `.aiq-progress-bar-fill` with `[data-height]` / `[data-variant]` selectors | 6 |
   | `Placeholder` | `width?: number \| string`, `height?: number \| string`, `radius?: number \| string`, `caption?: string` (default `"image"`) | `.aiq-placeholder` (striped diagonal `repeating-linear-gradient`) | 6 |

   ARIA: `Spinner` is `role="status" aria-live="polite"`; `ProgressBar` is `role="progressbar"` with `aria-valuenow/min/max`; `Placeholder` is `role="img"` with `aria-label` from caption. `ProgressBar` clamps `value` to `[0, max]`. `Placeholder` honors consumer `style` overrides via spread ordering.

   **Test infra:** `vitest` + `vitest-axe` + `@testing-library/react` + `jsdom` added as devDeps. `vitest.config.ts` (jsdom env), `vitest.setup.ts` (axe matchers + cleanup), `src/test-setup.d.ts` (vitest-axe@0.1.0 `Vi` namespace → vitest v2 `declare module "vitest"` patch). One axe assertion per primitive — precedent for the rest of the v1.1 port (17/17 tests green).

What's live (UI v1.1 Phase 3b — 2026-05-13):

Activity-screen primitives. All three sourced from [`AssessIQ_UI_Template/screens/activity.jsx`](../modules/17-ui-system/AssessIQ_UI_Template/screens/activity.jsx); none import from the kit (translated manually, ESLint blocks kit imports). All use the production `--aiq-color-chart-{1..8}` palette (NOT the kit's hardcoded `ACT_COLORS` hex array — the two palettes intentionally differ; production is Google-brand-anchored, kit is Tailwind). Each ships with one `axe(container)` assertion in its `.test.tsx` per the Phase 3a precedent.

| Component | Props | CSS / tokens | Tests |
| --- | --- | --- | --- |
| `ActivityHeatmap` | `data: number[]` (0–4 column-major), `weeks?: number` (default 52), `monthLabels?: string[]`, `dayLabels?: string[]` (default `["M","W","F"]`), `streakSummary?: string`, `legendLessLabel?` / `legendMoreLabel?`, `aria-label?`, `data-test-id?`, `className?` | Five new tokens added to `tokens.css`: `--aiq-color-heatmap-{0..4}`. Level 0 is mapped to `--aiq-color-bg-sunken` (auto-tracks dark mode); 1–4 are explicit `oklch()` stops on hue 258 (matches `--aiq-color-accent`). Pure CSS grid; no chart lib. Out-of-range data values clamped to `[0, 4]`; `data.length < weeks*7` zero-pads, longer truncates. | 7 (incl. axe) |
| `StackedBarChart` | `bars: StackedBarChartBar[]`, `colors?: string[]` (defaults `--aiq-color-chart-{1..8}`), `seriesLabels?: string[]`, `yAxisLabels?: string[]`, `xAxisStartLabel?` / `xAxisEndLabel?`, `height?: number` (default 200), `gap?: number` (default 4), `aria-label?`, `data-test-id?`, `className?` | Pure div/flex; no chart lib (anti-pattern guard). Per-bar height = `sum(segments) / max(totals)`; per-segment share = `segment / sum`. Empty bars (total = 0) render at 0 height — no NaN. Y-axis labels positioned absolutely at `top: i/(n-1)*100%`; chart reserves `paddingLeft: 36` when `yAxisLabels` present. Segments at `opacity: 0.85` (matches kit). | 6 (incl. axe) |
| `LeaderboardList` | `items: LeaderboardListItem[]`, `columns?: 1\|2` (default 2), `colors?: string[]` (defaults `--aiq-color-chart-{1..8}`), `onShowMore?: () => void`, `showMoreLabel?: string`, `data-test-id?`, `className?` | Renders as semantic `<ol>` with `listStyle: none` (rank order conveyed both visually and via DOM order). Rank avatar = 32×32 outer ring at `opacity: 0.18` + 12×12 inner solid dot. **Avatar opacity fix vs kit**: the kit nests the inner dot inside the 0.18-opacity outer div, which cascades opacity and makes the dot semi-transparent too. Production splits them: outer is `position: absolute; inset: 0` with the opacity; inner is `position: relative` at full opacity. Show More uses the existing `Button` with `variant="ghost" size="sm"`. | 6 (incl. axe) |

ARIA: `ActivityHeatmap` and `StackedBarChart` are `role="img"` with `aria-label`; their decorative day-labels / month-labels / y-axis labels are `aria-hidden`. `LeaderboardList` is a native `<ol>` so screen readers convey ranked order; avatars are `aria-hidden` (decorative).

The new components are exported from `@assessiq/ui-system` and ready for Phases 11 (admin `/activity`) + 12 (candidate `/activity`) page consumers.

---

What's live (UI v1.1 Phase 5 — 2026-05-14):

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
| `StatCard.breakdown` prop | Would need categorical breakdown data (e.g. by domain); queue items have only status |
| 4th stat card | Kit's "Time saved via auto-grading" derives from AI grading stats; no endpoint for it yet |

**Token decisions:** All tokens already present from Phases 1–3. No new tokens added. `fontSize: 10` (bare numeric, not `"10px"`) used for role label — smallest mono size, no `--aiq-text-xxs` token exists; matches the existing `SidebarSection` pattern.

**Verification:** `pnpm -C modules/10-admin-dashboard typecheck` ✓, `pnpm -C apps/web typecheck` ✓, `pnpm -C modules/17-ui-system typecheck` ✓. Zero hex colors in diff. Zero `px`/`rem` string literals in diff. Zero secrets. `assessiq-frontend` healthy on VPS; `/admin/dashboard` → HTTP 200.

What still needs to happen, on demand as later v1.1 phases land:

1. **Phase 4–8 — Page refreshes** against kit screens (auth, dashboard, take flow, list pages, results/reports).
2. **Phase 9–12 — Activity feature** (backend endpoints + `/admin/activity` + `/candidate/activity` consumer wires).
3. **Domain composites** — `QuestionCard`, `KqlEditor`, `RubricEditor`, `BandPicker`, `AnchorChip`, `GradingProposalCard`. Map onto the existing branding idioms.
4. **Visual regression baseline** as components land.
5. **Self-host fonts** if Phase 1 perf budget needs it — current build uses the Google Fonts `<link>` in `apps/web/index.html`.
6. **Live tenant theme resolver** wired to `tenants.branding` JSONB once `02-tenancy` exposes the API.

The reference template files (`design-canvas.jsx`, `tweaks-panel.jsx`, `AccessIQ.html`, `.design-canvas.state.json`) are the omelette/Claude design-canvas wrapper that produced the template — useful for visual reference (open the HTML to see all screens) but **must not be imported by production code**. Enforcement: ESLint flat config has `no-restricted-imports` blocking `**/AccessIQ_UI_Template/**` globally; CI's no-template grep verifies.

## Storybook

Run `pnpm storybook` locally. Every primitive and composite has stories covering:
- Default state
- All size variants
- All intent/variant variants
- Disabled, loading, error states
- RTL (right-to-left) — for future Hindi/Arabic support
- Dark mode
- Keyboard focus

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

apps/web/                              # Vite + React 18 + TS SPA host (not yet routed)
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
