# Plan: upgrade react-router-dom 6 to react-router 7 (Z-38)

**Type:** plan only. **Status:** not started. **Date:** 2026-10-19 (S31). **Owner yes needed before any upgrade.**
**Old task or feature checked:** RCA 2026-10-18 "Admin page blank after login: two copies of react-router in the bundle"; `tools/__tests__/single-router-copy.test.ts`; Z-47 (error boundary); Z-38 (Dependabot tail).

## Why this plan exists

- Dependabot offers react-router 7. The upgrade is a major version.
- On 2026-10-18 a half-done router bump made two router copies in the bundle. The admin page was blank after login. A new bump must not repeat that.
- No security alert needs the upgrade today. The row stays open until the owner decides.

## Facts from the code (checked 2026-10-19)

| Item | Fact |
|---|---|
| Packages | `react-router-dom` `^6.30.6` in `apps/web` and `modules/10-admin-dashboard`; `modules/11-candidate-ui` lists `^6.27.0` (one entry) and `^6.30.6` (another entry) |
| Router style | One `<BrowserRouter>` in `apps/web/src/App.tsx` (line 72). No data router (`createBrowserRouter`, loaders, actions): no `json()`, `defer()` or `useBlocker` calls found |
| APIs used (count of import names) | `useNavigate` 29, `MemoryRouter` 26 (tests), `Link` 19, `useParams` 13, `Routes` 11, `Route` 11, `useSearchParams` 9, `useLocation` 4, `Navigate` 4, `Outlet` 1, `NavLink` 1, `BrowserRouter` 1 |
| Files that import the router | about 92 files in `apps` and `modules` |
| React | `^19.3.0` (version 7 needs React 18 or newer: fine) |
| Node | `>=22` (version 7 needs Node 20 or newer: fine) |
| Guard test | `tools/__tests__/single-router-copy.test.ts` reads `pnpm-lock.yaml` and fails if a router package resolves to more than one version |

## What changes in version 7 (verify in the official changelog on the day)

- The main package is `react-router`. `react-router-dom` stays as a thin re-export for now. Importing from `react-router` is the supported way.
- The "future flags" of 6.x become the default. Check each: `v7_relativeSplatPath`, `v7_startTransition`, `v7_fetcherPersist`, `v7_normalizeFormMethod`, `v7_partialHydration`, `v7_skipActionErrorRevalidation`.
- Relative links inside splat routes (`path="*"`) change. This is the most likely break in this app (the admin and candidate shells use nested routes).
- `json()` and `defer()` are removed. The app does not use them.
- State updates run inside `React.startTransition`. Tests that read the DOM right after a navigation may need `await`.

## Steps (when the owner says yes)

1. **Prepare on 6.30.x.** Turn on all `future` flags on the one `<BrowserRouter>` and fix each warning. Run the signed-in smoke. This is safe and can ship first.
2. **Align versions.** Make every workspace declare the same range (fix the `^6.27.0` entry in `modules/11-candidate-ui`). Run `pnpm install` and the `single-router-copy` test.
3. **Bump in one commit.** Change `react-router-dom` to `react-router` `^7` in `apps/web`, `modules/10-admin-dashboard` and `modules/11-candidate-ui` together, then update the imports (one search and replace: `from "react-router-dom"` to `from "react-router"`). If `react-router-dom` 7 is kept, bump all three workspaces to the same version.
4. **Check the lockfile.** `pnpm why react-router` must show one version. The `single-router-copy` test must pass.
5. **Tests.** Run the full test files of every module whose files changed (10, 11, `apps/web`), `pnpm typecheck`, and the web unit tests. Fix `await` timing in tests that follow navigation.
6. **Smoke.** Run the local smoke spec for the changed screens, plus a signed-in check of `/admin` and one take page. A blank page after login is the known failure.
7. **Deploy** only the frontend: `bash tools/deploy.sh --dry-run`, then `--yes`, then `bash tools/post-deploy-sweep.sh` (the sweep must include a signed-in `/admin` check; Z-47 adds it).

## Acceptance

- `pnpm verify` passes. CI is green on the code commit.
- `single-router-copy` test passes.
- Signed-in smoke passes for `/admin`, `/candidate` and one `/take` page.
- No console error `useNavigate() may be used only in the context of a <Router>`.

## Rollback

- Revert the bump commit and redeploy the frontend. The previous image tag stays on the VPS (`docker images assessiq/*`). Step 1 (future flags on 6.30) can stay.

## Not included

- The upgrade itself.
- Moving to a data router (loaders, actions). It is a separate design.
- Other Dependabot majors.

## Owner decision needed

- Yes or no for the upgrade. Recommendation: do step 1 now (no risk), and do steps 2 to 7 in one batch of its own after the Free plan work, not in a batch with feature changes.
