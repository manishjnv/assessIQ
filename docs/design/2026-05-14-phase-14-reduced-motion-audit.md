# Phase 14 — Reduced-motion audit (2026-05-14)

Scope: `modules/17-ui-system/src/components/` + `hooks/useCountUp.ts`.
Produced by: Phase 14 narrow-slice session.

## Reduced-motion component table

| Component | Animation present? | Mechanism | Reduced-motion honored before? | Fix landed in this commit? | Notes |
|---|---|---|---|---|---|
| **ScoreRing** | Yes — `stroke-dashoffset` CSS transition, 1600ms | Inline `style` prop on `<circle>` | Yes (partial) — global `@media` rule in `tokens.css` collapses `transition-duration: 0.01ms !important`, which overrides inline styles. JS count-up via `useCountUp` checks `matchMedia` directly. | No fix needed — both paths already correct | Confirmed by test: `useCountUp` returns target immediately under reduced motion; SVG fill uses `transition` not `animation`, so global rule reaches it |
| **Sparkline** | No | n/a — static SVG polyline rendered at final state on first paint | n/a | n/a | No JS animation, no CSS `animation` or `transition`. Comment in source correctly notes "no animation". |
| **ActivityHeatmap** | No | n/a — pure CSS grid, static background colors per cell | n/a | n/a | No transitions or animations anywhere in the component |
| **StackedBarChart** | No | n/a — bar heights are inline `style={{ height: "N%" }}`, set directly on first render | n/a | n/a | No transitions or keyframe animations. Static layout. |
| **LeaderboardList** | No | n/a — list rows rendered at final position on mount | n/a | n/a | No transitions. Delta arrows are text characters, not animated icons. |
| **Spinner** | Yes — `aiq-spin` CSS `@keyframes`, `0.75s linear infinite` | CSS class `.aiq-spinner` | **No** — old rule only slowed to 1.5s instead of stopping | **Yes** — `animation: none` now applied under reduced motion | Fix: `tokens.css` line 326-328. `animation: none` collapses to no rotation at all. `border-top-color` preserved so the static ring is still visually distinct. |
| **ProgressBar** | Yes — `transition: width 0.3s ease-out` on `.aiq-progress-bar-fill` | CSS class | Yes — explicit `@media (prefers-reduced-motion: reduce) { .aiq-progress-bar-fill { transition: none; } }` already in `tokens.css` | No fix needed | Rule correctly uses `transition: none` (instant), not a duration reduction |
| **Modal** | No | n/a — uses conditional render (`if (!open) return null`), no enter/exit transition | n/a | n/a | `backdropFilter: blur(2px)` on backdrop has no transition. Focus trap is behavior, not animation. |
| **Drawer** | No | n/a — same pattern as Modal: conditional render, no slide-in CSS transition | n/a | n/a | No `transform: translateX` transition present at all — the panel appears instantly on mount |
| **Tooltip** | Yes — `opacity` + `scale` CSS transition on popover `style` prop | Inline `style` prop | Yes — global `tokens.css` `@media` rule collapses all inline transitions to `0.01ms !important` | No fix needed | Comment in `Tooltip.tsx` (line 221) correctly documents this. Tooltip visibility is JS state (`visible` boolean), not CSS animation, so the collapse to near-instant is correct behavior |
| **useCountUp** | Yes — RAF-based numeric animation, 1400ms cubic-out | JavaScript (`requestAnimationFrame`) | Yes — reads `window.matchMedia("(prefers-reduced-motion: reduce)").matches` at call time and returns `target` immediately if true | No fix needed | JS path is the correct approach; CSS `@media` cannot affect RAF loops |
| **Card (hover)** | Yes — `transition: border-color 0.15s, box-shadow 0.15s` on `.aiq-card` | CSS class | Yes — global `@media` rule in `tokens.css` collapses all `transition-duration` to `0.01ms !important` | No fix needed | `.aiq-card[data-interactive="true"]:hover` only changes `border-color`; no `transform` or scale |
| **Button (hover)** | Yes — `transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease` on `.aiq-btn` | CSS class | Yes — global `@media` rule collapses all transitions | No fix needed | Hover states snap immediately under reduced motion; no `transform` involved |

### Summary of fixes in this commit

1. **Spinner (`tokens.css`):** Changed `animation-duration: 1.5s` → `animation: none`. The previous rule merely slowed the spin rather than stopping it, violating the guideline that animations "collapse to instant (no transition, immediate final state), not just slow down" (`UI_KIT_V1_1_PORT.md:214`).

2. **`useReducedMotion` hook created** (`modules/17-ui-system/src/hooks/useReducedMotion.ts`): Standard `matchMedia` listener pattern with live change subscription. Exported from `src/index.ts`. Components that drive JS animations should prefer this hook over ad-hoc `matchMedia` calls.

3. **8 new reduced-motion vitest test cases** (`src/__tests__/reduced-motion.test.tsx`): Covers `useReducedMotion` (2), `useCountUp` under reduced motion (2), Spinner CSS class assertion (1), ScoreRing transition mechanism + count-up snap (2), Tooltip trigger sanity (1).

---

## Phase 14 remaining work

Checklist of sub-items from `UI_KIT_V1_1_PORT.md:500-506` not completed in this session.

### Auth-seeded axe pass (admin/candidate routes behind a session)

**Status:** Not started. **Infrastructure missing:**
- `apps/web/e2e/a11y.spec.ts` covers only unauthenticated pages. Auth-seeded Playwright tests require a test-account seed (admin credentials + magic-link candidate) injected via Playwright's `storageState` or a custom login fixture.
- No `playwright/fixtures/adminSession.ts` or `candidateSession.ts` exists yet.
- The admin login flow requires TOTP MFA — needs a `totp` helper that derives codes from a test-account seed secret.
- Candidate magic-link login requires server cooperation (either a bypass for test mode or reading the link from server logs/DB in Playwright `beforeAll`).
- Likely 2–3 sessions of work: (1) auth fixture infrastructure, (2) admin route axe sweep, (3) candidate route axe sweep.

### Lighthouse CI ≥ 90 on 5 highest-traffic pages

**STATUS: SHIPPED** in commit `f34f9bd`.

**What landed:**
- `@lhci/cli@0.15.1` added to `apps/web/package.json` devDependencies.
- `apps/web/lighthouserc.json`: 5 unauthenticated routes, ≥ 0.90 threshold across performance / accessibility / best-practices / SEO, `numberOfRuns: 1`, `temporary-public-storage` upload. Config lives alongside `apps/web/package.json` so `lhci autorun` finds it when pnpm runs the script with `apps/web` as the working directory.
- `.github/workflows/lighthouse.yml`: PR trigger, advisory (not required status check), matches ci.yml style (Node 22, pnpm 9.15, same checkout/cache pattern).
- `lhci:run` script in `apps/web/package.json` for local runs.
- `docs/11-observability.md` § 31 added: full config notes, route rationale, how-to-run, threshold-update guidance, advisory→required promotion path.

**5 routes covered (all unauthenticated):**
1. `/admin/login` — `<AdminLogin>`
2. `/candidate/login` — `<CandidateLogin>`
3. `/take/expired` — `<Expired>`
4. `/take/error` — `<ErrorPage>`
5. `/this-is-not-a-page` — `<NotFound>` (404)

**Route selection notes:**
- `/` excluded: it's a `<Navigate replace />` to `/admin/login` — would duplicate that run.
- `/verify/:id` excluded: no `/verify/` route exists in the current SPA router (`App.tsx`).
- Auth-seeded coverage (admin/candidate dashboards, attempt pages) still deferred — needs Playwright session fixtures (see "Auth-seeded axe pass" section above).

**Baseline scores:** not yet confirmed — first CI run on a PR will establish the baseline. If any route scores below ≥ 90, that is tracked as follow-up work, not a blocker for the setup commit. Promote to required status check after the first green run (see `docs/11-observability.md` § 31.6).

### Visual regression baseline (Playwright snapshot)

**Status:** Not started. **Infrastructure missing:**
- No `playwright.config.ts` `expect.toHaveScreenshot()` baseline directory.
- No `apps/web/e2e/visual/` directory with snapshot tests.
- Playwright screenshot infrastructure depends on a consistent render environment (font loading, OS rendering differences between CI and local). Needs `--update-snapshots` run on a known-good commit to establish the baseline.
- CI must pin the same browser version (via Playwright install in workflow) and same viewport/DPR to avoid snapshot drift.
- Consider running visual tests in Docker to eliminate platform rendering differences.

### Help-content audit — `help_id` usage vs YAML entries

**Grep results (original baseline):** `data-help-id` / `helpId=` / `<HelpTip` usages found in production code:

| File | help_id used |
|---|---|
| `apps/web/src/pages/admin/login.tsx:83` | `admin.auth.login.tenant_slug` |
| `apps/web/src/pages/admin/mfa.tsx:343` | `admin.auth.mfa.enroll_vs_verify` |
| `modules/10-admin-dashboard/src/pages/users.tsx:182` | `admin.users.role` |

**`apps/web/src/pages/take/TakeRoot.tsx`** wraps candidate routes in `<HelpProvider>` but no `<HelpTip helpId="...">` usages appear in that subtree from the grep — candidate help tips are either not yet wired or use a different prop name.

**YAML entries in `modules/16-help-system/content/en/`:** 57 keys across `admin.yml` + `candidate.yml`.

**Orphan analysis (used in code but missing from YAML):** None — all 3 `data-help-id` values used in code exist in `admin.yml`.

**Missing entries (YAML has content but no `data-help-id` wiring in code):** 54 of 57 YAML keys had no `data-help-id` counterpart found in the original grep. This is expected for Phase 3 — the help system was populated ahead of UI wiring.

#### Wired in commit `6760a7c`

8 of 12 `admin.grading.*` keys wired. Updated count: **11 of 57** wired.

| Key | File | Element | Status |
|---|---|---|---|
| `admin.grading.proposal.anchors` | `modules/10-admin-dashboard/src/components/GradingProposalCard.tsx:89` | Anchors section wrapper `<div>` | wired |
| `admin.grading.proposal.band` | `modules/10-admin-dashboard/src/components/GradingProposalCard.tsx:67` | Band+score row inner `<div>` | wired |
| `admin.grading.proposal.justification` | `modules/10-admin-dashboard/src/components/GradingProposalCard.tsx:103` | Justification block `<div>` | wired |
| `admin.grading.proposal.error_class` | `modules/10-admin-dashboard/src/components/GradingProposalCard.tsx:115` | Error-class row `<div>` (conditional) | wired |
| `admin.grading.proposal.escalation` | `modules/10-admin-dashboard/src/components/GradingProposalCard.tsx:54` | Stage-3 badge `<span>` (conditional) | wired |
| `admin.grading.accept` | `modules/10-admin-dashboard/src/components/GradingProposalCard.tsx:129` | Accept `<button>` | wired |
| `admin.grading.override.reason` | `modules/10-admin-dashboard/src/pages/attempt-detail.tsx:357` | Override-reason `<label>` wrapper | wired |
| `admin.grading.rerun.opus` | `modules/10-admin-dashboard/src/components/GradingProposalCard.tsx:149` | Re-run `<button>` (posts `?escalate=opus`) | wired |
| `admin.grading.queue.row` | — | No live queue table today (`grading-jobs.tsx` is informational, Card 4 "Coming soon") | **skipped — no UI element** |
| `admin.grading.queue.empty` | — | No live queue empty-state today (same reason as above) | **skipped — no UI element** |
| `admin.grading.rerun` | — | No separate Sonnet-only Re-run button; the single Re-run button always calls `?escalate=opus`; wired as `rerun.opus` above | **skipped — no UI element** |
| `admin.grading.skill_drift` | — | No prompt-drift banner rendered in `GradingProposalCard.tsx` or `attempt-detail.tsx` today | **skipped — no UI element** |

#### Wired in commit `b777ba4` (admin.certificates.*)

4 of 4 `admin.certificates.*` keys wired (prior audit listed 5 — confirmed miscount; YAML has exactly 4 keys). Updated count: **15 of 57** wired.

| Key | File | Element | Status |
|---|---|---|---|
| `admin.certificates.list` | `modules/10-admin-dashboard/src/pages/certificates.tsx:374` | Page-header wrapper `<div>` (contains h1 + subtitle) | wired |
| `admin.certificates.revoke` | `modules/10-admin-dashboard/src/pages/certificates.tsx:644` | Inline table Revoke `<button>` | wired |
| `admin.certificates.reissue` | `modules/10-admin-dashboard/src/pages/certificates.tsx:667` | Inline table Reissue `<button>` | wired |
| `admin.certificates.revoke_reason` | `modules/10-admin-dashboard/src/pages/certificates.tsx:760` | Revoke-reason `<label>` in revoke modal | wired |

#### Wired in commit `ac0e4ec` (candidate.attempt.* + candidate.result.*)

6 of 8 `candidate.attempt.*` / `candidate.result.*` keys wired (2 skipped — no corresponding UI element renders today). Updated count: **23 of 57** wired.

| Key | File:line | Status |
|---|---|---|
| `candidate.attempt.timer` | `apps/web/src/pages/take/Attempt.tsx` — `<AttemptTimer data-help-id=...>` in top-bar `<header>` | wired |
| `candidate.attempt.flag` | `apps/web/src/pages/take/Attempt.tsx` — flag-toggle `<Button>` in bottom bar | wired |
| `candidate.attempt.kql.editor` | `apps/web/src/pages/take/Attempt.tsx` — `<textarea aria-label="KQL query">` in `KqlAnswerArea` | wired |
| `candidate.attempt.scenario.steps` | `apps/web/src/pages/take/Attempt.tsx` — outer `<div>` of `ScenarioAnswerArea` return | wired |
| `candidate.attempt.subjective.length` | `apps/web/src/pages/take/Attempt.tsx` — word-count `<div>` in `SubjectiveAnswerArea` | wired |
| `candidate.attempt.disconnect` | — | skipped — no `stale_connection` `IntegrityBanner` renders in the `ready` state of `Attempt.tsx`; the disconnect banner appears only in the `network_error` page branch (pre-attempt load failure). The `useIntegrityHooks` hook fires behavioral signals but has no visible DOM element to wire in the ready path. |
| `candidate.attempt.submit.confirm` | `apps/web/src/pages/take/Attempt.tsx` — Submit `<Button>` in bottom bar (triggers `window.confirm` guard) | wired |
| `candidate.result.bands` | — | skipped — `Submitted.tsx` explicitly prohibits "No Score / Band / Anchor display — Phase 1 has no grading" (file comment, line 23). No band labels or score elements render on the result page today; `candidate.result.bands` has no live DOM target. |

#### Wired in commit `61e97f2` (admin.reports.* + admin.analytics.*)

2 of 6 `admin.reports.*` / `admin.analytics.*` keys wired (4 skipped — no corresponding UI element renders today). Updated count: **17 of 57** wired.

| Key | File:line | Status |
|---|---|---|
| `admin.reports.cohort.distribution` | `modules/10-admin-dashboard/src/pages/cohort-report.tsx:120` | wired — archetype distribution card `<div>` |
| `admin.analytics.cohort-report` | `modules/10-admin-dashboard/src/pages/cohort-report.tsx:81` | wired — page `<h1>` heading |
| `admin.reports.heatmap.colors` | — | skipped — no topic heatmap renders in `cohort-report.tsx` today (heatmap is a Phase 3 feature not yet built) |
| `admin.reports.archetype.disclaimer` | — | skipped — `individual-report.tsx` renders no archetype disclaimer text block; only the radar chart and score history |
| `admin.reports.export.format` | — | skipped — `reports.tsx` has no export format selector; export panel not yet built |
| `admin.reports.cost.empty_in_claude_code_vps_mode` | — | skipped — `reports.tsx` has no cost/billing panel; cost breakdown UI not yet built |

#### Wired in commit `283e466` (admin.settings.*)

3 of 4 `admin.settings.*` keys wired (1 skipped — no live UI element). Updated count: **26 of 57** wired.

| Key | File:line | Status |
|---|---|---|
| `admin.settings.billing.budget` | `modules/10-admin-dashboard/src/pages/billing.tsx` — Card 2 inner `<div>` ("Your monthly grading limit") | wired |
| `admin.settings.billing.alert_threshold` | — | skipped — billing.tsx has no alert-threshold input or display; the page is read-only informational; threshold control noted as "Phase 3" in the technical-details section (billing.tsx:329) |
| `admin.settings.help_content.markdown` | `modules/10-admin-dashboard/src/pages/help-content.tsx` — `<label>` wrapping the Markdown body `<textarea>` in the edit modal | wired |
| `admin.settings.ai_generate_mode` | `modules/10-admin-dashboard/src/pages/billing.tsx` — `<label htmlFor="ai-generate-mode-select">` in super-admin AI Generation Mode card | wired |

#### Wired in commit `28c97be` (admin.activity/assessments/questions/packs.*)

11 of 20 keys wired (9 skipped — no UI element). Updated count: **37 of 57** wired.

| Namespace | Key | File:line | Status |
|---|---|---|---|
| activity | `streak.explanation` | `modules/10-admin-dashboard/src/pages/activity.tsx` — "Activity streak." `<h2>` in heatmap card | wired |
| activity | `heatmap.legend` | — | skipped — `ActivityHeatmap` is a black-box component; no legend wrapper div exists in `activity.tsx` itself |
| activity | `leaderboard.delta` | — | skipped — delta value rendered inside `LeaderboardList` component internals; no delta element exposed in `activity.tsx` |
| assessments | `publish` | `modules/10-admin-dashboard/src/pages/assessment-detail.tsx` — "Publish" `<button>` (draft-only, conditional) | wired |
| assessments | `invite.bulk` | `modules/10-admin-dashboard/src/pages/assessment-detail.tsx` — "Invitations." section `<h2>` | wired |
| assessments | `close.early` | — | skipped — no close-early button or control in `assessments.tsx` or `assessment-detail.tsx`; only a `closes_at` date field |
| assessments | `create.duration` | — | skipped — new-assessment form has no duration field; only `opens_at` / `closes_at` date inputs |
| assessments | `create.question_count` | — | skipped — no `question_count` field in new-assessment form |
| assessments | `create.randomize` | — | skipped — no randomize checkbox in new-assessment form |
| questions | `generate.draft` | `modules/10-admin-dashboard/src/pages/pack-detail.tsx` — "✦ Generate" `<button>` per level | wired |
| questions | `attempt-status` | `modules/10-admin-dashboard/src/pages/pack-detail.tsx` — `GenerationAttemptLine` wrapper `<div>` (conditional) | wired |
| questions | `bulk.approve` | `modules/10-admin-dashboard/src/pages/pack-detail.tsx` — bulk-confirm modal approve `<button>` (dynamic `data-help-id`) | wired |
| questions | `bulk.archive` | `modules/10-admin-dashboard/src/pages/pack-detail.tsx` — bulk-confirm modal archive `<button>` (dynamic `data-help-id`) | wired |
| questions | `generate.modal` | `modules/10-admin-dashboard/src/pages/pack-detail.tsx` — generate drawer `role="dialog"` `<div>` | wired |
| questions | `subjective` | `modules/10-admin-dashboard/src/pages/pack-detail.tsx` — subjective row `<div>` in per-type breakdown table | wired |
| questions | `type.subjective.rubric` | `modules/10-admin-dashboard/src/pages/question-editor.tsx` — "Rubric" `<h2>` (conditional `data-help-id` when `question.type === "subjective"`) | wired |
| questions | `import.format` | — | skipped — no file-import UI in `pack-detail.tsx` or `question-editor.tsx`; `CreateQuestionForm` has a JSON textarea but no import format explainer element |
| questions | `type.kql.expected_keywords` | — | skipped — `expected_keywords` only appears in `DEFAULT_CONTENT` template string; no dedicated DOM field renders for it in the editor or pack detail |
| questions | `type.scenario.step_dependency` | — | skipped — `step_dependency` only in `DEFAULT_CONTENT`; no dedicated DOM element for it in the editor or pack detail |
| packs | `create.domain` | `modules/10-admin-dashboard/src/pages/question-bank.tsx` — "Domain *" `<input>` in new-pack inline form | wired |

**Remaining unwired gap pages:**

- ~~All analytics/reports keys (`admin.reports.*`, `admin.analytics.*` — 6 entries)~~ (miscount in prior audit was 7; confirmed 6; 2 wired in commit above, 4 skipped — no UI element)
- ~~All certificate management keys (`admin.certificates.*` — 5 entries)~~ (miscount; was 4; now wired — see commit `b777ba4` below)
- ~~All candidate attempt keys (`candidate.attempt.*`, `candidate.result.*` — 8 entries in `apps/web/src/pages/take/`)~~ (6 wired, 2 skipped — no UI element; see commit above)
- ~~All settings keys (`admin.settings.*` — 4 entries)~~ (3 wired, 1 skipped — no UI element; see commit above)
- ~~Remaining admin keys (packs, questions, assessments, audit, scoring, rubric, notifications — ~22 entries)~~ (11 wired, 9 skipped — no UI element; see commit `28c97be` above)
- Remaining unwired admin keys: audit, scoring, rubric, notifications — ~20 entries (deferred per task scope)

**Action for next session:** Wire the next slice — remaining admin keys (audit, scoring, rubric, notifications — ~20 entries).

### Branding-guideline doc reconcile — token drift

**Status: RESOLVED in commit `2e1af79`** — all 8 stale hex values updated in `docs/10-branding-guideline.md` §§ 3.1 and 3.2 to match live v1.1 tokens.

Diff between live `modules/17-ui-system/src/styles/tokens.css` and values quoted in `docs/10-branding-guideline.md` § 3.1 (Light mode) and § 3.2 (Dark mode).

**Light mode drift (tokens.css ← live, guideline ← doc):**

| Token | tokens.css (live, v1.1) | branding-guideline.md (stale, v1.0) | Notes |
|---|---|---|---|
| `--aiq-color-bg-sunken` | `#f3f3f4` | `#f5f5f5` | v1.1 token migration |
| `--aiq-color-fg-primary` | `#0a0a0b` | `#1a1a1a` | v1.1 darkened text |
| `--aiq-color-fg-secondary` | `#3f3f46` | `#5f6368` | v1.1 token migration |
| `--aiq-color-fg-muted` | `#71717a` | `#9aa0a6` | v1.1 token migration |
| `--aiq-color-border` | `#e4e4e7` | `#e8e8e8` | v1.1 token migration |
| `--aiq-color-border-strong` | `#cdcdd1` | `#d4d4d4` | v1.1 token migration |

**Dark mode drift:**

| Token | tokens.css (live) | branding-guideline.md (stale) | Notes |
|---|---|---|---|
| `--aiq-color-fg-secondary` | `#8a8a94` | `#a0a0a8` | dark-mode token migration |
| `--aiq-color-fg-muted` | `#88889a` | `#6a6a72` | dark-mode token migration (direction reversed — live is lighter than doc) |

**Accent, success, warning, danger, shadow, radius, spacing:** No drift — these match exactly between tokens.css and the guideline.

**Action:** `docs/10-branding-guideline.md` §§ 3.1 and 3.2 should be updated to reflect the v1.1 token values. This is a doc-only change; no CSS changes needed. The guideline already states "v1.1 fully shipped" in § 0 but the color blocks still show v1.0 values.
