# UI Kit v1.1 Port — Phased Implementation Plan

**Goal:** Adopt the v1.1 design kit shipped at `modules/17-ui-system/AssessIQ_UI_Template/` (commit `9c03797`) across every live page in `apps/web`, plus introduce the new Activity surface at `/admin/activity` and `/candidate/activity` with role-aware data scoping.

**Authored:** 2026-05-13 from Phase 0 documentation discovery (5 parallel research agents). See "Phase 0 research artifacts" section at the bottom of this file for the source reports.

**Audience:** Each phase is designed to be executed in its own session by an Opus orchestrator + Sonnet subagents per `CLAUDE.md` orchestration playbook. Phases are sequenced but most are independent below the dependency line — do NOT batch multiple phases into one session.

**Phasing summary:** 14 phases, ~14–18 sessions of work. Phase 1 is the highest-impact-per-line session (7 token value changes ripple visible darker-text identity across all 25+ existing pages). Phases 9–12 (Activity feature) can be parallelized with Phases 5–8 (page refresh) since they touch independent code.

**Progress:** ✅ P1 (tokens) · ✅ P2 (atoms) · ✅ P3a (Spinner/Icon) · ✅ P3b (Activity primitives) · ✅ P4 (auth flows) · ✅ P5 (admin dashboard + shell) · ✅ P6a (candidate take flow — landing/submitted/expired/error) · ✅ P6b (Attempt page) · ✅ P7a (list template + Users + Attempts) · ✅ P7b (remaining list ports) · ✅ P8a (Cohort report + Attempt detail) · ✅ P8b (Individual report + Reports landing) · ✅ P9 (admin activity backend) · ✅ P10 (candidate activity backend) · ✅ P11 (admin Activity wire) · ✅ P12 (CandidateActivity Spinner) · ✅ P13 (settings + low-traffic pages) — **14/14 phases complete.**

---

## Anti-pattern guards (apply to EVERY phase)

These are bounce conditions for every diff. Cite the source when a Phase 3 critique flags one.

1. **No imports from `modules/17-ui-system/AssessIQ_UI_Template/**` in production code.** ESLint `no-restricted-imports` blocks this. (`eslint.config.js:55-58`). Translate kit values into the `@assessiq/ui-system` package.
2. **No new page without a matching `screens/<name>.jsx` in the kit.** If no screen exists for what you're building, STOP and surface the gap; either request a new reference screen first or get explicit approval. (`docs/10-branding-guideline.md:29`).
3. **No token hardcoding.** No inline hex, `oklch()`, or px values if a `--aiq-*` token expresses the same thing. (`docs/10-branding-guideline.md:428`).
4. **No `data-theme="dark"` rendering in production.** SPA mounts `<ThemeProvider theme="light">` and dark mode is gated on 3 explicit conditions (`docs/10-branding-guideline.md:48-56`). Dark tokens may be EDITED in `tokens.css`; they must not be APPLIED at runtime.
5. **Every new UI element needs `help_id` + content entry in `modules/16-help-system` in the SAME PR.** (`PROJECT_BRAIN.md:104`, `CLAUDE.md:74`).
6. **No non-pill buttons.** Every button is `border-radius: 999px`. (`docs/10-branding-guideline.md:207`).
7. **Serif for big numbers, sans for body, mono for IDs/timestamps.** Family swap is a bounce. (`docs/10-branding-guideline.md:77-89`).
8. **Single accent (hue 258).** No new hues; status colors used sparingly. (`docs/10-branding-guideline.md:103-128`).
9. **Borders, not shadows.** Cards at rest are border-only; shadow is hover-elevated or floating only. (`docs/10-branding-guideline.md:204-206`).
10. **Multi-tenant lock.** Every new domain table → `tenant_id` + RLS policy. Every new endpoint → tenant-context middleware. Never `if (domain === "x")`. (`CLAUDE.md` rule #4).
11. **No batching of phases.** Per `CLAUDE.md` rule #9: each session = own commit/deploy/document/handoff. Never roll up 4 sessions into one mega-handoff.
12. **Document deliberate divergence.** If a live page diverges from the kit screen, the page header comment must say `// Diverges from screens/<name>.jsx because: <reason>`. (`docs/10-branding-guideline.md:38`).
13. **Audit log every admin mutation.** New admin write paths add an `auditInTx` row in the same transaction. (`PROJECT_BRAIN.md:106`).

---

## Dependency graph

```
P1 (tokens) ──┬──> P2 (atoms) ──> P3 (primitives) ──┬──> P4 (auth flows)
              │                                      ├──> P5 (admin dashboard)
              │                                      ├──> P6 (take flow)
              │                                      ├──> P7 (list pages)
              │                                      └──> P8 (results/reports)
              │
              │   [parallel track — Activity feature]
              └──> P9 (admin activity backend) ──> P10 (candidate activity backend)
                                                    │
                                                    └──> P11 (admin activity wire) ─┐
                                                                                    ├──> P14 (cross-cut verify)
                                                                                    │
                                                    └──> P12 (candidate activity wire) ─┘
                  P13 (settings/low-traffic) ─────────────────────────────────────────┘
```

P1 must land before P2/P9. P2 must land before P3. P3 must land before P4–P8. P9 must land before P11. P10 must land before P12. P13 has no hard dependencies (could land any time after P3). P14 is last.

---

## Phase 1 — Token migration (1 session)

**Why first:** The 7 diverged token values + serif weight will ripple a visible v1.1 identity across every existing page with one ~10-line CSS edit. Maximum visible payoff per byte changed.

### What to implement
Edit `modules/17-ui-system/src/styles/tokens.css` with these exact value changes:

| Line (approx.) | Token | Old value | New value | Source citation |
|---|---|---|---|---|
| 19 | `--aiq-color-bg-sunken` | `#f5f5f5` | `#f3f3f4` | kit `styles.css:5` |
| 21 | `--aiq-color-fg-primary` | `#1a1a1a` | `#0a0a0b` | kit `styles.css:8` (NEAR-BLACK) |
| 22 | `--aiq-color-fg-secondary` | `#5f6368` | `#3f3f46` | kit `styles.css:9` |
| 23 | `--aiq-color-fg-muted` | `#9aa0a6` | `#71717a` | kit `styles.css:10` |
| 25 | `--aiq-color-border` | `#e8e8e8` | `#e4e4e7` | kit `styles.css:6` |
| 26 | `--aiq-color-border-strong` | `#d4d4d4` | `#cdcdd1` | kit `styles.css:7` |
| 137 | `.aiq-serif` `font-weight` | `400` | `500` | kit `styles.css:76`, `tokens.md:64` |

**Dark-mode block ALSO needs adjustment** (production `tokens.css` lines ~90–110, find `[data-theme="dark"]`). The light-mode darkening compresses contrast vs the existing dark values. Adjust:
- `--aiq-color-fg-muted` dark: current `#6a6a72` → propose `#88889a` (current value is now too close to the new light-mode value, breaking the hierarchy). Validate with axe ≥ 4.5:1 against `#0e0e10` dark bg. (`docs/10-branding-guideline.md` § Light-mode lock).
- `--aiq-color-fg-secondary` dark: current `#a0a0a8` → propose `#8a8a94` to mirror the ~20-step L* shift in light mode.

**Note:** Even though dark mode is locked off at runtime, these tokens are still load-bearing for the future opt-in. Fix the values now so the next time dark mode is unlocked, no follow-up PR is needed.

### Documentation references (read in this order)
1. Kit token reference: `modules/17-ui-system/AssessIQ_UI_Template/styles.css:1-53` (light + dark blocks).
2. Kit token table: `modules/17-ui-system/AssessIQ_UI_Template/design-system/tokens.md:1-168` (colors, type, spacing, radii, shadows).
3. Production token file (target): `modules/17-ui-system/src/styles/tokens.css:1-285`.
4. Translation pattern: `docs/10-branding-guideline.md:31-36` step 5.

### Verification checklist
- `pnpm -C modules/17-ui-system typecheck` clean (no TS errors).
- `pnpm -C apps/web typecheck` clean.
- `pnpm -C apps/storybook build` succeeds (visual regression: Storybook still renders).
- Browser smoke: `pnpm -C apps/web dev`, open `/admin/login` and a list page (e.g. `/admin/users`). Confirm body text is visibly darker, secondary labels are visibly darker, serif headings are visibly heavier. Hard-refresh + screenshot for the handoff.
- Production smoke after deploy: hit `https://assessiq.automateedge.cloud/admin/login` and verify the same darkening.
- `axe-core` contrast spot-check on the login page (light mode). All text ≥ 4.5:1 against bg.

### Anti-pattern guards (this phase)
- Don't touch any component `.tsx` file — token migration is CSS-only.
- Don't introduce new token names — only modify existing values.
- Don't remove the dark-mode block — only adjust values within it.
- Don't change `--aiq-color-accent` family (`oklch(0.58 0.17 258)`) — they already match the kit.

### Docs to update (same commit)
- `docs/10-branding-guideline.md` — section listing exact production token values (search for `--aiq-color-fg-primary` references; update). Add a note: "Values aligned to kit v1.1 in commit `<sha>`."
- `docs/08-ui-system.md` — token catalog section if it lists raw values.
- `modules/17-ui-system/SKILL.md` — status section bullet noting v1.1 token alignment.

### Estimated diff
- `tokens.css`: ~10 lines changed.
- 3 doc files: 3–6 lines each.
- 0 component files.
- Total: ~25 lines.

---

## Phase 2 — Atom refresh (1 session)

**Why now:** Phase 1 cascades through tokens, but a handful of atoms need structural tweaks (CSS class additions, weight adjustments, polyline vs path, breakdown variant) that token edits alone won't catch.

### What to implement
Five surgical component updates. Each is < 30 lines.

#### 2a. `Chip` — add `warn` variant
- Current variants: `default | accent | success`. Kit assessment screen uses a warn state on flagged navigator squares.
- Update `modules/17-ui-system/src/components/Chip.tsx`: add `"warn"` to `ChipVariant` union; auto-default `leftIcon` to `flag` for `warn`.
- Update `tokens.css`: add `.aiq-chip-warn` class with `--aiq-color-warning-soft` bg + `--aiq-color-warning` border/text. Source recipe: `AssessIQ_UI_Template/design-system/components.md:93+` chip variants.
- Add `--aiq-color-warning-soft` token if missing (mirror `--aiq-color-success-soft` at `oklch(0.97 0.04 70)`).
- Add Storybook story variant + 1 a11y axe assertion.

#### 2b. `Sparkline` — switch path to polyline
- Current: `<path d="M..L..">` with strokeWidth 1.5px.
- Kit: `<polyline points="..." vector-effect="non-scaling-stroke">` with strokeWidth 1.2px (`kit dashboard.jsx`).
- Reason: non-scaling-stroke keeps line width consistent in responsive containers.
- File: `modules/17-ui-system/src/components/Sparkline.tsx`.

#### 2c. `ScoreRing` — animation timing fix
- Current: 180ms SVG transition + 1400ms count-up (split timing).
- Kit `results.jsx`: 1.6s ring arc animation (single timing).
- Fix: align ring stroke-dashoffset transition to 1600ms ease-out, keep count-up at 1400ms.
- Also: review `<text>` inside SVG vs DOM overlay (kit uses DOM overlay; some browsers have font-rendering edge cases on SVG `<text>`). If the SVG approach renders fine on current browsers, leave it — note the deviation in component comment.

#### 2d. `StatCard` — add optional `breakdown` prop
- New prop: `breakdown?: Array<{ label: string; value: string | number; pct: number; color?: string }>`.
- When provided: renders a mini stacked bar (5-column sparse chart) + colored legend rows below the main KPI.
- When absent: renders existing simple KPI tile (backwards compatible).
- Internal color constant `ACT_COLORS = ['#1a73e8', '#10b981', '#fbbc04', '#ea4335', '#9333ea', '#06b6d4', '#f97316']` from `activity.jsx`. Promote to a `--aiq-chart-*` token series in `tokens.css` for tenant overridability.
- ~80 lines of new render logic. Source: `kit activity.jsx:10-51` (`StatChart` component).

#### 2e. `Sidebar` / `NavItem` — width + section headers + footer slot
- Sidebar width: bump from 220px → 240px (match kit `dashboard.jsx`).
- Add optional `<SidebarSection label="Workspace" />` sub-component for mono 10px uppercase section headers.
- Add `footer?: ReactNode` prop on Sidebar for user-card / settings link slot.
- NavItem gap/padding currently uses tokens; kit uses literal 12px / 9px-14px — confirm tokens compute to those values; if not, adjust the relevant `--aiq-space-*` mapping.

### Documentation references
- `modules/17-ui-system/AssessIQ_UI_Template/design-system/components.md` — all component recipes.
- `modules/17-ui-system/AssessIQ_UI_Template/screens/atoms.jsx` — Logo, Icon, Placeholder, useCountUp.
- `modules/17-ui-system/AssessIQ_UI_Template/screens/dashboard.jsx` — Sidebar, NavItem, StatCard, Sparkline in context.
- `modules/17-ui-system/AssessIQ_UI_Template/screens/activity.jsx` — StatCard breakdown variant in context.

### Verification checklist
- Typecheck clean both packages.
- Storybook builds and 5 new/updated stories render.
- 1 axe assertion per updated component (this is the first session where axe lands — see note below).
- Visual: pull up `/admin` (dashboard uses Sidebar + StatCard + Sparkline) and verify polyline width is 1.2px, sidebar is 240px, NavItem hover state matches kit.

### A11y wiring note
This is the first session where we INTRODUCE axe a11y tests. The current ui-system has no axe coverage (Agent 2 finding: "A11y gap is total"). Add the minimal scaffolding: install `@axe-core/playwright` or `vitest-axe`, write one assertion per updated component as a precedent for the rest of the port. Defer cross-page axe sweep to Phase 14.

### Anti-pattern guards (this phase)
- Do NOT remove props from existing components (Chip, Sparkline consumers count on current signatures).
- Do NOT break Storybook story signatures — add stories, don't replace.
- New `ACT_COLORS` palette: tokenize, don't hardcode hex in components.

### Docs to update
- `docs/08-ui-system.md` — component catalog: new Chip variant, StatCard breakdown shape, Sidebar section/footer slots.
- `modules/17-ui-system/SKILL.md` — status + new exports.
- `modules/16-help-system` — help entries for any new admin-facing element (`admin.sidebar.section`, etc. — confirm what's user-visible).

### Estimated diff
- 5 component files, ~30–80 lines each: ~250 lines.
- `tokens.css`: ~15 lines (warn-soft, ACT_COLORS token series).
- Storybook stories: ~80 lines.
- Total: ~400 lines.

---

## Phase 3 — New primitives (2 sessions: 3a then 3b)

**Why now:** Activity screen (Phases 11–12) and several Tier B/C ports (Phase 7) need primitives that don't exist yet. Build them all in one phase so subsequent page-port sessions can just import.

### Phase 3a — Easy primitives (1 session)
1. **`Spinner`** — promote 4 ad-hoc inline implementations. Rotating ring loader, sizes sm/md/lg. ~30 lines + story.
2. **`ProgressBar`** — thin horizontal bar (2/4/6px), track + fill, variants `accent | success | fg`. ~30 lines + story. Source: `kit components.md:170-183`.
3. **`Placeholder`** — striped diagonal `repeating-linear-gradient`, mono uppercase caption, configurable w/h/radius. ~25 lines + story. Source: `kit atoms.jsx:43-54`, `components.md:227-233`.

### Phase 3b — Activity primitives (1 session)
1. **`ActivityHeatmap`** — 52×7 grid, 5 intensity levels, month/day labels, legend + streak summary. Props per the agent-4 report. ~120 lines + 4 stories. Source: `kit activity.jsx:53-107`.
2. **`StackedBarChart`** — multi-series stacked bars, no chart library, pure SVG/divs. ~150 lines + 4 stories. Source: `kit activity.jsx:109-143`.
3. **`LeaderboardList`** — 2-col grid of `LeaderboardRow` (rank + avatar + name + metric + delta), optional `onShowMore`. ~100 lines + 4 stories. Source: `kit activity.jsx:146-185`.

(Note: `StatCardWithBreakdown` was already added as `StatCard` `breakdown` prop in Phase 2d; not duplicated here.)

### Verification checklist (both 3a and 3b)
- Each new component has a Storybook story with ≥ 3 variants (default, empty, edge case).
- Each has 1 axe a11y assertion.
- Each is exported from `modules/17-ui-system/src/index.ts`.
- `pnpm -C modules/17-ui-system typecheck` clean.
- Storybook build green.
- No consumer wiring in this phase — just the components and stories.

### Anti-pattern guards
- Don't import from `AssessIQ_UI_Template/**` — translate the kit JSX manually, don't copy.
- Don't add `<canvas>` / chart-library dependencies for `StackedBarChart` — kit does it with pure SVG/divs.
- `ActivityHeatmap` must respect `prefers-reduced-motion` (no fade-in animations if user opts out).
- `LeaderboardList` rank avatar colors: use the tokenized chart palette from Phase 2d.

### Docs to update
- `docs/08-ui-system.md` — full API reference for each new component.
- `modules/17-ui-system/SKILL.md` — public surface section.
- Module 16 — no help entries needed yet (these are framework primitives, not user-facing labels).

### Estimated diff
- Phase 3a: ~250 lines across 3 components + stories.
- Phase 3b: ~700 lines across 3 components + stories.

---

## Phase 4 — Auth flow refresh (1 session)

**Why before dashboard:** Login is the entry point. Visual coherence here matters most for first impression.

### What to implement
Refresh 5 auth pages against `kit/screens/login.jsx`:
- `apps/web/src/pages/admin/login.tsx`
- `apps/web/src/pages/admin/mfa.tsx`
- `apps/web/src/pages/candidate/CandidateLogin.tsx`
- `apps/web/src/pages/candidate/CandidateLoginVerify.tsx`
- `apps/web/src/pages/invite-accept.tsx`
- `apps/web/src/pages/take/TokenLanding.tsx` (variant of login layout)

For each: read the current implementation, read `kit/screens/login.jsx` and the relevant pattern in `kit/design-system/patterns.md`, identify deltas (two-pane vs centered, mock score-card sidebar, copy tone), and patch in place.

### Verification checklist
- Each page typechecks clean.
- Each page renders without console errors on `pnpm dev`.
- Visual regression: screenshot before/after each page. Phase 3 critique reads diffs against screenshots.
- E2E: login flow end-to-end works (admin sign-in, candidate magic-link, MFA verify, invite redemption, take-link landing).

### Docs to update
- `docs/04-auth-flows.md` if any flow copy/UX changed.
- `docs/10-branding-guideline.md` — add a "ported pages" log entry.

### Estimated diff
- 6 page files, ~40–80 lines each: ~300 lines.

---

## Phase 5 — Admin dashboard + shell ✅ SHIPPED (3b7e2d9)

### What to implement
Refresh `modules/10-admin-dashboard/src/pages/dashboard.tsx` against `kit/screens/dashboard.jsx`. The kit dashboard shows:
- Sidebar shell (Phase 2e refresh already landed)
- Stat-card row (Phase 2d refresh)
- "Continue where you left off" cards with sparklines
- Recent activity rows

Also refresh `AdminShell` (the layout wrapper) to use the new Sidebar section/footer slots.

### Verification checklist
- Dashboard typecheck + render.
- Sidebar's section headers + footer slot visible.
- Stat cards animate count-up.
- Sparklines render with 1.2px stroke (Phase 2b).
- Phase 3 critique compares against `kit/screens/dashboard.jsx` line-by-line.

### Estimated diff
- `dashboard.tsx`: ~80 lines.
- `AdminShell`: ~40 lines.

---

## Phase 6 — Candidate take flow (2 sessions: 6a then 6b)

### Phase 6a — TokenLanding + Submitted + Expired + Error ✅ SHIPPED (7e89875)
Lightweight pages. Refresh against `kit/screens/login.jsx` (token landing) and atoms-only patterns (terminal pages).

### Phase 6b — Attempt page ✅ SHIPPED (f528fc6)
The question runner is load-bearing (`modules/11-candidate-ui` + `apps/web/src/pages/take/Attempt.tsx`). Refresh against `kit/screens/assessment.jsx`:
- Sticky timer header with warn-state transition (uses Chip warn from Phase 2a)
- Question navigator (existing `QuestionNavigator` in candidate-ui module; promote to ui-system per `SKILL.md` flag — OPTIONAL this phase, can defer to Phase 14)
- Multi-format question options (MCQ / essay / scenario — confirm rendering matches kit)
- Integrity banner (focus-loss warning)

**Risk:** Attempt page has integrity hooks (focus-loss detection, autosave, paste-block per pack policy). Don't regress any of these while restyling. Snapshot tests against attempt flow before edit.

### Verification checklist (6a + 6b)
- Take flow end-to-end works: invite link → landing → start → submit → submitted page.
- Timer behavior unchanged (warn at 5min, danger at 1min).
- Autosave intervals unchanged.
- Phase 3 critique includes a focused review of the autosave + integrity paths since UI restyling can accidentally break event handlers.

### Estimated diff
- 6a: 4 pages, ~40 lines each = ~160 lines.
- 6b: `Attempt.tsx` ~150 lines + module-internal changes ~100 lines = ~250 lines.

---

## Phase 7 — List-page template + first 5 list ports (2 sessions: 7a then 7b)

### Phase 7a — List template + Users + Attempts ✅ SHIPPED (f528fc6)
The repo has no `users.jsx` in the kit (documented gap, `branding-guideline.md:29`). Establish the canonical list-page composition by porting `library.jsx` patterns into a `<ListPage>` wrapper or set of recipes documented in `08-ui-system.md`:
- Page header (icon + title + lede + actions)
- Sticky filter row (Chip filters + search Input)
- Card grid OR sortable Table (data-density dependent)
- Empty state pattern
- Pagination footer

Then port:
- `modules/10-admin-dashboard/src/pages/users.tsx` against this template.
- `modules/10-admin-dashboard/src/pages/attempts.tsx` against this template.

### Phase 7b — Question-bank, Assessments, Candidate Certificates (1 session)
- `modules/10-admin-dashboard/src/pages/question-bank.tsx`
- `modules/10-admin-dashboard/src/pages/pack-detail.tsx`
- `modules/10-admin-dashboard/src/pages/assessments.tsx`
- `modules/10-admin-dashboard/src/pages/assessment-detail.tsx`
- `modules/11-candidate-ui/src/components/MyCertificates.tsx`

All reuse the list template from 7a.

### Docs to update
- `docs/08-ui-system.md` — new "List Page Pattern" recipe section.
- `docs/10-branding-guideline.md` — record the new pattern source.
- `modules/16-help-system` — `admin.list.filter`, `admin.list.search` help_ids if not already there.

### Estimated diff
- 7a: 2 page files + template ~100 lines = ~250 lines.
- 7b: 5 page files, ~50 lines each = ~250 lines.

---

## Phase 8 — Results / reports (2 sessions: 8a then 8b)

### Phase 8a — Cohort report + Attempt detail (1 session)
- `modules/10-admin-dashboard/src/pages/cohort-report.tsx` vs `kit/screens/results.jsx` cohort variant.
- `modules/10-admin-dashboard/src/pages/attempt-detail.tsx` vs `kit/screens/results.jsx` individual variant.

### Phase 8b — Individual report + Reports landing (1 session)
- `modules/10-admin-dashboard/src/pages/individual-report.tsx` — animated ring (ScoreRing Phase 2c) + competency breakdown + archetype panel + AI insights box.
- `modules/10-admin-dashboard/src/pages/reports.tsx` — landing hub (dashboard variant).

### Verification checklist
- Animated score ring runs 1.6s ease-out (Phase 2c).
- Competency breakdown bars use chart palette tokens.
- Phase 3 critique compares score-band rendering against `0/25/50/75/100` model — never raw percentages (CLAUDE.md rule #4).

### Estimated diff
- 8a: 2 files, ~120 lines each = ~250 lines.
- 8b: 2 files, ~100 lines each = ~200 lines.

---

## Phase 9 — Admin Activity backend endpoints ✅ SHIPPED (c87cf53 + d083646)

**Parallelizable with Phases 5–8.** Touches `modules/15-analytics`, not UI.

### What to implement
Four new endpoints under `/api/admin/activity/*`:
1. `GET /api/admin/activity/stats?from=&to=&groupBy=` — 3 stat cards' data (completions / candidates / avgScore with breakdowns).
2. `GET /api/admin/activity/heatmap?from=&to=` — 365-day daily completion counts + streak math.
3. `GET /api/admin/activity/timeline?from=&to=` — 52-week stacked-bar data by domain.
4. `GET /api/admin/activity/leaderboard?period=&page=&pageSize=` — catalog-wide assessment rankings by takers + W/W delta.

All admin-auth + tenant-scoped (RLS via `withTenant`).

### Documentation references
- `modules/15-analytics/src/routes.ts` — existing route layout.
- `modules/15-analytics/src/service.ts` + `repository.ts` — pattern to follow.
- `docs/02-data-model.md` — `attempt_summary_mv`, `attempts`, `question_packs`, `users` schemas.
- `docs/03-api-contract.md` — endpoint format conventions.
- Agent 4 report (this plan's footer) — full SQL sketches per endpoint.

### Verification checklist
- Vitest integration tests against testcontainer DB for each endpoint.
- RLS tested: cross-tenant request returns 0 rows.
- `lint-rls-policies.ts` clean.
- `pnpm -C modules/15-analytics test` green.
- Smoke against staging fixture data.

### Anti-pattern guards
- **Streak computation:** O(365) iteration in TS, not SQL. Don't try to do it in a single window function.
- **Leaderboard delta:** prior-period CTE on live `attempts` table, not the MV (MV is too stale for week-over-week).
- **Domain → display name:** there's no `domain_display_name` mapping in the DB. Either (a) ship a hardcoded frontend mapping for the v1.1 ship and add a schema migration later, or (b) return raw slugs and have frontend map. **Decision needed BEFORE this phase starts.**

### Docs to update (same commit)
- `docs/03-api-contract.md` — full request/response for all 4 endpoints.
- `modules/15-analytics/SKILL.md` — new public surface.

### Estimated diff
- 4 routes + 4 services + 4 repository queries + tests = ~600 lines.

---

## Phase 10 — Candidate Activity backend endpoints (1 session)

**Depends on Phase 9 (reuse SQL, scope adds `WHERE user_id = $session.userId`).**

### What to implement
Four mirror endpoints under `/api/me/activity/*` with candidate auth.

**Open product questions BEFORE this phase (must resolve in kickoff):**
1. **Candidate stat-card #2 replacement.** "Active candidates" doesn't make sense for candidate self-view. Options: (a) "Assessments available to me", (b) "Certificates earned", (c) "Avg time per assessment". Recommend (b) since certification is shipped (Phase 5 module 18) and the data is already queryable.
2. **Candidate leaderboard semantics.** Admin leaderboard = "popular assessments by takers." Candidate leaderboard cannot show that (privacy + DPDP). Two interpretations: (a) candidate's own attempts ranked by their score, (b) public anonymized comparison to peer cohort. Recommend (a) — closest to existing `individualReport` semantics, no DPDP issue.
3. **DPDP gate.** If anything cross-user surfaces in the candidate view, route through the DPDP review the same way `docs/03-api-contract.md` already flags public-leaderboard endpoints.

### Verification checklist
- Same as Phase 9.
- Extra: cross-user RLS test — candidate A's session cannot read candidate B's activity.

### Estimated diff
- Mirrors Phase 9 size: ~500 lines.

---

## Phase 11 — Admin Activity page (1 session)

**Depends on Phase 9 (backend) + Phase 3b (primitives).**

### What to implement
- New file: `modules/10-admin-dashboard/src/pages/activity.tsx` (or `apps/web/src/pages/admin/activity.tsx` — decide based on Phase 0 inventory of existing admin pages location).
- Compose: page header (Phase 7 list-template) + 3 `StatCard` with `breakdown` (Phase 2d) + `ActivityHeatmap` (Phase 3b) + `StackedBarChart` (Phase 3b) + `LeaderboardList` (Phase 3b).
- Wire 4 `/api/admin/activity/*` endpoints via existing fetch infra (TanStack Query or whatever the dashboard uses; check `modules/10-admin-dashboard/`).
- Date-range picker state + period toggle.
- Loading skeletons.
- Register route in `apps/web/src/App.tsx`: `<Route path="/admin/activity" element={<RequireSession role="admin"><AdminActivity /></RequireSession>} />`.
- Add sidebar nav link (Phase 2e Sidebar accepts section structure).

### Verification checklist
- Page renders with mock data on `pnpm dev`.
- Empty-state handling: all 4 endpoints return zero rows → page shows empty messaging not skeleton-infinite.
- Production deploy + smoke: `GET /admin/activity` returns 200, HTML contains heatmap markers.

### Docs to update
- `docs/03-api-contract.md` — confirm endpoints are documented.
- `modules/16-help-system` — `admin.activity.*` help IDs (heatmap legend, streak explanation, leaderboard delta).

### Estimated diff
- 1 page file + nav wiring + help content = ~250 lines.

---

## Phase 12 — Candidate Activity page (1 session) ✅ SHIPPED (f74c0a0)

**Depends on Phase 10 (backend) + Phase 3b (primitives).**

Mirror Phase 11 for candidate side. Mount at `/candidate/activity` with `<RequireSession unauthRedirect="/candidate/login">`.

### Estimated diff
- ~200 lines.

---

## Phase 13 — Settings + low-traffic pages (2–3 sessions, can stretch)

**No hard dependency on any other phase after Phase 3. Schedule when other phases stall on review.**

### What to implement
Pages with no direct kit screen — compose from atoms + patterns:
- `apps/web/src/pages/admin/users.tsx` (already done in 7a) — skip.
- Question editor (`/admin/question-bank/questions/:id`) — MCQ/essay/scenario editor.
- Billing settings (`/admin/settings/billing`).
- Help-content authoring (`/admin/settings/help-content`).
- Admin guide (`/admin/guide`) — markdown renderer.
- Grading jobs (`/admin/grading-jobs`) — Phase 2+ feature, low priority.
- Generation attempts (`/admin/generation-attempts`) — AI-generation history.
- Admin certificates (`/admin/certificates`) — Phase 5 feature.
- Take terminal pages (`/take/expired`, `/take/error`) — error states.
- 404 catch-all in `App.tsx`.

Group into sessions by domain:
- **13a:** Settings (billing, help-content, guide).
- **13b:** Tooling (grading-jobs, generation-attempts, question editor).
- **13c:** Admin certificates + take terminal pages + 404.

### Verification checklist (per session)
- Each page renders + typechecks.
- No new patterns invented without a kit recipe citation.
- Help content + `help_id` for any new admin element.

### Estimated diff
- 13a: ~250 lines across 3 pages.
- 13b: ~300 lines across 3 pages (question editor is heavy).
- 13c: ~150 lines across 4 small pages.

---

## Phase 14 — Cross-cut verification (1 session)

**Last. After everything else.**

### What to implement
- **A11y sweep:** axe assertion per page (use Playwright + `@axe-core/playwright`). Add CI step to gate.
- **Visual regression baseline:** snapshot every page in Storybook + Playwright. Pin to a known-good commit.
- **Lighthouse pass:** ≥ 90 in performance, accessibility, best-practices, SEO for the 5 highest-traffic pages.
- **Reduced-motion sweep:** every animation respects `prefers-reduced-motion: reduce` (ScoreRing, count-up, Sparkline reveal, ActivityHeatmap fade-in).
- **Help-content audit:** every `help_id` referenced in production code has a matching entry in `modules/16-help-system` content table.
- **Branding-guideline reconcile:** read the now-shipped v1.1 implementation alongside `docs/10-branding-guideline.md`. Fix anywhere the doc drifted during the port.

### Verification checklist
- `pnpm test:a11y` (new) clean.
- `pnpm test:visual` (new) clean against baseline.
- Lighthouse CI reports ≥ 90 for the targeted pages.
- All 10+ phases' commits referenced from `docs/SESSION_STATE.md` history.

### Docs to update
- `docs/SESSION_STATE.md` — final "v1.1 port complete" handoff.
- `docs/10-branding-guideline.md` — version bump to v1.1, ship-complete notation.
- `PROJECT_BRAIN.md` — decision-log entry noting full v1.1 adoption.
- `modules/17-ui-system/SKILL.md` — status: v1.1 fully shipped.

### Estimated diff
- Test scaffolding + CI changes + doc updates: ~400 lines.

---

## Phase 0 research artifacts

This plan was built from 5 parallel discovery agents on 2026-05-13. Their reports are NOT included in this document (would balloon size) but the agentIds are recoverable from the session that produced this file. Key citations used:

- **Token diff (Agent 1):** Production `tokens.css` diverges from kit `styles.css` in 6 color values + serif weight. Agent 1 was VERIFIED correct by direct file read; Agent 2's "values match exactly" claim was wrong.
- **Component inventory (Agent 2):** 14 production components catalogued with consumer counts. 4 classifications used (STAY / TOKEN-ONLY / MINOR UPDATE / MAJOR UPDATE / NEW VARIANT / NEW COMPONENT).
- **Route inventory (Agent 3):** 28 routes mapped to kit screens, tiered A/B/C/D.
- **Activity deep-dive (Agent 4):** 4 admin endpoints + 4 candidate endpoints + 4 new primitives, with API contracts and open product questions.
- **Constraints (Agent 5):** Hard rules, design non-negotiables, translation rules, light-mode lock, multi-tenancy, DoD, help requirements, ESLint forbidden imports, Phase 3 bounce conditions, prior decisions. All consolidated into the "Anti-pattern guards" section at the top of this plan.

---

## Open questions that must resolve before specific phases

1. **Phase 9:** Domain → display name mapping strategy. **RESOLVED 2026-05-13 (user decision):** option (a) — FE hardcoded map. Backend returns raw `domain` slugs from `question_packs.domain`. Frontend renders via a shared map (`apps/web/src/lib/domains.ts` or similar; both admin and candidate Activity pages consume it). No schema migration in v1.1; revisit if/when a tenant-admin "manage domain labels" feature is requested.
2. **Phase 10:** Candidate stat-card #2 replacement (vote: "Certificates earned"). Candidate leaderboard semantics (vote: own attempts by score).
3. **Phase 10:** DPDP review gate if any cross-user data surfaces.
4. **Phase 2:** Self-host fonts vs Google CDN — `docs/08-ui-system.md` flagged "Phase 1 perf budget" but no number set. Defer to Phase 14.
5. **Phase 14:** Visual regression tool choice (Percy / Chromatic / Playwright snapshot). Recommend Playwright snapshot for cost.

---

## Session-by-session ship cadence

| Session | Phase | Description | Est. duration |
|---|---|---|---|
| 1 | P1 | Token migration | 1–2h |
| 2 | P2 | Atom refresh | 3–4h |
| 3 | P3a | Easy primitives (Spinner, ProgressBar, Placeholder) | 2–3h |
| 4 | P3b | Activity primitives (Heatmap, StackedBars, Leaderboard) | 4–6h |
| 5 | P4 | Auth flows | 3–4h |
| 6 | P5 | Admin dashboard | 2–3h |
| 7 | P6a | Take flow lite | 2–3h |
| 8 | P6b | Attempt page | 4–6h |
| 9 | P7a | List template + Users + Attempts | 3–4h |
| 10 | P7b | Question bank + Assessments + Candidate Certs | 3–4h |
| 11 | P8a | Cohort + Attempt detail | 3–4h |
| 12 | P8b | Individual report + Reports landing | 3–4h |
| 13 | P9 | Admin Activity backend | 4–6h |
| 14 | P10 | Candidate Activity backend | 3–4h |
| 15 | P11 | Admin Activity page | 3–4h |
| 16 | P12 | Candidate Activity page | 2–3h |
| 17–18 | P13 | Settings + low-traffic (2 sessions) | 6–8h total |
| 19 | P14 | Cross-cut verify | 4–6h |

**Total estimate: 19 sessions, ~60–90 hours of focused work.**

Order can vary after Phase 3. Activity track (P9–P12) is parallelizable with page-refresh track (P5–P8) if two contributors work concurrently. Solo: prefer the order above (highest visible impact first).
