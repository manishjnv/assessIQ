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
The UI template at `modules/17-ui-system/AccessIQ_UI_Template/` is the **canonical visual identity** for AssessIQ. The actionable, sectioned guideline lives in `docs/10-branding-guideline.md` — every new page, layout, and component must follow it. The token namespace + values in `docs/08-ui-system.md` mirror the template's palette and type system in the `--aiq-*` namespace.

Files under `AccessIQ_UI_Template/` are reference, not production code. The designer-tool harness (`design-canvas.jsx`, `tweaks-panel.jsx`, `AccessIQ.html`, `.design-canvas.state.json`) must never be imported by app code; port the screen JSX and atoms into typed components under `components/` on demand as features land.

Component APIs in this module stay stable; visual fidelity to the branding guideline is the contract.

## Help/tooltip surface
- `admin.settings.tenant.branding.preview` — live preview of brand changes
- `admin.profile.theme` — light/dark/system explanation
- `admin.profile.density` — comfortable vs compact

## Open questions
- Internal vs publishable component library — keep internal for v1; consider extraction if external partners build on AssessIQ
- Tailwind utilities + design tokens overlap — use Tailwind `@apply` referencing CSS vars; no fight between systems
