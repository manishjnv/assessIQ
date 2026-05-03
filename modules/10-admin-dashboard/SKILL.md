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

**2026-05-04 — /admin/guide jargon cleanup.** Removed all "PHASE 3+" chip badges from every step header (StepCard `live` prop and `<Chip>` removed). Step numbers reformatted from zero-padded "01"–"12" to plain integers "1"–"12" in both the circle bubble and TOC links. Inline "Phase 3+" text removed from step 6 body, step 8 body, step 12 body, and Tips Audit-log copy. No coming-soon notes needed — commit 35f78e6 shipped Question Bank, Assessments, and Reports pages before this cleanup landed. Only remaining coming-soon note: Tips Audit log (Settings → Audit log UI not yet shipped). 17/17 tests pass; 357 Vite modules; grep "PHASE 3|claude|anthropic" → 0 user-facing hits.

**2026-05-04 — question-bank + assessments + reports list pages shipped (session 35f78e6).** 5 new pages promoted from the 19-deferred backlog:
- `/admin/question-bank` (`question-bank.tsx`) — pack list, filter chips (All/Draft/Published/Archived), name search, inline "+ New Pack" form. Consumes live endpoints `GET/POST /admin/packs`.
- `/admin/question-bank/:id` (`pack-detail.tsx`) — pack header, levels list, per-level question list (fetched via `GET /admin/questions?pack_id=:id`), inline "+ Add level" form, "Activate all" per level, "Publish" CTA. Consumes live endpoints `GET /admin/packs/:id`, `POST /admin/packs/:id/levels`, `POST /admin/packs/:id/publish`, `POST /admin/packs/:id/activate-questions`.
- `/admin/assessments` (`assessments.tsx`) — assessment (cycle) list, filter chips (All/Draft/Published/Active/Closed), inline "+ New Assessment" form. NOTE: "Cycles" in product spec = "Assessments" in backend — nav label is "Assessments". Consumes live `GET/POST /admin/assessments`.
- `/admin/assessments/:id` (`assessment-detail.tsx`) — assessment header, invitations table, inline "+ Invite candidates" checkbox picker (sourced from `GET /admin/users`), link to filtered attempts. Consumes live `GET /admin/assessments/:id`, `GET /admin/assessments/:id/invitations`, `POST /admin/assessments/:id/invite`, `POST /admin/assessments/:id/publish`.
- `/admin/reports` (`reports.tsx`) — two-card landing: "Cohort reports" (lists non-draft assessments → `/admin/reports/cohort/:id`) and "Individual reports" (lists recent released attempts → `/admin/reports/individual/:userId`). FALLBACK: uses `/admin/assessments` + `/admin/attempts?status=released` — dedicated list endpoints `GET /api/admin/reports/cycles` and `GET /api/admin/reports/recent-attempts` flagged for follow-up session.

AdminShell sidebar nav updated: added Assessments (clock icon), Reports (sparkle icon), Question Bank (grid icon). Final order: Dashboard / Assessments / Attempts / Grading / Reports / Question Bank / Users / Help guide / Settings. Filter state in URL query params (not sessionStorage). Removed 2 TODO Phase3+ comments. 357 Vite modules; 0 new TS errors; all gates green. Commit `35f78e6`. Deploy verified (all 3 list routes → HTTP 200 on VPS).

Page count: 7 shipped G2.C + 5 shipped this session = **12 live pages**. 14 remain deferred from the original 26 (settings overview / per-tenant settings / webhook config / embed-secrets UI / audit log UI / bulk import / topic-heatmap / CSV export / etc.).

**2026-05-04 — grading-jobs + billing pages rewritten for user-facing clarity.** `grading-jobs.tsx` and `billing.tsx` had developer-speak copy (Phase 1/3, BullMQ, P2.D6, Max OAuth, `tenant_grading_budgets`, "platform admin updates the database directly"). Both pages were rewritten to answer "what does this mean for me right now?" for a tenant admin (e.g. a SOC manager at Wipro). Internal jargon moved to a `<details>` collapsible ("Technical details (for engineers)") that is closed by default — preserving the content for engineering/audit purposes without exposing it to non-technical admins. Both pages now use `Card`, `Chip`, and `Icon` from `@assessiq/ui-system` and include a footer link to `/admin/guide`. Button label "Grade all" is used consistently (matches the actual button on the attempt-detail page). "Coming soon" replaces all "deferred to Phase 3" references in user-facing copy. Commit: see SESSION_STATE.md 2026-05-04.

## Open questions
- Tenant switcher — only shown if user has multi-tenant role; rare for v1 (deferred until needed)
- Mobile admin UI — desktop-first; mobile only for "monitor queue/approve override" lite view in Phase 3
- /admin/guide Option B migration (16-help-system YAML content) — Phase 4+ backlog
