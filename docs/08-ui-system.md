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

1. **Phase 6b — Attempt page** against `kit/screens/assessment.jsx` — timer header, question navigator, integrity banner.
2. **Phase 7–8 — List pages + results/reports** against kit screens.
3. **Phase 10/12 — Candidate Activity backend + wire.**

The reference template files (`design-canvas.jsx`, `tweaks-panel.jsx`, `AccessIQ.html`, `.design-canvas.state.json`) are the omelette/Claude design-canvas wrapper that produced the template — useful for visual reference (open the HTML to see all screens) but **must not be imported by production code**. Enforcement: ESLint flat config has `no-restricted-imports` blocking `**/AccessIQ_UI_Template/**` globally; CI's no-template grep verifies.

What's live (UI v1.1 Phase 6a — 2026-05-14):

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

---

What's live (UI v1.1 Phase 7a — 2026-05-14):

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

---

What's live (UI v1.1 Phase 7b — 2026-05-14):

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

---

What's live (UI v1.1 Phase 8a — 2026-05-14):

Applied Spinner loading state + count Chip + serif h1 + lede to the two results/reports detail pages. Commit `86f7de3`.

| File | Change |
| --- | --- |
| `modules/10-admin-dashboard/src/pages/cohort-report.tsx` | Added `Chip, Spinner` imports. Replaced "Loading…" div with centered `<Spinner>`. Replaced mono meta line (cohort name) with count Chip `{N} candidate(s)` + h1 "Cohort Report." + lede "Score distribution and archetype breakdown across all scored attempts." |
| `modules/10-admin-dashboard/src/pages/attempt-detail.tsx` | Added `Chip, Spinner` imports. Spinner loading state. Status Chip (attempt.status) above h1 displaying `{attempt.assessment_name}.` Mono meta row below: `candidate_email · level_label · submitted_at`. |

---

What's live (UI v1.1 Phase 8b — 2026-05-14):

Applied Spinner + count Chip + serif h1 + lede to individual report and reports landing. Commit `378c93d`.

| File | Change |
| --- | --- |
| `modules/10-admin-dashboard/src/pages/individual-report.tsx` | Added `Chip, Spinner` to existing Sparkline/StatCard import. Spinner loading state. Count Chip `{N} attempt(s)` + h1 `{report.email}.` + lede "Attempt history and progression for this candidate." |
| `modules/10-admin-dashboard/src/pages/reports.tsx` | Added `Spinner` import. Replaced "Loading…" in `ReportSection` with `<Spinner size="sm">`. Added lede below existing h1: "Cohort summaries and per-candidate progression across all assessments." |

---

What's live (UI v1.1 Phase 12 — 2026-05-14):

Spinner loading states for all 4 async sections in CandidateActivity. Commit `b0a512d`.

| File | Change |
| --- | --- |
| `modules/11-candidate-ui/src/components/CandidateActivity.tsx` | Added `Spinner` to existing ui-system import (StatCard, ActivityHeatmap, StackedBarChart, LeaderboardList). Replaced 4 "Loading…" inline divs — statsLoading, heatmapLoading, timelineLoading, leaderboardLoading — with `<Spinner size="sm" aria-label="Loading [section]" />`. |

---

What's live (UI v1.1 Phase 13 — 2026-05-14):

Kit treatment for settings + low-traffic admin pages. Commit `e624184`.

| File | Change |
| --- | --- |
| `modules/10-admin-dashboard/src/pages/generation-attempts.tsx` | Added `Chip, Spinner` imports. Count Chip + h1 text-3xl "AI generation history." (period added). Spinner in table td loading cell. |
| `modules/10-admin-dashboard/src/pages/certificates.tsx` | Added `Chip, Spinner` imports. Count Chip + h1 text-3xl "Certificates." Spinner in table td loading cell. |
| `modules/10-admin-dashboard/src/pages/help-content.tsx` | Added `Spinner` to existing Modal import. Spinner replaces "Loading…" div. h1 already correct (text-3xl, "Help content.", period present). |
| `modules/10-admin-dashboard/src/pages/question-editor.tsx` | Added `Spinner` import. Full-page loading state → centered `<Spinner>`. Two h1s upgraded: text-2xl → text-3xl, period appended — "New question." and "Edit rubric." |

**Not changed (Phase 13):** `guide.tsx` doesn't exist as a separate page file — `<AdminGuide>` is wrapped by App.tsx externally with `<AdminShell>`; no file to modify.

---

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

## Super-admin Platform page (2026-05-17)

### `/admin/platform` — company provisioning

Route: `apps/web/src/App.tsx` → `<Route path="/admin/platform" element={<RequireSession role="super_admin"><AdminPlatform /></RequireSession>} />`

Component: `modules/10-admin-dashboard/src/pages/platform.tsx` → `export function AdminPlatform()`

**`RequireSession role="super_admin"` exact-match semantics:** when `role="super_admin"` is passed, only a session with `session.user.role === "super_admin"` is admitted. A plain `admin` is redirected to `/admin/login`. This is asymmetric with all other role gates (`admin`, `reviewer`) where `super_admin` satisfies the gate — because `super_admin` is a platform-level role above the tenant hierarchy, not a peer of admin. The asymmetry is documented with a code comment in `apps/web/src/lib/RequireSession.tsx`. The backend enforces the real gate; this is FE defense-in-depth.

**Nav entry:** `AdminShell` renders a "Platform" nav entry in the Account section with `superAdminOnly: true`. Tenant admins (`role === "admin"`) do not see this entry.

**Page pattern:** mirrors `users.tsx` exactly — `AdminShell breadcrumbs={["Platform"]}`, serif h1 `Companies.`, count Chip, `listTenantsApi()` on mount, `Spinner` / error Chip / empty-state card / read-only zebra table (columns: slug mono, name, status Chip, created en-GB date).

**Create-company modal:** fixed-position Card with backdrop, required fields (name, slug, admin email), collapsible Advanced section (domain, admin display name). Slug auto-derived from name; client-side `[a-z0-9-]+` validation. MFA step-up sub-state on `401 AUTHN_FAILED` + message `/fresh totp/i` — preserves all entered form values, calls `verifyTotpApi`, refreshes session via `fetchAdminWhoami(true)`, auto-retries `createCompanyApi`. No secrets stored beyond the transient 6-digit TOTP code (cleared on success/close).

**Tenant lifecycle (Manage menu + confirmation modal):** each tenant row carries a `Manage ▾` dropdown (`ManageMenu`, rendered via `createPortal` to `document.body` so it escapes the table's `overflow:hidden`; closes on outside-click / scroll / resize). It offers Open billing, Manage users, and **status-aware** lifecycle actions: Suspend + Archive (when `active`), Resume + Archive (when `suspended`), Unarchive (when `archived`), and a non-actionable "Provisioning in progress" note (when `provisioning`). Selecting a lifecycle action opens `LifecycleConfirmModal` with action-specific copy, an optional **Reason** textarea (≤500 chars, recorded in the audit log) and a confirm button; success surfaces a toast with the idempotent-no-op state or the `sessionsRevoked` count. The four lifecycle endpoints are gated server-side by **fresh MFA** (TOTP within 15 min — `superAdminFreshMfa` on `apps/api/src/routes/admin-super.ts`), so as of **2026-05-24** the modal carries the same **MFA step-up sub-state** as Create-company: a stale-MFA `401` + `/fresh totp/i` flips it in-place to `MfaStepUp` (lifecycle-specific `prompt` + a `Verify & {action}` `confirmLabel`), then on `onVerified` auto-retries the original action with the typed reason preserved. The page-level `handleLifecycleConfirm` re-throws **only** that fresh-MFA 401 (narrow `status===401 && /fresh totp/i` match) so the modal owns recovery; every other error (incl. `INVALID_LIFECYCLE_TRANSITION`) surfaces as a page-level Chip and closes the modal. `MfaStepUp` is shared by Create-company, Edit-admin, and the lifecycle modal — its `confirmLabel` defaults to `"Verify & create"` so the first two are unchanged.

**Help page key:** `admin.platform` (wired via `AdminShell helpPage="admin.platform"`). Field-level keys: `admin.platform.slug`, `admin.platform.admin_email`, `admin.platform.domain`, `admin.platform.admin_name`, `admin.platform.mfa_code`.

---

## Admin list-page kit alignment + Table grid fix (2026-05-21)

A design review of `/admin/attempts` and `/admin/question-bank` against [`docs/10-branding-guideline.md`](./10-branding-guideline.md) uncovered a load-bearing render bug in the shared `Table` primitive plus several drift points from the kit. Shipped in commit `8558750`.

### `Table` width contract — **numbers are pixels, strings pass through**

Source: [`modules/17-ui-system/src/components/Table.tsx`](../modules/17-ui-system/src/components/Table.tsx).

**Root cause that motivated the fix:** the previous `String(c.width)` stringified a numeric column hint (e.g. `width: 80`) into a unitless CSS grid track length (`"80"`). Browsers reject that as invalid `grid-template-columns`, the declaration is discarded, and the body grid collapses to a single implicit column — every header + cell stacks vertically. The bug silently affected every page using the primitive (attempts, question-bank, assessments, dashboard, assessment-detail).

**Contract now:**

| `ColumnDef.width` value | Output track |
| --- | --- |
| `number` (e.g. `80`) | `"80px"` — bare numbers are pixel lengths |
| `string` (e.g. `"1fr"`, `"minmax(120px, 1fr)"`, `"auto"`) | passed through verbatim |
| `undefined` / `null` / `""` / `0` | `"1fr"` (default; share remaining space equally) |

Callers should keep using `width: 80` for pixel hints — no migration needed. The fix is in the primitive.

### Click-to-sort columns (2026-05-21)

The shared `Table` already supports sorting via the `sortable` (per-column), `sortBy`, `sortDir`, and `onSort` props — but it only **emits** the sort event in `onSort`; it does not reorder `data` itself. Admin list pages full-fetch their rows (`pageSize 100`), so they sort **client-side** over the loaded page rather than re-fetching. The shipped pattern (commit `ef9d2d8`) is identical across pages:

- A module-level `sortRows<T>(rows, key, dir)` helper: keys ending in `_at` compare as dates, numeric columns numerically, everything else case-insensitive string. Keep it page-local (a duplicated ~15-line helper) rather than a shared lib import — a prior shared-lib extraction on this module caused a parallel-agent file race.
- `sortBy` defaults to `""` (no active column) so first paint matches the server's fetch order; `const sortedRows = useMemo(() => sortBy ? sortRows(items, sortBy, sortDir) : items, …)`.
- Wire `data={sortedRows}` `sortDir={sortDir}` `onSort={(k,d)=>{setSortBy(k);setSortDir(d);}}`, and pass `sortBy` via the spread `{...(sortBy ? { sortBy } : {})}` — passing `sortBy={undefined}` is a type error under `exactOptionalPropertyTypes`.
- Mark `sortable: true` on every data column **except** action/empty-label columns and columns whose value is a composite object the generic comparator can't order (e.g. assessments' "Invited" `{ total, … }`).

Live on: Question Bank, Attempts, Assessments, Dashboard grading queue, and Assessment-detail invitations.

**Server-paginated tables sort server-side instead.** `certificates.tsx` and `generation-attempts.tsx` use native `<table>` markup with `limit`/`offset` + "Load more", so client-side sort would only reorder the loaded page. They send `sort`/`dir` query params to the API (which maps the key through a fixed `ORDER BY` allowlist — `ORDER BY` can't be parameterized) and **refetch from `offset 0`** on header click. Clickable `<th>`s carry the same `▲`/`▼` affordance. See `docs/03-api-contract.md` for the per-endpoint sort allowlists. Rule of thumb: full-fetch list → client-side `sortRows`; paginated list → server-side allowlisted sort.

### Shared admin formatters (`modules/10-admin-dashboard/src/lib/`)

Two small helpers consolidate display logic that was previously duplicated inline on each list page. New pages MUST use these instead of re-inventing per-page status switches or `toLocaleString()` calls.

| Helper | Source | Purpose |
| --- | --- | --- |
| `attemptStatusDisplay(status)` | [`lib/status.ts`](../modules/10-admin-dashboard/src/lib/status.ts) | Maps attempt enum (`submitted`/`auto_submitted`/`pending_admin_grading`/`graded`/`released`) → `{ label, ChipVariant }`. Operators see "Pending grading", not `PENDING_ADMIN_GRADING`. |
| `packStatusDisplay(status)` | [`lib/status.ts`](../modules/10-admin-dashboard/src/lib/status.ts) | Same shape for pack enum (`draft`/`published`/`archived`). |
| `formatTimestamp(iso)` | [`lib/format.ts`](../modules/10-admin-dashboard/src/lib/format.ts) | `"21 May 2026 · 23:17"` — mid-dot separator, en-GB month, 24h (`hourCycle: "h23"`) so display is locale-stable across operators. Per branding §2.4. |
| `formatDate(iso)` | [`lib/format.ts`](../modules/10-admin-dashboard/src/lib/format.ts) | `"21 May 2026"` — date-only variant for created-at columns. |

Status rendering composes with the `Chip` primitive: `const s = attemptStatusDisplay(row.status); return <Chip variant={s.variant}>{s.label}</Chip>;`.

**Question Bank list — Status column (added 2026-05-25).** The `/admin/question-bank` pack list previously had **no status column**, so an admin couldn't tell draft / published / archived packs apart in the list (only the per-pack detail page showed a status pill). A sortable **Status** column now sits between Domain and Questions, rendered via the canonical `packStatusDisplay(row.status)` → `<Chip variant={s.variant}>` pattern above — not a hand-rolled colour map. This pairs with the same-session archive fix (`docs/RCA_LOG.md` 2026-05-24): archiving a draft pack now works *and* is visible in the list. The detail page still uses its own inline `packStatusColor` span (pre-existing drift) — harmless, but a future consolidation could route it through `packStatusDisplay` too.

**Pack detail — "Activate all" → "Activate drafts", conditional (2026-05-25).** Publishing a pack now auto-activates its `draft` questions (see `docs/03-api-contract.md` publish row), so the per-level activate button is no longer the primary path. It's renamed **"Activate drafts"** and only renders when that level actually has `draft` questions (`levelQs.some(q => q.status === "draft")`) — previously it showed on every published pack regardless, which read as a dead button on a fully-active pack (the reported confusion: "Published" + "Activate all" looked contradictory). The two axes are still distinct — pack status (draft/published/archived) vs question status (ai_draft/draft/active/archived) — but the common case (publish → everything usable) no longer needs a second click.

**Inline button help — Wave 1 (2026-05-25).** Action buttons now carry `<HelpTip helpId>` (hover tooltip from `short_text` + a (?) icon opening the help drawer with `long_md`). Wave 1 covers the two Question Bank pages: the **list** (`admin.question_bank.list.new_pack`, `…list.add_to_workspace`) and **pack detail** (`admin.question_bank.pack.{generate,publish,archive,activate_drafts}`). Content lives in `content/en/admin.yml` and ships to prod via forward migration `0093_seed_question_bank_button_help.sql` (the `0011` canonical seed was regenerated for source-sync; new rows reach prod via the forward migration, same pattern as 0089/0092). **Reminder (the `HelpProvider` prefix rule):** a button's `helpId` MUST sit under its page's `helpPage` prefix or `listHelpForPage` (`key LIKE '<page>.%'`) won't fetch it and `HelpTip` silently renders nothing — list page is `admin.question_bank.list`, pack detail is `admin.question_bank.pack`. Remaining admin pages (Assessments — note its create-form keys are under `admin.assessments.create.*` while the page prefix is `admin.assessments.list`, a mismatch to reconcile — Attempts, Grading, Reports, Certificates, Users, Platform, Billing, Dashboard) are follow-up waves.

**Inline button help — Wave 2 (2026-05-25).** Covered the assessment-lifecycle + certificates action buttons: assessments → **Create assessment**; assessment-detail → **Publish**, **+ Invite candidates**; certificates → **Revoke**, **Reissue**. Key insight applied: `data-help-id` attributes are **inert markers** — only `<HelpTip>` renders visible help — and most of these buttons already had content keys (`admin.assessments.publish`, `.invite.bulk`, `admin.certificates.revoke`, `.reissue`) that simply weren't loading because the page's `helpPage` was a deeper prefix than the key. So Wave 2 **broadened the `helpPage` prefix** (`admin.assessments.detail`/`.list` → `admin.assessments`; `admin.certificates.list` → `admin.certificates`) so the existing content is fetched, then wrapped the buttons in `HelpTip`. Only ONE new key was authored (`admin.assessments.create.submit`, migration `0094`). **Lesson for future waves: prefer broadening `helpPage` to reuse existing content over authoring duplicate keys; remember `data-help-id` alone shows nothing.** Still-remaining pages (Attempts, Grading, Reports, Users, Platform, Billing, Dashboard, Activity) are later waves — several already have `data-help-id` content that just needs a `helpPage` broaden + `HelpTip` wrap.

**Question Bank list — three follow-ups (2026-05-25).** (1) **Row `⋯` menu rendered via portal.** `RowOverflowMenu` previously used `position:absolute`, which the packs table's `overflow:hidden` (rounded corners) clipped — the Archive menu silently never appeared. It now mirrors `platform.tsx`'s `ManageMenu`: `createPortal` to `document.body`, anchored via `getBoundingClientRect` with `position:fixed`, `zIndex:1000`, closing on outside-click / Esc / scroll / resize. **Recurrence class:** any row-level popover inside a table with `overflow:hidden` MUST portal out — see the same note on ManageMenu (§ Super-admin Platform page). (2) **Levels column** between Status and Questions, sourced from a new `level_count` on `GET /admin/packs` (0 rendered muted — flags a pack with no levels yet). (3) **Default filter is now Published**, not All: a one-time, ref-guarded mount effect sets `?status=published` when no `status` param is present, so the list opens on live content; clicking **All** (which clears the param) is still respected and never bounced back.

### Question & answer content renderers (never raw JSON)

Any admin surface that displays a frozen question or a candidate's submitted answer MUST render a typed, human-readable layout — **never** `JSON.stringify` the stored payload into a `<pre>`/text node. Two renderers own this:

| Renderer | Source | Renders |
| --- | --- | --- |
| `QuestionContentView` | [`components/QuestionContentView.tsx`](../modules/10-admin-dashboard/src/components/QuestionContentView.tsx) | A frozen question's `content`, switched by type (`mcq`/`subjective`/`kql`/`scenario`/`log_analysis`). Strips JSON-escape + markdown noise via `cleanText()`; for MCQ highlights the correct option (✓) and shows the rationale. Genuinely malformed/unknown content degrades to a styled JSON fallback (debug aid, not the normal path). |
| `AttemptAnswerView` | [`pages/attempt-detail.tsx`](../modules/10-admin-dashboard/src/pages/attempt-detail.tsx) | A candidate's submitted answer, switched by question type (mcq → selected letter + option text + ✓/✗ vs the key; subjective → response prose; kql → query in a mono block; log_analysis → findings list + explanation; scenario → per-step responses). Empty answers show "No answer submitted."; unrecognised shapes show a readable message, never braces. |

**History (2026-05-22):** until this date the attempt-detail page used a local `QuestionContent`/`AnswerContent` pair that did `typeof x === "string" ? x : JSON.stringify(x, null, 2)`. Question `content` and every answer shape are objects, so the JSON branch always fired — every question and answer rendered as a raw `{ "correct": 0, "options": [...] }` blob (the reported bug). The page now delegates the question to the shared `QuestionContentView` and the answer to `AttemptAnswerView`. The candidate take-flow was never affected (it renders field-by-field) and answer-key fields are stripped server-side before reaching candidates (`sanitizeContentForCandidate`, see `docs/RCA_LOG.md` 2026-05-16). The correct-option/rationale display in `QuestionContentView` is therefore **admin-only and intentional** — do not reuse it on a candidate-facing surface without re-gating those fields.

### Attempt-detail — grading summary + Accept-all (2026-05-28, commit `defb9f9`)

The attempt-detail page now surfaces grading progress at the top, between the header and the per-question cards, whenever there is at least one fresh proposal OR at least one accepted gradings row. The panel is hard-tied to the backend completion-gate (see `docs/05-ai-pipeline.md` § Accept-all + completion-gate, and `docs/03-api-contract.md` `/admin/attempts/:id/accept`).

| Element | Purpose |
| --- | --- |
| `Graded` line | `{acceptedDistinct} of {N} ({M} AI-gradeable)` — N = frozen question count; M = subset whose `type ∈ {subjective, scenario, log_analysis}`. acceptedDistinct counts non-overridden rows. Drives the admin's mental model of "why isn't this attempt finishing." |
| `Score` line | Sum of `score_earned / score_max` across non-overridden gradings. Hidden when no gradings exist yet. |
| Per-question status chips | One chip per frozen question, labelled `Q{idx} graded` / `Q{idx} needs review` / `Q{idx} ready` / `Q{idx} pending`. `needs review` is set when a fresh proposal has `isAiFailure()` true (model=`"none"` / `prompt_version_sha="error:no-sha"` / `band.error_class` starting `AIG_` — incl. new `AIG_STAGE1_DEGRADED`). Tokens use existing `aiq-color-{success,warning,danger,fg-muted}` pairs. |

**Header buttons.** `Grade all` is unchanged. A new `Accept all (N)` button renders next to it whenever there is at least one proposal `p` with `!isAiFailure(p)` — `N` shows the count that will actually post. The button posts every acceptable proposal in a single `{proposals: […]}` body to `/admin/attempts/:id/accept`. AI-failures stay in their per-question cards for manual Re-run / Override; the user-locked decision (2026-05-26) is that the system NEVER auto-commits a score-0 / `AIG_*` row.

**Help IDs.** New `admin.attempts.accept_all` (button) and `admin.attempts.grading_summary` (panel) — wire content via `modules/16-help-system` when copy is finalised. Existing `admin.attempts.grading_dispatch` (Grade all) is unchanged.

**History.** Pre-2026-05-28 the page had only a single per-question Accept button that posted `{question_id}` — the backend required `{proposals: […]}`, so every Accept silently 422'd and no attempt ever reached `graded` status. See `docs/RCA_LOG.md` 2026-05-28 entries (Bug A + Bug B) for the full incident.

### Attempt-detail — navigate-away robustness (2026-05-29, commit `96b71a6`)

Operator-observed after the Bug-A fix deployed: even when the admin stayed on the attempt page after Grade-all, the proposals never appeared. Root cause was a Cloudflare ~100s edge timeout killing the 4-minute synchronous POST `/grade` response mid-flight (`docs/RCA_LOG.md` 2026-05-29). The fix persists proposals server-side as a review cache and adds two new UI affordances so the admin can navigate away during a batch and pick up proposals on return.

| Element | Purpose |
| --- | --- |
| **"Grading in progress" banner** (`admin.attempts.grading_in_progress`) | Blue info banner, rendered between the header and the grading-summary panel when `detail.grading_started_at != null`. Shows a Spinner + "Started Ns ago · polling every 15s · safe to navigate away" + a **Check now** button (manual `load()` trigger). Disappears the moment the marker is nulled by the backend's batch-completion write. |
| **"Previous grading stalled" banner** (`admin.attempts.grading_stalled`) | Yellow warning banner, replaces the in-progress banner once the elapsed time exceeds `STALE_MARKER_SEC = 600` (10 min). Indicates likely API container SIGKILL mid-batch — the `handleAdminGrade` catch-block marker-clear didn't run. Coaches the admin to click **Re-grade**, which is enabled in this state because the server's in-process single-flight is fresh after a restart. |
| **Grade-all button — three states** | (a) Disabled "Grading…" while a local `handleGrade()` call is in flight OR while `gradingActive` is server-reported. (b) Enabled "Re-grade (previous stalled)" when `gradingStalled`. (c) Enabled "Grade all" otherwise. Title attribute carries hover-hint per state. |
| **Auto-poll** | A `useEffect` polls `load()` every 15s while `detail.grading_started_at != null`. Hard cap at `POLL_CAP_SEC = 720` (12 min) — beyond that the FE stops polling and shows the stalled banner. Adjusts to `gradingElapsedSec` so even a stalled marker that was set, say, 11 minutes before page load still polls for ~60s before giving up. |

**Hydration on mount.** `load()` reads `detail.ai_proposals` (a `GradingProposal[] \| null` from the new GET endpoint contract) and seeds the local `proposals` state. Explicit reset to `{}` when null so a stale proposal from a previous attempt doesn't bleed into a freshly-navigated-to one. The same `load()` call powers the auto-poll, so when proposals land in the cache the FE picks them up within at most 15 seconds.

**Timeout-resilient `handleGrade()`.** The synchronous POST `/grade` still fires on click, but a thrown 504/524/408 (proxy timeout) is now non-fatal — the FE shows "Grading is taking longer than the connection timeout — it continues on the server. This page will refresh automatically when proposals arrive." and calls `load()` to start the poll. Real errors (e.g. 422 contract violation, 503 mode mismatch) still bubble through the existing error banner.

**Compliance frame UNCHANGED.** The cache is review-state only. `Accept all` still runs the Phase-1 completion gate. Billing still fires same-tx with the gate flip. The admin still clicks Accept on visible proposals before any `gradings` row is written. See `docs/05-ai-pipeline.md` § "Proposals cache + navigate-away robustness" for the full compliance argument.

### Attempt-detail — pre-Release review UX bundle (2026-05-29, commit `d5ad835`)

Replaces the prior `window.confirm()` Release flow with a richer evaluation-review surface so the admin can verify **what was evaluated and why this score** before publishing results to the candidate (Release is the publish step — best-effort result-released email + cert if eligible, candidate sees results immediately on next reload).

| Affordance | Lives in | Renders |
| --- | --- | --- |
| **`ReleaseConfirmModal`** | [components/ReleaseConfirmModal.tsx](../modules/10-admin-dashboard/src/components/ReleaseConfirmModal.tsx) | Centered modal triggered by clicking **Release to candidate** (replaces `window.confirm`). Header: candidate email + assessment name + level label. Three stat cards: **Total score** (`scoreEarned/scoreMax` + percentage in serif lining-nums), **Questions graded** (`graded/total`), **Average band** (rounded avg → 0/25/50/75/100). **AI-failure callout** (only when count > 0): yellow `aiq-banner-warning` explaining flagged-for-review questions are excluded. **Per-question table**: Q-position chip + type + topic (40-char trunc) + band/score + status chip (`graded` green, `needs review` yellow, `ungraded` muted). Footer: **Release** (disabled + "Releasing…" while POST in flight) + **Cancel**. ESC and click-outside both cancel. Help id `admin.attempts.release_confirm`. |
| **`AnchorChip` enrichment** | [components/AnchorChip.tsx](../modules/10-admin-dashboard/src/components/AnchorChip.tsx) | New optional `anchorDef?: { concept, weight, synonyms? }` prop. When provided, chip text becomes `✓ concept · Npts` (40-char trunc); tooltip carries three blocks: full concept (medium weight), `Weight: Npts · Confidence: NN%` (confidence shown only if `finding.confidence` set), `as the model cited: "<evidence>"`. When omitted, falls back to existing `label ?? anchor_id` chip + evidence-only tooltip. |
| **`ConceptCoverageView`** | [components/ConceptCoverageView.tsx](../modules/10-admin-dashboard/src/components/ConceptCoverageView.tsx) | Collapsible card under each question's candidate answer (left column). Header: `{hitCount}/{anchors.length} concepts found · {hitWeight}/{totalWeight} weight` + chevron toggle. Expanded body highlights HIT-anchor concepts and their explicit synonyms inline in the answer text using **case-insensitive whole-word match** (no stemming — admins author synonyms deliberately per Sonnet V2 adversarial revision). Each match is a green ✓ pill with the concept as `title=` tooltip. Below the answer: **Missed concepts** block — muted ✗ pills for any anchor `hit=false`. **Truncation** with "Show all" when `answerText.length > maxChars` (default 800). Only renders for narrative answer types: `subjective`, `scenario`, `log_analysis` — `mcq` / `kql` / unknown suppress the view via empty `serializeAnswerForCoverage()`. |
| **Print review** | header button + inline `@media print` `<style>` block in [pages/attempt-detail.tsx](../modules/10-admin-dashboard/src/pages/attempt-detail.tsx) | New **Print review** button (header, `aiq-no-print` class) — rendered when `gradings.length > 0`, calls `window.print()`. Print stylesheet hides `.aiq-no-print, .aiq-banner:not(.aiq-error-banner), .aiq-shell-nav, .aiq-shell-sidebar, nav`, the grading-in-progress + grading-stalled banners; flattens the 2-col `.aiq-admin-detail-two-col` grid; removes card shadows; whitewashes background. **Error banner** carries a new `aiq-error-banner` class and is INTENTIONALLY exempted from the hide (Sonnet V5 adversarial revision — operational errors are part of audit context if the admin chose to print mid-error). |

**Backend dependency.** Both `AnchorChip` enrichment and `ConceptCoverageView` require the question's rubric to be present in the GET `/admin/attempts/:id` response. The 07-ai-grading `loadFrozenQuestions` SELECT was extended to include `qv.rubric` in commit `d5ad835` — the prior "rubric column intentionally excluded — this read is for display" comment was over-conservative (the loader IS the display read for the admin grading review surface, and the route is `adminOnly`-gated; candidates never reach it). See `docs/03-api-contract.md` for the response shape.

**Data plumbing in `attempt-detail.tsx`.**
- `FrozenQuestion` interface gained `topic?`, `position?`, `rubric?: RubricForReview | null`.
- `serializeAnswerForCoverage(type, answer)` produces a plain-text serialisation per type for the coverage matcher (returns `""` for non-narrative types → coverage view suppressed).
- `<ScoreDetail>` receives `rubricAnchors={q.rubric.anchors}` (when present) and looks up each `anchor_hit.anchor_id` to build a chip `anchorDef`.
- `<ConceptCoverageView>` receives the paired `{rubric anchors × anchor_hits}` array so it knows which rubric concepts were hit vs missed.
- `handleRelease` is now sync (`function`, not `async`) — opens the modal; the actual POST runs in `handleReleaseConfirm()` after the admin clicks Release inside the modal.

**Adversarial review** (Sonnet takeover, REVISE → addressed):
- V1 rubric-PII-leak: ACCEPT (same admin authors rubric + views attempt; admin-only route).
- V2 stemming false positives → fixed (literal whole-word match only — no `s` / `ing` suffix-strip).
- V3 malformed `log_analysis.findings`: ACCEPT (`filter(typeof === "string")` catches it).
- V4 250KB rubric payload at 50-question packs: ACCEPT-noted.
- V5 print over-hides error banner → fixed (`.aiq-error-banner` class + `:not()` selector).
- V6 modal live-prop updates during 15s poll: ACCEPT (fresher data preferred).
- V7 `handleRelease` sync-not-async: ACCEPT (call site is sync dispatch).

**Compliance frame UNCHANGED.** ReleaseConfirmModal does NOT bypass any backend check — the POST `/release` route still validates `attempts.status === 'graded'`. No new `gradings` write path. No `dangerouslySetInnerHTML` anywhere (rubric content is admin-authored, but still rendered through React text nodes).

### Row-overflow menu pattern (currently page-local)

Question-Bank's destructive `Archive` action moved into a `⋯` row-level menu (`useRef` + click-outside listener + `Esc` to close) so destructive verbs don't crowd a list row. Implementation lives inline at [`modules/10-admin-dashboard/src/pages/question-bank.tsx`](../modules/10-admin-dashboard/src/pages/question-bank.tsx) as `RowOverflowMenu`. **Promote to `@assessiq/ui-system` when a second admin list needs it** (likely soon — assessments + users + certificates all have row-level destructive actions today).

### Admin list-page chrome contract

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

- **Filter tabs** are ghost buttons (`aiq-btn aiq-btn-ghost aiq-btn-sm`), inactive `transparent + fg-secondary`, active `accent-soft bg + accent fg + weight 500`. Never use `aiq-btn-primary` blue fills on tabs — that's reserved for the single primary action per surface.
- **Filter strip** carries the `.aiq-admin-filter-strip` class so the parallel mobile-port (A2) reflow rules can target it. New list pages MUST include this class on the filter row.
- **Results counter** is right-aligned, mono uppercase tracked, fg-muted: `{N} {result|results}`. Hidden during loading / error.
- **Table card** wraps in `<div className="aiq-card" data-density="compact">` so row padding tightens per branding §4. The inner `<div className="aiq-admin-table-scroll">` is from the mobile-port A2 wave and must stay (mobile horizontal-scroll behavior).
- **Empty state** is editorial — serif H3 + sans muted lede + max-width 360px, filter-aware copy ("No attempts in this state." vs "No attempts yet."). Replaces the Table primitive's inline "No data." fallback when items array is empty and not loading.
- **Row action** is ghost `View →` (per kit §8.1 tertiary affordance). Outline `Open` is the previous pattern and should not be reintroduced.

### Migrating other admin list pages

`assessments.tsx`, `dashboard.tsx`, `assessment-detail.tsx`, `users.tsx`, `certificates.tsx`, `generation-attempts.tsx` still use the older pre-2026-05-21 chrome (primary/outline filter tabs, inline `toLocaleString()` timestamps, inline status pill spans, `Open` outline buttons). They render correctly now that the Table width bug is fixed but do not yet match the chrome contract above. Treat the migration as ad-hoc polish — touch a page when you're already editing it for another reason; no big sweep PR planned.

---

## Mobile (Mobile Kit Port M0–M6 SHIPPED — 2026-05-20)

See [docs/10-branding-guideline.md § 15. Mobile](./10-branding-guideline.md#15-mobile) for the canonical visual contract + the full per-pattern reflow catalog (M1 magic-link landing, M2a AttemptPage chrome, M2b per-question-type sizing, M3 Submitted, M4 CandidateShell nav + Activity, M5 admin graceful-degrade). This section catalogs the API surface that lives in `@assessiq/ui-system` and `apps/web/src/lib/`.

### Viewport hooks (`@assessiq/ui-system`)

- `useViewport(): 'mobile' | 'desktop'` — SSR-safe (returns `'desktop'` when `window` is undefined). Subscribes to `matchMedia` change events so live resize / orientation changes update the value. Source: [`modules/17-ui-system/src/hooks/useViewport.ts`](../modules/17-ui-system/src/hooks/useViewport.ts).
- `useViewportSync(): void` — side-effect hook that writes `data-viewport` on `<html>` and keeps it in sync. Called once inside `ThemeProvider`; consumers never call it directly. Source: [`modules/17-ui-system/src/hooks/useViewportSync.ts`](../modules/17-ui-system/src/hooks/useViewportSync.ts).
- Predicate constant: `VIEWPORT_QUERY` = `(max-width: 719px), ((pointer: coarse) and (max-width: 1024px))`. The combined OR covers small phones AND iPads in portrait. Single source-of-truth — never duplicate this predicate elsewhere.

### First-paint hint

[`apps/web/index.html`](../apps/web/index.html) carries a tiny inline IIFE in `<head>` that sets `data-viewport` on `<html>` BEFORE the React bundle loads. Without this, the page paints in desktop layout for one frame then re-flows to mobile. The IIFE has a try/catch with `'desktop'` fallback so any `matchMedia` weirdness can't blank the page.

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

### ViewportLock (M5 — fully implemented)

[`apps/web/src/lib/ViewportLock.tsx`](../apps/web/src/lib/ViewportLock.tsx) wraps `<Routes>` in [`apps/web/src/App.tsx`](../apps/web/src/App.tsx) and renders the "Admin tools work best on desktop" interstitial when ALL hold: viewport is `mobile`, path starts with `/admin/`, path is not one of `{login, login/email, select-identity, mfa}`, no `sessionStorage.aiq_admin_mobile_override='1'` is set, not in embed mode (`?embed=true`). Pass-through otherwise — candidate, take-flow, embed, 404 routes are not affected because their pathnames don't match `/admin/`. Override storage is `sessionStorage` (per-tab, clears on tab close) — the plan's "per-session" + `localStorage` wording was contradictory; M5 honors the per-session intent. Security gates (rate-limit errors, locked-account, MFA prompts) render exactly as on desktop when the override is on — the override only relaxes layout.

### ESLint guard

[`eslint.config.js`](../eslint.config.js) blocks runtime imports from `**/AssessIQ-Mobile-Kit/**` (in addition to the existing `**/AssessIQ_UI_Template/**` block). Hand-port idioms into `modules/17-ui-system/src/components/` per the desktop-kit pattern. The Mobile Kit is REFERENCE-ONLY — never imported from production code.

### Where mobile-mode components live

- Foundation: `modules/17-ui-system/src/hooks/{useViewport,useViewportSync}.ts`, `modules/17-ui-system/src/styles/tokens.css` (`[data-viewport="mobile"]` block + per-page scoped overrides).
- Magic-link auth (M1): `apps/web/src/pages/candidate/CandidateLogin.tsx`, `apps/web/src/pages/take/{TokenLanding,Expired,ErrorPage}.tsx` (CSS-only reflow on the M1 shared `.aiq-take-twopane` class).
- Take-flow chrome (M2a): `apps/web/src/pages/take/Attempt.tsx` (header padding shrink, navigator-aside hidden + lazy `<Drawer>` mount via the new `aiq-attempt-nav-toggle` button, footer flex-wrap restack).
- Take-flow answer areas (M2b): same file — textareas + the log-analysis finding `<input>` read `--aiq-answer-input-size`; the KQL textarea reads `--aiq-answer-mono-size` and renders a mobile-only `.aiq-attempt-kql-mobile-tip` caveat above the editor.
- Submitted page (M3): `apps/web/src/pages/take/Submitted.tsx` (class-managed header/main padding + hero h1 size).
- Candidate portal (M4): `modules/11-candidate-ui/src/components/CandidateShell.tsx` (new shell-level nav + mobile overflow menu via controlled state + outside-click + Escape), `CandidateActivity.tsx` (stats grid 3→1 col, heatmap horizontal-scroll wrapper, leaderboard `columns={viewport === 'mobile' ? 1 : 2}` via `useViewport()`), `MyCertificates.tsx` (1-line h1 size swap to `var(--aiq-h1-size)`).
- Admin graceful-degrade (M5): `apps/web/src/lib/ViewportLock.tsx` (above).

### Help-system entries added by the port

- `candidate.attempt.navigator.toggle` (M2a — bottom-sheet navigator toggle).
- `candidate.attempt.kql.mobile_tip` (M2b — KQL caveat tip).
- `candidate.shell.nav.mobile_menu` (M4 — candidate-shell overflow menu).
- `admin.shell.mobile_continue_anyway` (M5 — admin interstitial override).

All four wired via `data-help-id` on the actual control and seeded into 0011 by `pnpm help:seed:regen`.

## Generation admin UI — wizard resume + scorecard help (2026-05-24)

Two super-admin-only generation surfaces in `modules/10-admin-dashboard`. Both
are presentational/help only — no auth, tenancy, or grading-pipeline logic.

### Generation gating is already complete (no code this round)

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

### Resume a running generation (`generate-wizard.tsx`)

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

### Scorecard inline help (`generation-attempts.tsx`)

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

---

## Admin dashboard UI changes (2026-05-24)

Three admin-facing UI changes shipped as part of the domain-slug normalization + Question Bank import work.

### Question Bank — Domain field changed from free-text to dropdown

**What:** The "Domain" field on the New Pack form (`modules/10-admin-dashboard/src/pages/question-bank.tsx`, New Pack modal) is now a `<Select>` populated from `GET /api/admin/domains` (the tenant's canonical domain list). Previously it was a free-text `<Input>`, which allowed mixed-case entries like `'SOC'` that silently failed entitlement resolution at publish time (the license resolver matches `question_packs.domain` by exact lowercase slug).

**Why:** Free-text entry was the root cause of the casing-drift bug fixed by migration `0090_normalize_domain_slugs.sql` (see `docs/02-data-model.md`). Sourcing from the `domains` table guarantees the stored value is always a canonical lowercase slug. The dropdown renders the human-readable `label` but submits the lowercase `slug`.

**Not included:** retroactive UI changes to the Pack Edit form (PATCH) — the domain field is not editable post-creation in the current admin surface; if it is added later, it must also use the dropdown.

**Downstream:** `createPack`/`updatePack` service methods also lowercase `domain` at the write path as defense-in-depth; the UI change removes the primary entry point for drift, not the only guard.

---

### Question Bank — "Licensed sets" section (2026-05-24)

**What:** A new read-only **Licensed sets** section in the Question Bank page (`modules/10-admin-dashboard/src/pages/question-bank.tsx`) lists the PLATFORM-library question sets the calling tenant is licensed for, sourced from `GET /api/billing/available-sets`.

**Layout:** The section appears below the tenant's own pack list and is hidden entirely when `sets` is empty (no licensed sets). Each row shows:

| Column | Content |
|---|---|
| Name | `source.name` |
| Domain | lowercase slug chip |
| Questions | `question_count` |
| Status badge | "In your workspace" (`success` Chip, when `cloned: true` and not `update_available`) — "Update available" (`warning` Chip, when `cloned: true` and `update_available: true`) — no badge when not yet cloned |
| Action | "Add to workspace" button (`ghost` variant, visible only when `cloned: false`) — calls `POST /api/admin/sets/:source_pack_id/import` and refreshes the section on success |

**"In your workspace" / "Update available" logic:** driven by the `cloned` and `update_available` flags from the `GET /api/billing/available-sets` response. "Update available" means a newer `source_version` exists than what was cloned; the update path (re-clone) is deferred — the badge is informational only for now, no button.

**"Add to workspace" button:** calls `POST /api/admin/sets/:source_pack_id/import` (see `docs/03-api-contract.md` § `POST /api/admin/sets/:sourcePackId/import`). On `201` success, the button switches to the "In your workspace" badge and the tenant's own pack list is refreshed so the new clone appears immediately. On `403 NOT_LICENSED`, an inline error Chip is shown ("Not licensed"); on other errors, a toast.

**Not included:** a re-clone/update flow for `update_available: true` sets (deferred); pagination of the licensed sets list (platform library is expected to stay small for Phase 1); candidate-facing visibility of licensed sets.

---

### Assessments — Blueprint mode button hidden for non-super-admins (2026-05-24)

**What:** On the New Assessment form (`modules/10-admin-dashboard/src/pages/assessments.tsx`), the "Blueprint" mode toggle button is rendered only when `session.user.role === 'super_admin'`. Tenant admins (`role === 'admin'`) do not see the button; the form defaults to the standard mode silently.

**Why:** Blueprint mode sets `settings.blueprint` on the assessment, which is a `super_admin`-only capability enforced server-side by both `POST /admin/assessments` and `PATCH /admin/assessments/:id` (see `docs/03-api-contract.md` § Blueprint authoring restriction). The FE hide is defense-in-depth — the backend 403 is the authoritative gate.

**Implementation:** The session role is already available via `useSession()` (or the equivalent `AdminWhoami` hook) used throughout the admin dashboard. The conditional is a single `{isSuperAdmin && <BlueprintModeButton … />}` guard, consistent with the existing `{isSuperAdmin && …}` pattern used on the Platform nav entry and the AI-generate-mode select.

**Not included:** any change to the assessment edit form for existing draft assessments — if a super-admin created a blueprint assessment and a tenant admin views it in edit mode, `settings.blueprint` is simply not rendered in the form (read-only exclusion); the tenant admin cannot clear or modify it.

---

## Add-candidate drawer + invite-picker filter (2026-05-26)

**What:** The admin Users page (`modules/10-admin-dashboard/src/pages/users.tsx`) `InviteForm` drawer is now role-aware. The role picker gained a third option, **candidate**. When `candidate` is selected the drawer shows **Name** (required) + **Designation** (optional, e.g. "SOC Analyst L1") fields, retitles to "Add candidate", swaps the subtitle to "Candidates are added directly — no email is sent now…", posts to `POST /admin/users` (not `/admin/invitations`), and confirms with a "Candidate added." chip. Admin/reviewer behaviour is byte-for-byte unchanged (still invite-email flow). On `assessment-detail.tsx` the invite picker now filters to `role==='candidate' && status==='active'` (was: all users), so only assignable candidates appear.

**Why:** There was no UI to create a candidate (the invite form only offered admin/reviewer, and `inviteUser` hard-blocks candidates at `CANDIDATE_INVITATION_PHASE_1`). Candidates authenticate only via per-assessment magic links, so they need no invite/accept email — direct active creation is the simple, correct model. The picker previously listed admins/reviewers too, which the server silently rejected — confusing UX.

**Implementation:** A form-local `type InviteRole = "admin" | "reviewer" | "candidate"` (the file-level `UserRole` is used by filter chips/manage menus and was left untouched). Error display switched from the email `Field`'s `error` prop to a shared `role="alert"` danger-coloured div below the fields (covers both email + name validation). Help: `data-help-id="admin.users.candidate.fields"` → content in `modules/16-help-system/content/en/admin.yml` + seed migration `0099_seed_candidate_fields_help.sql`.

**Not included:** No bulk CSV add (still the `/admin/users/import` 501 stub). No reverse "assign assessment from the user row" flow — assignment stays on the assessment-detail page (single source of truth). No new component in the kit — composed from existing `Field`/`Button`/`Card`/`Chip` atoms.
