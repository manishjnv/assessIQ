# 16-help-system — Tooltip framework, help content, contextual drawer

> Full architecture in `docs/07-help-system.md`. This is the implementation orientation.

## Purpose
Three layers of help (tooltip, inline, drawer) on every page, for every audience, in every locale. Centralized authoring; instant updates; versioned content.

## Scope
- **In:** `help_content` schema + CRUD, `<HelpTip>` and `<HelpDrawer>` and `<HelpProvider>` React components, public read API for embed/anonymous use, admin authoring UI, default content shipped as YAML, i18n hooks, telemetry on help usage.
- **Out:** specific help text per module (each module declares its `help_id`s in its SKILL.md and contributes default copy).

## Dependencies
- `00-core`, `02-tenancy` (tenant-overridable content)
- `17-ui-system` (Tooltip primitive)
- `13-notifications` (Phase 2: notify admins of help they should review based on usage)

## Public surface
```tsx
<HelpProvider page="admin.assessments.create" audience="admin" locale="en">
  ...page content...
</HelpProvider>

<HelpTip helpId="admin.assessments.create.duration">
  <input ... />
</HelpTip>

<HelpDrawerTrigger />   // renders the (?) icon in page header

useHelp("admin.assessments.create.duration"): { shortText, longMd, openDrawer }
```

## API
```
GET  /api/help?page=&audience=&locale=          # bulk fetch for a page
GET  /api/help/:key?locale=                     # single key
GET  /help/:key?locale=                         # public/anonymous (for embed)
PATCH /api/admin/help/:key                      # author content
GET  /api/admin/help/export?locale=             # bulk export for translation
POST /api/admin/help/import?locale=             # bulk upsert
```

## Default content seeding
On first migration: load `modules/16-help-system/content/en/*.yml` into `help_content` table with `tenant_id=NULL` (global default). Per-tenant overrides written by admin take precedence at read time.

## Telemetry
- Tooltip shown count per key (sample 10%; aggregate hourly)
- Drawer opens per page
- 👍/👎 feedback per key
Output: "Help health" admin report — pages with high drawer-open rate signal unclear UI; keys with 👎 dominance signal bad copy.

## Help/tooltip surface (meta)
- `admin.help-content.author` — markdown style guide, length limits
- `admin.help-content.locale` — translation workflow
- `admin.help-content.diff` — interpreting version diffs

## Open questions
- AI-assisted help drafting from a screen/component name + description — Phase 3 admin tool
- Embedded screencasts/GIFs in drawer content — supported in markdown; storage in static asset CDN
