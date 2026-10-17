# Admin navigation review — fewer, flow-shaped pages for the organisation admin

**Status:** REVIEW DONE 2026-10-17, no code yet. Feeds ROADMAP rows Z-21 (help drawer + My account), Z-22 (flow gaps), Z-23 (7-item regroup, owner-gated), Z-24 (flow-first Home checklist). **Same-day update:** S15 shipped RW-83 "Start a test" (`283dd23`, `/admin/start-test`, `pages/start-test.tsx`) as a new nav item in the Work section, so the tenant admin now sees 16 items; the target layout folds it into Home as the primary button.
**Owner question (2026-10-17, screenshot of assessiq.in/admin):** how many left-nav items are documentation, can they be one user guide, and how can the org admin run one assessment end to end with fewer, more effective pages. Constraint: do not delete or discard any feature (PROJECT_BRAIN Rule A).
**Method:** four read-only sweeps (Sonnet) over all 36 `/admin/*` routes in `apps/web/src/App.tsx:85-139`, every page under `modules/10-admin-dashboard/src/pages/`, `AdminShell.tsx`, module 16 help components and seeds, docs 07, 08, 09, 10, 14, STYLE, ROADMAP, SESSION_STATE. Two surprising claims re-verified by grep (no admin help trigger; Attempts ignores `assessmentId`).

## 1. What the admin sees today (tenant `admin` role)

Sidebar `AdminShell.tsx:259-311`, sections rendered at `:445-450`: **Work** (Dashboard, Assessments, Attempts, Grading status, Reports, Certificates) · **Content** (Question bank; super admin also Generate questions, Generation history) · **Admin** (Users, Activity, Audit log) · **Integrations** (Webhooks, Embed) · **Account** (Help guide, Account security, Settings) · **Platform** (super admin only: Grading queue, Platform, Help content). Tenant admin count: **15 items in 5 sections** at review time, **16** after S15 added "Start a test" (`AdminShell.tsx:261`).

Top bar (`AdminShell.tsx:459-572`): hamburger (mobile), AssessIQ link, tenant logo, NotificationBell, email text, Sign out. **No help button.** Sidebar footer (`:324-370`): avatar, name, role. **Not clickable.**

### Route table (role gate = router guard; super admin passes the admin gate)

| Route | Page file | In nav | Gate |
| --- | --- | --- | --- |
| /admin | dashboard.tsx | Y Dashboard | admin |
| /admin/start-test | start-test.tsx (S15, RW-83: pick set, difficulty, count, name; tick candidates or paste emails; create → publish → invite) | Y (since 283dd23) | admin |
| /admin/assessments, /:id | assessments.tsx (+assessments/), assessment-detail.tsx (+assessment-detail/) | Y / N | admin |
| /admin/attempts, /:id | attempts.tsx, attempt-detail.tsx | Y / N | admin |
| /admin/grading-jobs | grading-jobs.tsx ("Grading status") | Y | admin |
| /admin/reports, /cohort/:assessmentId, /individual/:userId | reports.tsx, cohort-report.tsx, individual-report.tsx | Y / N / N | admin |
| /admin/certificates | certificates.tsx | Y | admin |
| /admin/question-bank, /:id, /questions/:id | question-bank.tsx, pack-detail.tsx (+pack-detail/), question-editor.tsx | Y / N / N | admin (curation buttons super admin only) |
| /admin/question-import | question-import.tsx | N (button on Question bank) | super_admin |
| /admin/generate-wizard, /admin/generation-attempts | generate-wizard.tsx, generation-attempts.tsx | Y | super_admin |
| /admin/users | users.tsx | Y | admin |
| /admin/activity | activity.tsx | Y | admin |
| /admin/audit-log | audit-log.tsx | Y | admin |
| /admin/integrations/webhooks, /embed | webhooks.tsx, embed-config.tsx | Y | admin |
| /admin/guide | admin-guide.tsx (wrapped in AdminShell by App.tsx:106, no `helpPage`) | Y | admin |
| /admin/account-security | account-security.tsx | Y | admin |
| /admin/settings (/settings/billing redirects) | billing.tsx ("Plan & usage" + embedded TenantSettings) | Y "Settings" | admin |
| /admin/tenant-settings | tenant-settings.tsx (alias; also embedded in billing.tsx:468) | N | admin |
| /admin/settings/help-content | help-content.tsx | Y (Platform) | super_admin |
| /admin/platform, /platform/evaluations, /platform/evaluations/:attemptId, /platform/:tenantId/users | platform.tsx (+platform/), evaluations-queue.tsx, evaluation-detail.tsx, super-admin-users.tsx | Y / Y / N / N | super_admin |
| /admin/login, /select-identity, /login/email, /mfa, /invite/accept | apps/web pages | N | pre-session |

## 2. Answers to the owner's questions

### 2.1 Documentation items
- **One** nav item is documentation: **Help guide** (`/admin/guide`). Static JSX, 732 lines: "Conducting an assessment." → Overview (three-layer model), Prerequisites, 12-step workflow (find licensed sets, copy a set, question types, build assessment, sections and timers, integrity, publish, invite, candidates take, AI grades, review and release, reports), 6 tips, 6 FAQ, "On this page" TOC. Buttons: Open Users, View Attempts, How grading works. `TODO(phase-4)` at lines 9-11: move to help YAML. No `admin.guide.*` keys exist in `modules/16-help-system/content/en/admin.yml` or the seed.
- **Hidden help that does not work in admin:** every admin page mounts `HelpProvider` through `helpPage` (`AdminShell.tsx:648-653`) and carries `data-help-id` markers (497 seeded admin rows), but `HelpDrawer` / `HelpDrawerTrigger` are mounted only in `apps/web/src/pages/take/TakeRoot.tsx` and `modules/11-candidate-ui/.../CandidateHelp.tsx`. In admin only `HelpTip` tooltips render (one use: billing.tsx:291). The `<page>.page` entries are unreachable.
- **Doc-like fragments elsewhere:** Grading status "How grading works" text + Help guide link; billing.tsx static "How grading and usage work", "Questions about your plan", footer "Help guide" button; Embed "Integration snippet"; Certificates info rows.
- **Stale guide text:** Audit log tip says the UI is "not yet shipped" (admin-guide.tsx:25-26, 606-610); `/admin/audit-log` exists.

### 2.2 Overlaps found (same data or action on two pages)
- Queue counts: Dashboard StatCards and Grading status StatCards read the same `GET /admin/dashboard/queue` numbers (grading-jobs.tsx:134 says so).
- Queue rows: Dashboard "Results queue" (oldest 50, Review button, 30 s poll) and Attempts tabs "Awaiting grading"/"Released" list the same attempts.
- Per-assessment status: Grading status "By assessment" table vs Assessment detail invitations table.
- Release: single release on Attempt detail; bulk "Release all ready" on Assessment detail; certificates auto-issue on release (docs/14 § `issueCertificateOnRelease`), the Certificates page is revoke/reissue only.
- Reports landing re-lists Assessments (non-draft) and Attempts (released, last 20).
- Activity page has an inner tab named "Audit log" (activity.tsx:755) that shows the activity feed (audit_log ∪ attempt_events), not the Audit log page; same name as the nav item.
- "Webhook secret" (HMAC regenerate) lives on the Embed page, not on Webhooks.
- Activity vs Audit log: Activity = analytics (period stats, 52-week heatmap, weekly bars, leaderboard) + humanised feed, role filter, load-more; Audit log = raw `audit_log`, date and entity filters, 50/page, CSV + JSONL export, archive range (marks rows, 100 000 cap), backend-only list/restore archives (`modules/14-audit-log/src/routes.ts:188,199`).

### 2.3 Flow gaps that break "end to end" (ROADMAP Z-22)
1. `attempts.tsx` never reads `assessmentId`; the Assessment detail link "View attempts for this assessment" (`/admin/attempts?assessmentId=…`) therefore shows all attempts.
2. Dashboard "New assessment" navigates to the list; the create form is on the list page and does not open.
3. Reports landing shows only the last 20 released candidates (de-duplicated) with no search; older candidates are unreachable except through Attempts.
4. Guide text stale (Audit log "not yet shipped").
5. No `admin.activity.page` key seeded; `admin.users.list.reset_totp` seeded but unused by users.tsx.
6. Activity inner tab label "Audit log" clashes with the nav item.

## 3. Target layout (ROADMAP Z-23) — 15 items → 7, nothing removed

Each tab = the existing page component at its existing route with its own `helpPage`. Only the sidebar entries and a tab strip (kit Tabs, as tenant-settings.tsx:667-685 already does) change. Old routes stay live; any renamed route gets a redirect (precedent: `/admin/settings/billing`).

| Nav item | Tabs (existing pages) | Notes |
| --- | --- | --- |
| **Home** | Dashboard | Primary button "Start a test" (the S15 page at `/admin/start-test`; its nav item goes away, the route stays). Z-24 adds the 6-step "Run an assessment" checklist. |
| **Assessments** | Assessments · Attempts · Grading status · Certificates | Whole lifecycle. Grading status stays read-only (FU-C1). Fix 2.3 #1 so the tab opens filtered. |
| **Question bank** | unchanged | Import stays a super-admin button. |
| **Reports** | Reports · Activity | Rename Activity's inner "Audit log" tab to "Recent activity". |
| **People** | Users · Audit log | |
| **Integrations** | Webhooks · Embed | Move the "Webhook secret" card to Webhooks (new help ids `admin.webhooks.secret*`, migration like 0149/0155). Parked FU-B11 API keys becomes a third tab. |
| **Settings** | Organisation · Results · Data privacy · Plan & usage | These tabs already exist inside billing.tsx + TenantSettings; surface them at nav level. Super-admin "AI Generation Mode" card stays in Plan & usage. |

Outside the list:
- **"?" in the top bar** (Z-21): mount `HelpDrawerTrigger` + `HelpDrawer` from module 16 in `AdminShell`, with Ctrl/Cmd+/ as in the take page. Two tabs: *This page* (`<helpPage>.page` + element ids) and *Guide* (the 12 steps, tips, FAQ moved to `admin.yml` under a new `admin.guide.*` family; closes the phase-4 TODO). Sidebar "Help guide" item removed; `/admin/guide` route stays and renders the same guide (or redirects to Home with the drawer open).
- **My account** (Z-21): footer avatar card becomes a link/menu: two-factor status, regenerate recovery codes (account-security.tsx content), enrol link to `/admin/mfa`, Sign out. Sidebar "Account security" item removed; route stays.
- **Platform** section: unchanged.

Labels follow the glossary (docs/10 § glossary, STYLE.md): organisation, question set, attempt, assessment, grade, release, publish; no company/tenant/pack/test/exam.

### Rejected
- Collapsible sidebar groups: the 2026-05-20 reorg chose flat sections on purpose ("lowest-risk reorg", `AdminShell.tsx:249-257`).
- Merging page components into one file: forces help-id renames and a help migration for every merged page; tabs avoid it.
- Removing Grading status, Activity or Certificates pages: Rule A; they become tabs.
- Changing routes: emails and docs carry admin URLs (docs/14:176, docs/09 Settings paths).

## 4. Delivery order and sizes
1. **Z-21 light (1 session, S):** help drawer in admin + guide into YAML + My account footer + remove the two nav items. 15 → 13.
2. **Z-22 flow gaps (any session, S):** the six fixes in 2.3. Independent of the layout.
3. **Z-23 regroup (2 sessions, M, owner confirms names and order first):** 7 items + tab strips + redirects + docs 08 and 10 + help ids for the webhook-secret move + e2e nav smoke.
4. **Z-24 flow-first (after Z-23, S):** Home checklist (start a test or create → invite → take → grade → release → certificate, each step links to the tab and ticks from live data). RW-83 "Start a test" already exists (S15) and is step 1.

## 5. Constraints every implementer must keep
- Help-id prefix guard: `modules/16-help-system/src/__tests__/help-id-page-prefix.test.ts` (empty allowlist). Element ids must start with the page's `helpPage`; segments `[a-z0-9_]` only. Help text edits go through `content/en/admin.yml` → `pnpm tsx tools/generate-help-seed.ts`; a text change on an existing key needs a new-version migration (docs/07:403-426).
- Role gates live in two places: nav flags in `AdminShell.tsx` and `RequireSession` guards in `App.tsx:93-139`. Change both.
- Kit rules: consult `modules/17-ui-system/AssessIQ_UI_Template/`, never import from it; list-page header pattern (count Chip + serif h1 + lede + filter strip); sidebar 240 px, 10 px mono section labels; `cozy` density, `compact` tables (docs/08:788, docs/10:38, 287, 406-448).
- Mobile: off-canvas drawer with focus trap (`AdminShell.tsx:150-200`); tab strips must scroll horizontally on phones.
- Prior decisions this supersedes on an explicit owner yes: 2026-05-20 four-section layout (`032ef84`), RW-16 five-section order (`fee09fd`, "owner confirms the order").
- Rows to align: RW-83 (shipped S15 `283dd23`; nav item folds into Home), RW-81 (design pass, no new features), E11 (list quick actions), FU-B11 (API keys tab), X7/FU-A5 (route tier gates; keep gating per tab route), X2 (self-serve onboarding, owner-gated), RO4 (admin MFA optional wording in the guide).
- Same-PR docs: docs/08-ui-system.md § AdminShell, docs/10-branding-guideline.md § shell, modules/10-admin-dashboard SKILL.md, docs/07 for the `admin.guide.*` family; help text for every new element.

## 6. Features that must survive (checklist for the Z-23 verification sweep)

**Start a test (S15):** licensed set, difficulty, count, name · tick candidates or paste emails · window defaults · create → publish → invite → users/import sequence · result card with assessment link and skip reasons · link on the assessments list.
**Dashboard:** queue counts (in queue, awaiting grading, ready to release; 30 s poll) · UsageBanner · Results queue table with sort and Review · Refresh · New assessment.
**Assessments list:** status tabs in URL · sortable table with invited counts · UsageBanner · create form: From a set (FromSetPicker: set, difficulty, question count), Blueprint (super admin, BlueprintBuilder, PreviewAdequacy), name, opens/closes, SectionsEditor, integrity switches, entitlement-filtered domains.
**Assessment detail:** header chips · Back · Cancel (soft retire) · Delete (no attempts only) · Publish with entitlement hint · ReleaseResendBlock (view attempts link, Release all ready with released/skipped report, Resend to all not started, cap 200) · IntegrityCard · SectionsCard · Advanced settings (HighStakesCard, NegativeMarksCard, RemindersCard) · Invitations table (paging, status, score, per-row Resend) · Invite candidates multi-select + link to Users · CandidateCsvImport · results sort (name/rank/branch) · Download results CSV.
**Attempts:** tabs All/Submitted/Awaiting grading/Graded/Released (sessionStorage) · sortable table · ErasedChip · limit 100.
**Attempt detail:** status chip · 3-step bar · awaiting banner · section scores · AttemptIntegrityCard · AttemptGradingPanel review · Print review · Send back for re-grading (note ≤500) · Release to candidate (ReleaseConfirmModal, terminal) · Override grade (band, reason, fresh MFA).
**Grading status:** 3 StatCards · Waiting time card · By assessment table · How grading works · links to assessment, Attempts, guide.
**Reports:** landing (cohort list 50, individual last 20) · cohort: StatCards + percentiles, by difficulty, by topic, topic heatmap with set selector, archetype distribution · individual: sparkline, per-attempt radar, link to attempt.
**Certificates:** info rows · tier filter · status filter · sortable table + Load more · super-admin Organisation column · drawer (copy ID, verify link, PDF, counters) · Revoke (reason) · Reissue (display name).
**Question bank:** pack list with status tabs + URL filters + search · sortable columns (levels, questions, completed) · create set (super admin) · archive from row menu · Licensed sets card: Add to organisation (clone), Update (resync), chips · Import questions button (super admin).
**Pack detail:** header (status, version, domain, created) · Back · Generate (super admin) · Archive, Publish, Revise (super admin) · FrameworkTreePicker filter · per-level panel: counts, status and type chips, last-generation line with 5 s poll, rows with source links, per-row archive, selection · Activate drafts and bulk Approve/Archive bar (super admin).
**Question editor:** create for 9 types with per-type forms (super admin) · content view · chips (status, type, Bloom, NICE) · negative marks · answer guidance with AI generate · framework nodes (edit super admin) · Approve/Reject ai_draft · Archive · RubricEditor (Generate, Regenerate confirm, Enter manually, abort, Save rubric as new version, reasoning weight) · read-only for admin.
**Question import (super admin):** template download CSV/XLSX per type · upload CSV/XLSX/GIFT/Aiken with subject and size cap · dry-run report with Fix/Skip · Commit (skip errors)/Discard · open draft set · batch AI rubric drafting.
**Users:** invite admin (7-day link) · add candidate · search, role chip, status filter, paging · Disable/Re-enable/Remove/Restore with audit reason · last-admin and self guards · Reset two-factor · Cancel pending invitation · candidate Download data (JSON) and Erase personal data · super-admin read-only banner.
**Activity:** period stats · heatmap with streaks · weekly stacked bar · leaderboard with deltas · role-filtered feed with load more.
**Audit log:** date and entity filters · paged table · Export CSV/JSONL · Archive range · truncation note · (API only: list/restore archives).
**Webhooks:** add endpoint with one-time secret + copy · Test · Delete · delivery log with status filter, Replay, CSV export, paging.
**Embed:** embed secrets create/rotate (24 h grace)/delete, one-time show · integration snippet · webhook HMAC secret regenerate · trusted origins add/remove/save.
**Settings:** organisation name · logo upload/remove (MFA step-up) · result release mode (MFA step-up) · retention days · purge preview/run · erased candidates list with window filter · plan & usage card, limits · static explainers · super-admin AI generation mode.
**Account security:** 2FA status · regenerate recovery codes (one-time view, copy) · enrol link.
**Help guide:** overview, prerequisites, 12 steps with in-page links, tips, FAQ, TOC.
**Shell:** NotificationBell · MFA nudge banner · breadcrumbs · tenant logo · Sign out · sidebar collapse (sessionStorage per tenant) · mobile drawer with focus trap · role-gated nav · `/admin/tenant-settings` alias and `/admin/settings/billing` redirect · HelpProvider, HelpTip, all data-help-id markers.
**Super admin (unchanged):** Generate questions, Generation history, Grading queue, Evaluation detail, Platform (+ company provisioning, billing drawer, lifecycle, AI grading scope, background jobs, domains, frameworks), per-tenant Users, Help content editor.
