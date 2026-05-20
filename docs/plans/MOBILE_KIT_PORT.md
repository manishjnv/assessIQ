# Mobile Kit Port — Phased Implementation Plan

**Goal:** Apply the mobile UI kit shipped at `modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/` to the **routes and features that already exist** in the candidate-facing product. Make the app legible and usable on phones without changing any product flow, auth posture, or backend semantics.

**Authored:** 2026-05-20 from Phase 0 inspection of the mobile kit drop (folder appeared as an untracked add — see `git status`), the existing route inventory in [apps/web/src/App.tsx](../../apps/web/src/App.tsx), and project memory `feedback-functionality-drives-ui.md`.

**Audience:** Each phase is designed to be executed in its own session by an Opus orchestrator + Sonnet subagents per the project [CLAUDE.md](../../CLAUDE.md) orchestration playbook. Phases are sequenced but most are independent below the dependency line — do NOT batch multiple phases into one session.

**Phasing summary:** 7 phases, ~7–9 sessions of work. M0 (foundation) and M1 (login/magic-link mobile tune) deliver the biggest user-visible wins per byte. M2 (AttemptPage) is the highest-value mobile surface — likely 2 sessions because of per-question-type handling (KQL editor on mobile has real viewport constraints).

**Progress:** ☐ M0 (foundation) · ☐ M1 (login + magic-link landing) · ☐ M2 (AttemptPage) · ☐ M3 (Submitted) · ☐ M4 (Certificates + Activity) · ☐ M5 (admin graceful-degrade) · ☐ M6 (docs + handoff) — **0/7 complete**.

---

## North-star rule for this port

**Functionality drives UI; UI never drives functionality.** The mobile kit is a *palette of idioms* — tokens, atoms (TabBar, MobileHeader, IconBtn), padding/typography deltas, navigator-as-bottom-sheet pattern. It is **not a product spec**.

- The kit ships a "Today / Home" candidate landing screen and a candidate Library screen. **Neither exists in the product. They are NOT being added by this port.**
- The kit's `TabBar` has four items (Today / Library / Activity / Profile). Only two candidate portal routes exist (`/candidate/certificates`, `/candidate/activity`). Any mobile bottom-nav we ship is sized to existing routes, not to the kit's mock.
- Per [feedback-functionality-drives-ui.md](../../../C:/Users/manis/.claude/projects/e--code-AssessIQ/memory/feedback-functionality-drives-ui.md) in user memory.

If a future phase wants to add a route the kit hints at, that is a **separate product decision** outside this plan — propose it, get approval, then add it. Don't fold it into a mobile-port session.

---

## Anti-pattern guards (apply to EVERY phase)

These are bounce conditions for every diff. Cite the source when a Phase 3 critique flags one. The first six are mobile-specific; the rest are inherited from [UI_KIT_V1_1_PORT.md](./UI_KIT_V1_1_PORT.md).

1. **No new routes, pages, or flows.** This port applies kit visuals to **existing** routes only. Adding a "Today" page, a candidate library, or any other route that exists in the kit but not in the product is a bounce.
2. **Functionality unchanged.** No backend changes, no API changes, no auth-flow changes, no semantics changes. If a mobile tune requires a backend tweak, stop and surface it as a separate scope. The candidate magic-link posture in particular is locked (no passwords, no SSO additions).
3. **No imports from `modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/**`** in production code. Add to the existing ESLint `no-restricted-imports` block alongside the desktop-kit guard. Translate kit values into the `@assessiq/ui-system` package.
4. **Mobile-specific anchors:**
   - Breakpoint is `< 720px` OR `(pointer: coarse) and (max-width: 1024px)` — coarse pointer covers tablets in portrait that should still get mobile layout.
   - `data-viewport="mobile" | "desktop"` lives on `<html>`, not on individual surfaces.
   - Sticky bottom nav (if introduced) uses `position: fixed` with `padding-bottom: env(safe-area-inset-bottom)` — NOT the kit's `position: absolute` (kit positions inside an iPhone artboard).
   - Test in Gmail / Outlook / Apple Mail in-app webviews on M1 — that's where magic-link clicks actually land, not Safari/Chrome.
5. **No hidden behavior change behind viewport switch.** If `data-viewport="mobile"` renders a different component tree, both trees call the same backend with the same payloads and surface the same errors. Divergent behavior across viewports is a bounce.
6. **Document deliberate kit divergence in a page header comment** — `// Diverges from mobile-screens/<name>.jsx because: <reason>`. Follow the same convention as the v1.1 port. (`docs/10-branding-guideline.md:38`).

Inherited from the desktop v1.1 port (still apply):

7. **No token hardcoding.** No inline hex, `oklch()`, or px values if a `--aiq-*` token expresses the same thing. ([docs/10-branding-guideline.md:428](../10-branding-guideline.md#L428)).
8. **No `data-theme="dark"` rendering in production.** SPA mounts `<ThemeProvider theme="light">` ([docs/10-branding-guideline.md:48-56](../10-branding-guideline.md#L48-L56)).
9. **Every new UI element needs `help_id` + content entry in `modules/16-help-system` in the SAME PR.** ([PROJECT_BRAIN.md:104](../../PROJECT_BRAIN.md), [CLAUDE.md:74](../../CLAUDE.md)).
10. **No non-pill buttons.** Every button is `border-radius: 999px`.
11. **Serif for big numbers, sans for body, mono for IDs/timestamps.** Family swap is a bounce.
12. **Single accent (hue 258).** No new hues; status colors used sparingly.
13. **Borders, not shadows.** Cards at rest are border-only.
14. **Multi-tenant lock.** Existing — not changing here.
15. **No batching of phases.** Per [CLAUDE.md rule #9](../../CLAUDE.md): each session = own commit / deploy / document / handoff.
16. **Audit log every admin mutation.** Not relevant here (no backend changes), but listed for completeness.

---

## Dependency graph

```
M0 (foundation: viewport + tokens + ESLint guard)
 │
 ├──> M1 (candidate login + magic-link landing — 4 pages)
 │     │
 │     ├──> M2 (AttemptPage mobile take-flow — possibly 2 sessions)
 │     │     │
 │     │     └──> M3 (Submitted)
 │     │
 │     └──> M4 (Certificates + Activity mobile tunes)
 │
 ├──> M5 (admin graceful-degrade screen)    [independent of M1–M4]
 │
 └──> M6 (docs + handoff)                   [after all above]
```

M0 must land before everything. M1–M5 can be done in any order after M0, but M2 must land before M3 (Submitted is post-attempt; same component family). M4 has no hard deps but is lowest priority. M6 is last.

---

## Phase M0 — Foundation (1 session, load-bearing)

**Why first:** Every later phase needs viewport detection + the mobile token block + the ESLint guard. Until M0 lands, mobile tunes can't activate.

### What to implement

1. **Viewport hook + root attribute.** Add `modules/17-ui-system/src/hooks/useViewport.ts` (typed, SSR-safe with `matchMedia`):
   - `useViewport()` returns `'mobile' | 'desktop'`.
   - Mobile when `window.matchMedia('(max-width: 719px), ((pointer: coarse) and (max-width: 1024px))').matches`.
   - `ThemeProvider` (or a new lightweight `<ViewportProvider>` inside it) writes `data-viewport` on `<html>` and subscribes to `matchMedia` change events.
   - First-paint flicker: set `data-viewport` via a tiny inline `<script>` in [apps/web/index.html](../../apps/web/index.html) BEFORE the React bundle loads, identical pattern to how dark-mode-flash is normally solved. Without this, the page paints in desktop layout for a frame before re-flowing to mobile.

2. **Mobile token block in `tokens.css`.** Add a `[data-viewport="mobile"]` block to [modules/17-ui-system/src/styles/tokens.css](../../modules/17-ui-system/src/styles/tokens.css) overriding:

   | Token / class | Desktop | Mobile |
   | --- | --- | --- |
   | Page H1 (`.aiq-h1` if present, else direct selectors) | 36–52px | 28–34px |
   | `--aiq-page-padding` (new) | 32–48px | 20–24px |
   | `--aiq-card-padding` (new) | 22–28px | 16–20px |
   | `--aiq-space-page-x` (new) | 40px | 22px |

   Token names follow the existing `--aiq-*` namespace per [docs/10-branding-guideline.md § 0 step 4](../10-branding-guideline.md). New tokens are added (not renamed) so desktop callers are unaffected.

3. **ESLint guard.** Extend the existing `no-restricted-imports` block in `eslint.config.js` to also reject `**/AssessIQ-Mobile-Kit/**`. Same wording as the desktop-kit guard.

4. **`<ViewportLock>` wrapper for admin routes (foundation for M5).** Stub-only in M0 — a no-op component that M5 will fill in. Lives at `apps/web/src/lib/ViewportLock.tsx`. Wrap the existing `<Route path="/admin/*">` subtree's children in it so M5 just edits the component body, not the route table.

### Documentation references (read in this order)

1. Mobile kit philosophy: [AssessIQ-Mobile-Kit/README.md](../../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/README.md).
2. Mobile kit tokens: [AssessIQ-Mobile-Kit/design-system/tokens.md](../../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/design-system/tokens.md).
3. Production token file (target): [modules/17-ui-system/src/styles/tokens.css](../../modules/17-ui-system/src/styles/tokens.css).
4. Branding guideline § 0 translation pattern: [docs/10-branding-guideline.md:31-36](../10-branding-guideline.md#L31-L36).
5. Existing ESLint guard for the desktop kit (mirror it): `eslint.config.js:55-58`.

### Verification checklist

- `pnpm -C modules/17-ui-system typecheck` clean.
- `pnpm -C apps/web typecheck` clean.
- Browser smoke: `pnpm -C apps/web dev`, open `/admin/login` in desktop viewport (≥ 1024px) and Chrome DevTools mobile emulation (iPhone 14 Pro, Galaxy S20). Confirm `<html data-viewport>` attribute updates on viewport resize. Confirm no first-paint flicker between layouts.
- Lint smoke: add a temporary `import {} from '../../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/mobile-screens/login.jsx'` in any apps/web file → confirm ESLint flags it → remove.

### Anti-pattern guards (this phase)

- Don't port any mobile atoms into typed components yet (no `TabBar`, no `MobileHeader`). Wait for the first phase that actually needs them — that's M1.
- Don't change any existing component's behavior. M0 is additive only: a new hook, a new CSS block, a new ESLint entry, a new stub.
- Don't introduce a 3rd viewport mode ("tablet"). One breakpoint, two modes. The kit doesn't ship tablet screens and shipping a third mode triples the QA surface.

### Docs to update (same commit)

- [docs/10-branding-guideline.md](../10-branding-guideline.md) — add a top-level **§ 15. Mobile** section with viewport mechanism, token deltas table, and "kit is reference only — never adds functionality" rule. Cross-link to this plan.
- [docs/08-ui-system.md](../08-ui-system.md) — add a Mobile subsection covering `useViewport()` + the new tokens. Cross-link to the branding section.

### Estimated diff

- `tokens.css`: ~15 lines added (new block + new tokens).
- `useViewport.ts`: ~30 lines new.
- `ThemeProvider.tsx` (or `ViewportProvider.tsx`): ~20 lines added.
- `apps/web/index.html`: ~10-line inline script for first-paint hint.
- `ViewportLock.tsx`: ~10 lines stub.
- `eslint.config.js`: 1 line addition.
- 2 doc files: ~30 lines each.
- Total: ~150 lines.

---

## Phase M1 — Candidate login + magic-link landing (1 session)

**Why now:** This is the **most-clicked mobile entry path**: candidates receive an admin invite by email, tap the magic link from their phone's mail app, and land on `TokenLanding` (or `CandidateLogin` / `CandidateLoginVerify` for the portal). M1 makes those four pages readable on a phone.

### Pages touched (no behavior change to any)

- [apps/web/src/pages/candidate/CandidateLogin.tsx](../../apps/web/src/pages/candidate/CandidateLogin.tsx) — portal login (email → magic-link request).
- [apps/web/src/pages/candidate/CandidateLoginVerify.tsx](../../apps/web/src/pages/candidate/CandidateLoginVerify.tsx) — POST-verify SPA intermediary.
- [apps/web/src/pages/take/TokenLanding.tsx](../../apps/web/src/pages/take/TokenLanding.tsx) — assessment-invite magic-link landing.
- [apps/web/src/pages/take/Expired.tsx](../../apps/web/src/pages/take/Expired.tsx) and [apps/web/src/pages/take/ErrorPage.tsx](../../apps/web/src/pages/take/ErrorPage.tsx) — error states for the take-flow.

### What to implement

For each page:
- When `data-viewport="mobile"`, hide the right `<aside>` (TakeRightPane / login marketing aside) and let the left form column take the full width.
- Reduce h1 from 36–52px to 28–34px (use the new mobile token from M0 via CSS, not by hardcoding).
- Reduce horizontal padding from 48px to 22px.
- Stack the form vertically; primary button full-width.
- Keep all existing copy, all existing validation, all existing anti-enumeration delays, all existing rate-limit messages.

Kit reference: [AssessIQ-Mobile-Kit/mobile-screens/login.jsx](../../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/mobile-screens/login.jsx). **Note three intentional divergences already documented in [CandidateLogin.tsx:1-32](../../apps/web/src/pages/candidate/CandidateLogin.tsx) and preserve them:** no signin/signup toggle, no password field, no Google SSO button. Mobile tune does not re-introduce any of those.

### Documentation references

1. [AssessIQ-Mobile-Kit/mobile-screens/login.jsx](../../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/mobile-screens/login.jsx) — visual reference.
2. [AssessIQ-Mobile-Kit/design-system/patterns.md § Two-pane auth layout](../../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/design-system/patterns.md).
3. Existing divergence notes: [CandidateLogin.tsx:1-32](../../apps/web/src/pages/candidate/CandidateLogin.tsx#L1-L32).
4. Right-pane shared component: [apps/web/src/pages/take/TakeRightPane.tsx](../../apps/web/src/pages/take/TakeRightPane.tsx) — likely needs a `hideOnMobile?: boolean` prop OR a `display: none` CSS rule under `[data-viewport="mobile"]`.

### Verification checklist

- `pnpm -C apps/web typecheck` clean.
- Browser smoke: open all 4 pages in desktop view → unchanged. Switch to mobile emulation → form fills viewport, right pane hidden, h1 sized down.
- **Email-webview smoke (mandatory for M1):** deploy to staging, generate a real magic-link, tap it from Gmail iOS, Outlook iOS, Apple Mail. Confirm the page renders correctly in each (these in-app browsers have quirky CSS support — e.g. some lack `gap` polyfill, some force `font-size: 16px` minimum on inputs to prevent auto-zoom).
- Functional smoke: complete a magic-link request → receive email → tap link → land on verify → arrive at /candidate/certificates. Same flow on desktop and mobile.
- Anti-enumeration: same confirmation text shown for known and unknown emails. Same 200ms minimum delay.

### Anti-pattern guards (this phase)

- Don't introduce a hamburger menu on these pages — there's no navigation to show. The header is logo + page name.
- Don't change anti-enumeration behavior. Same screens, same copy, same timings.
- Don't move the rate-limit error from where it currently surfaces.
- Don't add a "save email for next time" affordance — Phase 1 candidate auth has no "remember me" and adding one is functionality, not UI.

### Docs to update

- [docs/04-auth-flows.md](../04-auth-flows.md) — small note under both candidate magic-link sections: "Mobile renders single-column; right aside hidden under `[data-viewport='mobile']`. No flow change."
- [docs/10-branding-guideline.md § Mobile](../10-branding-guideline.md) — add the "magic-link landing reflow" pattern.

### Estimated diff

- 5 page files: ~10–20 lines each for the mobile branch (mostly CSS overrides or a small conditional block).
- Possibly 1 new `TakeRightPane` prop OR a CSS rule in `tokens.css`.
- 2 doc files: ~10 lines each.
- Total: ~120 lines.

---

## Phase M2 — `AttemptPage` mobile take-flow ⭐ (likely 2 sessions: M2a + M2b)

**Why this is the highest-value mobile surface:** This is where candidates actually take the assessment. Many candidates are invited by email, click on a phone, and would happily complete a non-coding question set on the spot if the UI permitted. Today the desktop layout pinch-zooms into illegibility.

**Why possibly 2 sessions:** The page hosts five question-type renderers (MCQ, KQL editor, subjective long-form, log analysis, scenario). The page chrome (header, navigator, footer nav) is one concern; per-question-type mobile handling is another. Recommended split:

- **M2a — Page chrome.** Sticky timer/autosave header reflow, navigator-panel-as-bottom-sheet, footer nav stacked. MCQ renders correctly on mobile (it's the easiest type).
- **M2b — Per-question-type tuning.** KQL editor, subjective, log analysis, scenario. KQL specifically may need a "mobile not supported for this question type, please switch to desktop" interstitial — if the existing KQL editor uses Monaco or a similar IDE-class component, it's not viable in a 375px viewport. **That's a product decision, not a UI port decision — surface it before implementing.**

### Page touched

[apps/web/src/pages/take/AttemptPage.tsx](../../apps/web/src/pages/take/AttemptPage.tsx) (or whichever file in `modules/06-attempt-engine/` is the canonical home — verify in M2a).

### What to implement (M2a)

- Sticky header with timer + autosave indicator + flag-for-review + save-and-exit. Reduce padding; keep all behaviors (timer turning danger at < 5min, autosave debounce, integrity-hook beacon-on-blur, all unchanged).
- Navigator panel (currently a right-side aside) → bottom-sheet drawer toggled by a `<IconBtn icon="grid">` in the header. Same 8-col grid inside; same per-cell states (current / answered / flagged / unseen).
- Footer nav (Previous / Skip / Next) stacks on mobile: primary "Next" full-width at the bottom, "Previous" and "Skip" as ghost links above it.
- Question text reflows: serif h2 drops from 30px → 22–24px on mobile per the kit's `mobile-screens/assessment.jsx`.

### What to implement (M2b)

- MCQ options: stack vertically (already do), but reduce padding and confirm tap targets ≥ 44×44px (iOS HIG / WCAG 2.5.5).
- Subjective long-form: full-width `<textarea>` with proper inputmode; auto-grow if not already.
- Log analysis / scenario: similar — mostly text reflow.
- **KQL editor decision:** surface to user. Options:
  - (a) Render a read-only preview on mobile + a "this question requires a desktop browser to answer — please open the link on a laptop" notice.
  - (b) Render the full editor with mobile keyboard caveats.
  - (c) Skip mobile entirely for assessments containing KQL questions (admin sees a warning when assigning).
  - **Recommendation:** (a). Cleanest and respects functionality-drives-UI: the editor wasn't designed for mobile, so don't pretend.

### Documentation references

1. Mobile kit: [AssessIQ-Mobile-Kit/mobile-screens/assessment.jsx](../../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/mobile-screens/assessment.jsx).
2. Mobile kit patterns § Assessment-in-progress layout: [patterns.md](../../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/design-system/patterns.md).
3. Existing take-flow architecture: `modules/06-attempt-engine/SKILL.md`.
4. Integrity hooks (must not break under reflow): search `06-attempt-engine` for `integrity` / `beacon` / `visibilitychange`.
5. Help-IDs on the take-flow chrome: `modules/16-help-system` content registry.

### Verification checklist

- All existing E2E tests pass unchanged.
- Manual mobile smoke: complete a 5-question MCQ assessment end-to-end on Chrome iOS DevTools + a real device if available. Timer counts down, autosave fires, flag-for-review works, navigator drawer opens/closes, submit succeeds, lands on Submitted page.
- Integrity hooks fire under viewport switch (rotate device mid-attempt, swap from desktop to mobile by resizing). Beacon emits, attempt state survives.
- Performance: Lighthouse mobile score on the page does not regress > 5 points vs current baseline.
- No new help_ids — chrome is the same controls; existing help_ids remain wired.

### Anti-pattern guards (this phase)

- Do not change the integrity-hook surface (blur/visibility/beacon). Reflow does not equal behavior change.
- Do not change timer math, autosave debounce, or submit semantics.
- Do not introduce a "save and resume on desktop" affordance — that's product, not UI.
- Do not silently render KQL questions in a tiny viewport. Either ship the desktop-required interstitial or do not enter M2b until the decision is made.

### Docs to update

- [docs/10-branding-guideline.md § Mobile](../10-branding-guideline.md) — add the bottom-sheet navigator pattern.
- [modules/06-attempt-engine/SKILL.md](../../modules/06-attempt-engine/SKILL.md) — note that the navigator collapses to a bottom-sheet on mobile; behavior unchanged.
- [docs/RCA_LOG.md](../RCA_LOG.md) — only if a real bug is found during the port.

### Estimated diff

- M2a: ~200–250 lines across the take-flow chrome.
- M2b: depends on the KQL decision; ~80 lines for the interstitial route + ~150 lines for the per-type tunings = ~230 lines.
- Total: ~450 lines across 2 sessions.

---

## Phase M3 — `Submitted` page (1 session, lightweight)

### Page touched

[apps/web/src/pages/take/Submitted.tsx](../../apps/web/src/pages/take/Submitted.tsx)

### What to implement

- Same right-aside-hidden + single-column treatment from M1.
- Pending-grading state: existing Spinner stays; size correctly on mobile.
- Graded state: if scores/cert links are shown here, they reflow correctly (score-ring stacks above breakdown, not beside).

### Verification checklist

- Both pending and graded states render correctly on mobile and desktop.
- Lighthouse mobile score doesn't regress.
- If the page links to a certificate verify URL or a download, those links work in mobile webviews.

### Estimated diff

- 1 page file: ~30 lines.
- Total: ~30 lines.

---

## Phase M4 — `MyCertificates` + `CandidateActivity` mobile tunes (1 session)

**Why low priority:** Both pages get traffic only after a candidate has been graded at least once. The Phase 1 candidate flow doesn't loop people back through these regularly. Worth doing but not load-bearing.

### Pages touched

- `MyCertificates` (in [modules/11-candidate-ui/src/components/MyCertificates.tsx](../../modules/11-candidate-ui/src/components/MyCertificates.tsx), wrapped by `CandidateShell`).
- `CandidateActivity` (in [modules/11-candidate-ui/src/components/CandidateActivity.tsx](../../modules/11-candidate-ui/src/components/CandidateActivity.tsx), same shell).

### What to implement

- **`CandidateShell` mobile mode:** the existing shell likely renders a sidebar. On `data-viewport="mobile"`, either (a) replace the sidebar with a top-bar carrying just the logo + page title + overflow menu containing the 2 routes (Certificates, Activity), OR (b) render a 2-item `TabBar` at the bottom. **Recommendation: (a).** Two items is too thin for a bottom tab bar; an overflow menu in a top bar is cleaner. Revisit (b) only if/when a third route appears.
- **MyCertificates:** count Chip + h1 + lede already there from v1.1 Phase 7b. Just reduce typography and padding via M0 tokens, ensure cert list rows stack legibly (date / cert ID / share button).
- **CandidateActivity:** the heatmap (`ActivityHeatmap` component) needs to reflow — at < 375px wide, 52 weeks × 7 days is unreadable. Kit's `mobile-screens/activity.jsx` shows it scrolling horizontally inside a contained box. Apply that pattern; the underlying data wiring (from `modules/15-analytics`) is unchanged. `StackedBarChart` and `LeaderboardList` reflow to single column.

### Documentation references

1. Mobile kit: [AssessIQ-Mobile-Kit/mobile-screens/activity.jsx](../../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Mobile-Kit/mobile-screens/activity.jsx).
2. Existing `ActivityHeatmap` API: confirm horizontal-scroll mode is opt-in via a prop or a container CSS rule.
3. CandidateShell file (inspect first to confirm sidebar shape).

### Verification checklist

- Both pages render correctly on mobile + desktop.
- Existing data fetches and analytics endpoints unchanged.
- Heatmap is scrollable on mobile without breaking the page's vertical scroll.

### Anti-pattern guards (this phase)

- Don't add a 3rd or 4th candidate route to the TabBar / overflow menu. There are 2 routes today; that's the size of the nav.
- Don't change which time window the heatmap shows on mobile vs desktop. Same data, different layout.

### Docs to update

- [docs/10-branding-guideline.md § Mobile](../10-branding-guideline.md) — add the "shell becomes top-bar + overflow menu" pattern.
- [modules/11-candidate-ui/SKILL.md](../../modules/11-candidate-ui/SKILL.md) — note `CandidateShell` mobile behavior.

### Estimated diff

- `CandidateShell.tsx`: ~80 lines for mobile branch.
- `MyCertificates.tsx`: ~30 lines for reflow.
- `CandidateActivity.tsx`: ~50 lines for reflow.
- 2 doc files: ~10 lines each.
- Total: ~180 lines.

---

## Phase M5 — Admin graceful-degrade (1 session, no port)

**Why this exists:** Admins genuinely should not use the platform on a phone. Workflows are table-heavy, multi-column, and benefit from a real keyboard. But admins do occasionally tap an admin link from a notification email on their phone — we should not silently render a broken pinch-zoom.

### What to implement

In `apps/web/src/lib/ViewportLock.tsx` (stubbed in M0), implement:

- If `data-viewport="mobile"` AND the route matches `/admin/*` (excluding `/admin/login`, `/admin/login/email`, `/admin/select-identity`, `/admin/mfa`, which mobile admins legitimately use to complete an MFA prompt on the go), render a friendly interstitial:
  - h1: `Admin tools work best on desktop.`
  - p: copy explaining this and that the candidate experience is mobile-friendly.
  - Primary action: a `<Button>` linking to `/candidate/login` (in case it's a candidate who hit `/admin/*` by mistake) OR `mailto:` to forward the link to themselves.
  - Override link (tiny, ghost): `Continue anyway →` — sets a session-only `localStorage.aiq_admin_mobile_override = '1'` and reloads. Per-session only, not persistent.
- Login + MFA routes still render normally on mobile (this is critical — admins resolving an MFA challenge on the go must not be blocked).

### Verification checklist

- `/admin/login`, `/admin/login/email`, `/admin/select-identity`, `/admin/mfa` render normally on mobile.
- `/admin`, `/admin/users`, `/admin/attempts/*`, `/admin/reports/*` all render the interstitial on mobile.
- Override link sets storage and reveals the page; clearing storage restores the interstitial.
- Desktop view is completely unaffected.

### Anti-pattern guards (this phase)

- Don't store the override server-side. It's a per-session client convenience, not a setting.
- Don't suppress security warnings (rate-limit errors, locked-account messages) when the override is on. The page renders as if on desktop.
- Don't render the interstitial in an iframe / embed (`?embed=true`) — embed mode is its own viewport contract.

### Docs to update

- [docs/08-ui-system.md](../08-ui-system.md) — add a Mobile subsection capturing the "admin is desktop-only" stance and the override mechanism.

### Estimated diff

- `ViewportLock.tsx`: ~80 lines.
- 1 doc file: ~20 lines.
- Total: ~100 lines.

---

## Phase M6 — Documentation + handoff (1 session)

**Why last:** consolidates the per-phase docs into a coherent mobile chapter, and updates the index.

### What to implement (docs only)

1. [docs/10-branding-guideline.md § 15. Mobile](../10-branding-guideline.md) — final, consolidated section:
   - Viewport mechanism + breakpoint
   - Mobile token deltas (final values, not interim from M0)
   - Per-pattern reflow rules: two-pane → single column; sidebar → top-bar + overflow; right-aside → hidden; navigator panel → bottom sheet.
   - The "functionality drives UI" rule, restated in production-doc form (not just user memory).
   - Email-webview testing requirement (Gmail / Outlook / Apple Mail).
2. [docs/08-ui-system.md § Mobile](../08-ui-system.md) — finalize: hook API, token namespace, `<ViewportLock>` shape, where the mobile-mode components live.
3. [PROJECT_BRAIN.md](../../PROJECT_BRAIN.md) decision log — one row: `2026-MM-DD | Mobile kit port shipped (M0–M5) | Visual-only port; no flow/auth/backend changes; admin remains desktop-only with graceful-degrade interstitial. | docs/plans/MOBILE_KIT_PORT.md`.
4. [docs/RCA_LOG.md](../RCA_LOG.md) — only entries for bugs actually surfaced during the port (typically: integrity-hook regressions, viewport-flicker, email-webview surprises). Empty if clean.
5. Mark this plan doc's "Progress" line all ✅ and add a "**Status: SHIPPED** (M0–M6 complete, YYYY-MM-DD)" header.

### Anti-pattern guards (this phase)

- No code changes. Docs only.
- Don't backdate decision-log entries; use the actual session date.

### Estimated diff

- 4 doc files: 30–100 lines each.
- Total: ~250 lines.

---

## Open decisions to surface before M0 starts

These are not pre-decided here — they need a user call.

1. **Breakpoint policy** — `< 720px` width OR `(pointer: coarse) and (max-width: 1024px)`? The combined predicate covers small phones AND iPads in portrait. Picking just `< 720px` is cleaner but iPads in portrait then render the desktop layout (which they handle OK, so this may be fine).

2. **M2 KQL editor decision** — option (a) "desktop-required interstitial", (b) "render with caveats", or (c) "skip mobile entirely for assessments containing KQL questions". **Default recommendation: (a)**. Block M2b until decided.

3. **M4 CandidateShell mobile shape** — (a) top-bar + overflow menu, or (b) 2-item bottom TabBar. **Default recommendation: (a)** because 2 items is thin for a tab bar.

4. **M5 override mechanism** — per-session `localStorage`, or no override at all (admin is hard-blocked from `/admin/*` on mobile)? **Default recommendation: keep the override.** A trapped admin who legitimately needs to action something on their phone gets a path; the friction is enough to push them to desktop in the normal case.

5. **Mobile help_ids** — the M0–M5 plan does not add new UI elements that need new help_ids; existing chrome retains its existing help_ids. If we end up adding a new control (e.g., the bottom-sheet navigator toggle in M2a is a new control), it needs a help_id. **Confirm this is OK** rather than letting it surprise us mid-M2a.

---

## Out of scope (explicitly)

The following are NOT part of this port. If they become wanted later they are separate scopes:

- Adding a candidate "Today / Home" landing page.
- Adding a candidate "Library" route.
- Adding a 4-item bottom TabBar.
- Native mobile app (iOS / Android).
- PWA install prompt or service-worker offline mode.
- Mobile-specific accent or branding overrides.
- Tablet-specific layouts (third viewport mode).
- Per-question-type mobile-native editors (beyond the M2b decision on KQL).
- Admin mobile UI port (M5 ships the graceful-degrade only).
- Dark mode for any of the above.
- Any new auth flow (passwords for candidates, SSO for candidates, etc.).
