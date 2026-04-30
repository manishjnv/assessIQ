# 08 — UI System

> Design tokens + component library + theming, all in one module. **You said you'll share a UI template** — when you drop it in, the integration plan in this doc tells us how to wire it into the token system without touching the rest of the platform.

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

What's done:
- Token namespace + values reconciled (this doc, above).
- OKLCH palette, density mechanic (`--u`), editorial type system codified.
- Reference files preserved under `modules/17-ui-system/AccessIQ_UI_Template/`.

What still needs to happen, on demand as Phase 0–2 work lands (not up front):

1. **Port `styles.css` → `tokens/tokens.css`** with the renamed `--aiq-*` namespace from this doc.
2. **Extract atoms** (`Logo`, `Icon`, `Placeholder`, `useCountUp`) from the template's `screens/atoms.jsx` into typed components under `components/primitives/`.
3. **Extract reusable composites** referenced by the layout templates: `Sidebar`, `NavItem`, `StatCard`, `Sparkline`, `ScoreRing`, `QuestionNav`, `Chip`. Keep visual fidelity 1:1.
4. **Map domain composites** — `QuestionCard`, `KqlEditor`, `RubricEditor`, `BandPicker`, `AnchorChip`, `GradingProposalCard` — onto the branding component idioms.
5. **Storybook + visual-regression baseline** as components land, not retroactively at the end.
6. **Update help-drawer screenshots** as the visuals stabilize.

The reference template files (`design-canvas.jsx`, `tweaks-panel.jsx`, `AccessIQ.html`, `.design-canvas.state.json`) are the omelette/Claude design-canvas wrapper that produced the template — useful for visual reference (open the HTML to see all screens) but **must not be imported by production code**.

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
├── tokens/
│   ├── tokens.css            # The :root + [data-theme="dark"] above
│   ├── tokens.ts             # TS export of token names for typesafe usage
│   └── theme-resolver.ts     # Server-side resolver (tenant.branding → token map)
├── components/               # As above
├── stories/                  # Storybook
├── tests/                    # Visual regression + a11y
└── README.md                 # Component usage examples
```

When the user-supplied UI template lands, drop it in `modules/17-ui-system/templates/<vendor-name>/` and follow the integration plan above.
