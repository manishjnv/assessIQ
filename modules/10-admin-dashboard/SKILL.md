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
├── /guide                  End-to-end admin workflow guide (L1→L3) — static JSX, Option A
└── /profile                Self profile + TOTP management
```

## Layout shell
- Top nav: tenant switcher (if user belongs to multiple tenants), help button (`?`), profile menu
- Side nav: collapsible, role-aware (reviewers see fewer items)
- Breadcrumbs above page title
- Notification toast region (top-right)
- Help drawer (right side, opened by `?` or Cmd/Ctrl+/)

> **AdminShell wraps ALL `/admin/*` routes (updated 2026-05-04, commit `473fef1`).** `/admin/users` was a Phase 0 G0.C-5 page that predated the G2.C AdminShell; it is now wrapped like every other admin route in `apps/web/src/App.tsx`. The only intentional exception is `/admin/mfa` — it is a constrained pre-session flow step; the sidebar would expose nav links the user cannot reach until MFA is verified, creating broken affordances.

## State management
- TanStack Query for server state (caching, refetch, optimistic updates)
- Local component state for ephemeral UI
- No global Redux/Zustand — server state and URL state cover 95% of needs
- URL is source of truth for filters, pagination, selected items

## Help/tooltip surface
Every page has a `<HelpProvider page="admin.<area>.<page>" audience="admin">` wrapper that loads help on mount. Every non-obvious control wrapped in `<HelpTip helpId="...">`. See `docs/07-help-system.md` for the convention.

## Status

**2026-05-04 — /admin/guide shipped.** `modules/10-admin-dashboard/src/pages/admin-guide.tsx` — 12-step end-to-end admin workflow guide (L1→L3). Option A (static JSX). Sidebar nav entry "Help guide" (book icon) added to AdminShell.tsx, above Settings. Route wired in `apps/web/src/App.tsx` at `/admin/guide` with external AdminShell wrap + breadcrumbs=["Help guide"]. Steps 1–7 flagged Phase 3+ (question-bank + assessment-lifecycle pages not yet routed); steps 8–12 reference live pages (users, attempts, grading, reports). Phase 4+ TODO in page header comment: migrate to Option B (16-help-system YAML) for edit-without-redeploy. Commit: see SESSION_STATE.md 2026-05-04.

## Open questions
- Tenant switcher — only shown if user has multi-tenant role; rare for v1 (deferred until needed)
- Mobile admin UI — desktop-first; mobile only for "monitor queue/approve override" lite view in Phase 3
- /admin/guide Option B migration (16-help-system YAML content) — Phase 4+ backlog
