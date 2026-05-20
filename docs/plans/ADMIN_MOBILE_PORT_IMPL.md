# Admin Mobile Port — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every authenticated admin surface mobile-responsive and remove the `ViewportLock` desktop-only interstitial.

**Architecture:** Reuse the M0 viewport pipeline (`<html data-viewport="mobile">` + token overrides). Add three admin-shell tokens, wrap the existing Sidebar primitive in an off-canvas drawer on mobile, apply six canonical reflow recipes (R1–R6) to admin pages, then delete `ViewportLock.tsx`. CSS-only deltas where possible; lazy-mount the drawer only.

**Tech Stack:** React 18 + Vite + TypeScript, `@assessiq/ui-system` (Sidebar, NavItem, Drawer, useViewport), `@assessiq/help-system`, Vitest, Playwright (a11y only, deferred to Phase 15).

**Spec:** [docs/plans/ADMIN_MOBILE_PORT.md](./ADMIN_MOBILE_PORT.md)

---

## File structure

### Files created

- `modules/10-admin-dashboard/src/__tests__/admin-shell-mobile.test.tsx` (A1)
- `modules/10-admin-dashboard/src/__tests__/admin-pages-mobile-recipes.test.tsx` (A2)

### Files modified

| Phase | Path | Change |
| --- | --- | --- |
| A0 | `modules/17-ui-system/src/styles/tokens.css` | Add 3 admin-shell tokens + mobile overrides |
| A0 | `docs/10-branding-guideline.md` | Append § 15.2 token rows |
| A1 | `modules/10-admin-dashboard/src/components/AdminShell.tsx` | Wrap Sidebar in off-canvas drawer, add hamburger, reflow top-bar, breadcrumb wrap, MFA nudge stack |
| A1 | `modules/17-ui-system/src/styles/tokens.css` | Add `.aiq-admin-shell-*` CSS rules |
| A1 | `modules/16-help-system/content/en/admin.yml` | Add `admin.shell.nav.mobile_menu` entry |
| A1 | `modules/16-help-system/db/migrations/0011_seed_help_content.sql` | Catch-up seed (if drift gate flags it) |
| A2 | `modules/10-admin-dashboard/src/pages/{dashboard,attempts,users,grading-jobs,activity,assessments,question-bank,generation-attempts,certificates,super-admin-users}.tsx` | Apply R1/R2/R3 anchor classes + recipe rules |
| A2 | `modules/17-ui-system/src/styles/tokens.css` | Add R1/R2/R3 CSS recipe blocks |
| A3 | `modules/10-admin-dashboard/src/pages/{attempt-detail,cohort-report,individual-report,pack-detail,assessment-detail,help-content}.tsx` | Apply R4 anchor class + recipe rules |
| A3 | `modules/17-ui-system/src/styles/tokens.css` | Add R4 + sticky-action-bar CSS |
| A4 | `modules/10-admin-dashboard/src/pages/{billing,admin-guide,platform}.tsx` | Token-only reflow + R1 tab strip + 16px+ input rule |
| A4 | `modules/17-ui-system/src/styles/tokens.css` | Add cross-cutting input font-size rule |
| A5 | `modules/10-admin-dashboard/src/pages/{question-editor,generate-wizard,assessment-detail,pack-detail}.tsx` | R5 wizard + R6 accordion + sticky save bar |
| A5 | `modules/10-admin-dashboard/src/components/RubricEditor.tsx` | Wrap anchor/band sections in `<details>` |
| A5 | `modules/17-ui-system/src/styles/tokens.css` | Add R5 + R6 CSS recipe blocks |
| A6 | `apps/web/src/lib/ViewportLock.tsx` | **DELETE** |
| A6 | `apps/web/src/App.tsx` | Remove `<ViewportLock>` wrapper import + usage |
| A6 | `modules/16-help-system/content/en/admin.yml` | Remove `admin.shell.mobile_continue_anyway` |
| A6 | `docs/10-branding-guideline.md` | Rewrite § 15.3 M5 entry as superseded; add "Admin pattern reflows" subsection |

### Module boundaries

- **`modules/17-ui-system`** — tokens.css only; Sidebar primitive untouched (wrapped from outside).
- **`modules/10-admin-dashboard`** — page reflows + AdminShell drawer wrap.
- **`modules/16-help-system`** — one new help_id (A1), one removed (A6).
- **`apps/web`** — ViewportLock deletion in A6.

---

## A0 — Foundation tokens

**Risk:** trivial. Pure additive token work; no admin page visually changes.

### Task A0.1: Add three admin-shell tokens

**Files:**

- Modify: `modules/17-ui-system/src/styles/tokens.css`
- Modify: `docs/10-branding-guideline.md` § 15.2 token table

- [ ] **Step 1: Open `tokens.css` and locate the `:root` layout block (around line 72–78).** Confirm the four existing layout tokens (`--aiq-page-padding-x/y`, `--aiq-card-padding`, `--aiq-h1-size`) are present and the `[data-viewport="mobile"]` override block (around line 131) is intact.

- [ ] **Step 2: Add desktop defaults inside `:root`.**

   ```css
   /* --- Admin shell layout tokens (A0 — Admin Mobile Port).
    * Desktop defaults; mobile overrides in the [data-viewport="mobile"] block.
    * drawer-width is mobile-only — desktop renders the Sidebar in-flow so
    * the value is left unset (computed CSS resolves to `auto`/`initial`). */
   --aiq-admin-shell-topbar-padding-x: var(--aiq-space-xl);
   --aiq-admin-shell-topbar-h: 52px;
   ```

   Insert immediately after `--aiq-h1-size:        var(--aiq-text-3xl);` line.

- [ ] **Step 3: Add mobile overrides inside `[data-viewport="mobile"]` block.**

   ```css
   --aiq-admin-shell-topbar-padding-x: var(--aiq-space-md);
   --aiq-admin-shell-topbar-h: 48px;
   --aiq-admin-drawer-width: min(280px, 85vw);
   ```

   Insert as the last three lines of the existing `[data-viewport="mobile"]` block, right before the closing `}`.

- [ ] **Step 4: Run existing token tests.**

   ```bash
   pnpm --filter @assessiq/ui-system test
   ```

   Expected: PASS (no test changes; new tokens are additive).

- [ ] **Step 5: Append to `docs/10-branding-guideline.md` § 15.2 token table.**

   Three new rows, immediately below the existing `--aiq-h1-size` row:

   ```markdown
   | `--aiq-admin-shell-topbar-padding-x` | `var(--aiq-space-xl)` (24px) | `var(--aiq-space-md)` (12px) | AdminShell top bar (A0) |
   | `--aiq-admin-shell-topbar-h` | `52px` | `48px` | AdminShell top bar height (A0) |
   | `--aiq-admin-drawer-width` | unset | `min(280px, 85vw)` | A1 drawer off-canvas width |
   ```

- [ ] **Step 6: Commit.**

   ```bash
   git add modules/17-ui-system/src/styles/tokens.css docs/10-branding-guideline.md
   GIT_COMMITTER_EMAIL="257227540+manishjnv@users.noreply.github.com" \
   GIT_COMMITTER_NAME="Manish Kumar" \
     git commit -m "$(cat <<'EOF'
   feat(admin-mobile): A0 — foundation tokens

   Adds three admin-shell tokens (topbar padding-x, topbar height,
   drawer width) with [data-viewport="mobile"] overrides. No admin
   page visually changes yet — overrides activate when A1 consumers
   reference them.

   Spec: docs/plans/ADMIN_MOBILE_PORT.md § 2.2
   EOF
   )" \
     --author="Manish Kumar <257227540+manishjnv@users.noreply.github.com>"
   ```

- [ ] **Step 7: Deploy A0 to VPS.**

   ```bash
   git push
   ssh assessiq-vps 'cd /srv/assessiq && git pull && docker compose -f infra/docker-compose.yml build assessiq-frontend && docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-frontend'
   ```

   Smoke check: open the admin in Chrome mobile emulation (Pixel 7), confirm no visual change vs desktop (correct — A0 ships tokens only, no consumers wired yet).

- [ ] **Step 8: Update spec status header.** In `docs/plans/ADMIN_MOBILE_PORT.md`, change `A0 — Foundation tokens | NOT YET STARTED` to `A0 — Foundation tokens | SHIPPED <YYYY-MM-DD>`. Commit alongside the next phase.

---

## A1 — AdminShell mobile reflow (load-bearing)

**Risk:** medium. AdminShell wraps every admin route; a regression breaks the entire admin surface.

**Adversarial gate:** Phase 3 Opus diff review mandatory before push. A1 is NOT `07-ai-grading`-adjacent so `codex:rescue` is not auto-fired, but Sonnet+GLM-5.1 adversarial pass is required per memory `feedback-adversarial-reviewer-routing.md` because AdminShell is load-bearing.

### Task A1.1: Write failing test for mobile drawer

**Files:**

- Create: `modules/10-admin-dashboard/src/__tests__/admin-shell-mobile.test.tsx`

- [ ] **Step 1: Create the test file.**

   ```tsx
   // modules/10-admin-dashboard/src/__tests__/admin-shell-mobile.test.tsx
   //
   // A1 — AdminShell mobile reflow.
   // Asserts the off-canvas drawer mounts on data-viewport="mobile" only,
   // opens via hamburger, closes via Escape / backdrop / route change.

   import { describe, it, expect, beforeEach, afterEach } from 'vitest';
   import { render, screen, fireEvent, cleanup } from '@testing-library/react';
   import { MemoryRouter } from 'react-router-dom';
   import { ThemeProvider } from '@assessiq/ui-system';
   import { AdminShell } from '../components/AdminShell.js';

   function setViewport(v: 'mobile' | 'desktop') {
     document.documentElement.dataset.viewport = v;
   }

   function renderShell() {
     return render(
       <MemoryRouter>
         <ThemeProvider theme="light" density="cozy">
           <AdminShell breadcrumbs={['Dashboard']}>
             <p>page content</p>
           </AdminShell>
         </ThemeProvider>
       </MemoryRouter>,
     );
   }

   afterEach(() => {
     cleanup();
     delete document.documentElement.dataset.viewport;
   });

   describe('AdminShell mobile reflow (A1)', () => {
     it('renders hamburger button on mobile only', () => {
       setViewport('mobile');
       renderShell();
       expect(screen.getByLabelText(/open navigation/i)).toBeInTheDocument();
     });

     it('does not render hamburger on desktop', () => {
       setViewport('desktop');
       renderShell();
       expect(screen.queryByLabelText(/open navigation/i)).not.toBeInTheDocument();
     });

     it('opens drawer when hamburger is clicked', () => {
       setViewport('mobile');
       renderShell();
       const hamburger = screen.getByLabelText(/open navigation/i);
       fireEvent.click(hamburger);
       expect(screen.getByRole('dialog', { name: /navigation/i })).toBeInTheDocument();
     });

     it('closes drawer when Escape is pressed', () => {
       setViewport('mobile');
       renderShell();
       fireEvent.click(screen.getByLabelText(/open navigation/i));
       fireEvent.keyDown(document, { key: 'Escape' });
       expect(screen.queryByRole('dialog', { name: /navigation/i })).not.toBeInTheDocument();
     });

     it('closes drawer when backdrop is clicked', () => {
       setViewport('mobile');
       renderShell();
       fireEvent.click(screen.getByLabelText(/open navigation/i));
       fireEvent.click(screen.getByTestId('admin-drawer-backdrop'));
       expect(screen.queryByRole('dialog', { name: /navigation/i })).not.toBeInTheDocument();
     });
   });
   ```

- [ ] **Step 2: Run test — expect FAIL.**

   ```bash
   pnpm --filter @assessiq/admin-dashboard test src/__tests__/admin-shell-mobile.test.tsx -- --run
   ```

   Expected: all five tests FAIL with "unable to find element with label `Open navigation`" because no hamburger button exists yet.

### Task A1.2: Add hamburger + drawer state to AdminShell

**Files:**

- Modify: `modules/10-admin-dashboard/src/components/AdminShell.tsx`

- [ ] **Step 1: Import drawer-state needs.** At the top of `AdminShell.tsx`, add `useEffect` and `useRef` to the React import and import `Icon` from `@assessiq/ui-system`:

   ```tsx
   import React, { Fragment, useEffect, useRef, useState } from "react";
   ```

   Add `Icon` to the existing `@assessiq/ui-system` import:

   ```tsx
   import { Icon, Sidebar, NavItem, SidebarSection } from "@assessiq/ui-system";
   ```

- [ ] **Step 2: Add drawer state + focus-trap refs inside `AdminShell`** (after the existing `nudgeDismissed` state, before `dismissNudge`). The focus-trap implementation is non-negotiable per spec § 5 anti-pattern guard #11:

   ```tsx
   const [drawerOpen, setDrawerOpen] = useState(false);
   const drawerRef = useRef<HTMLDivElement | null>(null);
   const lastFocusedRef = useRef<HTMLElement | null>(null);

   // Close drawer on route change
   useEffect(() => {
     setDrawerOpen(false);
   }, [location.pathname]);

   // Drawer lifecycle: Escape, body scroll lock, focus capture+trap+restore.
   // Spec § 5 #11 — modal overlays must trap focus.
   useEffect(() => {
     if (!drawerOpen) return;

     // (a) Capture currently-focused element so we can restore it on close.
     lastFocusedRef.current = document.activeElement as HTMLElement | null;

     // (b) Move focus into the drawer's first focusable child.
     // requestAnimationFrame ensures the drawer node is mounted + visible.
     const focusFirst = () => {
       const drawer = drawerRef.current;
       if (!drawer) return;
       const focusable = drawer.querySelector<HTMLElement>(
         'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
       );
       focusable?.focus();
     };
     const raf = requestAnimationFrame(focusFirst);

     // (c) Trap Tab/Shift-Tab inside the drawer.
     const onKey = (e: KeyboardEvent) => {
       if (e.key === "Escape") {
         setDrawerOpen(false);
         return;
       }
       if (e.key !== "Tab") return;
       const drawer = drawerRef.current;
       if (!drawer) return;
       const focusables = Array.from(
         drawer.querySelectorAll<HTMLElement>(
           'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
         ),
       ).filter((el) => !el.hasAttribute("disabled"));
       if (focusables.length === 0) return;
       const first = focusables[0];
       const last = focusables[focusables.length - 1];
       if (e.shiftKey && document.activeElement === first) {
         last.focus();
         e.preventDefault();
       } else if (!e.shiftKey && document.activeElement === last) {
         first.focus();
         e.preventDefault();
       }
     };

     const prevOverflow = document.body.style.overflow;
     document.body.style.overflow = "hidden";
     document.addEventListener("keydown", onKey);

     return () => {
       cancelAnimationFrame(raf);
       document.body.style.overflow = prevOverflow;
       document.removeEventListener("keydown", onKey);
       // (d) Restore focus to the element that opened the drawer.
       lastFocusedRef.current?.focus?.();
     };
   }, [drawerOpen]);
   ```

- [ ] **Step 3: Replace the outer `aiq-screen` wrapper.** The existing wrapper at the top of `content` becomes (note `ref={drawerRef}` on the sidebar wrapper — needed by the focus-trap effect):

   ```tsx
   const content = (
     <div
       className="aiq-screen aiq-admin-shell"
       data-drawer-open={drawerOpen ? "true" : "false"}
       style={{
         display: "flex",
         height: "100vh",
         overflow: "hidden",
         background: "var(--aiq-color-bg-base)",
       }}
     >
       {/* Drawer backdrop — mobile only, only when open. Click closes. */}
       {drawerOpen && (
         <div
           data-test-id="admin-drawer-backdrop"
           onClick={() => setDrawerOpen(false)}
           className="aiq-admin-drawer-backdrop"
           aria-hidden="true"
         />
       )}

       {/* Sidebar — wrapped in aiq-admin-sidebar-wrap so mobile CSS can
           position it off-canvas without the primitive knowing.
           drawerRef is consumed by the focus-trap effect when drawerOpen. */}
       <div
         ref={drawerRef}
         className="aiq-admin-sidebar-wrap"
         role={drawerOpen ? "dialog" : undefined}
         aria-label={drawerOpen ? "Navigation" : undefined}
         aria-modal={drawerOpen ? "true" : undefined}
       >
         <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} footer={sidebarFooter}>
           {/* existing nav-section children unchanged */}
         </Sidebar>
       </div>
   ```

   Move the existing `<Sidebar>` JSX (children intact) inside the new wrapper. Keep all `renderSection` / `workspaceEntries` / etc. exactly as-is — only the wrapper changes.

- [ ] **Step 4: Add hamburger button to the top-bar left.** Inside the existing top-bar `<div>` (around line 336 currently), prepend the hamburger before the "AssessIQ" button:

   ```tsx
   <button
     type="button"
     className="aiq-admin-hamburger"
     onClick={() => setDrawerOpen(true)}
     aria-label="Open navigation"
     data-help-id="admin.shell.nav.mobile_menu"
     style={{
       background: "none",
       border: "1px solid var(--aiq-color-border)",
       borderRadius: "var(--aiq-radius-pill)",
       width: 32,
       height: 32,
       display: "none",  // overridden to inline-flex on mobile via CSS
       alignItems: "center",
       justifyContent: "center",
       cursor: "pointer",
       padding: 0,
       flexShrink: 0,
     }}
   >
     <Icon name="drag" size={14} />
   </button>
   ```

- [ ] **Step 5: Apply token to top-bar padding + height.** Replace the existing top-bar inline style:

   ```tsx
   style={{
     display: "flex",
     alignItems: "center",
     justifyContent: "space-between",
     padding: "0 var(--aiq-admin-shell-topbar-padding-x)",
     height: "var(--aiq-admin-shell-topbar-h)",
     borderBottom: "1px solid var(--aiq-color-border)",
     flexShrink: 0,
     background: "var(--aiq-color-bg-raised)",
   }}
   ```

- [ ] **Step 6: Wrap MFA nudge banner + breadcrumbs row** with anchor classes so CSS can target them:

   - Add `className="aiq-admin-mfa-nudge"` to the MFA banner wrapping `<div>` inside `MfaNudgeBanner`.
   - Add `className="aiq-admin-breadcrumbs"` to the breadcrumbs row `<div>`.

   These are CSS hooks only; no inline-style change is needed.

- [ ] **Step 7: Tag tenant slug + email for mobile-hide.** On the `<span>` wrapping the user email (currently `{session?.user.email}`), add `className="aiq-admin-shell-email"`. On the tenant-slug button + its preceding `/` separator, wrap them in `<span className="aiq-admin-shell-slug">…</span>`.

### Task A1.3: Add CSS recipes to tokens.css

**Files:**

- Modify: `modules/17-ui-system/src/styles/tokens.css`

- [ ] **Step 1: Append after the existing CandidateActivity rules** (after the `[data-viewport="mobile"] .aiq-candidate-activity-stats` rule around line 242):

   ```css
   /* ─────────────────────────────────────────────────────────────
    * Admin Mobile Port — A1 AdminShell drawer + reflow.
    * Spec: docs/plans/ADMIN_MOBILE_PORT.md § 2.3
    *
    * Strategy: the existing Sidebar primitive is always rendered.
    * On mobile, .aiq-admin-sidebar-wrap repositions it off-canvas
    * (fixed, translateX(-100%)) and slides it back into view via
    * the [data-drawer-open="true"] attribute on the screen root.
    * Backdrop fades in concurrently. Body scroll lock + Escape
    * handler + focus trap are JS (AdminShell.tsx) — CSS only
    * handles geometry.
    * ───────────────────────────────────────────────────────────── */

   .aiq-admin-shell .aiq-admin-hamburger { display: none; }
   .aiq-admin-shell .aiq-admin-drawer-backdrop { display: none; }
   .aiq-admin-shell .aiq-admin-sidebar-wrap { display: contents; }

   /* Hamburger — branding § 8.1 requires explicit focus ring on every button. */
   .aiq-admin-shell .aiq-admin-hamburger:focus-visible {
     outline: 2px solid var(--aiq-color-accent);
     outline-offset: 2px;
   }

   [data-viewport="mobile"] .aiq-admin-shell .aiq-admin-hamburger {
     display: inline-flex;
     min-width: 44px;
     min-height: 44px;
   }

   /* Top-bar button tap-target floor — branding/anti-pattern §5 #10.
    * The AdminShell top bar currently renders Sign out as aiq-btn-sm (32px).
    * On mobile, every interactive control must hit 44×44. This rule covers
    * Sign out + any future btn-sm in the top bar without per-page edits. */
   [data-viewport="mobile"] .aiq-admin-shell .aiq-btn-sm {
     min-height: 44px;
     min-width: 44px;
     padding-inline: var(--aiq-space-md);
   }

   /* Hide the tenant slug + the desktop email span on mobile to make room
      for the hamburger. Sign-out stays visible (44px target). */
   [data-viewport="mobile"] .aiq-admin-shell .aiq-admin-shell-slug { display: none; }
   [data-viewport="mobile"] .aiq-admin-shell .aiq-admin-shell-email {
     max-width: 40vw;
     overflow: hidden;
     text-overflow: ellipsis;
     white-space: nowrap;
   }

   /* Mobile: sidebar becomes a fixed off-canvas drawer; ::backdrop overlays. */
   [data-viewport="mobile"] .aiq-admin-shell .aiq-admin-sidebar-wrap {
     display: block;
     position: fixed;
     top: 0; bottom: 0; left: 0;
     width: var(--aiq-admin-drawer-width);
     z-index: 50;
     transform: translateX(-100%);
     transition: transform var(--aiq-motion-duration-base) var(--aiq-motion-easing-out);
   }
   [data-viewport="mobile"] .aiq-admin-shell[data-drawer-open="true"] .aiq-admin-sidebar-wrap {
     transform: translateX(0);
     box-shadow: var(--aiq-shadow-lg);
   }
   [data-viewport="mobile"] .aiq-admin-shell[data-drawer-open="true"] .aiq-admin-drawer-backdrop {
     display: block;
     position: fixed;
     inset: 0;
     z-index: 49;
     background: rgba(0, 0, 0, 0.45);
     animation: aiq-fade-in 150ms ease-out;
   }

   /* Breadcrumbs allow wrapping on narrow viewports. */
   [data-viewport="mobile"] .aiq-admin-breadcrumbs { flex-wrap: wrap; }

   /* MFA nudge banner — copy stacks above the dismiss control on mobile. */
   [data-viewport="mobile"] .aiq-admin-mfa-nudge {
     flex-direction: column;
     align-items: stretch;
     gap: var(--aiq-space-sm);
   }

   @keyframes aiq-fade-in {
     from { opacity: 0; }
     to   { opacity: 1; }
   }
   ```

### Task A1.4: Add help_id entry

**Files:**

- Modify: `modules/16-help-system/content/en/admin.yml`

- [ ] **Step 1: Inspect the existing admin.yml shape FIRST.** The implementer must not guess at the YAML structure.

   ```bash
   head -40 modules/16-help-system/content/en/admin.yml
   ```

   Note the top-level key (likely `pages:` or flat key/value), the indentation depth, and how an existing entry like `admin.shell.mobile_continue_anyway` (from M5) is shaped. Match that shape exactly for the new entry.

- [ ] **Step 2: Append the new entry** following the observed shape from Step 1. The example below assumes a flat-key shape; adjust if Step 1 reveals a nested `pages.admin.shell:` group:

   ```yaml
   admin.shell.nav.mobile_menu:
     audience: admin
     tooltip: Open navigation menu.
     drawer: |
       Tap to open the full admin navigation drawer. Available on phone-sized
       viewports only — on a laptop the sidebar is always visible.
   ```

- [ ] **Step 3: Run the help-content drift gate.**

   ```bash
   pnpm --filter @assessiq/help-system test
   ```

   If the test asserts seed-file parity, copy the new entry into `modules/16-help-system/db/migrations/0011_seed_help_content.sql` per the catch-up-commit pattern (see PROJECT_BRAIN § "MFA Nudge Banner Exists in AdminShell").

### Task A1.5: Verify tests + adversarial review

- [ ] **Step 1: Run the new test file.**

   ```bash
   pnpm --filter @assessiq/admin-dashboard test src/__tests__/admin-shell-mobile.test.tsx -- --run
   ```

   Expected: all 5 tests PASS.

- [ ] **Step 2: Run all existing AdminShell-touching tests.**

   ```bash
   pnpm --filter @assessiq/admin-dashboard test -- --run
   ```

   Expected: PASS (no regressions).

- [ ] **Step 3: Sonnet+GLM-5.1 adversarial pass.** Per memory `feedback-adversarial-reviewer-routing.md`, AdminShell is load-bearing. Dispatch one Sonnet agent + one OR-`glm-5.1` adversarial review:

   ```bash
   node C:/Users/manis/bin/or.mjs glm-5.1 \
     --system "You are an adversarial reviewer focused on UI security and a11y." \
     "Review this diff for: (1) DOM swap between viewports, (2) missing aria attributes, (3) focus trap leaks, (4) body-scroll-lock cleanup on unmount, (5) help-id seed drift. Diff: $(git diff HEAD~0 -- modules/10-admin-dashboard/src/components/AdminShell.tsx modules/17-ui-system/src/styles/tokens.css)"
   ```

   Both must return `accept`. Bounce → Phase 4 revision. Second bounce → abort and ask the user (per global `feedback-abort-approach-criterion.md`).

### Task A1.6: Commit + deploy

- [ ] **Step 1: Commit.**

   ```bash
   git add modules/10-admin-dashboard/src/components/AdminShell.tsx \
           modules/10-admin-dashboard/src/__tests__/admin-shell-mobile.test.tsx \
           modules/17-ui-system/src/styles/tokens.css \
           modules/16-help-system/content/en/admin.yml \
           modules/16-help-system/db/migrations/0011_seed_help_content.sql
   GIT_COMMITTER_EMAIL="257227540+manishjnv@users.noreply.github.com" \
   GIT_COMMITTER_NAME="Manish Kumar" \
     git commit -m "$(cat <<'EOF'
   feat(admin-mobile): A1 — AdminShell drawer + top-bar reflow

   Wraps the Sidebar primitive in an off-canvas drawer triggered by a
   new hamburger button. Same DOM both viewports; CSS toggles
   geometry via [data-drawer-open]. Body scroll lock + Escape +
   backdrop click close the drawer. Top bar tightens via the A0
   tokens; tenant slug hides on mobile; email truncates; breadcrumbs
   wrap; MFA nudge banner stacks.

   New help_id: admin.shell.nav.mobile_menu (admin.yml + seed catch-up).

   Adversarial: Sonnet+GLM-5.1 accept (load-bearing).

   Spec: docs/plans/ADMIN_MOBILE_PORT.md § 2.3
   EOF
   )" \
     --author="Manish Kumar <257227540+manishjnv@users.noreply.github.com>"
   ```

- [ ] **Step 2: Deploy.**

   ```bash
   git push
   ssh assessiq-vps 'cd /srv/assessiq && git pull && docker compose -f infra/docker-compose.yml build assessiq-frontend && docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-frontend'
   ```

- [ ] **Step 3: Live smoke (manual).** Tap "Continue anyway" on the M5 interstitial (ViewportLock is still in place — A6 removes it). Confirm:
   1. Hamburger pill renders top-left.
   2. Tap opens drawer with full nav.
   3. Tap backdrop closes drawer.
   4. Tap a nav item navigates AND closes drawer.
   5. Top bar shows AssessIQ + ellipsized email + Sign out; tenant slug hidden.
   6. Page below scrolls normally with drawer closed; locked when drawer open.

- [ ] **Step 4: SESSION_STATE handoff** with 5-line agent-utilization footer. Spec status header updated: `A1 — AdminShell drawer + reflow | SHIPPED <YYYY-MM-DD>`.

---

## A2 — Lists & home (parallel-Sonnet-friendly)

**Risk:** medium. 10 pages, mechanical, ideal for parallel Sonnet fan-out (max 6 concurrent — split into 2 waves of 5).

**Wave 1:** Dashboard, Attempts, Users, Grading, Activity.
**Wave 2:** Assessments, Question Bank, Generation history, Certificates, Super-admin Users.

Each page gets the same recipe-paste pattern. Below is the per-page task template; instantiate it 10 times (once per page).

### Task A2.0: Add R1/R2/R3 CSS recipes to tokens.css (do once before wave 1)

**Files:**

- Modify: `modules/17-ui-system/src/styles/tokens.css`

- [ ] **Step 1: Append the recipe block** after the A1 admin-shell rules:

   ```css
   /* ─────────────────────────────────────────────────────────────
    * Admin Mobile Port — A2 list/table recipes (R1, R2, R3).
    * Spec: docs/plans/ADMIN_MOBILE_PORT.md § 4 (R1/R2/R3)
    * ───────────────────────────────────────────────────────────── */

   /* R1 — filter / tab strip → horizontally-scrollable pill row.
    *
    * Desktop default is EXPLICIT (flex-wrap: wrap) — must match today's
    * behavior so filter strips with many chips fall to row 2 on a laptop.
    * Per spec § 4 R1 anti-pattern guard: do not drop inline flexWrap:"wrap"
    * from existing filter rows on the assumption that browser default
    * suffices — browser default is `nowrap` and that's a desktop regression. */
   .aiq-admin-filter-strip {
     display: flex;
     flex-wrap: wrap;
     gap: var(--aiq-space-xs);
   }
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

   /* R2 — dense table → horizontal-scroll wrapper with sticky first column */
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

   /* R3 — sparse list → card-row reflow.
      The <td>'s data-label attribute is the source for the eyebrow that
      appears above each value on mobile. ColumnDef.label populates it. */
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
     font-size: 11px;  /* branding § 8.2: chip/microcopy 11px mono-uppercase */
     text-transform: uppercase;
     letter-spacing: 0.06em;
     color: var(--aiq-color-fg-muted);
     margin-bottom: 2px;
   }
   ```

- [ ] **Step 2: Verify Table primitive populates `data-label` on `<td>`.** Open `modules/17-ui-system/src/components/Table.tsx`. If `ColumnDef.label` is not currently emitted as `data-label` on every `<td>`, add it:

   ```tsx
   <td data-label={col.label} ...>{...}</td>
   ```

   This is a load-bearing primitive change. Run `pnpm --filter @assessiq/ui-system test` to confirm no regression.

### Task A2.W{1..10}: Per-page reflow

Repeat for each of the 10 pages. Below uses `Attempts` as the example; substitute the page name for each.

**Files (per page):**

- Modify: `modules/10-admin-dashboard/src/pages/<page>.tsx`

- [ ] **Step 1: Add anchor class to filter strip — keep existing wrap behavior on desktop.** Locate the filter-tabs container (e.g., the `<div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>` in `attempts.tsx:143`).

   Add the anchor class. **Do NOT drop the inline `flexWrap: "wrap"` style.** The R1 CSS in A2.0 makes desktop wrap explicit, but leaving the inline style as well is harmless and protects against future CSS-load-order surprises. The container becomes:

   ```tsx
   <div className="aiq-admin-filter-strip" style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
   ```

   Rationale: the previous version of this plan instructed implementers to drop `flexWrap` on the assumption that browser default suffices. It doesn't — browser default for `flex-wrap` is `nowrap`. Without R1's explicit desktop rule AND/OR the inline `flexWrap: "wrap"`, filter strips with ≥ 6 chips overflow the right edge on a 1280px laptop instead of falling to row 2. Belt-and-suspenders: leave the inline style and rely on R1's CSS.

- [ ] **Step 2: Choose R2 or R3 per the recipe map** (see [spec § 4.7](./ADMIN_MOBILE_PORT.md#per-page-recipe-map)):

   - **R2 pages (dense triage):** Attempts, Users, Grading, Super-admin Users, Generation history. Wrap the `<Table>` in:

     ```tsx
     <div className="aiq-admin-table-scroll">
       <Table ... />
     </div>
     ```

   - **R3 pages (browsable catalogs):** Assessments, Question Bank, Certificates. Add `mobileCardLayout` class to the `<Table>` (or wrap):

     ```tsx
     <Table className="aiq-admin-table-cards" ... />
     ```

     If `Table` does not accept `className`, wrap and apply the class to the wrapper.

   - **Dashboard:** mixes R1 + R2. Apply both anchor classes — `aiq-admin-filter-strip` on the queue's status filter, `aiq-admin-table-scroll` on the queue table.

   - **Activity:** reuses M4 candidate-Activity patterns. The page renders an `<ActivityHeatmap>` and `<LeaderboardList>` — wrap heatmap in `.aiq-candidate-activity-heatmap-scroll` (existing) and set `<LeaderboardList columns={viewport === 'mobile' ? 1 : 2}>` via `useViewport()` import.

- [ ] **Step 3: Verify `data-label` reaches `<td>`** by inspecting the rendered DOM in DevTools mobile emulation. If `Table.tsx` is the consumer (not raw `<table>`), the A2.0 primitive change handles this.

- [ ] **Step 4: Smoke at 360×640.** Open `/admin/<page>` in Chrome mobile emulation (after tapping "Continue anyway" on M5 interstitial). Confirm:
   1. Filter strip scrolls horizontally with snap.
   2. Table either scrolls (R2) or stacks as cards (R3) — no horizontal page scroll outside the wrapper.
   3. Action buttons (Open / Edit) are tap-reachable (≥ 44px).

- [ ] **Step 5: No commit yet.** Wave 1 commits all 5 page diffs in one phase commit. Same for Wave 2.

### Task A2.C: Wave commits + adversarial

- [ ] **Step 1: After Wave 1 (Dashboard, Attempts, Users, Grading, Activity) all pass smoke**, run page-level Vitests for any of these pages that have existing test files. Add an assertion in the existing test that the anchor class is present:

   ```tsx
   expect(container.querySelector('.aiq-admin-filter-strip')).toBeInTheDocument();
   ```

- [ ] **Step 2: Sonnet+GLM-5.1 adversarial only on Wave 1 — Wave 2 inherits.**

- [ ] **Step 3: Commit Wave 1.**

   ```bash
   git add modules/10-admin-dashboard/src/pages/{dashboard,attempts,users,grading-jobs,activity}.tsx \
           modules/17-ui-system/src/styles/tokens.css \
           modules/17-ui-system/src/components/Table.tsx
   git commit -m "feat(admin-mobile): A2 wave 1 — Dashboard/Attempts/Users/Grading/Activity"
   ```

- [ ] **Step 4: Deploy Wave 1, smoke, then run Wave 2 same way.**

- [ ] **Step 5: Commit Wave 2 and deploy.**

---

## A3 — Detail / report pages

**Risk:** higher. Attempt Detail is `07-ai-grading`-adjacent → Sonnet+GLM-5.1 adversarial mandatory; `codex:rescue` if flagged.

### Task A3.0: Add R4 + sticky-action-bar CSS

**Files:**

- Modify: `modules/17-ui-system/src/styles/tokens.css`

- [ ] **Step 1: Append after A2 recipes:**

   ```css
   /* ─────────────────────────────────────────────────────────────
    * Admin Mobile Port — A3 detail recipes (R4 + sticky action bar).
    * Spec: docs/plans/ADMIN_MOBILE_PORT.md § 4 (R4)
    * ───────────────────────────────────────────────────────────── */

   .aiq-admin-detail-two-col {
     display: grid;
     grid-template-columns: 1fr 380px;
     gap: var(--aiq-space-xl);
   }
   [data-viewport="mobile"] .aiq-admin-detail-two-col {
     grid-template-columns: 1fr;
     gap: var(--aiq-space-lg);
   }

   /* Charts/radars with min-width wrap in horizontal scroll. */
   [data-viewport="mobile"] .aiq-admin-chart-scroll {
     overflow-x: auto;
     -webkit-overflow-scrolling: touch;
     margin-inline: calc(-1 * var(--aiq-page-padding-x));
     padding-inline: var(--aiq-page-padding-x);
   }

   /* Sticky action bar for detail-page actions (Accept / Override / Release).
    *
    * SCROLL-CONTAINER CONTRACT (spec § 4 R4):
    * `position: sticky` only sticks within its nearest scrolling ancestor.
    * AdminShell makes <main> the scroll context (overflowY: auto). Therefore
    * the action bar MUST be a direct or shallow descendant of <main> with NO
    * intermediate ancestor introducing overflow: auto/hidden/scroll. Per-page
    * audit step in A3.{1..6} verifies this; bounce in Phase 3 critique if an
    * ancestor scroll context breaks stickiness. */
   .aiq-admin-action-bar { display: flex; gap: var(--aiq-space-sm); justify-content: flex-end; }
   [data-viewport="mobile"] .aiq-admin-action-bar {
     position: sticky;
     bottom: 0;
     background: var(--aiq-color-bg-base);
     border-top: 1px solid var(--aiq-color-border);
     padding: var(--aiq-space-md) 0;
     margin-inline: calc(-1 * var(--aiq-page-padding-x));
     padding-inline: var(--aiq-page-padding-x);
     display: grid;
     grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
     gap: var(--aiq-space-sm);
     z-index: 5;  /* above scrolling card content; below A1 drawer (z=50) */
   }
   [data-viewport="mobile"] .aiq-admin-action-bar button {
     width: 100%;
     min-height: 44px;
   }
   [data-viewport="mobile"] .aiq-admin-action-bar button:focus-visible {
     outline: 2px solid var(--aiq-color-accent);
     outline-offset: 2px;
   }

   /* Long-form text inputs (override reason, justification, anchor evidence).
    * Spec § 4 — must compose a 200-word response with the keyboard open. */
   [data-viewport="mobile"] .aiq-admin-longform-textarea {
     min-height: 120px;
     font-size: max(16px, var(--aiq-input-size-base, 14px));
   }
   ```

### Task A3.{1..6}: Per-page R4 application

Repeat for: Attempt Detail, Cohort Report, Individual Report, Pack Detail, Assessment Detail (read), Help Content.

- [ ] **Step 1: Scroll-container audit (do this BEFORE any other change).** Grep the page for `overflow:` declarations and trace the ancestor chain from any candidate action-bar location up to the `<AdminShell>` `<main>`.

   ```bash
   grep -n "overflow" modules/10-admin-dashboard/src/pages/<page>.tsx \
                       modules/10-admin-dashboard/src/components/*.tsx
   ```

   For each `overflow: auto / hidden / scroll` found on an ancestor of where the action bar will sit:

   - If the overflow is decorative (e.g., a `<Card>` clipping its child for radius), change it to `overflow: visible` if removing it doesn't break layout, OR move the action bar OUT of that ancestor so it's a direct child of `<main>`.
   - If the overflow is essential (e.g., a long anchor list that must scroll independently), the action bar MUST be lifted to page-level (sibling of the scrolling region, not inside it).

   Document any decision in a `// MOBILE-PORT:` comment on the touched line so Phase 3 review can verify.

- [ ] **Step 2: Locate the two-column grid.** Each page has a `display: grid; gridTemplateColumns: "1fr 380px"` (or similar) on its main layout `<div>`. Replace with `className="aiq-admin-detail-two-col"`; drop the inline `display/gridTemplateColumns/gap` styles (CSS class supplies them).

- [ ] **Step 3: Verify mobile source order.** In each two-column page, confirm the JSX order is: left-pane (question/answer) first, right-pane (grading/proposal) second. Mobile CSS preserves source order; no DOM reorder needed.

- [ ] **Step 4: Wrap any charts.** In Individual Report (`ArchetypeRadar`), Cohort Report (`StackedBarChart`), wrap with `<div className="aiq-admin-chart-scroll">…</div>`.

- [ ] **Step 5: Tag action bars.** Attempt Detail's Accept/Override/Release row → `className="aiq-admin-action-bar"`. Cohort/Individual Report's Share/Download/Print row → same. Verify scroll-container contract from Step 1 — the tagged row must sit as a direct child of `<main>` or a non-overflowing wrapper inside `<main>`.

- [ ] **Step 6: Long-form textareas.** For Attempt Detail specifically, tag the override-reason textarea (inside the override form) and any justification textarea with `className="aiq-admin-longform-textarea"`. Other detail pages: tag any `<textarea>` that accepts ≥ 100-word input. CSS already in A3.0 supplies `min-height: 120px` + iOS-zoom-safe font.

- [ ] **Step 7: Wrap nested tables** (Pack Detail's question sublist, Cohort Report's per-candidate table) per R3 recipe.

- [ ] **Step 8: Smoke at 360×640.** For Attempt Detail specifically, verify the full flow: load → Grade → Accept → Override → Release. Every button reachable, no off-screen content. **Specifically test that the sticky action bar stays pinned to the viewport bottom while scrolling the question/answer content above it** — if it scrolls away with the page, the scroll-container audit (Step 1) missed something. With the on-screen keyboard open inside the override textarea, the bar should remain visible above the keyboard (mobile browser behavior — `position: sticky` plays nicely with visualViewport on modern Safari/Chrome).

### Task A3.C: Commit + adversarial

- [ ] **Step 1: Sonnet+GLM-5.1 adversarial pass on the Attempt Detail diff specifically** (the highest-risk page in A3 — load-bearing AI-grading-adjacent):

   ```bash
   node C:/Users/manis/bin/or.mjs glm-5.1 \
     --system "Adversarial reviewer for 07-ai-grading-adjacent UI." \
     "Diff: $(git diff -- modules/10-admin-dashboard/src/pages/attempt-detail.tsx). Check: (1) grading proposal data integrity preserved, (2) override fresh-MFA redirect path unchanged, (3) no candidate PII leak via responsive reflow, (4) sticky action bar doesn't obscure scroll content, (5) Band picker tap area ≥ 44px."
   ```

   Both Sonnet (page review) and GLM-5.1 must accept. Bounce → revise; second bounce → `codex:rescue`.

- [ ] **Step 2: Run tests.**

   ```bash
   pnpm --filter @assessiq/admin-dashboard test -- --run
   ```

- [ ] **Step 3: Commit + deploy + smoke.**

---

## A4 — Settings / help

**Risk:** low–medium. Mostly card-stacked; light reflow.

### Task A4.0: Add cross-cutting input rule

**Files:**

- Modify: `modules/17-ui-system/src/styles/tokens.css`

- [ ] **Step 1: Append after A3 recipes:**

   ```css
   /* ─────────────────────────────────────────────────────────────
    * Admin Mobile Port — A4 cross-cutting input rule.
    * iOS Safari auto-zooms <input> / <textarea> / <select> with
    * computed font-size < 16px on focus. Bumping to 16px on mobile
    * defeats it without affecting desktop ergonomics.
    * Spec: docs/plans/ADMIN_MOBILE_PORT.md § 4 (cross-cutting)
    * ───────────────────────────────────────────────────────────── */

   [data-viewport="mobile"] .aiq-admin-input,
   [data-viewport="mobile"] .aiq-admin-page textarea,
   [data-viewport="mobile"] .aiq-admin-page input:not([type="checkbox"]):not([type="radio"]),
   [data-viewport="mobile"] .aiq-admin-page select {
     font-size: max(16px, var(--aiq-input-size-base, 14px));
   }
   ```

### Task A4.{1..5}: Per-page light reflow

Pages: Billing, Help guide, Admin guide, Platform, Help Content.

- [ ] **Step 1: Add `className="aiq-admin-page"` to the outermost wrapper** of each page (immediately inside `<AdminShell>`). This activates the cross-cutting input rule.

- [ ] **Step 2: Wrap any tab strip in `className="aiq-admin-filter-strip"`** (Billing has no tabs; Help Content's tag filter does — apply there).

- [ ] **Step 3: Replace multi-column stat grids with single-column on mobile.** Billing's "Your plan & usage" card has a 3-up stat block — add `className="aiq-admin-stats-3"` and the CSS rule (in A4.0):

   ```css
   .aiq-admin-stats-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--aiq-space-lg); }
   [data-viewport="mobile"] .aiq-admin-stats-3 { grid-template-columns: 1fr; gap: var(--aiq-space-md); }
   ```

- [ ] **Step 4: Smoke at 360×640.**

- [ ] **Step 5: Commit A4 + deploy.**

---

## A5 — Editors (highest-risk)

**Risk:** high. Phase 3 critique + Sonnet+GLM-5.1 adversarial pass mandatory.

### Task A5.0: Add R5 + R6 CSS

**Files:**

- Modify: `modules/17-ui-system/src/styles/tokens.css`

- [ ] **Step 1: Append after A4 recipes:**

   ```css
   /* ─────────────────────────────────────────────────────────────
    * Admin Mobile Port — A5 editor recipes (R5 wizard + R6 accordion).
    * Spec: docs/plans/ADMIN_MOBILE_PORT.md § 4 (R5/R6)
    * ───────────────────────────────────────────────────────────── */

   /* R5 — wizard mobile: vertical steps + sticky bottom nav */
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
     margin-inline: calc(-1 * var(--aiq-page-padding-x));
     padding-inline: var(--aiq-page-padding-x);
   }
   [data-viewport="mobile"] .aiq-admin-wizard-nav button {
     width: 100%;
     min-height: 44px;
     justify-content: center;
   }

   /* R6 — editor/rubric accordion using <details>. */
   .aiq-admin-editor-section {
     border: 1px solid var(--aiq-color-border);
     border-radius: var(--aiq-radius-lg);
     padding: var(--aiq-card-padding);
     margin-bottom: var(--aiq-space-md);
   }
   .aiq-admin-editor-section > summary {
     cursor: pointer;
     display: flex;
     align-items: center;
     gap: var(--aiq-space-sm);
     list-style: none;
     min-height: 44px;
   }
   .aiq-admin-editor-section > summary::-webkit-details-marker { display: none; }
   .aiq-admin-editor-section > summary .chevron {
     margin-left: auto;
     transition: transform var(--aiq-motion-duration-fast);
   }
   .aiq-admin-editor-section[open] > summary .chevron { transform: rotate(180deg); }
   .aiq-admin-editor-section-body { padding-top: var(--aiq-space-md); }
   ```

### Task A5.1: Question Editor

**Files:**

- Modify: `modules/10-admin-dashboard/src/pages/question-editor.tsx`
- Modify: `modules/10-admin-dashboard/src/components/RubricEditor.tsx`

- [ ] **Step 1: Wrap form sections in `<details>` accordion (R6).** In RubricEditor, the existing "Anchors" + "Bands" sections become:

   ```tsx
   import { useViewport } from '@assessiq/ui-system';
   // ...
   const viewport = useViewport();
   // ...
   <details
     className="aiq-admin-editor-section"
     open={viewport === 'desktop'}
   >
     <summary>
       <span className="aiq-serif" style={{ fontSize: 18, fontWeight: 400 }}>Anchors</span>
       <span className="aiq-chip">{anchors.length} items</span>
       <span className="chevron" aria-hidden="true">▾</span>
     </summary>
     <div className="aiq-admin-editor-section-body">
       {/* existing anchor list JSX */}
     </div>
   </details>
   ```

   Apply to Anchors AND Bands sections. Bands starts collapsed on mobile (`open={viewport === 'desktop'}` — first section gets `||` clause for `open` if you want anchors auto-open on mobile too).

- [ ] **Step 2: Question-type selector → vertically-stacked radio cards on mobile.** Find the QUESTION_TYPES selector. If it's a horizontal segmented control, add `className="aiq-admin-qtype-selector"` and CSS:

   ```css
   .aiq-admin-qtype-selector { display: flex; gap: var(--aiq-space-xs); }
   [data-viewport="mobile"] .aiq-admin-qtype-selector {
     flex-direction: column;
     gap: var(--aiq-space-sm);
   }
   [data-viewport="mobile"] .aiq-admin-qtype-selector > label {
     padding: var(--aiq-space-md);
     border: 1px solid var(--aiq-color-border);
     border-radius: var(--aiq-radius-lg);
     min-height: 44px;
   }
   ```

- [ ] **Step 3: Wrap code-like content in `.aiq-admin-chart-scroll`.** For `kql.question`, `kql.expected_keywords`, `log_analysis.log_excerpt` rendered in QuestionContentView — wrap any `<pre>` or fixed-width display in the chart-scroll class.

- [ ] **Step 4: Sticky action bar.** Replace the existing "Save rubric" / "Regenerate via AI" button row with `<div className="aiq-admin-action-bar">…</div>`.

- [ ] **Step 5: Mobile smoke — full authoring flow.** Open Question Editor on mobile. Verify: pick type → fill content → expand Anchors → add an anchor → expand Bands → fill a band → tap Save rubric. No reflow regression on desktop.

### Task A5.2: Generate Wizard

**Files:**

- Modify: `modules/10-admin-dashboard/src/pages/generate-wizard.tsx`

- [ ] **Step 1: Tag wizard step indicator + nav row.** Add `className="aiq-admin-wizard-steps"` to the step indicator row; `className="aiq-admin-wizard-nav"` to the Prev/Next row.

- [ ] **Step 2: Smoke the wizard end-to-end on mobile.** Confirm: each step renders single-column, nav buttons are sticky at the bottom, Prev/Next are full-width.

### Task A5.3: Assessment Detail / Pack Detail create forms

**Files:**

- Modify: `modules/10-admin-dashboard/src/pages/assessment-detail.tsx`
- Modify: `modules/10-admin-dashboard/src/pages/pack-detail.tsx`

- [ ] **Step 1: Identify the create-form variant** (when `:id === "new"` or `pack_id === undefined`). Apply R5 wizard classes if the form is multi-step; otherwise apply card-stacked layout with `aiq-admin-page` wrapper for the cross-cutting input rule.

- [ ] **Step 2: Native date inputs.** Replace any custom date-picker `<input type="text">` with `<input type="date">` where possible (Phase 1 forms are simple enough).

- [ ] **Step 3: Smoke.**

### Task A5.C: Commit + adversarial + deploy

- [ ] **Step 1: Sonnet+GLM-5.1 adversarial on Question Editor + RubricEditor diffs** (both `07-ai-grading`-adjacent).

- [ ] **Step 2: `codex:rescue` if either reviewer flags anything not trivially fixable.**

- [ ] **Step 3: Run tests + commit + deploy + smoke.**

---

## A6 — Remove ViewportLock + close-out

**Risk:** low. Mostly deletion + docs.

### Task A6.1: Delete ViewportLock

**Files:**

- Delete: `apps/web/src/lib/ViewportLock.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Delete the file.**

   ```bash
   git rm apps/web/src/lib/ViewportLock.tsx
   ```

- [ ] **Step 2: Remove the wrapper from `App.tsx`.** Grep for `<ViewportLock>` and remove the opening tag, the closing `</ViewportLock>`, AND the import line. The `<Routes>` block stays at the same indent level.

- [ ] **Step 3: Run the App's test suite.**

   ```bash
   pnpm --filter @assessiq/web test -- --run
   ```

   Expected: PASS (no test references ViewportLock; if any do, they were stale and should also be removed).

### Task A6.2: Remove help_id + verify no override key references

**Files:**

- Modify: `modules/16-help-system/content/en/admin.yml`

- [ ] **Step 1: Remove the `admin.shell.mobile_continue_anyway` entry from `admin.yml`.** If present in `0011_seed_help_content.sql`, leave the seed row in place (catch-up seeds are append-only for historical fidelity; reflow it by appending a `DELETE` migration only if the project's existing help-system pattern does so — otherwise leave the inert row).

- [ ] **Step 2: Grep verify removal.**

   ```bash
   grep -r "ViewportLock\|aiq_admin_mobile_override\|mobile_continue_anyway" apps/ modules/ --include="*.ts" --include="*.tsx" --include="*.yml"
   ```

   Expected: zero hits in production code. Doc/RCA hits in `docs/` are OK.

### Task A6.3: Branding guideline rewrite

**Files:**

- Modify: `docs/10-branding-guideline.md` § 15.3

- [ ] **Step 1: Replace the "Admin graceful-degrade interstitial (M5 — 2026-05-20)" subsection** with a one-paragraph historical note:

   ```markdown
   #### Admin graceful-degrade interstitial (M5 — 2026-05-20, superseded YYYY-MM-DD)

   M5 shipped a "desktop recommended" interstitial that intercepted /admin/*
   on mobile viewports. It was superseded by the Admin Mobile Port (see
   `docs/plans/ADMIN_MOBILE_PORT.md`) on YYYY-MM-DD. Admin pages are now
   responsive; ViewportLock and its sessionStorage override are removed.
   The original M5 design and the four excluded auth routes are preserved
   in git history (commit `<A6 sha>`); this entry is kept as a pointer.
   ```

- [ ] **Step 2: Add a new "Admin pattern reflows" subsection** after the M5 historical note, cataloging the six recipes (R1–R6) from the spec § 4. Be concise — link back to the spec for the full CSS.

### Task A6.4: Final smoke + commit + deploy

- [ ] **Step 1: Full-site smoke pass** on a real phone hitting every admin sidebar route:
   - Dashboard, Assessments, Attempts, Grading, Reports.
   - Question Bank (+ Generate Questions + Generation history for super_admin).
   - Users, Activity.
   - Help guide, Settings, Platform (super_admin).

   For each: no interstitial, no horizontal page scroll, all primary actions tap-reachable. Delegate to a Haiku subagent to confirm the checkmark grid:

   ```text
   Haiku prompt: "Open https://assessiq.automateedge.cloud/admin in a mobile-emulated browser. For each of the 11 admin routes (Dashboard, Assessments, Attempts, Grading, Reports, Question Bank, Users, Activity, Help guide, Settings, Platform), report: (1) renders without ViewportLock interstitial, (2) hamburger opens drawer, (3) no horizontal page scroll, (4) primary action visible above the fold. Return a markdown checkmark table."
   ```

- [ ] **Step 2: Commit A6.**

   ```bash
   git add -A
   GIT_COMMITTER_EMAIL="257227540+manishjnv@users.noreply.github.com" \
   GIT_COMMITTER_NAME="Manish Kumar" \
     git commit -m "$(cat <<'EOF'
   feat(admin-mobile): A6 — remove ViewportLock + close-out

   Deletes apps/web/src/lib/ViewportLock.tsx and removes the M5
   interstitial wrapper from App.tsx. Removes admin.shell.mobile_continue_anyway
   help_id. Rewrites docs/10-branding-guideline.md § 15.3 M5 entry as
   superseded; adds "Admin pattern reflows" subsection cataloging R1–R6.

   Admin pages are now responsive on every viewport. Phase contracts
   A0–A5 ship at: <A0 sha>, <A1 sha>, <A2 sha>, <A3 sha>, <A4 sha>, <A5 sha>.

   Spec: docs/plans/ADMIN_MOBILE_PORT.md § A6
   EOF
   )" \
     --author="Manish Kumar <257227540+manishjnv@users.noreply.github.com>"
   ```

- [ ] **Step 3: Deploy.**

   ```bash
   git push
   ssh assessiq-vps 'cd /srv/assessiq && git pull && docker compose -f infra/docker-compose.yml build assessiq-frontend && docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-frontend'
   ```

- [ ] **Step 4: Spec status header — all rows SHIPPED.** Final SESSION_STATE handoff with 5-line agent-utilization footer.

---

## Self-review checklist (run after writing all phases)

1. **Spec coverage.** Every section in the spec (§ 1 scope, § 2 architecture, § 3 phase contracts, § 4 recipes, § 5 anti-pattern guards, § 6 testing, § 7 docs) maps to a task — confirmed by skim-pass.
2. **Placeholder scan.** No "TBD"/"TODO"/"implement later" in this plan. `<A0 sha>`, `<A1 sha>`, etc. in the A6 commit message are intentional template placeholders the A6 implementer fills in.
3. **Type consistency.** Class names (`aiq-admin-filter-strip`, `aiq-admin-table-scroll`, `aiq-admin-table-cards`, `aiq-admin-detail-two-col`, `aiq-admin-wizard-*`, `aiq-admin-editor-section`, `aiq-admin-action-bar`, `aiq-admin-chart-scroll`, `aiq-admin-page`, `aiq-admin-stats-3`, `aiq-admin-shell`, `aiq-admin-hamburger`, `aiq-admin-drawer-backdrop`, `aiq-admin-sidebar-wrap`, `aiq-admin-breadcrumbs`, `aiq-admin-mfa-nudge`, `aiq-admin-shell-email`, `aiq-admin-shell-slug`, `aiq-admin-qtype-selector`) consistent across the plan.
4. **Token names** (`--aiq-admin-shell-topbar-padding-x`, `--aiq-admin-shell-topbar-h`, `--aiq-admin-drawer-width`) consistent across A0 (added), A1 (consumed), A6 (untouched — they're permanent).
5. **Adversarial gates.** A1, A3 (Attempt Detail), A5 all carry Sonnet+GLM-5.1 adversarial steps; A6 audit-grep confirms no ViewportLock remnants. Other phases skip adversarial (per project routing rules — non-load-bearing/non-AI-adjacent).
