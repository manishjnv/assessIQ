# 10-admin-dashboard — Admin web UI

## Purpose
The administrator's command center. Authoring, monitoring, reviewing, exporting. Pure UI module — composes primitives from 17-ui-system, calls APIs across the platform.

## Scope
- **In:** dashboard home (KPIs + queues), assessments list/detail/create, question authoring, attempts review, AI grading review with override flow, users + invitations, settings (tenant, branding, auth methods, integrations, API keys, embed secrets, webhooks, help authoring), reports.
- **Out:** business logic (lives in domain modules).

## Dependencies
- `17-ui-system` (every visual primitive)
- `16-help-system` (HelpTip + HelpDrawer on every page)
- All other modules via API

## Page tree
```
/admin
├── /                       Dashboard home (queues, KPIs, recent activity)
├── /assessments
│   ├── /                   List
│   ├── /new                Create wizard
│   └── /:id                Detail (cohort attempts table, settings, invite, close)
├── /question-bank
│   ├── /packs              Packs list
│   ├── /packs/:id          Pack detail (levels + questions)
│   ├── /questions/:id      Question editor (rubric, versions, preview)
│   └── /import             Bulk import wizard
├── /attempts
│   ├── /                   All attempts (filterable)
│   ├── /:id                Attempt detail (answers + AI gradings + override controls)
│   └── /grading-jobs       Background job monitor
├── /users
│   ├── /                   List + filters
│   ├── /:id                Detail (history, sessions, MFA reset)
│   └── /invitations        Outstanding invitations
├── /reports
│   ├── /cohort/:assessmentId
│   ├── /individual/:userId
│   ├── /topic-heatmap
│   └── /exports            CSV/JSON export hub
├── /settings
│   ├── /tenant             Branding, name, domain
│   ├── /authentication     Toggle SSO/TOTP/magic-link/etc.
│   ├── /integrations
│   │   ├── /api-keys
│   │   ├── /embed-secrets
│   │   └── /webhooks
│   ├── /help-content       Authoring UI
│   └── /audit              Audit log viewer
└── /profile                Self profile + TOTP management
```

## Layout shell
- Top nav: tenant switcher (if user belongs to multiple tenants), help button (`?`), profile menu
- Side nav: collapsible, role-aware (reviewers see fewer items)
- Breadcrumbs above page title
- Notification toast region (top-right)
- Help drawer (right side, opened by `?` or Cmd/Ctrl+/)

## State management
- TanStack Query for server state (caching, refetch, optimistic updates)
- Local component state for ephemeral UI
- No global Redux/Zustand — server state and URL state cover 95% of needs
- URL is source of truth for filters, pagination, selected items

## Help/tooltip surface
Every page has a `<HelpProvider page="admin.<area>.<page>" audience="admin">` wrapper that loads help on mount. Every non-obvious control wrapped in `<HelpTip helpId="...">`. See `docs/07-help-system.md` for the convention.

## Open questions
- Tenant switcher — only shown if user has multi-tenant role; rare for v1 (deferred until needed)
- Mobile admin UI — desktop-first; mobile only for "monitor queue/approve override" lite view in Phase 3
