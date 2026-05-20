# Admin Mobile Port — design spec

> **Status header (updated per phase):**
>
> | Phase | Status |
> | --- | --- |
> | A0 — Foundation tokens | SHIPPED 2026-05-21 |
> | A1 — AdminShell drawer + reflow | SHIPPED 2026-05-21 |
> | A2 — List / table pages | SHIPPED 2026-05-21 |
> | A3 — Detail / report pages | SHIPPED 2026-05-21 |
> | A4 — Settings / help pages | NOT YET STARTED |
> | A5 — Editor pages | NOT YET STARTED |
> | A6 — ViewportLock removal + docs | NOT YET STARTED |

Sibling to [docs/plans/MOBILE_KIT_PORT.md](./MOBILE_KIT_PORT.md), which shipped the candidate-facing mobile port (M0–M6) on 2026-05-20. This plan extends the same playbook to the admin surface and ultimately removes the M5 graceful-degrade interstitial.

This is the **spec**. The phase-by-phase implementation plan is generated next via the superpowers writing-plans skill.

---

## 1. Scope & non-goals

### In scope

Make every authenticated admin surface render correctly on a mobile viewport (`data-viewport="mobile"` — phones up to 719px CSS width, or coarse-pointer ≤ 1024px), using the kit's design philosophy (single accent, two type families, pill buttons, hairline borders, generous whitespace) rather than a kit-shipped admin mockup. **The mobile UI kit ships no admin idioms; admin reflows are derived from the kit's *philosophy*, not from per-page mockups** — per the working agreement clarified during brainstorming (2026-05-21).

Page roster (everything currently behind `ViewportLock`):

| Class | Pages | Phase |
| --- | --- | --- |
| Shell | AdminShell + Sidebar primitive | A1 |
| Home / landing | Dashboard | A2 |
| List / table | Attempts, Users, Grading (queue), Activity, Assessments, Question Bank, Generation history, Certificates, Super-admin Users | A2 |
| Detail / report | Attempt Detail, Cohort Report, Individual Report, Pack Detail, Assessment Detail, Help Content | A3 |
| Settings / forms | Billing (settings), Help guide, Admin guide, Platform | A4 |
| Editors | Question Editor, Rubric Editor (embedded), Generate Wizard | A5 |
| Removal | `ViewportLock.tsx` + override sessionStorage key + `App.tsx` wrapper | A6 |

### Out of scope

Per the candidate Mobile Kit Port's north-star rule (*functionality drives UI; UI never drives functionality*):

- No new routes, no new flows, no new pages.
- No backend / API changes.
- No data-model changes.
- No auth-semantics changes.
- No swapping React components per viewport — CSS-only deltas + lazy-mounted overlays.
- The four auth/MFA routes (`/admin/login`, `/admin/login/email`, `/admin/select-identity`, `/admin/mfa`) already work on mobile and are not touched.
- The candidate-side mobile port (M1–M5) is shipped and not re-touched.
- The `ai_generate_mode` toggle, `super_admin` UI gating, `tenant_id` RLS, and other domain invariants are unchanged.
- No new help-system audience tier (admin/candidate split is unchanged).
- No visual-regression baselines required (Phase 15 Playwright deferred).
- No authenticated a11y axe gate added (Phase 15 dependency).

---

## 2. Architecture mechanism

Reuse the M0 infrastructure proven on the candidate side. No new mechanism invented; the admin port is a *consumer* of the existing viewport pipeline.

### 2.1 Viewport detection (unchanged from M0)

`data-viewport="mobile" | "desktop"` is published on `<html>` by an inline script in [apps/web/index.html](../../apps/web/index.html) before the React bundle hydrates (no first-paint flicker). `useViewportSync()` keeps it in sync via `window.matchMedia('(max-width: 719px), ((pointer: coarse) and (max-width: 1024px))')`. Admin components reach the value via `useViewport()` from `@assessiq/ui-system` when they genuinely need a JS branch.

### 2.2 Token surface (extend, don't fork)

[modules/17-ui-system/src/styles/tokens.css](../../modules/17-ui-system/src/styles/tokens.css) already overrides four tokens under `[data-viewport="mobile"]`: `--aiq-page-padding-x` (40→22), `--aiq-page-padding-y` (32→20), `--aiq-card-padding` (24→18), `--aiq-h1-size` (36→30). These automatically apply to any admin page that uses them.

A0 adds three more for the admin shell:

| New token | Desktop | Mobile | Purpose |
| --- | --- | --- | --- |
| `--aiq-admin-shell-topbar-padding-x` | `var(--aiq-space-xl)` (24px) | `var(--aiq-space-md)` (12px) | AdminShell top bar |
| `--aiq-admin-shell-topbar-h` | `52px` | `48px` | AdminShell top bar height |
| `--aiq-admin-drawer-width` | n/a | `min(280px, 85vw)` | A1 drawer off-canvas width |

Everything else is plain CSS rules under `[data-viewport="mobile"]` selectors on existing className anchors.

### 2.3 AdminShell — three changes (A1)

1. **Sidebar → drawer on mobile.** The existing [Sidebar primitive](../../modules/17-ui-system/src/components/Sidebar.tsx) is a 240px / 56px fixed-width `<aside>`. A1 keeps the same `<Sidebar>` API but wraps it: on mobile, the sidebar renders inside a CSS `position: fixed; transform: translateX(-100%)` panel that slides in when an `open` prop is true. A 32px hamburger pill button is added to the AdminShell top-bar left (only `display: inline-flex` on mobile). Backdrop click + Escape + route change close it; outside-click semantics mirror M4's CandidateShell overflow menu.
   - **Same DOM both viewports.** The sidebar always renders; only the visual presentation differs. No lazy mount, no conditional component swap. Body scroll lock applied while drawer is open (mobile only).
   - **Sidebar primitive unchanged.** A1 wraps it from outside in AdminShell; candidate side does not use the primitive so it is unaffected.
2. **Top bar tightens.** Padding via the new token. The tenant slug hides on mobile to make room for the hamburger. The user email truncates with `text-overflow: ellipsis` and `max-width: 40vw`. The "Sign out" button stays visible (44px tap target).
3. **Breadcrumbs + MFA nudge banner reflow.** Breadcrumbs gain `flex-wrap: wrap`. MFA nudge banner stacks copy + dismiss vertically on mobile with the "Set up authenticator →" action taking full width below the message.

### 2.4 ViewportLock removal (A6)

- Delete [apps/web/src/lib/ViewportLock.tsx](../../apps/web/src/lib/ViewportLock.tsx) entirely.
- Remove the `<ViewportLock>` wrapper from `apps/web/src/App.tsx` (grep for `<ViewportLock>` — line numbers drift).
- Remove the `aiq_admin_mobile_override` sessionStorage key — nothing to migrate; it is per-tab and self-clears.
- Remove the `admin.shell.mobile_continue_anyway` help_id and its admin.yml entry.
- Update [docs/10-branding-guideline.md § 15.3 "Admin graceful-degrade interstitial (M5 — 2026-05-20)"](../10-branding-guideline.md) — rewrite as historical: "M5 was superseded by the Admin Mobile Port (`<A6 ship date>`). Admin pages are now responsive; the interstitial and override are removed." (A6 implementer fills the actual ship date when this edit lands.)

### 2.5 Module boundaries

- `modules/17-ui-system` — adds the three new tokens. Sidebar primitive unchanged.
- `modules/10-admin-dashboard` — every admin page gets CSS class hooks (e.g. `.aiq-admin-filter-strip`, `.aiq-admin-table-scroll`) so token scoping reaches them. JS branches minimized; per-viewport `<Drawer>` is the only JS-aware pattern.
- `modules/16-help-system` — one new help_id (`admin.shell.nav.mobile_menu`).
- All other modules untouched.

---

## 3. Phase contracts (A0–A6)

Each phase is a separate session with: same-PR doc update, RCA-log append if a bug is fixed, SESSION_STATE handoff with the 5-line agent-utilization footer.

### A0 — Foundation tokens (small, mandatory)

**Ships:** three new tokens in `tokens.css` (`--aiq-admin-shell-topbar-padding-x`, `--aiq-admin-shell-topbar-h`, `--aiq-admin-drawer-width`) with their `[data-viewport="mobile"]` overrides. A one-screen smoke check that the existing M0 tokens already cascade into admin pages on mobile.

**Exit criteria:**

- Tokens land in `tokens.css`.
- No admin page visually changes yet — overrides only activate when consumers reference them (A1+).
- `docs/10-branding-guideline.md § 15.2` token table updated.

**Risk:** trivial; pure additive token work.

### A1 — AdminShell (load-bearing)

**Ships:** hamburger button + off-canvas drawer wrapping the existing Sidebar; top-bar reflow; breadcrumb wrap; MFA nudge stack; body-scroll-lock on drawer-open. New help_id `admin.shell.nav.mobile_menu` with admin.yml entry.

**Exit criteria:**

- Sidebar opens / closes via hamburger, backdrop, Escape. Open state cleared on route change.
- Same DOM both viewports (verified by reading the rendered tree in both modes).
- Top bar functional on a 360×640 viewport without horizontal scroll.
- Existing AdminShell unit + integration tests pass unchanged.
- One new test in `modules/10-admin-dashboard/src/__tests__/admin-shell-mobile.test.tsx` asserting drawer mounts on `data-viewport="mobile"` and not on desktop.

**Risk:** medium. AdminShell is touched by every admin page; a regression breaks the whole admin surface.

### A2 — Lists & home (parallel-Sonnet-friendly)

**Pages:** Dashboard, Attempts, Users, Grading (queue), Activity, Assessments, Question Bank, Generation history, Certificates, Super-admin Users.

**Ships per page:** filter row → R1 horizontally-scrollable strip; status tabs → R1 pill row; tables → either R2 (`overflow-x: auto` wrapper) for dense triage tables (Attempts, Grading, Users, Super-admin Users, Generation history) or R3 (card-row reflow) for browsable catalogs (Assessments, Question Bank, Certificates). Dashboard mixes both (R1 status filters + R2 queue table). Activity reuses the candidate Activity reflow patterns (heatmap horizontal scroll, leaderboard `columns={1}`).

**Exit criteria per page:**

- Chrome (count chip + serif h1 + lede) renders cleanly on mobile.
- Filter tabs scroll horizontally without wrapping.
- Table or card list reads without horizontal scroll on the page itself (intentional scroll inside the table wrapper is OK).
- Tap targets ≥ 44px.

**Risk:** medium. Touch fan-out (10 pages) but mechanical; ideal for parallel Sonnet (≤ 6 concurrent per the orchestration playbook). Split into two waves of 5.

### A3 — Detail / report pages

**Pages:** Attempt Detail, Cohort Report, Individual Report, Pack Detail, Assessment Detail (read variant), Help Content.

**Ships per page:** two-column layouts → R4 single-column stack; side-by-side panels (GradingProposalCard, EscalationDiff, ScoreDetail, BandPicker) stack vertically with question/answer first, grading panel below; long justification blocks get vertical padding tuning via existing card token; charts/radars (ArchetypeRadar) wrapped in `overflow-x: auto` if they have a min-width; tables inside follow R2/R3.

**Exit criteria per page:**

- Entire page consumable on 360×640 with no horizontal scroll outside intentional wrappers.
- Long detail forms (override reason, justification) have 16px+ input font.
- Sticky action bars (Accept / Override / Release) reflow into a stacked footer area or float at bottom.

**Risk:** higher. Attempt Detail is the highest-value admin surface. **Phase 3 critique mandatory.** Adversarial review per memory `feedback-adversarial-reviewer-routing.md` — `modules/07-ai-grading` adjacency triggers Sonnet+GLM-5.1 chain pass; `codex:rescue` if either reviewer flags anything.

### A4 — Settings / help

**Pages:** Billing (Settings), Help guide, Admin guide, Platform, Help Content.

**Ships per page:** card stacks get smaller padding via existing `--aiq-card-padding` mobile token; multi-column billing/usage stat blocks → single column; tab strips → R1 horizontally-scrollable; form inputs hit 16px+; super-admin AI mode toggle gets touch-friendly tap area.

**Exit criteria per page:**

- All interactive controls reachable on mobile.
- Usage/quota chart legends readable.
- Form labels visible above inputs (no placeholder-only labels).

**Risk:** low–medium. Mostly card-stacked already; reflow is incremental.

### A5 — Editors (highest-risk)

**Pages:** Question Editor (+ RubricEditor component), Generate Wizard, the create-form variants of Assessment Detail / Pack Detail.

**Ships per page:**

- **Question Editor:** form fields full-width with 16px+ inputs; question-type selector → vertically-stacked radio cards (not horizontal segmented); content editor (`QuestionContentView`) wraps with `overflow-x: auto` for code-like fields (KQL question / expected_keywords, log_analysis log_excerpt); RubricEditor (anchors + bands) gets R6 accordion (anchors collapsed by default, bands collapsed); "Save rubric" + "Regenerate via AI" buttons sit in a sticky bottom action bar on mobile only.
- **Generate Wizard:** multi-step horizontal indicator → R5 vertical stack; per-step forms stack; "Next" / "Back" → sticky-bottom-bar full-width.
- **Assessment Detail / Pack Detail create:** invitation picker + cycle settings stack; date inputs use native mobile inputs (`<input type="date">`).

**Exit criteria:**

- An admin can complete an authoring task end-to-end on a phone: create a question with rubric, kick off AI generation, save. No control unreachable.

**Risk:** high. Editors have the most complex DOM and the biggest opportunity for "this stays desktop-best" admission. Phase 3 critique non-negotiable. Adversarial review per `07-ai-grading` adjacency rules.

### A6 — Removal + close-out

**Ships:**

- Delete `apps/web/src/lib/ViewportLock.tsx`.
- Remove `<ViewportLock>` wrapper in `App.tsx`.
- Strip the `aiq_admin_mobile_override` sessionStorage references (audit via Grep).
- Branding guideline § 15.3 M5 entry rewritten as superseded; new § 15.3 "Admin pattern reflows" subsection cataloging R1–R6.
- Final smoke pass on a real phone hitting every admin sidebar route.
- RCA log append only if a bug fix landed.

**Exit criteria:**

- No admin route shows an interstitial.
- Every sidebar page renders correctly on 360×640.
- `grep` for `ViewportLock`, `aiq_admin_mobile_override`, `mobile_continue_anyway` returns no production-code matches.

**Risk:** low.

### Phase dependency graph

```text
A0 ──> A1 ──┬──> A2 ──> A6
            ├──> A3 ──> A6
            ├──> A4 ──> A6
            └──> A5 ──> A6
```

A2 / A3 / A4 / A5 are independent once A1 ships and may run in parallel sessions. A6 fires only after all four merge.

---

## 4. Per-pattern reflow recipes

Six canonical recipes. Every admin page maps to one or more. Phase 3 critique enforces the mapping — a Sonnet diff that invents a new pattern is bounced unless it explains why none of these six fit.

### R1 — Filter / tab strip → horizontally-scrollable pill row

Anchor class `.aiq-admin-filter-strip`. **Desktop default preserves `flex-wrap: wrap`** so chip rows that exceed the page width fall to row 2 — this matches today's behavior on Attempts, Grading, Generation history, etc. Mobile flips it to `nowrap` + horizontal scroll. Both rules are explicit; no relying on browser defaults.

```css
/* Desktop default — explicit wrap, mirrors today's behavior. */
.aiq-admin-filter-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--aiq-space-xs);
}

/* Mobile — nowrap + horizontal scroll with snap. */
[data-viewport="mobile"] .aiq-admin-filter-strip {
  flex-wrap: nowrap;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
  margin-inline: calc(-1 * var(--aiq-page-padding-x));
  padding-inline: var(--aiq-page-padding-x);
  scrollbar-width: none;
}
[data-viewport="mobile"] .aiq-admin-filter-strip::-webkit-scrollbar { display: none; }
[data-viewport="mobile"] .aiq-admin-filter-strip > * {
  scroll-snap-align: start;
  flex-shrink: 0;
}
```

Used by: Attempts tabs, Grading filters, Activity date-range, Generation history filters. Negative-margin bleeds the strip edge-to-edge so the rightmost chip teases that more is available. **Implementers must not drop existing inline `flexWrap: "wrap"` styles on filter rows** — leave them OR move them into the anchor class above; either way, desktop wrap is preserved.

### R2 — Dense table → horizontal-scroll wrapper with sticky first column

Anchor class `.aiq-admin-table-scroll`. The `<Table>` primitive keeps its desktop column set; mobile wraps it.

```css
[data-viewport="mobile"] .aiq-admin-table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  margin-inline: calc(-1 * var(--aiq-page-padding-x));
  padding-inline: var(--aiq-page-padding-x);
}
[data-viewport="mobile"] .aiq-admin-table-scroll table { min-width: 640px; }
[data-viewport="mobile"] .aiq-admin-table-scroll th:first-child,
[data-viewport="mobile"] .aiq-admin-table-scroll td:first-child {
  position: sticky;
  left: 0;
  background: var(--aiq-color-bg-base);
  box-shadow: 1px 0 0 var(--aiq-color-border);
}
```

Used by: Attempts (5-column), Users (6-column), Grading queue (5-column), Super-admin Users, Generation history. Identity column (candidate email / name) stays visible while scrolling right.

### R3 — Sparse list → card-row reflow

Anchor class `.aiq-admin-table-cards`. Used when a list has ≤ 4 columns and one row should fit in a glance. The table's `<tr>` rows become full-width cards on mobile.

```css
[data-viewport="mobile"] .aiq-admin-table-cards thead { display: none; }
[data-viewport="mobile"] .aiq-admin-table-cards tr {
  display: block;
  padding: var(--aiq-card-padding);
  border: 1px solid var(--aiq-color-border);
  border-radius: var(--aiq-radius-lg);
  margin-bottom: var(--aiq-space-md);
}
[data-viewport="mobile"] .aiq-admin-table-cards td {
  display: block;
  padding: 0;
  border: 0;
}
[data-viewport="mobile"] .aiq-admin-table-cards td::before {
  content: attr(data-label);
  display: block;
  font-family: var(--aiq-font-mono);
  font-size: 11px;  /* branding § 8.2: chip/microcopy is 11px mono-uppercase */
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--aiq-color-fg-muted);
  margin-bottom: 2px;
}
```

Each `<td>` carries `data-label` via the existing `ColumnDef.label` field. Used by: Assessments list, Question Bank packs list, Certificates list, Pack Detail's question sublist.

**R2 vs R3 choice:** tables admins genuinely scan in dense form (queue triage, audit) use R2; browsable catalogs use R3. Mapping pinned in § 4.7.

### R4 — Two-column detail → single-column stack

Anchor class `.aiq-admin-detail-two-col`. Used by Attempt Detail, Individual Report, Cohort Report.

```css
.aiq-admin-detail-two-col {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: var(--aiq-space-xl);
}
[data-viewport="mobile"] .aiq-admin-detail-two-col {
  grid-template-columns: 1fr;
  gap: var(--aiq-space-lg);
}
```

Mobile order: question/answer content first, grading panel second. CSS preserves source order — no DOM reorder.

**Sticky action bar — scroll-container contract.** Detail-page action bars (Accept / Override / Release on Attempt Detail; Share / Download / Print on reports) use `.aiq-admin-action-bar` with `position: sticky; bottom: 0` on mobile. `position: sticky` only stick within its *nearest scrolling ancestor* — so the action bar MUST be a direct child of `<main>` (AdminShell's scroll container at [AdminShell.tsx:471-477](../../modules/10-admin-dashboard/src/components/AdminShell.tsx#L471-L477)), NOT nested inside any wrapper that introduces `overflow: auto` / `overflow: hidden` / `overflow: scroll`. The A3 implementation must:

1. Grep each detail page for any `overflow:` declaration on ancestors of the action bar.
2. If any ancestor introduces a scroll context, either lift the action bar up to a sibling of that ancestor OR change the ancestor's `overflow` to `visible` (only if doing so doesn't break a separate scroll requirement).
3. The grading-panel column on Attempt Detail in particular — its `<Card>` wrapper must NOT have its own scroll; the panel content scrolls with the page.

If a detail page genuinely needs a nested scrolling region (e.g., a long anchor list that should scroll independently of the candidate's answer), the action bar moves OUT of that region and stays at page-level.

**Long-form text inputs.** Override-reason and justification `<textarea>` elements on detail pages must declare `min-height: 120px` on mobile so a 200-word response is composable with the on-screen keyboard open. Class hook: `.aiq-admin-longform-textarea`.

```css
[data-viewport="mobile"] .aiq-admin-longform-textarea {
  min-height: 120px;
  font-size: max(16px, var(--aiq-input-size-base, 14px));  /* iOS zoom defense */
}
```

### R5 — Multi-column wizard → vertical-step stack with sticky-bottom nav

Anchor class `.aiq-admin-wizard`. Used by Generate Wizard and multi-step create variants.

```css
[data-viewport="mobile"] .aiq-admin-wizard-steps {
  flex-direction: column;
  align-items: stretch;
}
[data-viewport="mobile"] .aiq-admin-wizard-nav {
  position: sticky;
  bottom: 0;
  background: var(--aiq-color-bg-base);
  padding: var(--aiq-space-md) 0;
  border-top: 1px solid var(--aiq-color-border);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--aiq-space-sm);
}
[data-viewport="mobile"] .aiq-admin-wizard-nav button { width: 100%; }
```

### R6 — Editor / rubric accordion

Anchor class `.aiq-admin-editor-section`. Used by RubricEditor sections (Anchors, Bands), Question Editor multi-part content (scenario steps), Help Content authoring.

```html
<details
  class="aiq-admin-editor-section"
  open={!isMobile || isFirstSection}
>
  <summary>
    <span class="aiq-serif">Anchors</span>
    <span class="aiq-chip">3 items</span>
    <span class="chevron" aria-hidden="true">↓</span>
  </summary>
  <div class="aiq-admin-editor-section-body"> ... </div>
</details>
```

`open` defaulted to `useViewport() === 'desktop'` so desktop is unchanged; mobile opens the first section so the user has something to start with.

### Cross-cutting input rule

Every `<input type="text">`, `<input type="email">`, `<input type="number">`, `<textarea>`, `<select>` inside admin pages must compute `font-size: ≥ 16px` on mobile to defeat iOS Safari's auto-zoom.

```css
[data-viewport="mobile"] .aiq-admin-input,
[data-viewport="mobile"] textarea,
[data-viewport="mobile"] input:not([type="checkbox"]):not([type="radio"]) {
  font-size: max(16px, var(--aiq-input-size-base, 14px));
}
```

Applied at the page-level wrapper, not per-input.

### Per-page recipe map

| Page | Primary recipe(s) |
| --- | --- |
| Dashboard | R1 (status filters) + R2 (queue table) |
| Attempts | R1 + R2 |
| Users | R1 + R2 |
| Grading | R1 + R2 |
| Activity | R1 + existing M4 candidate-Activity patterns |
| Assessments | R1 + R3 |
| Question Bank | R1 + R3 |
| Generation history | R1 + R2 |
| Certificates | R3 |
| Super-admin Users | R1 + R2 |
| Attempt Detail | R4 (+ R6 for grading panel sub-sections if needed) |
| Cohort Report | R4 |
| Individual Report | R4 |
| Pack Detail | R4 + R3 (question sublist) |
| Assessment Detail (read) | R4 |
| Help Content | R6 |
| Billing (Settings) | token reflow only (vertical card stack already) |
| Help guide | token reflow only (long-form doc) |
| Admin guide | token reflow only |
| Platform | R3 (tenants list) |
| Question Editor | R6 + cross-cutting input rule |
| Generate Wizard | R5 |
| Assessment Detail (create) | R5 |
| Pack Detail (create) | R5 |

---

## 5. Anti-pattern guards (Phase 3 bounce conditions)

Adapted from the candidate Mobile Kit Port's M1–M5 guards. Phase 3 review bounces a diff that violates any of these:

1. **No DOM divergence by component swap.** Mobile must not render a *different* React tree than desktop — no swapping which component renders per viewport. CSS-only deltas are the default. **Mobile-additive overlays are allowed** (e.g., a sticky bottom action bar that only exists on mobile, like A5's "Save rubric" + "Regenerate" wizard nav) — these are conditionally *rendered*, not swapped. `useViewport()` is allowed for *prop hints* (`columns={1}`), lazy-mount additive overlays, and `<details open={...}>` defaults — never for "render `<FooDesktop>` here and `<FooMobile>` over there."
2. **No new routes, no new flows.** This is a visual port. Adding `/admin/mobile/foo` or a new wizard is a bounce.
3. **No backend / API changes.** Same payloads, same error surfaces, same rate-limits, same auth-semantics on both viewports.
4. **No security-gate relaxation.** Rate-limit messages, locked-account states, MFA prompts, fresh-MFA requirements render the same on mobile.
5. **No skipped help_id entries.** New `data-help-id` requires same-PR entry in the relevant audience YAML (`admin.yml`). Catch-up-commit via `0011_seed_help_content.sql` drift gate if needed.
6. **No load-bearing path edits without Opus diff review.** AdminShell (A1) touches every admin route; A3's Attempt Detail and A5's Question Editor are `07-ai-grading`-adjacent (memory `feedback-adversarial-reviewer-routing.md` → Sonnet+GLM-5.1 adversarial pass). Audit-log writes are not touched by this port; if a phase accidentally edits `auditInTx`, hard bounce.
7. **No multi-tenant guard regression.** No `if (tenant === ...)` introduced. No `tenant_id` column removed from a list query during reflow. RLS-relevant code paths read-only during this port.
8. **No `display: none` on essential content.** Cosmetic hides (tenant slug) OK; columns hidden inside R2 wrapper (still scrollable) OK; hiding action buttons is a bounce — admins must be able to complete every workflow on mobile after A5 ships.
9. **iOS auto-zoom must be defeated.** Any new `<input>` / `<textarea>` / `<select>` with computed font-size < 16px on mobile is a bounce. Cross-cutting input rule (§ 4) must apply.
10. **Tap targets ≥ 44px.** Every interactive control on mobile needs a minimum 44×44 px hit area. `aiq-btn-sm` (32px) gets a `min-height: 44px` mobile override via the global CSS rule shipped in A1 (not a per-page CSS edit). The AdminShell top-bar "Sign out" button is the highest-frequency offender and must be covered by that rule.
11. **Modal overlays trap focus.** The A1 drawer carries `role="dialog"` + `aria-modal="true"`; it MUST also (a) capture the focused element at open, (b) move focus into the drawer's first focusable child, (c) trap Tab/Shift-Tab inside the drawer until close, and (d) restore focus to the original element on close. Branding § 10.1–10.2 already mandates focus rings on all buttons and screen-reader-text for icon-only buttons; a half-baked modal-without-trap fails axe modal-dialog checks and breaks keyboard navigation. The same rule applies to any future overlay (drawer, modal dialog) added in later phases.
12. **Focus rings on every new interactive element.** Branding § 8.1: "Always include focus ring — 2px solid `--aiq-color-accent` outline at 2px offset, never `outline: none`." A `<button>` added in this port without an explicit `:focus-visible` rule is a bounce. Covers the A1 hamburger, A3 sticky-bar buttons, A5 wizard nav, and the R6 `<summary>` chevron.

---

## 6. Testing strategy

### Per-phase smoke testing

- **A0:** unit test asserts the three new tokens resolve to the right values on `data-viewport="mobile"` vs desktop. Existing token-cascade tests pass unchanged.
- **A1:** new `admin-shell-mobile.test.tsx` — drawer mounts on mobile, opens on hamburger click, closes on backdrop / Escape / route change. Same DOM verified by reading children with both viewports. Existing AdminShell tests pass unchanged.
- **A2–A5:** per-page Vitest renders the page at `<html data-viewport="mobile">` and asserts the anchor classes (`.aiq-admin-filter-strip`, `.aiq-admin-table-scroll`, `.aiq-admin-table-cards`, `.aiq-admin-detail-two-col`, `.aiq-admin-wizard`, `.aiq-admin-editor-section`) are present where the recipe map promises. No visual-regression baselines required.
- **A6:** grep assertions — `ViewportLock`, `aiq_admin_mobile_override`, `mobile_continue_anyway` return zero hits outside doc/RCA history.

### Live-prod verification (each phase)

- Deploy via `ssh assessiq-vps 'cd /srv/assessiq && git pull && docker compose -f infra/docker-compose.yml build assessiq-frontend && docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-frontend'` (per `docs/06-deployment.md`).
- Open <https://assessiq.automateedge.cloud/admin> in Chrome DevTools mobile emulation (iPhone 14 Pro · 393×852 + Pixel 7 · 412×915) and the actual mobile device.
- Per-page checklist:
  1. Renders without horizontal page scroll.
  2. Every sidebar item reachable via hamburger drawer.
  3. Every primary action button is tap-reachable.
  4. Form inputs do not auto-zoom on focus (iOS-only check).
  5. Modal overlays do not escape the viewport.
- Bulk multi-page smoke pass delegated to a Haiku subagent (checkmark-table return).

### Accessibility delta

- Existing `@axe-core/playwright` a11y gate covers unauthenticated routes only (Phase 14). Authenticated mobile a11y deferred (Phase 15).
- Per-phase manual check: keyboard-tab through every new interactive control (drawer, accordion `<details>`, sticky wizard nav); aria-labels on all new icon-only buttons.

### Routing telemetry (per orchestration playbook)

Per delegation, log a line in the Phase 6 handoff:

```text
A2-attempts · Sonnet · table-scroll wrapper + filter strip · reworked: N
A3-attempt-detail · Sonnet+GLM-5.1 adversarial · single-col reflow · reworked: Y (override sticky bar regression)
A5-question-editor · Sonnet · rubric accordion + sticky save · reworked: N
```

Mined across 7 sessions to retune the routing matrix.

---

## 7. Docs to update (per-phase, same-PR rule)

- **`docs/10-branding-guideline.md § 15.3`** — append "Admin pattern reflows" subsection cataloging R1–R6. M5 entry rewritten as superseded in A6.
- **`docs/plans/ADMIN_MOBILE_PORT.md`** — the status header at the top of this doc is updated each phase (NOT YET STARTED → IN PROGRESS → SHIPPED).
- **`docs/08-ui-system.md § Mobile`** — extend with the new admin tokens and the drawer-wrap pattern.
- **`docs/SESSION_STATE.md`** — replaced each session per the global Phase 6 rule.
- **`docs/RCA_LOG.md`** — append only if a bug fix landed during the port.
- **`modules/16-help-system/content/en/admin.yml`** — append `admin.shell.nav.mobile_menu` in A1.

---

## 8. Open questions (resolve before A1)

None at spec time. If a question surfaces during a phase, log it in `docs/SESSION_STATE.md` "Open questions" and resolve before that phase ships.

---

## Spec history

- 2026-05-21 — initial draft (brainstorming session: scope clarified to "complete site mobile-responsive following kit design philosophy"; `ViewportLock` removal scoped into A6).
