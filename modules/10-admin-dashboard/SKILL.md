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
│   ├── /                   All attempts (filterable; status chip = evaluation_status)
│   ├── /:id                Attempt detail — tenant REVIEW (final grades, override, send back, publish)
│   └── /grading-jobs       Background job monitor
├── /platform/evaluations   (super_admin only) AssessIQ evaluation queue — cross-tenant, oldest first
│   └── /:attemptId         (super_admin only) Evaluate: Grade all, Accept, Re-run, manual score, Override, Release to company
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

## Integrity (Integrity v1, 2026-10-01)
Create-assessment form: "Test integrity" fieldset with "Require full screen" and "Block copy and paste" (written to `settings.integrity`; help_ids `admin.assessment.integrity.fullscreen` / `.block_copy_paste`). Attempt detail: `IntegrityCard` (help_id `admin.attempt.integrity`) from `GET /api/admin/attempts/:id/integrity`; counts are not scores so it shows whatever the release state; "No events recorded" when all zero. Assessment detail page: `components/IntegrityCard.tsx` (own file, mounted with one line above the Invitations section; help_id `admin.assessment.integrity.edit`, migration 0130) shows the two switches ("Require full screen", "Block copy and paste") from `assessment.settings.integrity` and a "Save integrity settings" button that calls `PATCH /admin/assessments/:id/integrity`; inline "Saved. Applies to attempts that start from now on." or the server error. Editable in any status (see 05 SKILL). Test: `__tests__/integrity-card.test.tsx`.

## Help/tooltip surface
Every page has a `<HelpProvider page="admin.<area>.<page>" audience="admin">` wrapper that loads help on mount. Every non-obvious control wrapped in `<HelpTip helpId="...">`. See `docs/07-help-system.md` for the convention.

## Status

**2026-10-01 — scoring / result-release, Phase II frontend (spec `docs/design/2026-10-01-scoring-release-implementation-spec.md` §5/§5b).**
- **What changed.** AI evaluation moved from the tenant admin to the super admin. New super-admin pages `pages/evaluations-queue.tsx` (`/admin/platform/evaluations`: tenant, assessment, level, submitted, age badge amber >=24 h / red >=48 h, written/KQL counts, status, "Sent back" marker + note, company filter, counts, "Evaluate next", bulk "Release selected to company", 30 s silent poll) and `pages/evaluation-detail.tsx` (`/admin/platform/evaluations/:attemptId`). The grading panel was EXTRACTED from `attempt-detail.tsx` into `components/AttemptGradingPanel.tsx` (props: `mode` "evaluate"|"review", `apiBase`) so both pages share one implementation; evaluate mode calls `/admin/super/evaluations/:id/{grade,accept,rerun,questions/:qid/manual-score,gradings/:gid/override}`, review mode only `/admin/gradings/:id/override`. `attempt-detail.tsx` is now the tenant review page driven by `evaluation_status` (awaiting_evaluation banner / ready_to_publish: override + "Send back for re-evaluation" + "Publish to candidate" / published: read-only). "Publish all ready" on `assessment-detail.tsx` (POST `/admin/assessments/:id/release-all`). Dashboard queue + attempts list chips come from `evaluation_status`. Shared helpers: `lib/evaluation.ts` (types, `effectiveGradings`, `isMfaError`, age tone/label), `components/useMfaGuard.tsx` (fresh-MFA 401 or 403 MFA_REQUIRED -> shared `MfaStepUp` in a Modal, then retry). Nav entry "Evaluations" (AdminShell, `superAdminOnly`); `excludePath` stops "Platform" lighting up on it.
- **Why.** Owner decision 2026-10-01 (plan §11): only the super admin runs AI evaluation; companies review and publish. Tenant routes `grade|accept|rerun|manual-score|grading-jobs retry` return 403 `AI_EVALUATION_BY_ASSESSIQ`, so the buttons were removed rather than left to fail.
- **Behaviour fixes made on the way.** (1) The page used to show the ORIGINAL grading row per question (`!override_of`), so an override never changed what was displayed; it now shows the effective grading (newest row, override wins ties — same rule as the server) in the panel, the summary and `ReleaseConfirmModal`. (2) Re-run now sends `{ forceEscalate: true }` (old `{question_id}` + `?escalate=opus` was rejected by the strict body schema). The route is a whole-attempt batch; only the clicked question's Stage 3 result is kept for the diff. (3) Override fresh-MFA no longer redirects to `/admin/mfa` (it ignores `?return=` and lands on `/admin`); it uses the inline step-up. (4) Proposals for already-graded questions are filtered at render time instead of being removed from state after Accept. (5) `isGradeable` now includes `auto_submitted` (the server grades it). (6) A proposal's "Override" button used to do nothing; it now opens the manual-score form.
- **Considered and rejected.** Copying the panel into the super page (drift); a per-question Re-run endpoint (backend contract is attempt-level); a redirect for fresh MFA (loses the page); a numeric override input (would change the override API; `bandToScore` stays); server-side tenant filter on the queue (client-side filter on the full list keeps the company options stable).
- **Not included.** Playwright/visual sweep (owner deprioritised); `billing.tsx` still describes "Grade all" in its credit-usage copy; the admin-guide Phase 1 wording elsewhere; evaluation-queue age alerts (SP11 is backend); a select-all checkbox on the queue.
- **Downstream.** `GET /admin/super/evaluations/:id` payload nesting of `tenant_id/tenant_name/evaluation_*` is read from top level OR `attempt` (`evaluationMeta`) because the spec does not pin it. Help: 13 new keys (`admin.evaluations.*`, `admin.attempts.{awaiting_evaluation,send_back,release_button}`, `admin.assessments.release_all`) in `16-help-system/content/en/admin.yml` + seed `0116_seed_evaluation_queue_help.sql`; global-row test count 139 -> 152. Rollback: revert the merge; 0116 is additive (`ON CONFLICT DO NOTHING`), rows can be left in place.

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

**2026-05-14 — /admin/activity page shipped (UI v1.1 Phase 11).** New `pages/activity.tsx` + `lib/domains.ts`. Composes 4 Phase 9 endpoints (`/api/admin/activity/{stats,heatmap,timeline,leaderboard}`) into a dashboard page:
- Period toggle (week/month/quarter) re-fetches stats + leaderboard; heatmap + timeline always show rolling 52-week window.
- 3 `StatCard` with `breakdown`: completions (by domain), active candidates (by domain), avg score (by quartile — `QUARTILE_LABELS` map inline in the page).
- `ActivityHeatmap`: 52-week column-major intensity array (counts bucketed 0→0, 1-2→1, 3-5→2, 6-10→3, 11+→4). Month labels derived from rolling start date.
- `StackedBarChart`: maps timeline bars + domain slugs → display names via `domainLabel()`.
- `LeaderboardList`: maps leaderboard items; `deltaPct=null` (new entry) emits no delta chip; conditional spread throughout for `exactOptionalPropertyTypes`.
- `lib/domains.ts`: `DOMAIN_LABELS` map + `domainLabel(slug)` fallback capitalizer. Exported from the barrel for Phase 12 reuse.
- AdminShell nav: "Activity" entry (chart icon, adminOnly) inserted between Reports and AI generation history.
- Help: 3 keys added to `modules/16-help-system/content/en/admin.yml` + Block C test in `admin-help-keys.test.ts`.
- Route: `/admin/activity` in `apps/web/src/App.tsx`, `<RequireSession role="admin">`.

## Open questions
- Tenant switcher — only shown if user has multi-tenant role; rare for v1 (deferred until needed)
- Mobile admin UI — desktop-first; mobile only for "monitor queue/approve override" lite view in Phase 3
- /admin/guide Option B migration (16-help-system YAML content) — Phase 4+ backlog


## 2026-10-02 - paged invitations list (assessment-detail)

The invitations table on `assessment-detail.tsx` shows 100 rows per page (API cap) with `Showing x-y of N` + `Previous` / `Next` (only when N > 100; help id `admin.assessments.invitations.paging`). Sorting is per page. The invite picker's "already invited" set and the Delete has-attempts guard are computed from ALL pages (ids/flags only) so they never assume the visible page is everything; "Resend to everyone who hasn't started" is server-side (`resendable`, all pages).

## numeric / multi_select in the admin UI (2026-10-02)

- **Question editor** (new-question form): type list gains `numeric` and `multi_select` with starter JSON; a help icon (`admin.question.content.numeric` / `.multi_select`) sits on the "Content (JSON) *" label for those types. Content stays a JSON textarea like every other type; the server validates with the Zod schemas. JSON bulk import needs no change (it validates against `QUESTION_TYPES`).
- **Readers** (no raw JSON): `QuestionContentView` (numeric shows the correct value, tolerance and unit; multi_select reuses the option list with every correct option highlighted plus the scoring mode), `QuestionPromptView`, `ExpectedAnswerView`, and `AttemptGradingPanel`'s answer view (numeric value with a tick or cross; multi_select lists each picked option with a tick or cross). Option letters extended to J (10 options).
- Pack-detail type filter chips include the two types.
- Not included: field-by-field forms for the content (JSON editing only), AI generation wizard support.
